const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const tick = () => new Promise(resolve => setImmediate(resolve));
function hello(overrides = {}) {
  return {t:'ok', protocolVersion:2, compatibleVersions:[1,2], sessionEpoch:'fixture-epoch', capabilityRevision:1,
    roles:['viewer','controller'], permissions:{view:{state:'granted'},input:{state:'granted'},files:{state:'granted'},clipboard:{state:'granted'}},
    capabilities:{input:{state:'available',actions:['m','b','s','k','g','t'],effective:true},literal:{state:'unsupported'},video:{state:'unknown'}},
    source:{state:'unavailable'}, geometry:{state:'unavailable',geometryEpoch:null}, ...overrides};
}
function harness() {
  const sockets = [], changes = [], clock = {value: Date.now()};
  class Socket {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.({code:1000}); }
    receive(value) { this.onmessage({data:JSON.stringify(value)}); }
  }
  function load(name) {
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib', name + '.ts'), 'utf8'), {
      fileName: name + '.ts', compilerOptions: {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022},
    }).outputText;
    vm.runInNewContext(code, {exports, require: child => child.startsWith('./') ? load(child.slice(2)) : child === 'buffer' ? require('buffer') : {},
      Date:class extends Date {static now(){return clock.value;}}, URL, AbortController, WebSocket:Socket, setTimeout, clearTimeout, setInterval, clearInterval, fetch:async()=>({status:204})});
    return exports;
  }
  const {Connection} = load('connection');
  const connection = new Connection('https://test.example', () => {}, () => changes.push(true));
  return {connection, sockets, changes, advance:ms=>clock.value+=ms, async start(message = hello()) {
    connection.start(); await tick(); sockets.at(-1).receive(message); return sockets.at(-1);
  }};
}

test('receipt-aware actions carry ordered identity and resolve provider receipts', async () => {
  const h = harness();
  try {
    const ws = await h.start();
    const operationId = h.connection.pressAction({t:'k', a:'special', key:'Enter'}, true);
    assert.match(operationId, /^op-[A-Za-z0-9_-]+$/);
    assert.deepEqual(ws.sent[0], {t:'k', a:'special', key:'Enter', operationId,
      phase:'press', actionSequence:1, sessionEpoch:'fixture-epoch'});
    assert.equal(h.connection.repeatAction(operationId), true);
    assert.equal(ws.sent[1].phase, 'repeat');
    assert.equal(ws.sent[1].actionSequence, 2);
    const waiting = h.connection.waitActionReceipt(operationId);
    ws.receive({t:'receipt', operationId, phase:'repeat', state:'executed', repeatCount:1,
      detail:'uinput_keypress_complete', sessionEpoch:'fixture-epoch'});
    assert.equal((await waiting).state, 'executed');
    assert.equal(h.connection.getActionReceipt(operationId).repeatCount, 1);
    assert.equal(h.connection.repeatAction(operationId), true);
  } finally { h.connection.stop(); }
});

test('clipboard actions wait for execution, not mere admission', async () => {
  const h = harness();
  try {
    const ws = await h.start();
    const id = h.connection.pressAction({t:'k', a:'combo', mods:['ctrl'], key:'c'});
    let settled = false;
    const finished = h.connection.waitFinalActionReceipt(id).then(receipt => { settled = true; return receipt; });
    ws.receive({t:'receipt', operationId:id, phase:'press', state:'admitted', repeatCount:0, sessionEpoch:'fixture-epoch'});
    await tick();
    assert.equal(settled, false);
    ws.receive({t:'receipt', operationId:id, phase:'press', state:'executed', repeatCount:0, sessionEpoch:'fixture-epoch'});
    assert.equal((await finished).state, 'executed');
  } finally { h.connection.stop(); }
});

test('cancel remains sendable after input revocation and stops local repeats', async () => {
  const h = harness();
  try {
    const ws = await h.start();
    const operationId = h.connection.pressAction({t:'k', a:'combo', mods:['ctrl'], key:'c'});
    const revoked = hello({t:'capabilities', capabilityRevision:2});
    revoked.permissions.input = {state:'revoked'};
    revoked.capabilities.input = {state:'unavailable', actions:[], effective:false};
    ws.receive(revoked);
    assert.equal(h.connection.repeatAction(operationId), false);
    assert.equal(h.connection.cancelAction(operationId), true);
    const cancel = ws.sent.at(-1);
    assert.deepEqual(cancel, {t:'k', a:'cancel', operationId, phase:'cancel', sessionEpoch:'fixture-epoch'});
    ws.receive({t:'receipt', operationId, phase:'cancel', state:'cancelled', repeatCount:0,
      detail:'repeat_stopped_after_uncertain', sessionEpoch:'fixture-epoch'});
    assert.equal(h.connection.getActionReceipt(operationId).state, 'cancelled');
  } finally { h.connection.stop(); }
});

