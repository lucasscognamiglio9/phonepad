const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function clock() {
  let now = 0, sequence = 0;
  const tasks = new Map();
  const add = (fn, delay, repeat = false) => {
    const id = ++sequence; tasks.set(id, { fn, at: now + delay, repeat, delay }); return id;
  };
  return {
    env: {
      Date: class extends Date { static now() { return now; } },
      setTimeout: (fn, delay) => add(fn, delay), clearTimeout: id => tasks.delete(id),
      setInterval: (fn, delay) => add(fn, delay, true), clearInterval: id => tasks.delete(id),
    },
    get now() { return now; },
    get pending() { return tasks.size; },
    async advance(ms) {
      await drain(); const end = now + ms;
      while (true) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at).find(([, task]) => task.at <= end);
        if (!next) break;
        const [id, task] = next; now = task.at;
        if (task.repeat) task.at += task.delay; else tasks.delete(id);
        task.fn(); await drain();
      }
      now = end; await drain();
    },
  };
}
function load(file, extra) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, URL, AbortController, ...extra }); return exports;
}
function control() {
  const time = clock(), sockets = [], states = [];
  class Socket {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = [];
    constructor() { sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    // Deliberately never emits onclose: a failed connection must still recover.
    close() { this.readyState = 3; }
    ack() { this.onmessage({ data: '{"t":"ok"}' }); }
  }
  const { Connection } = load('connection.ts', { ...time.env, WebSocket: Socket, fetch: async () => ({ status: 204 }) });
  return { time, sockets, states, connection: new Connection('https://host.ts.net', state => states.push(state)) };
}

test('stalled control handshake reconnects without onclose and ignores the old socket', async () => {
  const h = control(); h.connection.start(); await drain();
  await h.time.advance(5000);
  assert.equal(h.states.at(-1), 'offline');
  await h.time.advance(250);
  assert.equal(h.sockets.length, 2);
  h.sockets[0].ack(); h.connection.click('l');
  assert.equal(h.sockets[1].sent.length, 0);
  h.sockets[1].ack(); h.connection.click('r');
  assert.equal(h.sockets[1].sent.length, 2);
  h.connection.stop(); assert.equal(h.time.pending, 0);
});

test('congestion discards buffered gestures and resumes with only fresh input', async () => {
  const h = control(); h.connection.start(); await drain(); h.sockets[0].ack();
  h.connection.move(900, 800); h.sockets[0].bufferedAmount = 65536; h.connection.click('l');
  await h.time.advance(250); h.sockets[1].ack(); h.connection.move(4, 5);
  await h.time.advance(8);
  assert.deepEqual(h.sockets[1].sent, [{ t: 'm', dx: 4, dy: 5 }]);
  h.connection.stop(); assert.equal(h.time.pending, 0);
});

test('raw contacts remain ordered and are never revived after reconnect', async () => {
  const h = control(); h.connection.start(); await drain(); h.sockets[0].ack();
  const epoch = h.connection.inputEpoch;
  const contacts = [{ id: 7, x: .4, y: .5 }, { id: 3, x: .6, y: .5 }];
  assert.equal(h.connection.touch(epoch, contacts), true);
  assert.equal(h.connection.touch(epoch, [contacts[0]]), true);
  assert.equal(h.connection.touch(epoch, []), true);
  assert.deepEqual(h.sockets[0].sent.map(packet => packet.c), [contacts, [contacts[0]], []]);
  assert.equal(h.connection.cancelTouch(epoch), true);
  assert.deepEqual(h.sockets[0].sent.at(-1), { t: 't', c: [], cancel: true });
  h.sockets[0].bufferedAmount = 65536;
  assert.equal(h.connection.touch(epoch, contacts), false);
  await h.time.advance(250); h.sockets[1].ack();
  assert.notEqual(h.connection.inputEpoch, epoch);
  assert.equal(h.connection.touch(epoch, contacts), false);
  assert.equal(h.connection.touch(epoch, []), false);
  assert.equal(h.connection.cancelTouch(epoch), false);
  assert.equal(h.sockets[1].sent.length, 0);
  assert.equal(h.connection.touch(h.connection.inputEpoch, contacts), true);
  h.connection.stop(); assert.equal(h.time.pending, 0);
});

test('background stop invalidates a finger sequence before the next connection', async () => {
  const h = control(); h.connection.start(); await drain(); h.sockets[0].ack();
  const epoch = h.connection.inputEpoch;
  assert.equal(h.connection.touch(epoch, [{ id: 1, x: .5, y: .5 }]), true);
  h.connection.stop(); h.connection.start(); await drain(); h.sockets[1].ack();
  assert.equal(h.connection.touch(epoch, [{ id: 1, x: .6, y: .5 }]), false);
  assert.equal(h.sockets[1].sent.length, 0);
  h.connection.stop(); assert.equal(h.time.pending, 0);
});

test('control heartbeat recovers a silent socket without replaying input', async () => {
  const h = control(); h.connection.start(); await drain(); h.sockets[0].ack();
  await h.time.advance(12000);
  assert.equal(h.states.at(-1), 'offline');
  await h.time.advance(250); assert.equal(h.sockets.length, 2);
  h.connection.stop(); assert.equal(h.time.pending, 0);
});

test('an explicit control takeover pauses instead of fighting the other session', async () => {
  const h = control(); h.connection.start(); await drain(); h.sockets[0].ack();
  h.sockets[0].onclose({ code: 1008 });
  await h.time.advance(30000);
  assert.equal(h.states.at(-1), 'paused'); assert.equal(h.sockets.length, 1);
  h.connection.stop(); assert.equal(h.time.pending, 0);
});

function video(options = {}) {
  const time = clock(), peers = [], calls = [], failures = [], shown = [];
  const controller = new AbortController();
  class Peer {
    iceGatheringState = options.gathering ? 'gathering' : 'complete';
    connectionState = 'new'; closed = 0; listeners = new Map();
    constructor() { peers.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    async setRemoteDescription() { this.listeners.get('track')?.({ track: { kind: 'video' }, streams: [{ id: 'stream' }] }); }
    async createAnswer() { if (options.hangNative) return new Promise(() => {}); return { type: 'answer', sdp: 'native-answer' }; }
    async setLocalDescription(answer) { this.localDescription = answer; }
    async getStats() {
      const framesDecoded = options.frozen ? 1 : options.empty ? 0 : 1 + Math.floor(time.now / 16);
      return new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded, packetsReceived: framesDecoded * 5, jitterBufferEmittedCount: framesDecoded, jitterBufferDelay: framesDecoded * 0.005 }]]);
    }
    close() { this.closed++; }
    fail() { this.connectionState = 'failed'; this.onconnectionstatechange?.(); }
  }
  const abortable = signal => new Promise((_, reject) => {
    if (signal.aborted) reject(Error('aborted'));
    else signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  });
  const fetch = async (url, init) => {
    const data = init.body ? JSON.parse(init.body) : { op: 'status' }; calls.push(data);
    if (options.hang === data.op) return abortable(init.signal);
    if (options.hangBody === data.op) return { ok: true, json: () => abortable(init.signal) };
    if (options.lateOffer && data.op === 'start') {
      controller.abort(); return { ok: true, json: async () => ({ id: 'session', sdp: 'offer' }) };
    }
    return { ok: true, json: async () => data.op === 'status' ? { state: 'ready' } : data.op === 'start' ? { id: 'session', sdp: 'offer' } : {} };
  };
  const { startVideo } = load('video.ts', {
    ...time.env, fetch,
    require: name => {
      assert.equal(name, '@livekit/react-native-webrtc');
      return { RTCPeerConnection: Peer, RTCSessionDescription: class { constructor(value) { Object.assign(this, value); } }, MediaStream: class {} };
    },
  });
  return { time, peers, calls, failures, shown, controller,
    start: () => startVideo('https://host.ts.net', controller.signal, stream => shown.push(stream), error => failures.push(error)),
  };
}

