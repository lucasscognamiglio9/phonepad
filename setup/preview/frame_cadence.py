"""Bound damage-driven capture without duplicating frames or queuing history."""

class FrameCadence:
    """Bound a damage-driven source without accumulating idle-time debt.

    No buffer is retained or duplicated. The corresponding caps describe the
    maximum cadence, not a promise to manufacture frames on an idle desktop.
    """
    def __init__(self, fps):
        self.fps = fps
        self.last_pts = None
        self.next_due = None
        self.previous_fps = fps
        self.dropped = 0

    def accept(self, pts, discontinuity=False):
        interval = 1_000_000_000 / self.fps
        if discontinuity or (self.last_pts is not None and pts < self.last_pts):
            self.last_pts = self.next_due = None
        if self.previous_fps != self.fps:
            self.previous_fps = self.fps
            self.next_due = self.last_pts + interval if self.last_pts is not None else None
        if self.last_pts == pts or (self.next_due is not None and pts + 1 < self.next_due):
            self.dropped += 1
            return False
        # Preserve phase through small scheduling jitter. Restart after idle
        # rather than spending old frame slots as a burst of new frames.
        self.next_due = (self.next_due + interval if self.next_due is not None
                         and pts < self.next_due + interval else pts + interval)
        self.last_pts = pts
        return True
