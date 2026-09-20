// Invoked by TestMobileSessionInterop against its private synthetic TLS host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const mobile = path.resolve(__dirname, '../../mobile');
const fromMobile = createRequire(path.join(mobile, 'package.json'));
const ts = fromMobile('typescript');
const WS = fromMobile('ws');
const [origin, cookie] = process.argv.slice(2);
assert.match(origin, /^https:\/\/127\.0\.0\.1:\d+$/);
const requests = [];
const request = async (url, options = {}) => {
  assert.equal(new URL(url).origin, origin);
  if (options.body) requests.push(JSON.parse(options.body));
  return fetch(url, {...options, headers: {...options.headers, Cookie: cookie}});
};
class CookieSocket extends WS {
  constructor(url) { super(url, {headers: {Cookie: cookie}}); }
}
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const exports = {};
  modules.set(name, exports);
  const code = ts.transpileModule(fs.readFileSync(path.join(mobile, 'src/lib', `${name}.ts`), 'utf8'), {
    fileName: `${name}.ts`, compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(code, {exports, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    WebSocket: CookieSocket, fetch: request, require: name => {
      if (name.startsWith('./')) return load(name.slice(2));
      if (name === 'buffer') return require('node:buffer');
      if (name === 'expo-crypto') return {randomUUID: crypto.randomUUID, CryptoDigestAlgorithm: {SHA256: 'sha256'},
        digestStringAsync: async (_, text) => crypto.createHash('sha256').update(text).digest('hex')};
      throw Error(`Unexpected module ${name}`);
    }}, {filename: `${name}.ts`});
  return exports;
}
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'session condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const {Connection} = load('connection');
const states = [];
const connection = new Connection(origin, state => states.push(state));
(async () => {
  try {
    connection.start();
    await until(() => states.at(-1) === 'connected');
    assert.equal(connection.capabilities.protocolVersion, 2);
    assert.equal(connection.canInput, true);
    const epoch = connection.capabilities.sessionEpoch;
    const receipt = await connection.literal.send('¿Pregunta_? 👨‍👩‍👧‍👦 e\u0301\r\n'.repeat(900));
    assert.equal(receipt.state, 'dispatched');
    assert.ok(requests.every(request => request.sessionEpoch === epoch));
    assert.ok(requests.filter(request => request.op === 'chunk').length > 1);
    const response = await request(origin + '/fixture/permission?revoke=1', {method: 'POST'});
    assert.equal(response.status, 204);
    await until(() => !connection.canInput);
    assert.equal(states.at(-1), 'connected');
    assert.equal(connection.canView, true);
    assert.equal(connection.send({t: 'k', a: 'special', key: 'Enter'}), false);
    assert.equal((await connection.literal.status()).state, 'dispatched');
    assert.equal(await connection.literal.reviewed(), true);
    assert.equal((await request(origin + '/fixture/permission', {method: 'POST'})).status, 204);
    await until(() => connection.canInput);
    assert.equal((await connection.literal.send('Texto después de reconectar')).state, 'dispatched');
    const lease = connection.literal.pending.manifest.session;
    connection.start();
    await until(() => states.at(-1) === 'connected' && connection.capabilities.sessionEpoch !== epoch);
    assert.equal((await connection.literal.status()).state, 'dispatched');
    assert.equal(requests.at(-1).session, lease);
    assert.equal(requests.at(-1).sessionEpoch, connection.capabilities.sessionEpoch);
    assert.equal(requests.filter(request => request.op === 'commit').length, 2);
    console.log('PASS: real TLS/WS hello, Unicode chunks, revocation, receipt recovery and reconnect without replay');
  } finally {
    connection.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