test('native preview requests desktop resolution and releases its encoder once on background', async () => {
  const h = video(); const stop = await h.start(); await drain();
  assert.deepEqual(h.calls.find(c => c.op === 'start'), { op: 'start', width: 1920, codec: 'H264' });
  assert.equal(h.shown.length, 1);
  await h.time.advance(1500);
  assert.ok(h.calls.filter(c => c.op === 'feedback').length >= 2);
  h.controller.abort(); stop(); await drain();
  assert.equal(h.calls.filter(c => c.op === 'stop').length, 1);
  assert.equal(h.peers[0].closed, 1); assert.equal(h.failures.length, 0);
  assert.equal(h.time.pending, 0);
});

test('a hung signaling response body times out and cleans up the native peer', async () => {
  const h = video({ hangBody: 'status' });
  const rejected = assert.rejects(h.start(), /aborted/);
  await h.time.advance(5000); await rejected;
  assert.equal(h.peers[0].closed, 1); assert.equal(h.time.pending, 0);
});

test('background cancellation during ICE gathering removes all listeners and timers', async () => {
  const h = video({ gathering: true });
  const rejected = assert.rejects(h.start(), /Cancelado/); await drain();
  h.controller.abort(); await rejected; await drain();
  assert.equal(h.peers[0].onicegatheringstatechange, null);
  assert.equal(h.time.pending, 0); assert.equal(h.failures.length, 0);
  assert.equal(h.calls.filter(c => c.op === 'stop').length, 1);
});

