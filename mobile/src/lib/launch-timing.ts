type Timer = ReturnType<typeof setTimeout>;
type Clock = { now: () => number; wait: (done: () => void, ms: number) => Timer; cancel: (timer: Timer) => void };

/** Count actual foreground visibility, starting when the local logo is decoded. */
export class LaunchTiming {
  private active = true;
  private shown = false;
  private ready = false;
  private exiting = false;
  private disposed = false;
  private elapsed = 0;
  private since?: number;
  private timer?: Timer;
  private generation = 0;
  constructor(private minimum: number, private exit: () => void, private clock: Clock = {
    now: () => performance.now(), wait: (done, ms) => setTimeout(done, ms), cancel: timer => clearTimeout(timer),
  }) {}
  show() {
    if (this.disposed || this.shown) return;
    this.shown = true;
    if (this.active) this.since = this.clock.now();
    this.ensure();
  }
  markReady() { if (!this.disposed) { this.ready = true; this.ensure(); } }
  setActive(active: boolean) {
    if (this.disposed || active === this.active) return;
    if (this.since !== undefined) { this.elapsed += Math.max(0, this.clock.now() - this.since); this.since = undefined; }
    this.active = active;
    this.clearTimer();
    if (active && this.shown) this.since = this.clock.now();
    this.ensure();
  }
  private ensure() {
    if (this.disposed || this.exiting || !this.active || !this.shown || !this.ready || this.timer !== undefined) return;
    const visible = this.elapsed + (this.since === undefined ? 0 : Math.max(0, this.clock.now() - this.since));
    const remaining = Math.max(0, this.minimum - visible);
    if (!remaining) { this.exiting = true; this.exit(); return; }
    const generation = this.generation;
    this.timer = this.clock.wait(() => { if (generation !== this.generation || this.disposed) return; this.timer = undefined; this.ensure(); }, remaining);
  }
  private clearTimer() { ++this.generation; if (this.timer !== undefined) this.clock.cancel(this.timer); this.timer = undefined; }
  dispose() { this.disposed = true; this.clearTimer(); }
}