test('malformed or stale receipts never become local success', async () => {
  const h = harness();
  try {
    const ws = await h.start();
    const operationId = h.connection.pressAction({t:'k', a:'special', key:'Escape'});
    ws.receive({t:'receipt', operationId, phase:'press', state:'executed', repeatCount:-1, sessionEpoch:'fixture-epoch'});
    ws.receive({t:'receipt', operationId, phase:'press', state:'executed', repeatCount:0, sessionEpoch:'other-epoch'});
    assert.equal(h.connection.getActionReceipt(operationId), null);
  } finally { h.connection.stop(); }
});

test('disconnect clears action receipts and never replays an old operation', async () => {
  const h = harness();
  const ws = await h.start();
  const operationId = h.connection.pressAction({t:'k', a:'special', key:'ArrowLeft'});
  ws.receive({t:'receipt', operationId, phase:'press', state:'executed', repeatCount:0,
    detail:'uinput_keypress_complete', sessionEpoch:'fixture-epoch'});
  assert.equal(h.connection.getActionReceipt(operationId).state, 'executed');

  h.connection.stop();
  assert.equal(h.connection.getActionReceipt(operationId), null);
  assert.equal(await h.connection.waitActionReceipt(operationId, 0), null);
  assert.equal(h.connection.repeatAction(operationId), false);
  assert.equal(h.connection.cancelAction(operationId), false);

  const fresh = await h.start();
  assert.deepEqual(fresh.sent, []);
  h.connection.stop();
});

test('thousands of executed one-shot arrows release admission capacity for paste without reconnecting', async () => {
 const h=harness();
 try {
  const ws=await h.start();
  for(let i=0;i<1500;i++){
   const id=h.connection.pressAction({t:'k',a:'special',key:i%2?'ArrowLeft':'ArrowRight'});
   assert.ok(id,`navigation action ${i} must be admitted`);
   ws.receive({t:'receipt',operationId:id,phase:'press',state:'admitted',repeatCount:0,sessionEpoch:'fixture-epoch'});
   ws.receive({t:'receipt',operationId:id,phase:'press',state:'executed',repeatCount:0,sessionEpoch:'fixture-epoch'});
  }
  const paste=h.connection.pressAction({t:'k',a:'combo',mods:['ctrl'],key:'v'});
  assert.ok(paste);
  const completion=h.connection.waitFinalActionReceipt(paste);
  ws.receive({t:'receipt',operationId:paste,phase:'press',state:'executed',repeatCount:0,sessionEpoch:'fixture-epoch'});
  assert.equal((await completion).state,'executed');
  assert.equal(h.connection.repeatAction(paste),false);
  assert.equal(ws.sent.length,1501);
 } finally {h.connection.stop();}
});

test('unconfirmed actions keep the admission bound and rejection releases a slot without replay',async()=>{
 const h=harness();
 try{
  const ws=await h.start(),ids=[];
  for(let i=0;i<256;i++)ids.push(h.connection.pressAction({t:'k',a:'special',key:'ArrowRight'}));
  assert.ok(ids.every(Boolean));assert.equal(h.connection.pressAction({t:'k',a:'special',key:'Enter'}),null);
  ws.receive({t:'receipt',operationId:ids[0],phase:'press',state:'rejected',repeatCount:0,sessionEpoch:'fixture-epoch'});
  assert.ok(h.connection.pressAction({t:'k',a:'combo',mods:['ctrl'],key:'v'}));
  assert.equal(ws.sent.length,257);
 }finally{h.connection.stop();}
});

test('lost one-shot receipts expire local tracking without claiming execution or resending',async()=>{
 const h=harness();
 try{
  const ws=await h.start(),ids=[];
  for(let i=0;i<256;i++)ids.push(h.connection.pressAction({t:'k',a:'special',key:'ArrowRight'}));
  h.advance(5001);
  assert.ok(h.connection.pressAction({t:'k',a:'combo',mods:['ctrl'],key:'v'}));
  assert.equal(h.connection.getActionReceipt(ids[0]),null);
  assert.equal(h.connection.repeatAction(ids[0]),false);assert.equal(ws.sent.length,257);
 }finally{h.connection.stop();}
});
