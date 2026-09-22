const appearanceModule = require('./appearance-fixture.cjs');
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
  const alerts = [];
  const slots = [], effects = [], sent = [], chosen = [], keyboardListeners = {}; let index = 0, tree, accepted = true, rejectAfter = Infinity;
  const focusCount = { value: 0 };
  const dimensions = { width: 390, height: 844 };
  const keyboardState = { isVisible: false, height: 0 };
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
  const keyboardLayout = {}; vm.runInNewContext(compile('components/keyboard-layout.ts'), { exports: keyboardLayout, require: () => appearanceModule });
  const jsx = (type, props) => {
    if (type === 'View' && props?.ref && typeof props.ref === 'object') {
      props.ref.current = { measureInWindow: callback => callback(
        measurement.x, measurement.y, measurement.width, measurement.height,
      ) };
    }
    if (type === 'TextInput' && props?.ref && typeof props.ref === 'object') {
      props.ref.current = { focus: () => { focusCount.value += 1; }, blur: () => {} };
    }
    return { type, props };
  };
  const modules = { './appearance': appearanceModule, '../components/appearance': appearanceModule,
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': {
      Alert: { alert: (...args) => alerts.push(args) },
      Keyboard: { addListener: (event, callback) => {
        (keyboardListeners[event] ??= []).push(callback);
        return { remove: () => { keyboardListeners[event] = (keyboardListeners[event] ?? []).filter(item => item !== callback); } };
      } },
      Platform: { OS: 'ios' },
      Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView',
      View: 'View',
      useWindowDimensions: () => dimensions,
    },
    'react-native-keyboard-controller': {
      KeyboardStickyView: 'KeyboardStickyView',
      useKeyboardState: selector => selector(keyboardState),
    },
    'react-native-reanimated': { __esModule: true, default: { View: 'AnimatedView' }, ReduceMotion: { System: 'system' },
      useSharedValue: v => useRef({ value: v }).current, useAnimatedStyle: fn => fn(), withTiming: v => v },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 54, bottom: 34, left: 0, right: 0 }) },
    './glass-surface': { GlassSurface: 'GlassSurface' }, './glass-button': { GlassButton: 'GlassButton' },
    './action-menu': { ActionMenu: 'ActionMenu' }, './keyboard-layout': keyboardLayout, '../lib/protocol': protocol,
  };
  const exports = {}; vm.runInNewContext(compile('components/native-keyboard.tsx'), { exports, require: name => modules[name] });
  const props = { connection: { send: c => { sent.push(JSON.parse(JSON.stringify(c))); return accepted && sent.length <= rejectAfter; } },
    active: false, disabled: false, choosing: false, open: () => { props.active = true; }, close: () => { props.active = false; }, choose: action => chosen.push(action) };
  function render() { index = 0; tree = exports.NativeKeyboard(props); while (effects.length) effects.shift()(); }
  function nodes(node) { if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
  const find = (type, label) => nodes(tree).find(n => n.type === type && (!label || n.props.label === label));
  const click = label => { const node = find('GlassButton', label); assert.ok(node, label); node.props.onPress(); render(); };
  const type = value => { find('TextInput').props.onChangeText(value); render(); };
  render(); render();
  return {
    props, sent, chosen, alerts, focusCount: () => focusCount.value, keyboardState, render, tree: () => tree, nodes, find, click, type,
    keyboard: (event, payload = {}) => (keyboardListeners[event] ?? []).forEach(callback => callback(payload)),
    measure: next => Object.assign(measurement, next),
    resize: next => Object.assign(dimensions, next),
    reject: () => { accepted = false; },
    accept: () => { accepted = true; rejectAfter = Infinity; },
    rejectAfter: count => { rejectAfter = count; },
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
test('the collapsed composer keeps plus, shortcuts and the send symbol inside the field', () => {
  const h = harness();
  const input = h.find('TextInput');
  assert.ok(h.find('GlassButton', 'Agregar'));
  assert.ok(h.find('GlassButton', 'Enter'));
  assert.ok(h.find('GlassButton', 'Teclas extra'));
  assert.equal(h.find('GlassButton','Enter').props.action,'send');
  assert.equal(input.props.style.marginLeft, 44);
  assert.equal(input.props.style.paddingVertical, 11);
  assert.equal(input.props.style.height, 44);
  assert.equal(input.props.style.textAlignVertical, 'center');
  const actionBar = h.nodes(h.tree()).find(node => node.type === 'View' && node.props.style?.position === 'absolute' && node.props.style?.height === 44);
  assert.equal(actionBar.props.pointerEvents, 'box-none', 'the gap between icons must let a tap focus the native input beneath it');
  assert.equal(h.find('ActionMenu').props.anchor, null);
});
test('expanded composer keeps placeholder and actions on one row', () => {
  const h = harness(); h.props.active = true; h.render();
  const input = h.find('TextInput');
  assert.ok(h.find('GlassButton', 'Teclas extra'));
  assert.equal(h.find('GlassButton','Enter').props.action,'send');
  assert.equal(input.props.style.marginLeft, 44);
  assert.equal(input.props.style.paddingVertical, 11);
  assert.equal(input.props.style.height, 44);
  assert.equal(input.props.style.textAlignVertical, 'center');
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


test('keyboard sticky state follows visibility, rotation and disabled composer state', () => {
  const h = harness();
  const sticky = () => h.find('KeyboardStickyView');
  assert.equal(sticky().props.enabled, false);
  h.props.active = true; h.keyboardState.isVisible = true; h.keyboardState.height = 336; h.render();
  assert.equal(sticky().props.enabled, true);
  assert.equal(sticky().props.offset.closed, 0);
  assert.ok(sticky().props.offset.opened > 0);
  h.props.active = false; h.render();
  assert.equal(sticky().props.enabled, false, 'closing must disable stale native keyboard movement');
  h.resize({ width: 844, height: 390 }); h.props.visible = false; h.render();
  assert.equal(sticky().props.enabled, false);
  h.resize({ width: 390, height: 844 }); h.props.visible = true; h.props.active = true; h.render();
  assert.equal(sticky().props.enabled, true);
  h.props.disabled = true; h.render();
  assert.equal(sticky().props.enabled, false, 'disabled input must not follow the keyboard');
});

test('composer uses residual keyboard overlap when Android resizes before visibility state', () => {
  const h = harness();
  h.props.active = true; h.render();
  const sticky = () => h.find('KeyboardStickyView');
  const closedBottom = 46;
  assert.equal(sticky().props.offset.opened, closedBottom - 8);

  h.resize({ height: 508 }); h.render();
  h.keyboardState.isVisible = true; h.keyboardState.height = 336; h.render();
  assert.equal(sticky().props.offset.opened, closedBottom - 8 + 336, 'sticky cancels the root resize before applying its gap');
  assert.ok(h.find('TextInput').props.style.height <= 508, 'editor budget follows the resized viewport');

  h.props.active = false; h.render();
  h.resize({ height: 844 }); h.render();
  h.props.active = true; h.keyboardState.isVisible = true; h.keyboardState.height = 336; h.render();
  assert.equal(sticky().props.offset.opened, closedBottom - 8, 'full-window mode uses only the keyboard overlap');
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


test('rejected navigation, clipboard and Enter preserve the draft without retry on reconnect', () => {
  for (const action of ['Arriba', 'Copiar', 'Pegar', 'Enter']) {
    const h = harness(); h.props.active = true; h.render(); h.type('borrador');
    h.click('Teclas extra'); h.reject(); h.click(action);
    assert.equal(h.find('TextInput').props.value, 'borrador', action);
    assert.ok(h.find('GlassButton', 'Continuar sin reenviar'));
    const sent = h.sent.length;
    h.props.disabled = true; h.render(); h.render();
    h.props.active = false; h.render(); h.render();
    assert.equal(h.find('TextInput').props.value, 'borrador');
    h.accept(); h.props.disabled = false; h.props.active = true; h.render(); h.render();
    assert.equal(h.sent.length, sent);
    h.click('Enter'); assert.equal(h.sent.length, sent, 'review is required before another action');
    h.click('Continuar sin reenviar'); assert.equal(h.sent.length, sent);
    h.type('borrador!'); assert.deepEqual(h.sent.at(-1), {t:'k', a:'text', text:'!'});
  }
});

test('partial correction failure keeps the complete desired draft and stops remote edits', () => {
  const h = harness(); h.props.active = true; h.render(); h.type('abc');
  h.rejectAfter(2); h.type('xyz');
  assert.equal(h.sent.length, 3); // text, one accepted Backspace, one rejected.
  assert.equal(h.find('TextInput').props.value, 'xyz');
  h.type('xyz guardado');
  assert.equal(h.sent.length, 3);
  assert.equal(h.find('TextInput').props.value, 'xyz guardado');
});

test('typed modifier shortcut rejection preserves its draft and requires review', () => {
  const h = harness(); h.props.active = true; h.render(); h.click('Teclas extra'); h.click('Ctrl');
  h.reject(); h.type('c');
  assert.equal(h.find('TextInput').props.value, 'c');
  assert.ok(h.find('GlassButton', 'Continuar sin reenviar'));
});

test('disconnect preserves a nonempty draft even without a synchronous send failure', () => {
  const h = harness(); h.props.active = true; h.render(); h.type('texto');
  h.props.disabled = true; h.render(); h.render();
  assert.equal(h.find('TextInput').props.value, 'texto');
  assert.ok(h.find('GlassButton', 'Continuar sin reenviar'));
});


test('failed delivery retains every Unicode and newline fixture without automatic replay', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tests/fixtures/input-integrity.json'), 'utf8'));
  for (const sample of fixture.textCases) {
    const h = harness(); h.props.active = true; h.render(); h.reject(); h.type(sample.value);
    assert.equal(h.find('TextInput').props.value, sample.value, sample.name);
    const attempts = h.sent.length;
    h.props.disabled = true; h.render(); h.render();
    h.props.disabled = false; h.accept(); h.render(); h.render();
    assert.equal(h.find('TextInput').props.value, sample.value, sample.name);
    assert.equal(h.sent.length, attempts);
  }
});

test('literal composer keeps dictation edits local and writes the final block without Enter', async () => {
  const h = harness(), blocks = [];
  const pending = [];
  h.props.onPendingChange = value => pending.push(value);
  h.props.connection.inputCapabilities = { version: 1 };
  h.props.connection.literal = { draft: '', pending: null, busy: false,
    send: async text => { blocks.push(text); return { state: 'dispatched' }; }, reviewed() { this.pending = null; } };
  h.props.active = true; h.render();
  h.type('quiero una caza'); h.type('quiero una casa ¿_ 👨‍👩‍👧‍👦\nsegunda línea');
  assert.equal(pending.at(-1), true, 'parent protects this draft before changing hosts or applying an update');
  assert.equal(h.sent.length, 0);
  assert.equal(h.find('TextInput').props.maxLength, undefined);
  h.click('Enviar texto'); await new Promise(resolve => setImmediate(resolve)); h.render();
  assert.deepEqual(blocks, ['quiero una casa ¿_ 👨‍👩‍👧‍👦\nsegunda línea']);
  assert.equal(h.sent.length, 0); assert.equal(h.find('TextInput').props.value, '');
  assert.equal(pending.at(-1), false, 'a confirmed block releases the host-switch guard');
});
test('literal draft survives close, navigation actions and a lost receipt', async () => {
  const h = harness();
  h.props.connection.inputCapabilities = { version: 1 };
  h.props.connection.literal = { draft: '', pending: null, busy: false,
    send: async text => { h.props.connection.literal.pending = { text }; throw Error('offline'); }, reviewed() { this.pending = null; } };
  h.props.active = true; h.render(); h.type('borrador de dictado');
  h.click('Teclas extra'); h.click('Derecha');
  assert.equal(h.find('GlassButton', 'Enter'), undefined);
  assert.equal(h.sent.length, 0); assert.equal(h.find('TextInput').props.value, 'borrador de dictado');
  h.props.active = false; h.render(); h.render();
  assert.equal(h.find('TextInput').props.value, 'borrador de dictado');
  h.props.active = true; h.render(); h.click('Enviar texto');
  await new Promise(resolve => setImmediate(resolve)); h.render();
  assert.equal(h.find('TextInput').props.value, 'borrador de dictado');
  assert.ok(h.find('GlassButton', 'Consultar envío'));
  assert.equal(h.sent.length, 0);
});

test('literal mode preserves explicit Ctrl shortcuts as key actions, not typed text', () => {
  const h=harness();
  h.props.connection.inputCapabilities={version:1};
  h.props.connection.literal={draft:'',pending:null,busy:false,reviewed(){}};
  h.props.active=true;h.render();h.click('Teclas extra');h.click('Ctrl');h.type('c');
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].a,'combo');assert.equal(h.sent[0].key,'c');
  assert.equal(h.find('TextInput').props.value,'');
});

test('a late native append during delivery retains only the unsent suffix', async () => {
  const h=harness();let finish;
  h.props.connection.inputCapabilities={version:1};
  h.props.connection.literal={draft:'',pending:null,busy:false,send:()=>new Promise(resolve=>{finish=resolve;}),reviewed(){}};
  h.props.active=true;h.render();h.type('first');h.click('Enviar texto');
  assert.equal(h.find('TextInput').props.editable,false);
  h.type('first next');finish({state:'dispatched'});
  await new Promise(resolve=>setImmediate(resolve));h.render();
  assert.equal(h.find('TextInput').props.value,' next');
  assert.equal(h.props.connection.literal.draft,' next');
});
test('callbacks two editor generations old preserve the current draft and expose the late version',async()=>{
 const h=harness();let finish;
 h.props.connection.inputCapabilities={version:1};
 h.props.connection.literal={draft:'',pending:null,lateDraft:null,
   send:()=>new Promise(resolve=>{finish=resolve;}),reviewed(){},
   noteLateDraft(text,confirmedText){return this.lateDraft={text,duplicate:text===confirmedText};},
   discardLateDraft(){this.lateDraft=null;}};
 h.props.active=true;h.render();h.type('first');h.click('Enviar texto');
 const firstEditor=h.find('TextInput');
 const focused=h.focusCount();
 finish({state:'dispatched'});await new Promise(resolve=>setImmediate(resolve));h.render();
 assert.ok(h.focusCount()>focused,'the remounted editor regains focus');
 h.type('second');h.click('Enviar texto');
 finish({state:'dispatched'});await new Promise(resolve=>setImmediate(resolve));h.render();
 h.type('nuevo');
 await new Promise(resolve=>setImmediate(resolve));
 firstEditor.props.onChangeText('first next');h.render();
 assert.equal(h.find('TextInput').props.value,'nuevo');
 assert.equal(h.props.connection.literal.draft,'nuevo');
 assert.equal(h.props.connection.literal.lateDraft.text,'first next');
 assert.equal(h.find('GlassButton','Enviar texto').props.disabled,true);
 assert.ok(h.find('GlassButton','Usar este texto'));
 h.props.visible=false;h.render();h.props.visible=true;h.render();
 assert.ok(h.find('GlassButton','Usar este texto'),'late version survives hiding');
 h.click('Descartar esta versión');
 assert.equal(h.find('TextInput').props.value,'nuevo');
 assert.equal(h.props.connection.literal.lateDraft,null);
 assert.equal(h.find('GlassButton','Enviar texto').props.disabled,false);
});
test('using a late editor version replaces the draft only after an explicit choice',async()=>{
 const h=harness();let finish;
 h.props.connection.inputCapabilities={version:1};
 h.props.connection.literal={draft:'',pending:null,lateDraft:null,
   send:()=>new Promise(resolve=>{finish=resolve;}),reviewed(){},
   noteLateDraft(text,confirmedText){return this.lateDraft={text,duplicate:text===confirmedText};},
   useLateDraft(){const value=this.lateDraft;this.lateDraft=null;return value;}};
 h.props.active=true;h.render();h.type('first');h.click('Enviar texto');
 const oldEditor=h.find('TextInput');finish({state:'dispatched'});
 await new Promise(resolve=>setImmediate(resolve));h.render();h.type('nuevo');
 oldEditor.props.onChangeText('first next');h.render();
 const sends=h.sent.length;
 h.click('Usar este texto');
 assert.equal(h.find('TextInput').props.value,'first next');
 assert.equal(h.props.connection.literal.lateDraft,null);
 assert.equal(h.sent.length,sends,'choosing a late version never sends it');
});
test('a late replacement during delivery requires review before another send',async()=>{
 const h=harness();let finish;
 h.props.connection.inputCapabilities={version:1};
 h.props.connection.literal={draft:'',pending:null,busy:false,send:()=>new Promise(resolve=>{finish=resolve;}),reviewed(){}};
 h.props.active=true;h.render();h.type('caza');h.click('Enviar texto');h.type('casa');finish({state:'dispatched'});
 await new Promise(resolve=>setImmediate(resolve));h.render();
 assert.equal(h.find('TextInput').props.value,'casa');assert.equal(h.find('GlassButton','Enviar texto').props.disabled,true);
 assert.ok(h.find('GlassButton','Continuar sin reenviar'));
});

test('a modern host without literal input never falls back to layout-dependent text commands',async()=>{
 const h=harness();h.props.connection.capabilities={protocolVersion:2};
 h.props.connection.literal={draft:'',pending:null,busy:false,
   send:async()=>{throw Error('La computadora no admite este envío de texto.');}};
 h.props.active=true;h.render();h.type('¿Pregunta_?');
 assert.equal(h.sent.length,0);
 h.click('Enviar texto');await new Promise(resolve=>setImmediate(resolve));h.render();
 assert.equal(h.sent.length,0);assert.equal(h.find('TextInput').props.value,'¿Pregunta_?');
});

test('revoking input still allows receipt review and explicit local discard without new remote edits',async()=>{
 const h=harness();let reviewed=0;
 h.props.connection.inputCapabilities={version:1};
 h.props.connection.literal={draft:'',pending:null,busy:false,reviewed:async()=>{reviewed++;h.props.connection.literal.pending=null;return true;}};
 h.props.active=true;h.render();h.type('texto pendiente');
 h.props.connection.literal.pending={text:'texto pendiente'};
 h.props.disabled=true;h.props.canReview=true;h.props.active=false;h.render();h.render();
 assert.equal(h.find('GlassButton','Continuar sin reenviar').props.disabled,false);
 h.click('Continuar sin reenviar');await new Promise(resolve=>setImmediate(resolve));h.render();
 assert.equal(reviewed,1);assert.equal(h.sent.length,0);assert.equal(h.find('TextInput').props.value,'texto pendiente');
 h.props.disabled=false;h.render();h.props.disabled=true;h.render();h.render();
 h.click('Descartar borrador');assert.equal(h.find('TextInput').props.value,'texto pendiente');
 h.alerts[0][2].find(b=>b.text==='Descartar').onPress();h.render();
 assert.equal(h.find('TextInput').props.value,'');assert.equal(h.props.connection.literal.draft,'');assert.equal(h.sent.length,0);
});

test('files permission can keep attachments available when input is unavailable',()=>{
 const h=harness();h.props.disabled=true;h.props.allowAttachments=true;h.render();h.render();
 assert.equal(h.find('GlassButton','Agregar').props.disabled,false);
 h.click('Agregar');assert.equal(h.find('ActionMenu').props.keyboardAllowed,undefined);
 h.find('ActionMenu').props.choose('photos');h.render();assert.deepEqual(h.chosen,['photos']);
 h.props.allowAttachments=false;h.render();h.find('ActionMenu').props.choose('files');
 assert.deepEqual(h.chosen,['photos']);
});

test('focused literal editor has no tutorial or extra send button and stays one row',()=>{
 const h=harness();h.props.connection.inputCapabilities={version:1};h.props.connection.literal={draft:'',pending:null,busy:false};
 h.props.active=true;h.render();
 assert.equal(h.find('GlassButton','Escribir'),undefined);
 assert.equal(h.find('TextInput').props.style.height,44);
 assert.equal(h.nodes(h.tree()).filter(n=>n.type==='Text').length,0);
 h.type('Texto largo\ncon otra línea');
 assert.equal(h.find('TextInput').props.style.height,44);
 assert.equal(h.find('TextInput').props.value,'Texto largo\ncon otra línea');
 assert.equal(h.find('TextInput').props.scrollEnabled,true);
});
