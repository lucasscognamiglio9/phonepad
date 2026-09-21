import { LiteralTransfer, inputCapabilities, type InputCapabilities } from './literal-transfer';
import { parseActionReceipt, type ActionCommand, type ActionReceipt, type Command, type TouchContact } from './protocol';
import { allowsInput, allowsPermission, parseSessionCapabilities, type SessionCapabilities } from './session-capabilities';
export type ConnectionState = 'connecting' | 'connected' | 'offline' | 'unauthorized' | 'paused' | 'incompatible';

type ActionIntent =
  | { t: 'k'; a: 'special'; key: string }
  | { t: 'k'; a: 'combo'; key: string; mods: string[] };
type ActiveAction = { command: ActionIntent; nextSequence: number; active: boolean };
type ActionWaiter = (receipt: ActionReceipt | null) => void;
let actionCounter = 0;

function newActionOperationId() {
  actionCounter = (actionCounter + 1) % 0x1000000;
  return `op-${Date.now().toString(36)}-${actionCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class Connection {
  private socket: WebSocket | null = null;
  inputCapabilities: InputCapabilities | null = null;
  capabilities: SessionCapabilities | null = null;
  lastRejection = '';
  readonly literal: LiteralTransfer;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private handshake?: ReturnType<typeof setTimeout>;
  private flush?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private generation = 0;
  private active = false;
  private ready = false;
  private attempts = 0;
  private pong = 0;
  private dx = 0;
  private dy = 0;
  private inputGeneration = 0;
  private actionOps = new Map<string, ActiveAction>();
  private actionReceipts = new Map<string, ActionReceipt>();
  private actionWaiters = new Map<string, Set<ActionWaiter>>();
  get inputEpoch() { return this.inputGeneration; }
  get canInput() { return allowsInput(this.capabilities); }
  get canView() { return allowsPermission(this.capabilities, 'view'); }
  get canTransfer() { return allowsPermission(this.capabilities, 'files'); }
  get canClipboard() { return allowsPermission(this.capabilities, 'clipboard'); }
  constructor(readonly origin: string, private report: (state: ConnectionState) => void,
    private changed: () => void = () => {}) {
    this.literal = new LiteralTransfer(origin, () => this.inputCapabilities, () => this.capabilities?.sessionEpoch ?? null);
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Se requiere una dirección HTTPS segura.');
  }
  start = () => { this.stop(); this.active = true; this.attempts = 0; void this.connect(); };
  stop = () => {
    this.active = false; this.ready = false; this.clearCapabilities(); this.generation++; this.inputGeneration++;
    clearTimeout(this.retry); this.clearSocketTimers();
    this.request?.abort(); this.dx = this.dy = 0;
    const old = this.socket; this.socket = null; old?.close();
  };
  private clearCapabilities() {
    this.inputCapabilities = null; this.capabilities = null; this.lastRejection = ''; this.clearActionState(); this.changed();
  }
  private acceptCapabilities(message: unknown, update = false) {
    const next = parseSessionCapabilities(message);
    const current = this.capabilities;
    if (update) {
      if (current?.protocolVersion !== 2 || next.protocolVersion !== 2
        || current.sessionEpoch !== next.sessionEpoch) throw Error('unexpected capability update');
      if (next.capabilityRevision <= current.capabilityRevision) return;
    }
    const literal = inputCapabilities((message as {input?: unknown}).input);
    if (next.literal === 'available' && !literal) throw Error('invalid literal capabilities');
    this.capabilities = next;
    this.inputCapabilities = allowsInput(next) && next.literal === 'available' ? literal : null;
    const inputChanged = update && current && (allowsInput(current) !== allowsInput(next)
      || current.input.actions.join(',') !== next.input.actions.join(','));
    if (inputChanged) {
      // A permission transition cannot resurrect a held finger or queued move.
      // File/clipboard-only changes must still let the old gesture release.
      this.inputGeneration++; this.dx = this.dy = 0;
      clearTimeout(this.flush); this.flush = undefined;
      // Do not replay a key operation after revocation. Keep its identity so
      // the UI can still send the definitive cancel frame while connected.
      for (const operation of this.actionOps.values()) operation.active = false;
    }
    this.lastRejection = ''; this.changed();
  }
  private clearSocketTimers() {
    clearTimeout(this.handshake); clearInterval(this.heartbeat);
    clearTimeout(this.flush); this.flush = undefined;
  }
  private disconnect(socket: WebSocket, takenOver = false) {
    if (this.socket !== socket) return;
    this.socket = null; this.ready = false; this.clearCapabilities(); this.dx = this.dy = 0; this.inputGeneration++;
    this.clearSocketTimers();
    // Recovery must not depend on a broken transport delivering onclose.
    socket.close();
    if (takenOver) { this.active = false; this.report('paused'); }
    else this.schedule();
  }
  private schedule() {
    if (!this.active) return;
    this.report('offline'); clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), [250, 500, 1000, 3000][Math.min(this.attempts++, 3)]);
  }
  private async connect() {
    const generation = ++this.generation;
    this.report('connecting');
    const request = new AbortController(); this.request = request;
    const timeout = setTimeout(() => request.abort(), 5000);
    try {
      const response = await fetch(this.origin + '/api/auth', { signal: request.signal });
      if (!this.active || generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) { this.active = false; this.report('unauthorized'); return; }
      if (response.status !== 204) throw Error('connection');
      const socket = new WebSocket(this.origin.replace('https:', 'wss:') + '/ws?protocol=2');
      this.socket = socket;
      this.handshake = setTimeout(() => this.disconnect(socket), 5000);
      socket.onmessage = event => {
        if (this.socket !== socket) return;
        let message; try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message || typeof message !== 'object') return;
        if (message.t === 'ok' && !this.ready) {
          clearTimeout(this.handshake);
          try { this.acceptCapabilities(message); }
          catch { this.stop(); this.report('incompatible'); return; }
          this.ready = true; this.attempts = 0; this.pong = Date.now(); this.report('connected');
          clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.pong > 10000) this.disconnect(socket);
            else this.send({ t: 'ping' });
          }, 2000);
        } else if (message.t === 'capabilities' && this.ready) {
          try { this.acceptCapabilities(message, true); }
          catch { this.stop(); this.report('incompatible'); }
        } else if (message.t === 'receipt' && this.ready) {
          const receipt = parseActionReceipt(message);
          if (receipt) this.acceptActionReceipt(receipt);
        } else if (message.t === 'rejected' && this.ready) {
          if (typeof message.code === 'string' && /^[a-z_]{1,64}$/.test(message.code)) {
            this.lastRejection = message.code; this.changed();
          }
        } else if (message.t === 'pong') this.pong = Date.now();
        else if (message.t === 'err') { this.stop(); this.report('unauthorized'); }
      };
      socket.onerror = () => this.disconnect(socket);
      socket.onclose = event => this.disconnect(socket, event.code === 1008);
    } catch { if (this.active && generation === this.generation) this.schedule(); }
    finally { clearTimeout(timeout); }
  }
  private sendWire(command: Command, bypassInput = false) {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) return false;
    if (command.t !== 'ping' && !bypassInput && !allowsInput(this.capabilities, command.t)) return false;
    // Never replay stale touches after congestion or reconnect.
    if (socket.bufferedAmount > 16384) { this.disconnect(socket); return false; }
    // Button edges must follow all movement collected before that edge.
    if (command.t === 'b') this.flushMovement();
    if (this.socket !== socket || !this.ready) return false;
    const envelope = command.t !== 'ping' && this.capabilities?.protocolVersion === 2
      ? { ...command, sessionEpoch: this.capabilities.sessionEpoch } : command;
    try { socket.send(JSON.stringify(envelope)); return true; }
    catch { this.disconnect(socket); return false; }
  }
  send = (command: Command) => this.sendWire(command);

  private clearActionState() {
    this.actionOps.clear(); this.actionReceipts.clear();
    for (const waiters of this.actionWaiters.values()) for (const waiter of waiters) waiter(null);
    this.actionWaiters.clear();
  }
  private acceptActionReceipt(receipt: ActionReceipt) {
    if (receipt.sessionEpoch && receipt.sessionEpoch !== this.capabilities?.sessionEpoch) return;
    this.actionReceipts.set(receipt.operationId, receipt);
    const operation = this.actionOps.get(receipt.operationId);
    if (operation && (receipt.phase === 'cancel' || receipt.state === 'rejected'
      || receipt.state === 'uncertain' || receipt.state === 'cancelled')) operation.active = false;
    const waiters = this.actionWaiters.get(receipt.operationId);
    if (waiters) {
      this.actionWaiters.delete(receipt.operationId);
      for (const waiter of waiters) waiter(receipt);
    }
    this.changed();
  }
  getActionReceipt = (operationId: string) => this.actionReceipts.get(operationId) ?? null;
  waitActionReceipt = (operationId: string, timeoutMs = 5000): Promise<ActionReceipt | null> => {
    const current = this.actionReceipts.get(operationId);
    if (current) return Promise.resolve(current);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(operationId) || timeoutMs < 0) return Promise.resolve(null);
    return new Promise(resolve => {
      const waiters = this.actionWaiters.get(operationId) ?? new Set<ActionWaiter>();
      let timer: ReturnType<typeof setTimeout>;
      const waiter: ActionWaiter = receipt => {
        clearTimeout(timer); waiters.delete(waiter); resolve(receipt);
      };
      waiters.add(waiter); this.actionWaiters.set(operationId, waiters);
      timer = setTimeout(() => {
        waiters.delete(waiter); if (!waiters.size) this.actionWaiters.delete(operationId); resolve(null);
      }, timeoutMs);
    });
  };
  // Presses are receipt-aware only on protocol v2. A null result means the
  // command was not admitted locally and no retry identity was created.
  pressAction = (command: ActionIntent): string | null => {
    if (!this.ready || this.capabilities?.protocolVersion !== 2 || !allowsInput(this.capabilities, 'k')) return null;
    const operationId = newActionOperationId();
    const action = { ...command, operationId, phase: 'press' as const, actionSequence: 1 } as ActionCommand;
    if (!this.send(action)) return null;
    this.actionOps.set(operationId, { command, nextSequence: 2, active: true });
    return operationId;
  };
  repeatAction = (operationId: string) => {
    const operation = this.actionOps.get(operationId);
    if (!operation?.active) return false;
    const action = { ...operation.command, operationId, phase: 'repeat' as const, actionSequence: operation.nextSequence } as ActionCommand;
    if (!this.send(action)) { operation.active = false; return false; }
    operation.nextSequence++;
    return true;
  };
  cancelAction = (operationId: string) => {
    const operation = this.actionOps.get(operationId);
    if (!operation || !this.ready || this.capabilities?.protocolVersion !== 2) return false;
    operation.active = false;
    const cancel: ActionCommand = { t: 'k', a: 'cancel', operationId, phase: 'cancel' };
    return this.sendWire(cancel, true);
  };
  // Every finger sequence belongs to one transport. A reconnect must wait for
  // a fresh touch-down instead of reviving a held finger as a new tap.
  touch = (epoch: number, contacts: TouchContact[]) => {
    if (epoch !== this.inputGeneration) return false;
    return this.send({ t: 't', c: contacts });
  };
  cancelTouch = (epoch: number) => {
    if (epoch !== this.inputGeneration) return false;
    return this.send({ t: 't', c: [], cancel: true });
  };
  move = (dx: number, dy: number) => {
    if (!this.ready || !allowsInput(this.capabilities, 'm')) return;
    this.dx += dx; this.dy += dy;
    if (this.flush) return;
    this.flush = setTimeout(() => this.flushMovement(), 8);
  };
  private flushMovement() {
    clearTimeout(this.flush); this.flush = undefined;
    const x = Math.round(this.dx), y = Math.round(this.dy);
    this.dx -= x; this.dy -= y;
    if (x || y) this.send({ t: 'm', dx: x, dy: y });
  }
  click = (btn: 'l' | 'r') => { this.send({ t: 'b', btn, a: 'down' }); this.send({ t: 'b', btn, a: 'up' }); };
}
