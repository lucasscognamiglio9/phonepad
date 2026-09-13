const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function harness() {
  const slots = [], effects = [], sent = [], chosen = [], keyboardListeners = {}; let index = 0, tree, accepted = true;
  const dimensions = { width: 390, height: 844 };
  const keyboardHeight = { value: 0 };
  const measurement = { x: 24, y: 720, width: 44, height: 44 };
  const useRef = initial => { const at = index++; return slots[at] ??= { current: initial }; };
  const react = {
    useRef,
    useState(initial) { const at = index++; if (!(at in slots)) slots[at] = initial;
      return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }]; },
    useEffect(fn, deps) { const at = index++, old = slots[at];
      if (!old || deps.some((d, i) => d !== old[i])) { slots[at] = deps; effects.push(fn); } },
  };
  const protocol = {}; vm.runInNewContext(compile('lib/protocol.ts'), { exports: protocol });
  const jsx = (type, props) => {
    if (type === 'View' && props?.ref && typeof props.ref === 'object') {
      props.ref.current = { measureInWindow: callback => callback(
        measurement.x, measurement.y, measurement.width, measurement.height,
      ) };
    }
    return { type, props };
  };
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': {
      Keyboard: { addListener: (event, callback) => {
        (keyboardListeners[event] ??= []).push(callback);
        return { remove: () => { keyboardListeners[event] = (keyboardListeners[event] ?? []).filter(item => item !== callback); } };
      } },
      Platform: { OS: 'ios' },
      TextInput: 'TextInput', ScrollView: 'ScrollView',
      View: 'View',
      useWindowDimensions: () => dimensions,
    },
    'react-native-keyboard-controller': { useReanimatedKeyboardAnimation: () => ({ height: keyboardHeight }) },
    'react-native-reanimated': { __esModule: true, default: { View: 'AnimatedView' }, ReduceMotion: { System: 'system' },
      useSharedValue: v => useRef({ value: v }).current, useAnimatedStyle: fn => fn(), withTiming: v => v },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 54, bottom: 34, left: 0, right: 0 }) },
    './glass-surface': { GlassSurface: 'GlassSurface' }, './glass-button': { GlassButton: 'GlassButton' },
    './action-menu': { ActionMenu: 'ActionMenu' }, '../lib/protocol': protocol,
  };
  const exports = {}; vm.runInNewContext(compile('components/native-keyboard.tsx'), { exports, require: name => modules[name] });
  const props = { connection: { send: c => { sent.push(JSON.parse(JSON.stringify(c))); return accepted; } },
    active: false, disabled: false, choosing: false, open: () => { props.active = true; }, close: () => { props.active = false; }, choose: action => chosen.push(action) };
  function render() { index = 0; tree = exports.NativeKeyboard(props); while (effects.length) effects.shift()(); }
  function nodes(node) { if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
  const find = (type, label) => nodes(tree).find(n => n.type === type && (!label || n.props.label === label));
  const click = label => { const node = find('GlassButton', label); assert.ok(node, label); node.props.onPress(); render(); };
  const type = value => { find('TextInput').props.onChangeText(value); render(); };
  render(); render();
  return {
    props, sent, chosen, keyboardHeight, render, tree: () => tree, nodes, find, click, type,
    keyboard: (event, payload = {}) => (keyboardListeners[event] ?? []).forEach(callback => callback(payload)),
    measure: next => Object.assign(measurement, next),
    resize: next => Object.assign(dimensions, next),
    reject: () => { accepted = false; },
  };
}
test('compact field expands on focus without swapping the native input; arrows stay inside extras', () => {
  const h = harness(), initial = h.find('TextInput'); assert.equal(initial.props.multiline, true);
  assert.equal(h.find('GlassButton', 'Arriba'), undefined);
  initial.props.onFocus(); h.render(); h.render();
  assert.equal(h.props.active, true); assert.equal(h.find('TextInput').type, initial.type);
  assert.equal(h.find('GlassButton', 'Arriba'), undefined);
  h.click('Teclas extra'); assert.ok(h.find('GlassButton', 'Arriba')); assert.ok(h.find('GlassButton', 'Enter'));
  h.click('Teclas extra'); assert.equal(h.find('GlassButton', 'Arriba'), undefined);
});
test('the collapsed composer keeps plus and Enter inside the field', () => {
  const h = harness();
  const input = h.find('TextInput');
  assert.ok(h.find('GlassButton', 'Agregar'));
  assert.ok(h.find('GlassButton', 'Enter'));
  assert.equal(input.props.style.paddingHorizontal, 44);
  assert.equal(input.props.style.paddingTop, 11);
  assert.equal(input.props.style.paddingBottom, 11);
  assert.equal(input.props.style.textAlignVertical, 'center');
  const actionBar = h.nodes(h.tree()).find(node => node.type === 'View' && node.props.style?.position === 'absolute' && node.props.style?.height === 44);
  assert.equal(actionBar.props.pointerEvents, 'box-none', 'the gap between icons must let a tap focus the native input beneath it');
  assert.equal(h.find('ActionMenu').props.anchor, null);
});
test('expanded composer keeps text above a fixed bottom action bar', () => {
  const h = harness(); h.props.active = true; h.render();
  const input = h.find('TextInput');
  assert.equal(input.props.style.paddingHorizontal, 12);
  assert.equal(input.props.style.paddingTop, 10);
  assert.equal(input.props.style.paddingBottom, 8);
  assert.equal(input.props.style.textAlignVertical, 'top');
  assert.ok(h.nodes(h.tree()).some(node => node.type === 'View' && node.props.style?.bottom === 0 && node.props.style?.height === 44));
});
test('the plus wrapper is measured for the mounted action menu', () => {
  const h = harness();
  const original = h.find('TextInput');
  h.click('Agregar');
  const menu = h.find('ActionMenu');
  assert.equal(menu.props.anchor.x, 24);
  assert.equal(menu.props.anchor.y, 720);
  assert.equal(menu.props.anchor.width, 44);
  assert.equal(menu.props.anchor.height, 44);
  assert.equal(typeof menu.props.close, 'function');
  assert.equal(typeof menu.props.choose, 'function');
  assert.equal(typeof menu.props.onDismiss, 'function');
  assert.equal(h.find('TextInput').type, original.type);
});
test('the open menu follows composer layout, keyboard frame, and orientation changes', () => {
  const h = harness();
  h.click('Agregar');
  const wrapper = h.nodes(h.tree()).find(node => node.type === 'View' && node.props.ref);
  assert.ok(wrapper?.props.onLayout);

  h.measure({ y: 610 });
  wrapper.props.onLayout();
  h.render();
  assert.equal(h.find('ActionMenu').props.anchor.y, 610);

  h.measure({ y: 286 });
  h.keyboard('keyboardDidChangeFrame', { endCoordinates: { screenY: 260 } });
  h.render();
  assert.equal(h.find('ActionMenu').props.anchor.y, 286);

  h.resize({ width: 844, height: 390 });
  h.measure({ y: 172 });
  wrapper.props.onLayout();
  h.render();
  assert.equal(h.find('ActionMenu').props.anchor.y, 172);
  assert.equal(h.find('TextInput').type, 'TextInput');
});
test('menu dismissal preserves an active composer and attachments close it after dismissal', () => {
  const h = harness(); h.props.active = true; h.render();
  h.click('Agregar');
  const menu = h.find('ActionMenu');
  h.find('TextInput').props.onBlur(); h.render();
  assert.equal(h.props.active, true);
  menu.props.choose('files'); menu.props.onDismiss(); h.render();
  assert.deepEqual(h.chosen, ['files']);
  assert.equal(h.props.active, false);
});
test('text reaches the laptop immediately, and Enter never sends it twice', () => {
  const h = harness(); h.props.active = true; h.render(); h.type('hola 👋');
  assert.deepEqual(h.sent, [{ t: 'k', a: 'text', text: 'hola 👋' }]);
  h.click('Enter'); assert.deepEqual(h.sent.at(-1), { t: 'k', a: 'special', key: 'Enter' });
  assert.equal(h.find('TextInput').props.value, ''); assert.equal(h.sent.length, 2);
});
test('navigation resets reconciliation so subsequent typing does not erase remote text', () => {
  const h = harness(); h.props.active = true; h.render(); h.type('abc'); h.click('Teclas extra'); h.click('Izquierda'); h.type('X');
  assert.deepEqual(h.sent, [{ t: 'k', a: 'text', text: 'abc' }, { t: 'k', a: 'special', key: 'ArrowLeft' }, { t: 'k', a: 'text', text: 'X' }]);
});
test('modifier plus typed letter sends a shortcut, not literal text', () => {
  const h = harness(); h.props.active = true; h.render(); h.click('Teclas extra'); h.click('Ctrl'); h.type('c');
  assert.deepEqual(h.sent, [{ t: 'k', a: 'combo', mods: ['ctrl'], key: 'c' }]);
  assert.equal(h.find('TextInput').props.value, '');
});
test('closing clears local context without deleting remote text, and the plus remains in the field', () => {
  const h = harness(); h.props.active = true; h.render(); h.type('hola'); h.find('TextInput').props.onBlur(); h.render(); h.render();
  assert.equal(h.find('TextInput').props.value, ''); assert.equal(h.sent.length, 1);
  h.click('Agregar'); assert.ok(h.find('ActionMenu'));
});

