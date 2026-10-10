type Result = { isAvailable?: boolean; isNew?: boolean; isRollBackToEmbedded?: boolean };
export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error' | 'applying';
type UpdatePort = {
  enabled: boolean;
  check: () => Promise<Result>;
  download: () => Promise<Result>;
  reload: () => Promise<void>;
};

// Downloads do not replace running JS. Protect pending content only when
// applying, after a real background transition or an explicit user action.
export class UpdateLifecycle {
  private active = false;
  private backgrounded = false;
  private pendingContent = false;
  private ready = false;
  private reloading = false;
  private inFlight = false;
  private lastCheck = -Infinity;
  private disposed = false;
  private generation = 0;
  private autoApplyFailed = false;
  constructor(private port: UpdatePort, private interactive: (active: boolean) => void,
    private now: () => number = Date.now, private report: (state: UpdateState) => void = () => {}) {}

  start(state: string) { this.disposed = false; this.setAppState(state); }

  markReady() { this.ready = true; this.report('ready'); }
  setPendingContent(pending: boolean) { this.pendingContent = pending; }
  apply() {
    if (this.disposed || !this.active || !this.port.enabled || !this.ready || this.pendingContent || this.reloading) return false;
    this.reloading = true;
    this.report('applying');
    this.interactive(false);
    const generation = this.generation;
    // No success continuation: reloadAsync resolves just before replacing JS.
    void this.port.reload().catch(() => {
      if (generation !== this.generation) return;
      this.reloading = false;
      this.autoApplyFailed = true;
      if (!this.disposed && this.active) { this.interactive(true); this.report('error'); }
    });
    return true;
  }
  setAppState(state: string) {
    if (this.disposed) return;
    this.active = state === 'active';
    if (state === 'background') this.backgrounded = true;
    if (!this.active) { this.interactive(false); return; }
    if (this.reloading) return;
    // The caller also marks pending text and attachments as interactive work.
    // Returning from a picker or dictation must not replace JS and lose it.
    const canApply = this.backgrounded && this.ready && this.port.enabled && !this.pendingContent && !this.autoApplyFailed;
    this.backgrounded = false;
    if (canApply) {
      this.apply();
      return;
    }
    this.interactive(true);
    void this.check();
  }
  async check(force = false) {
    if (this.disposed || !this.port.enabled || !this.active || this.reloading || this.inFlight) return;
    if (this.ready && !force) return;
    if (!force && this.now() - this.lastCheck < 5 * 60_000) return;
    this.lastCheck = this.now();
    this.inFlight = true;
    this.report('checking');
    const generation = this.generation;
    try {
      const result = await this.port.check();
      if (generation !== this.generation) return;
      if (this.disposed || !this.active) {
        this.lastCheck = -Infinity; // Retry when returning to the touchpad.
        return;
      }
      if (result.isAvailable || result.isRollBackToEmbedded) {
        this.report('downloading');
        const downloaded = await this.port.download();
        if (generation === this.generation && !this.disposed) {
          if (downloaded.isNew || downloaded.isRollBackToEmbedded) this.ready = true;
          this.report(this.ready ? 'ready' : 'current');
        }
      } else this.report(this.ready ? 'ready' : 'current');
    } catch {
      // Updates are optional for the current session. Offline never blocks input.
      if (generation === this.generation && !this.disposed) this.report('error');
    } finally { if (generation === this.generation) this.inFlight = false; }
  }
  dispose() {
    this.disposed = true; this.active = false; this.generation++;
    this.inFlight = false; this.reloading = false; this.lastCheck = -Infinity;
  }
}
