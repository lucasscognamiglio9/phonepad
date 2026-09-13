type Result = { isAvailable?: boolean; isNew?: boolean; isRollBackToEmbedded?: boolean };
type UpdatePort = {
  enabled: boolean;
  check: () => Promise<Result>;
  download: () => Promise<Result>;
  reload: () => Promise<void>;
};

// Download while the screen stream is closed. Apply only after a real trip to
// the background, before reconnecting input, never when a download completes.
export class UpdateLifecycle {
  private active = false;
  private backgrounded = false;
  private preview = false;
  private ready = false;
  private reloading = false;
  private inFlight = false;
  private lastCheck = -Infinity;
  private disposed = false;
  private generation = 0;
  constructor(private port: UpdatePort, private interactive: (active: boolean) => void,
    private now: () => number = Date.now) {}

  start(state: string) { this.disposed = false; this.setAppState(state); }

  markReady() { this.ready = true; }
  setPreview(open: boolean) { this.preview = open; if (!open) void this.check(); }
  setAppState(state: string) {
    if (this.disposed) return;
    this.active = state === 'active';
    if (state === 'background') this.backgrounded = true;
    if (!this.active) { this.interactive(false); return; }
    if (this.reloading) return;
    const canApply = this.backgrounded && this.ready && this.port.enabled;
    this.backgrounded = false;
    if (canApply) {
      this.reloading = true;
      this.ready = false;
      this.interactive(false);
      const generation = this.generation;
      // No success continuation: reloadAsync resolves just before replacing JS.
      void this.port.reload().catch(() => {
        if (generation !== this.generation) return;
        this.reloading = false;
        if (!this.disposed && this.active) this.interactive(true);
      });
      return;
    }
    this.interactive(true);
    void this.check();
  }
  async check(force = false) {
    if (this.disposed || !this.port.enabled || !this.active || this.preview || this.ready || this.reloading || this.inFlight) return;
    if (!force && this.now() - this.lastCheck < 5 * 60_000) return;
    this.lastCheck = this.now();
    this.inFlight = true;
    const generation = this.generation;
    try {
      const result = await this.port.check();
      if (generation !== this.generation) return;
      if (this.disposed || !this.active || this.preview) {
        this.lastCheck = -Infinity; // Retry when returning to the touchpad.
        return;
      }
      if (result.isAvailable || result.isRollBackToEmbedded) {
        const downloaded = await this.port.download();
        if (generation === this.generation && !this.disposed && (downloaded.isNew || downloaded.isRollBackToEmbedded)) this.ready = true;
      }
    } catch {
      // Updates are optional for the current session. Offline never blocks input.
    } finally { if (generation === this.generation) this.inFlight = false; }
  }
  dispose() {
    this.disposed = true; this.active = false; this.generation++;
    this.inFlight = false; this.reloading = false; this.lastCheck = -Infinity;
  }
}