test('immersive mode hides the field and any popup without deleting remote text', () => {
  const h = harness(); h.props.active = true; h.render(); h.type('texto'); h.click('Agregar');
  h.props.visible = false; h.render(); h.render();
  assert.equal(h.tree().props.pointerEvents, 'none');
  assert.equal(h.tree().props.style.display, 'none');
  assert.equal(h.find('ActionMenu').props.anchor, null);
  assert.equal(h.find('TextInput').props.value, '');
  h.props.active = false; h.render();
  h.find('TextInput').props.onFocus();
  assert.equal(h.props.active, false, 'late focus must not reopen the hidden keyboard after rotation');
  h.find('ActionMenu').props.choose('keyboard');
  h.find('ActionMenu').props.onDismiss();
  assert.equal(h.props.active, false);
  assert.deepEqual(h.sent, [{ t: 'k', a: 'text', text: 'texto' }]);
  h.props.visible = true; h.render();
  assert.equal(h.tree().props.style.display, 'flex');
  assert.ok(h.find('TextInput'));
});


test('stale keyboard height is explicitly zeroed for closed and rotated composers', () => {
  const h = harness();
  const transform = () => h.find('AnimatedView').props.style[1].transform[0].translateY;
  h.props.active = true; h.keyboardHeight.value = -336; h.render();
  assert.equal(transform(), -336);
  h.props.active = false; h.render();
  assert.equal(transform(), 0, 'the native hide event may never arrive');
  h.resize({ width: 844, height: 390 }); h.props.visible = false; h.render();
  assert.equal(transform(), 0);
  h.resize({ width: 390, height: 844 }); h.props.visible = true; h.render();
  assert.equal(transform(), 0);
  h.props.active = true; h.keyboardHeight.value = -280; h.render();
  assert.equal(transform(), -280);
  h.props.disabled = true; h.render(); assert.equal(transform(), 0);
});

