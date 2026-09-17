"""Pure receiver-feedback policy, independent of GStreamer and capture.

P00 preserves the audited policy exactly; its known failures are fixtures.
"""
import math


class RateController:
    def __init__(self, maximum=12000, initial=6000):
        self.maximum = maximum
        self.target = min(initial, maximum)
        self.base_rtt = None
        self.good = 0

    def update(self, loss, delay, rtt):
        values = (loss, delay, rtt)
        if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in values):
            raise ValueError('invalid feedback')
        if not (0 <= loss <= 1 and 0 <= delay <= 10 and 0 <= rtt <= 30):
            raise ValueError('invalid feedback')
        # A distant but stable path must not be mistaken for congestion.
        if rtt > 0:
            self.base_rtt = min(self.base_rtt or rtt, rtt)
        queued_rtt = max(0, rtt - (self.base_rtt or rtt))
        if loss > .025 or delay > .10 or queued_rtt > .15:
            self.target = max(350, int(self.target * .75))
            self.good = 0
        else:
            self.good += 1
            if self.good >= 2:
                self.target = min(self.maximum, self.target + max(300, self.target // 4))
                self.good = 0
        return self.target