test('a late server offer is released even when cancellation wins the race', async () => {
  const h = video({ lateOffer: true });
  await assert.rejects(h.start(), /Cancelado/); await drain();
  assert.equal(h.calls.filter(c => c.op === 'stop').length, 1);
  assert.equal(h.peers[0].closed, 1); assert.equal(h.time.pending, 0);
});

test('a frozen video recovers even though its network feedback still succeeds', async () => {
  const h = video({ frozen: true }); await h.start(); await h.time.advance(8000);
  h.peers[0].fail(); await drain();
  assert.equal(h.failures.length, 1); assert.equal(h.peers[0].closed, 1);
  assert.equal(h.calls.filter(c => c.op === 'stop').length, 1); assert.equal(h.time.pending, 0);
});

test('a negotiated track without decoded frames cannot stay connected indefinitely', async () => {
  const h = video({ empty: true }); await h.start(); await h.time.advance(12000);
  assert.equal(h.failures.length, 1); assert.equal(h.time.pending, 0);
});

test('a stuck native negotiation rejects once so the screen can reconnect', async () => {
  const h = video({ hangNative: true });
  const rejected = assert.rejects(h.start(), /Reconectando/);
  await h.time.advance(12000); await rejected; await drain();
  assert.equal(h.failures.length, 0); assert.equal(h.peers[0].closed, 1);
  assert.equal(h.time.pending, 0);
});

test('cancelling before startup never touches the network', async () => {
  const h = video(); h.controller.abort();
  await assert.rejects(h.start(), /Cancelado/);
  assert.equal(h.calls.length, 0); assert.equal(h.time.pending, 0);
});

test('paused native video stops feedback and resumes the same peer with a fresh frame budget', async () => {
  const h = video(); const session = await h.start(); await drain();
  await session.setActive(false); const count = h.calls.filter(c => c.op === 'feedback').length;
  await h.time.advance(299000);
  assert.equal(h.calls.filter(c => c.op === 'feedback').length, count);
  assert.equal(h.failures.length, 0); assert.equal(h.peers[0].closed, 0);
  await session.setActive(true); await drain();
  assert.equal(h.peers.length, 1); assert.ok(h.calls.some(c => c.op === 'resume'));
  session(); await drain(); assert.equal(h.time.pending, 0);
});

