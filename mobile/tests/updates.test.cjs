const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const exportsObject = {};
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/updates.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(code, { exports: exportsObject });
const { UpdateLifecycle } = exportsObject;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(overrides = {}) {
  const calls = { check: 0, download: 0, reload: 0 }, active = [];
  let time = 0;
  const app = new UpdateLifecycle({ enabled: true,
    check: async () => { calls.check++; return { isAvailable: true }; },
    download: async () => { calls.download++; return { isNew: true }; },
    reload: async () => { calls.reload++; }, ...overrides,
  }, value => active.push(value), () => time);
  return { app, calls, active, advance: ms => { time += ms; } };
}
test('download never interrupts control; applies once after a real background/foreground', async () => {
  const h = setup(); h.app.start('active'); await tick();
  assert.equal(h.calls.download, 1); assert.equal(h.calls.reload, 0);
  h.app.setAppState('inactive'); h.app.setAppState('active');
  assert.equal(h.calls.reload, 0); // Notification/permission overlay is not app exit.
  h.app.setAppState('background'); h.app.setAppState('active'); h.app.setAppState('active');
  assert.equal(h.calls.reload, 1); assert.equal(h.active.at(-1), false);
});
test('offline updates do not block control or spam the server on app switches', async () => {
  let checks = 0;
  const h = setup({ check: async () => { checks++; throw Error('offline'); } });
  h.app.start('active'); await tick();
  h.app.setAppState('background'); h.app.setAppState('active'); await tick();
  assert.equal(h.active.at(-1), true); assert.equal(checks, 1);
  h.advance(300000); h.app.setAppState('background'); h.app.setAppState('active'); await tick();
  assert.equal(checks, 2); assert.equal(h.calls.reload, 0);
});
test('does not start an update download while streaming, and retries when closing preview', async () => {
  const answer = deferred(); let checks = 0;
  const h = setup({ check: () => { checks++; return checks === 1 ? answer.promise : Promise.resolve({ isAvailable: true }); } });
  h.app.start('active'); h.app.setPreview(true);
  answer.resolve({ isAvailable: true }); await tick();
  assert.equal(h.calls.download, 0);
  h.app.setPreview(false); await tick();
  assert.equal(h.calls.download, 1); assert.equal(h.calls.reload, 0);
});
test('overlapping refreshes are coalesced and late results after unmount are ignored', async () => {
  const answer = deferred(); let checks = 0;
  const h = setup({ check: () => { checks++; return answer.promise; } });
  h.app.start('active'); void h.app.check(true); void h.app.check(true);
  assert.equal(checks, 1);
  h.app.dispose(); answer.resolve({ isAvailable: true }); await tick();
  assert.equal(h.calls.download, 0); assert.equal(h.calls.reload, 0);
});
test('rollback directives are downloaded and applied at the same safe boundary', async () => {
  const h = setup({ check: async () => ({ isRollBackToEmbedded: true }), download: async () => ({ isRollBackToEmbedded: true }) });
  h.app.start('active'); await tick(); assert.equal(h.calls.reload, 0);
  h.app.setAppState('background'); h.app.setAppState('active'); assert.equal(h.calls.reload, 1);
});
test('failed native reload restores control without a reload loop', async () => {
  let reloads = 0;
  const h = setup({ reload: async () => { reloads++; throw Error('reload failed'); } });
  h.app.start('active'); await tick();
  h.app.setAppState('background'); h.app.setAppState('active'); await tick();
  assert.equal(h.active.at(-1), true);
  h.app.setAppState('background'); h.app.setAppState('active'); await tick();
  assert.equal(reloads, 1);
});
test('Strict Mode effect cleanup/setup can resume without stale work taking over', async () => {
  const old = deferred(); let checks = 0;
  const h = setup({ check: () => ++checks === 1 ? old.promise : Promise.resolve({ isAvailable: false }) });
  h.app.start('active'); h.app.dispose(); h.app.start('active'); await tick();
  old.resolve({ isAvailable: true }); await tick();
  assert.equal(h.active.at(-1), true); assert.equal(h.calls.download, 0);
});
test('development builds never query the update service', async () => {
  const h = setup({ enabled: false }); h.app.start('active'); await tick();
  assert.equal(h.calls.check, 0); assert.equal(h.active.at(-1), true);
});
