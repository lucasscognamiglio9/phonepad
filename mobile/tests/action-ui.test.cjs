const controlFixture = require('./control-fixture.cjs');
const appearanceModule = require('./appearance-fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const compile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness() {
  const slots = [], effects = [], sent = [], receipts = new Map();
  const dimensions = { width: 390, height: 844 };
  const keyboard = { isVisible: false, height: 0 };
  let index = 0, tree, nextOperation = 1;
  const useRef = initial => { const at = index++; return slots[at] ??= { current: initial }; };
  const react = {
    useRef,
    useState(initial) { const at = index++; if (!(at in slots)) slots[at] = initial;
      return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }]; },
    useEffect(fn, deps) { const at = index++, old = slots[at];
      if (!old || deps.some((value, i) => value !== old[i])) { slots[at] = deps; effects.push(fn); } },
  };
  const protocol = {}; vmRun(compile('lib/protocol.ts'), { exports: protocol, setTimeout, clearTimeout, setInterval, clearInterval });
  const layout = {}; vmRun(compile('components/keyboard-layout.ts'), { exports: layout, require: () => appearanceModule });
  const jsx = (type, props) => {
    if (typeof type === 'function') return type(props);
    if (type === 'TextInput' && props?.ref && typeof props.ref === 'object') props.ref.current = { focus() {}, blur() {} };
    return { type, props };
  };
  const modules = { './appearance': appearanceModule, '../components/appearance': appearanceModule,
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': {
      Alert: { alert() {} }, Keyboard: { addListener: () => ({ remove() {} }) }, Platform: { OS: 'ios' }, Dimensions: {get:()=>dimensions},
      Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView', View: 'View',
      useWindowDimensions: () => dimensions,
    },
    'react-native-keyboard-controller': { KeyboardStickyView: 'KeyboardStickyView', useKeyboardState: selector => selector(keyboard) },
    'react-native-reanimated': { __esModule: true, default: { View: 'AnimatedView' }, ReduceMotion: { System: 'system' },
      useSharedValue: value => useRef({ value }).current, useAnimatedStyle: fn => fn(), withTiming: value => value },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 54, bottom: 34, left: 0, right: 0 }) },
    './glass-surface': { GlassSurface: 'GlassSurface' }, './glass-button': { GlassButton: 'GlassButton' },
    './action-menu': { ActionMenu: 'ActionMenu' }, './keyboard-layout': layout, '../lib/protocol': protocol,
  };
  const connection = {
    canInput: true, literal: { draft: '', pending: null, busy: false }, capabilities: null, inputCapabilities: null,
    send(command) { sent.push({ ...command, legacy: true }); return true; },
    pressAction(command) {
      const operationId = `op-test-${nextOperation++}`;
      sent.push({ ...command, operationId, phase: 'press', actionSequence: 1 });
      return operationId;
    },
    repeatAction(operationId) {
      const action = sent.find(item => item.operationId === operationId);
      if (!action) return false;
      const sequence = sent.filter(item => item.operationId === operationId && item.phase !== 'cancel').length + 1;
      sent.push({ ...action, phase: 'repeat', actionSequence: sequence });
      return true;
    },
    cancelAction(operationId) { sent.push({ t: 'k', a: 'cancel', operationId, phase: 'cancel' }); return true; },
    getActionReceipt(operationId) { return receipts.get(operationId) ?? null; },
  };
  const props = { connection, active: true, visible: true, disabled: false, choosing: false,
    open() {}, close() {}, choose() {} };
  controlFixture.install(modules, jsx);
  const exports = {}; vmRun(compile('components/native-keyboard.tsx'), { exports, require: name => modules[name], setTimeout, clearTimeout, setInterval, clearInterval });
  function render() { index = 0; tree = exports.NativeKeyboard(props); while (effects.length) effects.shift()(); }
  function nodes(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)]; }
  const find = (type, label) => controlFixture.find(nodes,tree,type,label);
  const click = label => { const button = find('GlassButton', label); assert.ok(button, label); button.props.onPress(); render(); };
  const receipt = (operationId, state, phase = 'press', repeatCount = 0, replayed = false, detail = '') => {
    receipts.set(operationId, { t: 'receipt', operationId, state, phase, repeatCount,
      ...(replayed ? { replayed: true } : {}), ...(detail ? { detail } : {}) });
    render(); render();
  };
  render();
  return { props, connection, sent, render, find, click, receipt, resize: value => Object.assign(dimensions, value), nodes, tree: () => tree };
}

function vmRun(code, context) {
  const vm = require('node:vm');
  vm.runInNewContext(code, context);
}