test('a five-minute-old native session is released instead of silently reused', async () => {
  const h = video(); const session = await h.start(); await session.setActive(false);
  await h.time.advance(300000);
  await assert.rejects(session.setActive(true), /Reconectando/);
  assert.equal(h.peers[0].closed, 1); assert.equal(h.time.pending, 0);
});

function previewLifecycle() {
  const time = clock(), sessions = [], pictures = [], messages = [];
  const { PreviewLifecycle } = load('preview-lifecycle.ts', time.env);
  const lifecycle = new PreviewLifecycle(async (signal, show) => {
    const s = Object.assign(() => { s.closed++; }, {closed: 0, activities: [], setActive: async active => { s.activities.push(active); }});
    sessions.push(s); show('image'); return s;
  }, image => pictures.push(image), message => messages.push(message));
  return {time,sessions,pictures,messages,lifecycle};
}

test('returning through an input handshake reuses warm preview without showing a loading screen', async () => {
  const h=previewLifecycle();h.lifecycle.update(true,true,true);await drain();
  h.lifecycle.update(true,false,true);await h.time.advance(1000);
  h.lifecycle.update(true,true,false);await drain();
  assert.equal(h.sessions.length,1);assert.equal(h.sessions[0].closed,0);
  h.lifecycle.update(true,true,true);await drain();
  assert.deepEqual(h.sessions[0].activities,[false,true]);assert.equal(h.messages.length,1);
  h.lifecycle.dispose();assert.equal(h.time.pending,0);
});

test('warm preview expires at five minutes and creates a fresh session on return', async () => {
  const h=previewLifecycle();h.lifecycle.update(true,true,true);await drain();
  h.lifecycle.update(true,false,true);await h.time.advance(300000);
  assert.equal(h.sessions[0].closed,1);
  h.lifecycle.update(true,true,true);await drain();assert.equal(h.sessions.length,2);
  h.lifecycle.update(false,true,true);assert.equal(h.sessions[1].closed,1);assert.equal(h.time.pending,0);
});

test('button release follows the last batched movement without waiting for the timer', async () => {
  const h = control(); h.connection.start(); await drain(); h.sockets[0].ack();
  h.connection.move(2, 3); h.connection.send({t:'b',btn:'l',a:'down'});
  h.connection.move(8, 9); h.connection.send({t:'b',btn:'l',a:'up'});
  assert.deepEqual(h.sockets[0].sent, [
    {t:'m',dx:2,dy:3},{t:'b',btn:'l',a:'down'},
    {t:'m',dx:8,dy:9},{t:'b',btn:'l',a:'up'},
  ]);
  await h.time.advance(8);assert.equal(h.sockets[0].sent.length,4);h.connection.stop();
});

test('resumed video starts a fresh network baseline instead of replaying past congestion', () => {
  const { networkSample } = load('video.ts', { require: () => ({}) });
  const old = { packetsReceived: 1000, packetsLost: 100, jitterBufferDelay: 20, jitterBufferEmittedCount: 100 };
  assert.equal(networkSample(old).loss, 0);
  assert.equal(networkSample(old).delay, 0);
  const fresh = { packetsReceived: 1100, packetsLost: 100, jitterBufferDelay: 20.2, jitterBufferEmittedCount: 120 };
  const sample = networkSample(fresh, old);
  assert.equal(sample.loss, 0);
  assert.ok(Math.abs(sample.delay - .01) < 1e-10);
  const loss = networkSample({ ...fresh, packetsLost: 110 }, old);
  assert.ok(Math.abs(loss.loss - 10 / 110) < 1e-10);
  const reset = networkSample({ packetsReceived: 10, packetsLost: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0 }, fresh);
  assert.equal(reset.loss, 0);
  assert.equal(reset.delay, 0);
});
