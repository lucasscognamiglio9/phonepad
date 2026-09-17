"""Bounded receiver-feedback policy. Rates are kbps; delays and clock are seconds.

This is not GCC. Moderate loss needs persistence; stable RTT and jitter-buffer
residence alone cannot distinguish congestion from a path or receiver change.
"""
from collections import deque
import math
import time


class RateController:
    def __init__(self, maximum=12000, initial=6000, policy='windowed'):
        if policy not in ('windowed', 'legacy'):
            raise ValueError('unknown rate policy')
        self.maximum = maximum
        self.target = min(initial, maximum)
        self.policy = policy
        self.reset()

    def reset(self):
        # Preserve target across resume; discard stale network evidence.
        self.base_rtt = None
        self.legacy_base = None
        self.history = deque(maxlen=120)
        self.previous = None
        self.last_time = None
        self.last_change = None
        self.good_since = None
        self.bad_since = None
        self.good = 0
        self.route = None
        self.sequence = None
        self.state = None
        self.state_since = None
        self.decision = {}

    def update(self, loss, delay, rtt, *, now=None, route=None, sequence=None):
        for value, limit in ((loss, 1), (delay, 10), (rtt, 30)):
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= limit):
                raise ValueError('invalid feedback')
        now = time.monotonic() if now is None else now
        if type(now) not in (int, float) or not math.isfinite(now) or now < 0:
            raise ValueError('invalid time')
        if route is not None and (not isinstance(route, str) or len(route) > 256):
            raise ValueError('invalid route')
        if sequence is not None and (type(sequence) is not int or sequence < 0):
            raise ValueError('invalid sequence')
        before = self.target
        reason = 'unknown'
        if (sequence is not None and self.sequence is not None and sequence <= self.sequence) or (self.last_time is not None and now <= self.last_time):
            self.decision = {**self.decision, 'reason': 'ignored_stale_feedback', 'ignoredSequence': sequence}
            return self.target
        if (route is not None and route != self.route) or (self.last_time is not None and now-self.last_time > 5):
            self.reset()
        self.route = route
        self.sequence = sequence
        self.last_time = now
        while self.history and now-self.history[0][0] > 30:
            self.history.popleft()
        if rtt is not None and rtt > 0:
            self.history.append((now, rtt))
        self.base_rtt = min((item[1] for item in self.history), default=None)
        prev = self.previous
        growing = bool(prev and rtt is not None and delay is not None and prev[0] is not None and prev[1] is not None
                       and rtt-prev[0] > .02 and delay-prev[1] > .01)
        self.previous = (rtt, delay)
        if loss is None:
            self.good_since = self.bad_since = None
        elif self.policy == 'legacy':
            # Explicit rollback, retaining the same diagnostics and missing-data guard.
            self.legacy_base = min(self.legacy_base or rtt or 30, rtt or 30)
            if loss > .025 or (delay or 0) > .10 or (rtt or 0)-self.legacy_base > .15:
                self.target = max(350, int(self.target*.75)); self.good = 0
                reason = 'legacy_decrease'
            else:
                self.good += 1
                if self.good >= 2:
                    self.target = min(self.maximum, self.target+max(300, self.target//4)); self.good = 0
                reason = 'legacy_recovery'
        else:
            severe = loss >= .08
            suspect = loss > .025 or growing
            if suspect:
                self.good_since = None
                if self.bad_since is None: self.bad_since = now
                persistent = now-self.bad_since >= 2
                cooldown = 1 if severe else 3
                if (severe or persistent) and (self.last_change is None or now-self.last_change >= cooldown):
                    self.target = max(350, int(self.target*(.75 if severe else .85)))
                    self.last_change = now
                    reason = 'severe_loss' if severe else 'persistent_loss_or_queue_growth'
                else:
                    reason = 'congestion_observation'
            else:
                self.bad_since = None
                if self.good_since is None: self.good_since = now
                if now-self.good_since >= 1 and (self.last_change is None or now-self.last_change >= 2):
                    self.target = min(self.maximum, self.target+max(300, self.target//4))
                    self.last_change = now
                reason = 'at_maximum' if self.target == self.maximum else 'recovery'
        if reason != self.state:
            self.state = reason; self.state_since = now
        self.decision = {'observedAtSeconds': now, 'policy': self.policy, 'reason': reason, 'stateDurationMs': round((now-self.state_since)*1000),
                         'requestedKbps': self.target, 'previousKbps': before, 'loss': loss, 'delay': delay,
                         'rtt': rtt, 'baseRtt': self.base_rtt, 'route': route, 'sequence': sequence}
        return self.target
