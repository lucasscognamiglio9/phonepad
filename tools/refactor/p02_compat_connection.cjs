// P02.7B cross-version client used by compat_interop_test.go.
//
// The script deliberately loads the requested checkout's real Connection
// source.  It does not use the unit-test socket stubs: the Go test supplies a
// loopback HTTPS CA and this process opens the real fetch and WebSocket
// transports with an explicit session cookie.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');

const [origin, cookie, sourceRoot, mode] = process.argv.slice(2);
assert.match(origin, /^https:\/\/127\.0\.0\.1:\d+$/);
assert.match(cookie, /^__Host-phonepad=[^;]+$/);
assert.ok(fs.existsSync(path.join(sourceRoot, 'connection.ts')), `missing Connection at ${sourceRoot}`);
assert.ok(mode === 'stable-to-current' || mode === 'current-to-stable');

const mobile = path.resolve(__dirname, '../../mobile');
const fromMobile = createRequire(path.join(mobile, 'package.json'));
const ts = fromMobile('typescript');
const WS = fromMobile('ws');
const requests = [];

const request = async (url, options = {}) => {
  assert.equal(new URL(url).origin, origin);
  requests.push({url, options});
  const headers = {...(options.headers || {}), Cookie: cookie};
  return fetch(url, {...options, headers});
};

class CookieSocket extends WS {
  constructor(url) { super(url, {headers: {Cookie: cookie}}); }
}

const modules = new Map();
function load(name) {
  if (name.endsWith('.ts')) name = name.slice(0, -3);
  if (modules.has(name)) return modules.get(name);
  const exports = {};
  modules.set(name, exports);
  const file = path.join(sourceRoot, `${name}.ts`);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(code, {
    exports, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    WebSocket: CookieSocket, fetch: request, console, process,
    require: imported => {
      if (imported.startsWith('./')) return load(imported.slice(2));
      if (imported === 'buffer') return require('node:buffer');
      if (imported === 'expo-crypto') return {
        randomUUID: crypto.randomUUID,
        CryptoDigestAlgorithm: {SHA256: 'sha256'},
        digestStringAsync: async (_, text) => crypto.createHash('sha256').update(text).digest('hex'),
      };
      throw Error(`Unexpected module ${imported}`);
    },
  }, {filename: file});
  return exports;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, description) {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, description || 'compatibility condition timed out');
    await delay(10);
  }
}

const {Connection} = load('connection');
const states = [];
const connection = new Connection(origin, state => states.push(state));

(async () => {
  try {
    connection.start();
    await until(() => states.at(-1) === 'connected', 'initial cross-version hello timed out');

    connection.move(7, -3);
    await delay(40); // allow the production 8 ms movement coalescer to flush
    connection.click('l');
    await delay(100); // give the real server read loop time to route all edges

    connection.stop();
    connection.start();
    await until(() => states.filter(state => state === 'connected').length >= 2,
      'cross-version reconnect timed out');
    connection.move(-2, 5);
    await delay(40);
    connection.click('r');
    await delay(100);

    if (mode === 'current-to-stable') {
      // The old server has no P01A literal endpoint or advertised limits.  A
      // new client must keep the draft local and never synthesize scancodes.
      assert.ok(connection.literal, 'current client did not expose literal transfer');
      await assert.rejects(connection.literal.send('texto legado sin fallback'), /admite este envío/);
      assert.equal(requests.filter(request => request.url.endsWith('/api/input')).length, 0,
        'legacy server caused an automatic literal-to-scancode/API fallback');
    }

    connection.stop();
    console.log(`PASS: ${mode} real TLS/WS hello, movement/click, stop/reconnect without replay`);
  } finally {
    connection.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
