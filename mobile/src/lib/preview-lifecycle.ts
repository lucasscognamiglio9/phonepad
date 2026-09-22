import type { VideoSession } from './video';

// Keep a paused native session while input reconnects. No streaming lease is
// extended by background heartbeats; the server owns the five-minute deadline.
export class PreviewLifecycle<T> {
  private wanted = false;
  private active = false;
  private ready = false;
  private controller?: AbortController;
  private session?: VideoSession;
  private paused = false;
  private pausedAt = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private generation = 0;
  constructor(
    private start: (signal: AbortSignal, show: (stream: T) => void, failed: (error: Error) => void) => Promise<VideoSession>,
    private show: (stream: T | null) => void,
    private message: (text: string) => void,
  ) {}
  update(wanted: boolean, active: boolean, ready: boolean) {
    this.wanted = wanted; this.active = active; this.ready = ready;
    if (!wanted) { this.clear(); return; }
    if (!active) {
      clearTimeout(this.retry); this.retry = undefined;
      if (!this.session) { this.clear(); return; }
      if (!this.paused) {
        this.paused = true; this.pausedAt = Date.now();
        const session = this.session;
        this.expiry = setTimeout(() => { if (this.session === session && this.paused) this.clear(); }, 300_000);
        void session.setActive(false).catch(() => {
          if (this.session === session) { this.clear(); this.ensure(); }
        });
      }
      return;
    }
    if (!ready) return;
    if (this.paused && this.session) {
      if (Date.now() - this.pausedAt >= 300_000) { this.clear(); this.ensure(); return; }
      const session = this.session; this.paused = false; clearTimeout(this.expiry);
      void session.setActive(true).catch(error => { if (this.session === session) this.failed(error); });
    } else this.ensure();
  }
  private ensure() {
    if (!this.wanted || !this.active || !this.ready || this.controller || this.retry) return;
    const generation = ++this.generation;
    this.controller = new AbortController();
    this.message('Conectando la pantalla…');
    void this.start(this.controller.signal,
      stream => { if (generation === this.generation) this.show(stream); },
      error => { if (generation === this.generation) this.failed(error); },
    ).then(session => {
      if (generation !== this.generation) { session(); return; }
      this.session = session;
    }).catch(error => { if (generation === this.generation) this.failed(error); });
  }
  private failed(error: Error) {
    console.warn('[PhonePad preview]', error);
    this.clear(); this.message('No se pudo conectar la pantalla. Reintentando…');
    if (this.wanted && this.active && this.ready) this.retry = setTimeout(() => {
      this.retry = undefined; this.ensure();
    }, 1500);
  }
  restart() { this.clear(); this.ensure(); }
  private clear() {
    ++this.generation; clearTimeout(this.retry); clearTimeout(this.expiry);
    this.retry = this.expiry = undefined;
    this.controller?.abort(); this.controller = undefined;
    this.session?.(); this.session = undefined; this.paused = false;
    this.show(null);
  }
  dispose() { this.wanted = false; this.clear(); }
}