test('native Backspace repetition targets the host once per key event and stops after revocation', () => {
  const h=harness();h.connection.capabilities={protocolVersion:2};h.render();
  for(let i=0;i<5;i++){h.find('TextInput').props.onKeyPress({nativeEvent:{key:'Backspace'}});h.render();}
  assert.equal(h.sent.length,5);assert.ok(h.sent.every(c=>c.phase==='press'&&c.key==='Backspace'));
  h.props.disabled=true;h.render();const count=h.sent.length;
  h.find('TextInput').props.onKeyPress({nativeEvent:{key:'Backspace'}});assert.equal(h.sent.length,count);
});

test('iPhone Backspace targets the remote field only when the composer is empty', () => {
  const h = harness(); h.connection.capabilities = {protocolVersion: 2}; h.render();
  h.find('TextInput').props.onKeyPress({nativeEvent:{key:'Backspace'}});
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].key, 'Backspace');
  h.find('TextInput').props.onChangeText('a'); h.render();
  const previous = h.find('TextInput');
  previous.props.onKeyPress({nativeEvent:{key:'Backspace'}});
  previous.props.onChangeText('');
  previous.props.onKeyPress({nativeEvent:{key:'Backspace'}});
  assert.equal(h.sent.length, 1, 'a local deletion must never also delete remote text');
});

function statusText(h) {
  return h.nodes(h.tree()).filter(node => node.type === 'Text').map(node => node.props.children)
    .find(value => typeof value === 'string' && (value.toLowerCase().includes('tecla') || value.includes('Resultado') || value.includes('Repetición'))) ?? '';
}

test('special action uses receipt states and never replays after uncertain result', () => {
  const h = harness();

  h.click('Teclas extra');h.click('Tab');
  const operationId = h.sent[0].operationId;
  assert.equal(h.sent.length, 1);
  h.receipt(operationId, 'admitted');
  assert.equal(statusText(h), '');
  h.receipt(operationId, 'uncertain');
  assert.equal(statusText(h), ''); h.click('Revisar envío');
  assert.match(statusText(h), /sin confirmar/);
  assert.equal(h.sent.length, 1, 'uncertain receipt must not trigger a replay');
});

test('executed and rejected receipts remain distinct for separate actions', () => {
  const h = harness();
   h.click('Teclas extra');h.click('Tab');
  const first = h.sent[0].operationId;
  h.receipt(first, 'executed');
  assert.equal(statusText(h), '');
  h.click('Esc');
  const second = h.sent.at(-1).operationId;
  h.receipt(second, 'rejected');
  assert.equal(statusText(h), ''); h.click('Revisar envío');
  assert.match(statusText(h), /rechazada/);
});

test('toolbar navigation has no held actions or repeat timers', t => {
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const h=harness();h.click('Teclas extra');h.click('Tab');
 t.mock.timers.tick(1000);assert.equal(h.sent.length,1);
 assert.equal(h.find('GlassButton','Arriba'),undefined);assert.equal(h.find('GlassButton','Borrar'),undefined);
});

test('isolated onPress executes one action for accessibility activation', () => {
  const h = harness();

  h.click('Teclas extra');const button = h.find('GlassButton', 'Esc');
  button.props.onPress();
  assert.equal(h.sent.filter(item => item.phase === 'press').length, 1);
});

test('a late cancelled or executed receipt preserves a newer local draft',()=>{
 const h=harness();h.click('Teclas extra');h.click('Tab');
 const operation=h.sent[0].operationId;h.connection.inputCapabilities={version:1};h.render();
 h.find('TextInput').props.onChangeText('contexto nuevo');h.render();
 h.receipt(operation,'cancelled','cancel');h.receipt(operation,'executed');
 assert.equal(h.find('TextInput').props.value,'contexto nuevo');assert.equal(h.sent.length,1);
});

test('action errors disappear without restarting the composer',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness();h.click('Teclas extra');h.click('Tab');
 h.receipt(h.sent[0].operationId,'rejected');assert.equal(statusText(h),'');h.click('Revisar envío');assert.match(statusText(h),/rechazada/);
 t.mock.timers.tick(5000);h.render();assert.equal(statusText(h),'');assert.ok(h.find('TextInput'));
});

test('an ordinary navigation receipt cannot erase a draft typed after the key was pressed',()=>{
 const h=harness();h.props.connection.inputCapabilities={version:1};h.click('Teclas extra');h.click('Tab');const operation=h.sent[0].operationId;
 h.find('TextInput').props.onChangeText('nuevo borrador');h.render();h.receipt(operation,'executed');assert.equal(h.find('TextInput').props.value,'nuevo borrador');
});