test('phone Return adds a line; only composer Enter submits even with a modifier armed', () => {
  const h = harness(); h.props.active = true; h.render();
  assert.equal(h.find('TextInput').props.submitBehavior, 'newline');
  assert.equal(h.find('TextInput').props.onSubmitEditing, undefined);
  h.type('hola'); h.type('hola\n'); h.type('hola\nmundo');
  assert.deepEqual(h.sent, [
    { t: 'k', a: 'text', text: 'hola' },
    { t: 'k', a: 'combo', mods: ['shift'], key: 'Enter' },
    { t: 'k', a: 'text', text: 'mundo' },
  ]);
  h.click('Teclas extra'); h.click('Shift'); h.click('Enter');
  assert.deepEqual(h.sent.at(-1), { t: 'k', a: 'special', key: 'Enter' });
});

test('every displayed shortcut sends the intended command and clears one-shot modifiers', () => {
  const h = harness(); h.props.active = true; h.render(); h.click('Teclas extra');
  for (const [label, key] of [['Esc','Escape'],['Tab','Tab'],['Arriba','ArrowUp'],['Abajo','ArrowDown'],['Izquierda','ArrowLeft'],['Derecha','ArrowRight']]) {
    h.click(label); assert.deepEqual(h.sent.at(-1), { t:'k', a:'special', key });
    h.click('Shift'); h.click(label);
    assert.deepEqual(h.sent.at(-1), { t:'k', a:'combo', mods:['shift'], key });
    assert.equal(h.find('GlassButton', 'Shift').props.selected, false);
  }
  for (const label of ['Ctrl','Alt','Super','Shift']) {
    h.click(label); h.type('a');
    assert.deepEqual(h.sent.at(-1), { t:'k', a:'combo', mods:[label.toLowerCase()], key:'a' });
  }
  for (const [label,key] of [['Copiar','c'],['Pegar','v']]) {
    assert.equal(h.find('GlassButton', label).props.symbol, undefined, 'clipboard actions have visible text');
    h.click(label); assert.deepEqual(h.sent.at(-1), { t:'k', a:'combo', mods:['ctrl'], key });
  }
});
