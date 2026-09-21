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
  const layout = {}; vmRun(compile('components/keyboard-layout.ts'), { exports: layout });
  const jsx = (type, props) => {
    if (type === 'TextInput' && props?.ref && typeof props.ref === 'object') props.ref.current = { focus() {}, blur() {} };
    return { type, props };
  };
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': {
      Alert: { alert() {} }, Keyboard: { addListener: () => ({ remove() {} }) }, Platform: { OS: 'ios' },
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
  const exports = {}; vmRun(compile('components/native-keyboard.tsx'), { exports, require: name => modules[name], setTimeout, clearTimeout, setInterval, clearInterval });
  function render() { index = 0; tree = exports.NativeKeyboard(props); while (effects.length) effects.shift()(); }
  function nodes(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)]; }
  const find = (type, label) => nodes(tree).find(node => node.type === type && (!label || node.props.label === label));
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

function statusText(h) {
  return h.nodes(h.tree()).filter(node => node.type === 'Text').map(node => node.props.children)
    .find(value => typeof value === 'string' && (value.includes('Tecla') || value.includes('Resultado') || value.includes('Repetición'))) ?? '';
}

test('special action uses receipt states and never replays after uncertain result', () => {
  const h = harness();
  h.click('Teclas extra');
  h.click('Arriba');
  const operationId = h.sent[0].operationId;
  assert.equal(h.sent.length, 1);
  h.receipt(operationId, 'admitted');
  assert.match(statusText(h), /admitida/);
  h.receipt(operationId, 'uncertain');
  assert.match(statusText(h), /incierto/);
  assert.equal(h.sent.length, 1, 'uncertain receipt must not trigger a replay');
});

test('executed and rejected receipts remain distinct for separate actions', () => {
  const h = harness();
  h.click('Teclas extra'); h.click('Arriba');
  const first = h.sent[0].operationId;
  h.receipt(first, 'executed');
  assert.match(statusText(h), /ejecutada/);
  h.click('Derecha');
  const second = h.sent.at(-1).operationId;
  h.receipt(second, 'rejected');
  assert.match(statusText(h), /rechazada/);
});

test('arrow hold sends ordered repeats, cancels on release, and does not duplicate onPress', async () => {
  const h = harness();
  h.click('Teclas extra');
  const button = h.find('GlassButton', 'Arriba');
  button.props.onPressIn();
  await new Promise(resolve => setTimeout(resolve, 430));
  const beforeRelease = h.sent.filter(item => item.phase === 'repeat').length;
  assert.ok(beforeRelease > 0, 'hold should produce repeat frames after the initial delay');
  button.props.onPressOut();
  const afterCancel = h.sent.length;
  button.props.onPress();
  assert.equal(h.sent.length, afterCancel, 'release must suppress the trailing onPress');
  assert.equal(h.sent.filter(item => item.phase === 'cancel').length, 1);
  button.props.onPress();
  assert.equal(h.sent.filter(item => item.phase === 'press').length, 2, 'the next tap must remain available after a cancelled hold');
});

test('isolated onPress executes one action for accessibility activation', () => {
  const h = harness();
  h.click('Teclas extra');
  const button = h.find('GlassButton', 'Derecha');
  button.props.onPress();
  assert.equal(h.sent.filter(item => item.phase === 'press').length, 1);
});

test('rotation and input revocation cancel a held action without replay', () => {
  const h = harness();
  h.click('Teclas extra');
  const button = h.find('GlassButton', 'Arriba');
  button.props.onPressIn();
  const operationId = h.sent[0].operationId;
  h.resize({ width: 844, height: 390 }); h.render();
  assert.equal(h.sent.at(-1).a, 'cancel');
  h.props.connection.canInput = false; h.render();
  assert.equal(h.sent.filter(item => item.operationId === operationId && item.a === 'cancel').length, 1);
});

test('a late press receipt cannot overwrite a cancelled operation context', () => {
  const h = harness();
  h.click('Teclas extra');
  const button = h.find('GlassButton', 'Arriba');
  button.props.onPressIn();
  const operationId = h.sent[0].operationId;
  button.props.onPressOut();
  button.props.onPress();
  h.props.connection.inputCapabilities = { version: 1 };
  h.render();
  h.find('TextInput').props.onChangeText('contexto nuevo');
  h.render();
  h.receipt(operationId, 'cancelled', 'cancel');
  assert.equal(h.find('TextInput').props.value, 'contexto nuevo');
  h.receipt(operationId, 'executed', 'press');
  assert.equal(h.find('TextInput').props.value, 'contexto nuevo', 'late executed press must not clear a newer draft');
});

test('an after-cancel effect is visible without clearing the new draft or replaying', () => {
  const h = harness();
  h.click('Teclas extra');
  const button = h.find('GlassButton', 'Arriba');
  button.props.onPressIn();
  const operationId = h.sent[0].operationId;
  button.props.onPressOut();
  button.props.onPress();
  h.props.connection.inputCapabilities = { version: 1 };
  h.render();
  h.find('TextInput').props.onChangeText('contexto nuevo');
  h.render();
  h.receipt(operationId, 'cancelled', 'cancel');
  h.receipt(operationId, 'executed', 'press', 0, false, 'executed_after_cancel');
  assert.equal(h.find('TextInput').props.value, 'contexto nuevo');
  assert.match(statusText(h), /posiblemente ejecutada/);
  assert.equal(h.sent.filter(item => item.operationId === operationId && item.phase !== 'cancel').length, 1);
});
