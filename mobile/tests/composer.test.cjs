const controlFixture = require('./control-fixture.cjs');
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
function harness(initialConnection = {}) {
  const alerts = [], clipboardTransfers = [], clipboardOffers = [];
  const slots = [], effects = [], sent = [], chosen = [], keyboardListeners = {}; let index = 0, tree, accepted = true, rejectAfter = Infinity;
  const focusCount = { value: 0 };
  const dimensions = { width: 390, height: 844 };
  const screen = {...dimensions};
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
    if (typeof type === 'function') return type(props);
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
      Platform: { OS: 'ios' }, Dimensions: {get:()=>screen},
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
    '../lib/clipboard-transfer': {
      transferClipboard: async (_connection, direction) => { clipboardTransfers.push(direction); },
      offerTextToHostClipboard: async (_connection, text) => { clipboardOffers.push(text); },
    },
  };
  controlFixture.install(modules, jsx);
  const exports = {}; vm.runInNewContext(compile('components/native-keyboard.tsx'), { exports, require: name => modules[name], setTimeout, clearTimeout, setInterval, clearInterval, AbortController });
  const props = { connection: { ...initialConnection, send: c => { sent.push(JSON.parse(JSON.stringify(c))); return accepted && sent.length <= rejectAfter; } },
    active: false, disabled: false, choosing: false, open: () => { props.active = true; }, close: () => { props.active = false; }, choose: action => chosen.push(action) };
  function render() { index = 0; tree = exports.NativeKeyboard(props); while (effects.length) effects.shift()(); }
  function nodes(node) { if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
  const find = (type, label) => controlFixture.find(nodes,tree,type,label);
  const click = label => { const node = find('GlassButton', label); assert.ok(node, label); node.props.onPress(); render(); };
  const type = value => {
    const editor=find('TextInput'),caret=controlFixture.load('lib/native-caret.ts');
    editor.props.onChangeText(editor.props.selectionColor==='transparent' ? caret.CARET_CONTEXT.slice(0,caret.CARET_ORIGIN)+value+caret.CARET_CONTEXT.slice(caret.CARET_ORIGIN) : value);
    render();
  };
  render(); render();
  return {
    props, sent, chosen, alerts, clipboardTransfers, clipboardOffers, focusCount: () => focusCount.value, keyboardState, render, showShortcuts: () => { render(); if (!find('GlassButton', 'Ctrl') && !find('GlassButton', 'Pegar')) click('Teclas extra'); }, tree: () => tree, nodes, find, click, type,
    keyboard: (event, payload = {}) => (keyboardListeners[event] ?? []).forEach(callback => callback(payload)),
    measure: next => Object.assign(measurement, next),
    resize: next => { if(next.width && next.width!==dimensions.width) Object.assign(screen,next); Object.assign(dimensions, next); },
    reject: () => { accepted = false; },
    accept: () => { accepted = true; rejectAfter = Infinity; },
    rejectAfter: count => { rejectAfter = count; },
  };
}
test('portrait keyboard opens with hidden shortcuts and a compact growing editor', () => {
  const h=harness(), original=h.find('TextInput');
  assert.equal(original.props.style.height,44);
  const inputBox=h.nodes(h.tree()).find(n=>n.type==='View'&&n.props.style?.marginLeft===44);
  assert.equal(inputBox.props.style.marginRight,88);
  const row=h.nodes(h.tree()).find(n=>n.type==='View'&&n.props.style?.height===44&&n.props.style?.marginTop===-44);
  assert.ok(row,'collapsed actions retain a full touchable row while overlaying the editor');
  original.props.onFocus();h.render();h.render();
  assert.equal(h.find('GlassButton','Ctrl'),undefined);
  assert.equal(h.find('TextInput').props.style.height,44);
  assert.equal(h.find('TextInput').props.ref,original.props.ref);
  assert.equal(h.find('GlassButton','Expandir texto'),undefined);
  h.showShortcuts();assert.ok(h.find('GlassButton','Ctrl'));
  h.click('Portapapeles');assert.ok(h.find('GlassButton','Pegar'));
  h.props.active=false;h.render();h.render();h.props.active=true;h.render();h.render();
  assert.equal(h.find('GlassButton','Ctrl'),undefined);assert.equal(h.find('GlassButton','Pegar'),undefined);
});
test('landscape defaults do not leak into portrait, even with the native keyboard open',()=>{
  const h=harness();h.props.active=true;h.render();h.render();
  h.showShortcuts();
  h.resize({width:844,height:390});h.props.column={left:59,top:8,width:320,height:210};h.render();h.render();
  assert.ok(h.find('GlassButton','Ctrl'));assert.ok(h.find('TextInput').props.style.height>44);
  h.click('Teclas extra');assert.equal(h.find('GlassButton','Ctrl'),undefined);
  h.resize({width:390,height:844});h.props.column=undefined;h.render();h.render();
  assert.equal(h.find('GlassButton','Ctrl'),undefined);assert.equal(h.find('TextInput').props.style.height,44);
  h.resize({width:844,height:390});h.props.column={left:59,top:8,width:320,height:210};h.render();h.render();
  assert.ok(h.find('GlassButton','Ctrl'));
});
test('composer keeps editor identity while actions move between inline and bottom row',()=>{
  const h=harness(),original=h.find('TextInput');
  for(const active of [true,false,true,false]){
    h.props.active=active;h.render();h.render();
    assert.equal(h.find('TextInput').props.ref,original.props.ref);
    assert.ok(h.find('GlassButton','Agregar'));assert.ok(h.find('GlassButton','Teclas extra'));
    assert.equal(h.find('GlassButton','Enviar texto').props.action,'send');
    const box=h.nodes(h.tree()).find(n=>n.type==='View'&&typeof n.props.style?.marginLeft==='number');
    assert.equal(box.props.style.marginLeft,active?0:44);
  }
});
test('multiline draft grows and survives close, reopen and landscape resizing',()=>{
  const h=harness();h.props.connection.inputCapabilities={version:1};h.props.connection.literal={draft:'',pending:null,busy:false};
  h.props.active=true;h.render();h.type('Primera línea\nSegunda línea 👋');
  h.find('TextInput').props.onContentSizeChange({nativeEvent:{contentSize:{height:80}}});h.render();
  const original=h.find('TextInput');assert.equal(original.props.style.height,80);
  h.props.active=false;h.render();h.render();assert.equal(h.find('TextInput').props.value,original.props.value);
  h.props.column={left:59,top:8,width:240,height:176};h.props.active=true;h.render();h.render();
  assert.equal(h.find('TextInput').props.value,original.props.value);assert.ok(h.find('GlassButton','Ctrl'));
  assert.equal(h.sent.length,0);
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
  h.click('Enviar texto'); assert.deepEqual(h.sent.at(-1), { t: 'k', a: 'special', key: 'Enter' });
  assert.equal(shownValue(h), ''); assert.equal(h.sent.length, 2);
});
test('navigation resets reconciliation so subsequent typing does not erase remote text', () => {
  const h = harness(); h.props.active = true; h.render(); h.type('abc'); h.showShortcuts(); h.click('Tab'); h.type('X');
  assert.deepEqual(h.sent, [{ t: 'k', a: 'text', text: 'abc' }, { t: 'k', a: 'special', key: 'Tab' }, { t: 'k', a: 'text', text: 'X' }]);
});
test('modifier plus typed letter sends a shortcut, not literal text', () => {
  const h = harness(); h.props.active = true; h.render(); h.showShortcuts(); h.click('Ctrl'); h.type('c');
  assert.deepEqual(h.sent, [{ t: 'k', a: 'combo', mods: ['ctrl'], key: 'c' }]);
  assert.equal(shownValue(h), '');
});
test('closing clears local context without deleting remote text, and the plus remains in the field', () => {
  const h = harness(); h.props.active = true; h.render(); h.type('hola'); h.find('TextInput').props.onBlur(); h.render(); h.render();
  assert.equal(shownValue(h), ''); assert.equal(h.sent.length, 1);
  h.click('Agregar'); assert.ok(h.find('ActionMenu'));
});

test('immersive mode hides the field and any popup without deleting remote text', () => {
  const h = harness(); h.props.active = true; h.render(); h.type('texto'); h.click('Agregar');
  h.props.visible = false; h.render(); h.render();
  assert.equal(h.tree().props.pointerEvents, 'none');
  assert.equal(h.tree().props.style.display, 'none');
  assert.equal(h.find('ActionMenu').props.anchor, null);
  assert.equal(shownValue(h), '');
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

test('phone Return with a draft remains local even with a modifier armed', () => {
  const h = harness(); h.props.active = true; h.render();
  assert.equal(h.find('TextInput').props.submitBehavior, 'newline');
  assert.equal(h.find('TextInput').props.onSubmitEditing, undefined);
  h.type('hola'); h.type('hola\n'); h.type('hola\nmundo');
  assert.deepEqual(h.sent, [
    { t: 'k', a: 'text', text: 'hola' },
    { t: 'k', a: 'combo', mods: ['shift'], key: 'Enter' },
    { t: 'k', a: 'text', text: 'mundo' },
  ]);
  h.showShortcuts(); h.click('Shift'); h.click('Enviar texto');
  assert.deepEqual(h.sent.at(-1), { t: 'k', a: 'special', key: 'Enter' });
});

test('every displayed shortcut sends the intended command and clears one-shot modifiers', () => {
  const h = harness(); h.props.active = true; h.render(); h.showShortcuts();
  for (const [label, key] of [['Esc','Escape'],['Tab','Tab']]) {
    h.click(label); assert.deepEqual(h.sent.at(-1), { t:'k', a:'special', key });
    h.click('Shift'); h.click(label);
    assert.deepEqual(h.sent.at(-1), { t:'k', a:'combo', mods:['shift'], key });
    assert.equal(h.find('GlassButton', 'Shift').props.selected, false);
  }
  for (const label of ['Ctrl','Alt','Super','Shift']) {
    h.click(label); h.type('a');
    assert.deepEqual(h.sent.at(-1), { t:'k', a:'combo', mods:[label.toLowerCase()], key:'a' });
  }
  h.click('Portapapeles');
  for (const [label,key] of [['Copiar','c'],['Pegar','v']]) {
    assert.equal(h.find('GlassButton', label).props.symbol, undefined, 'clipboard actions have visible text');
    h.click(label); assert.deepEqual(h.sent.at(-1), { t:'k', a:'combo', mods:['ctrl'], key });
  }
});


test('rejected navigation, clipboard and Enter preserve the draft without retry on reconnect', () => {
  for (const action of ['Tab', 'Copiar', 'Pegar', 'Enviar texto']) {
    const h = harness(); h.props.active = true; h.render(); h.type('borrador');
    h.showShortcuts(); if(['Copiar','Pegar'].includes(action))h.click('Portapapeles'); h.reject(); h.click(action);
    assert.equal(h.find('TextInput').props.value, 'borrador', action);
    assert.equal(h.find('GlassButton', 'Ya revisé'),undefined); h.click('Revisar envío'); assert.ok(h.find('GlassButton', 'Ya revisé'));
    const sent = h.sent.length;
    h.props.disabled = true; h.render(); h.render();
    h.props.active = false; h.render(); h.render();
    assert.equal(h.find('TextInput').props.value, 'borrador');
    h.accept(); h.props.disabled = false; h.props.active = true; h.render(); h.render();
    assert.equal(h.sent.length, sent);
    h.click('Revisar envío'); assert.equal(h.sent.length, sent, 'review never sends another action');
    h.click('Ya revisé'); assert.equal(h.sent.length, sent);
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
  const h = harness(); h.props.active = true; h.render(); h.showShortcuts(); h.click('Ctrl');
  h.reject(); h.type('c');
  assert.equal(h.find('TextInput').props.value, 'c');
  assert.equal(h.find('GlassButton', 'Ya revisé'),undefined); h.click('Revisar envío'); assert.ok(h.find('GlassButton', 'Ya revisé'));
});

test('disconnect preserves a nonempty draft even without a synchronous send failure', () => {
  const h = harness(); h.props.active = true; h.render(); h.type('texto');
  h.props.disabled = true; h.render(); h.render();
  assert.equal(h.find('TextInput').props.value, 'texto');
  assert.equal(h.find('GlassButton', 'Ya revisé'),undefined); h.click('Revisar envío'); assert.ok(h.find('GlassButton', 'Ya revisé'));
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
  assert.equal(h.sent.length, 0); assert.equal(shownValue(h), '');
  assert.equal(pending.at(-1), false, 'a confirmed block releases the host-switch guard');
});
test('literal draft survives close, navigation actions and a lost receipt', async () => {
  const h = harness();
  h.props.connection.inputCapabilities = { version: 1 };
  h.props.connection.literal = { draft: '', pending: null, busy: false,
    send: async text => { h.props.connection.literal.pending = { text }; throw Error('offline'); }, reviewed() { this.pending = null; } };
  h.props.active = true; h.render(); h.type('borrador de dictado');
  h.showShortcuts(); h.click('Tab');
  assert.equal(h.find('GlassButton', 'Enter'), undefined);
  assert.equal(h.sent.length, 1); assert.equal(h.find('TextInput').props.value, 'borrador de dictado');
  h.props.active = false; h.render(); h.render();
  assert.equal(h.find('TextInput').props.value, 'borrador de dictado');
  h.props.active = true; h.render(); h.click('Enviar texto');
  await new Promise(resolve => setImmediate(resolve)); h.render();
  assert.equal(h.find('TextInput').props.value, 'borrador de dictado');
  h.click('Revisar envío'); assert.ok(h.find('GlassButton', 'Consultar envío'));
  assert.equal(h.sent.length, 1);
});

test('literal mode preserves explicit Ctrl shortcuts as key actions, not typed text', () => {
  const h=harness();
  h.props.connection.inputCapabilities={version:1};
  h.props.connection.literal={draft:'',pending:null,busy:false,reviewed(){}};
  h.props.active=true;h.render();h.showShortcuts();h.click('Ctrl');h.type('c');
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].a,'combo');assert.equal(h.sent[0].key,'c');
  assert.equal(shownValue(h),'');
});

test('a late native append during delivery retains only the unsent suffix', async () => {
  const h=harness();let finish;
  h.props.connection.inputCapabilities={version:1};
  h.props.connection.literal={draft:'',pending:null,busy:false,send:()=>new Promise(resolve=>{finish=resolve;}),reviewed(){}};
  h.props.active=true;h.render();h.type('first');h.click('Enviar texto');
  assert.equal(h.find('TextInput').props.editable,true);
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
 assert.equal(h.focusCount(),focused,'a receipt preserves the native editor without forcing another focus');
 h.type('second');h.click('Enviar texto');
 finish({state:'dispatched'});await new Promise(resolve=>setImmediate(resolve));h.render();
 h.type('nuevo');
 await new Promise(resolve=>setImmediate(resolve));
 firstEditor.props.onChangeText('first next');h.render();
 assert.equal(h.find('TextInput').props.value,'nuevo');
 assert.equal(h.props.connection.literal.draft,'nuevo');
 assert.equal(h.props.connection.literal.lateDraft.text,'first next');
 assert.equal(h.find('GlassButton','Enviar texto'),undefined); assert.ok(h.find('GlassButton','Revisar envío'));
 h.click('Revisar envío'); assert.ok(h.find('GlassButton','Usar este texto'));
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
 h.click('Revisar envío'); h.click('Usar este texto');
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
 assert.equal(h.find('TextInput').props.value,'casa');assert.equal(h.find('GlassButton','Enviar texto'),undefined); assert.ok(h.find('GlassButton','Revisar envío'));
 h.click('Revisar envío'); assert.ok(h.find('GlassButton','Ya revisé'));
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
 h.click('Revisar envío'); assert.equal(h.find('GlassButton','Ya revisé').props.disabled,false);
 h.click('Ya revisé');await new Promise(resolve=>setImmediate(resolve));h.render();
 assert.equal(reviewed,1);assert.equal(h.sent.length,0);assert.equal(h.find('TextInput').props.value,'texto pendiente');
 h.props.disabled=false;h.render();h.props.disabled=true;h.render();h.render();
 h.click('Revisar envío'); h.click('Descartar borrador');assert.equal(h.find('TextInput').props.value,'texto pendiente');
 h.alerts[0][2].find(b=>b.text==='Descartar').onPress();h.render();
 assert.equal(shownValue(h),'');assert.equal(h.props.connection.literal.draft,'');assert.equal(h.sent.length,0);
});

test('files permission can keep attachments available when input is unavailable',()=>{
 const h=harness();h.props.disabled=true;h.props.allowAttachments=true;h.render();h.render();
 assert.equal(h.find('GlassButton','Agregar').props.disabled,false);
 h.click('Agregar');assert.equal(h.find('ActionMenu').props.keyboardAllowed,undefined);
 h.find('ActionMenu').props.choose('photos');h.render();assert.deepEqual(h.chosen,['photos']);
 h.props.allowAttachments=false;h.render();h.find('ActionMenu').props.choose('files');
 assert.deepEqual(h.chosen,['photos']);
});

test('literal editor grows with text, retains scrolling, and has no separate erase button',()=>{
 const h=harness();h.props.connection.inputCapabilities={version:1};h.props.connection.literal={draft:'',pending:null,busy:false};
 h.props.active=true;h.render();const minimum=h.find('TextInput').props.style.height;
 h.type('Texto largo\ncon otra línea');h.find('TextInput').props.onContentSizeChange({nativeEvent:{contentSize:{height:110}}});h.render();
 assert.ok(h.find('TextInput').props.style.height>minimum);
 h.type('');h.find('TextInput').props.onContentSizeChange({nativeEvent:{contentSize:{height:24}}});h.render();assert.equal(h.find('TextInput').props.style.height,minimum);
 assert.equal(h.find('TextInput').props.scrollEnabled,true);
 h.showShortcuts();assert.equal(h.find('GlassButton','Borrar en la computadora'),undefined);
});
test('toolbar is a sibling of the composer, with one horizontal scroller and no joystick',()=>{
 const h=harness();h.showShortcuts();
 for(const width of [280,390,844]){
  h.resize({width,height:width===844?390:844});h.render();h.showShortcuts();
  const keys=h.nodes(h.tree()).filter(n=>n.type==='Pressable').map(n=>n.props.accessibilityLabel);
  assert.deepEqual(keys,['Ctrl','Alt','Super','Shift','Esc','Tab','Portapapeles']);
  assert.equal(h.nodes(h.tree()).find(n=>n.type==='DirectionPad'),undefined);
  assert.equal(h.nodes(h.tree()).filter(n=>n.type==='ScrollView'&&n.props.horizontal).length,1);
  assert.equal(h.nodes(h.tree()).find(n=>n.type==='ScrollView'&&n.props.pagingEnabled),undefined);
  const surfaces=h.nodes(h.tree()).filter(n=>n.type==='GlassSurface');
  assert.equal(surfaces.length,2);
  assert.ok(!h.nodes(surfaces.find(n=>h.nodes(n).some(v=>v.type==='TextInput'))).some(v=>v.type==='ScrollView'&&v.props.horizontal));
 }
 h.click('Portapapeles');
 assert.deepEqual(h.nodes(h.tree()).filter(n=>n.type==='Pressable').map(n=>n.props.accessibilityLabel),['Pegar','Copiar','Al iPhone','Modificadores y teclas']);
});

test('horizontal offset cannot prevent later vertical switches in either direction',()=>{
 const h=harness();h.showShortcuts();
 const scroller=h.nodes(h.tree()).find(n=>n.type==='ScrollView'&&n.props.horizontal);
 scroller.props.onScroll({nativeEvent:{contentOffset:{x:160}}});
 const pan=()=>h.nodes(h.tree()).find(n=>n.type==='GestureDetector'&&n.props.gesture.kind==='Pan').props.gesture;
 assert.deepEqual([...pan().failOffsetXValue],[-12,12]);
 pan().onEndValue({translationY:-40});h.render();assert.ok(h.find('GlassButton','Pegar'));
 pan().onEndValue({translationY:40});h.render();assert.ok(h.find('GlassButton','Ctrl'));
});

test('selected computer text reaches the iPhone only after Copy executes', async () => {
 const h = harness();
 h.props.connection.canClipboard = true;
 h.props.connection.capabilities = {sessionEpoch:'session-1'};
 let finish;
 h.props.connection.pressAction = () => 'copy-1';
 h.props.connection.waitFinalActionReceipt = () => new Promise(resolve => { finish = resolve; });
 h.render(); h.showShortcuts(); h.click('Portapapeles'); h.click('Al iPhone');
 assert.equal(h.clipboardTransfers.length, 0);
 finish({state:'executed'});
 await new Promise(resolve => setTimeout(resolve, 180)); h.render();
 assert.deepEqual(h.clipboardTransfers, ['phone']);
});

test('verified literal rejection sends the draft through clipboard once', async () => {
 const h = harness();
 h.props.connection.canClipboard = true;
 h.props.connection.canInput = true;
 h.props.connection.capabilities = {sessionEpoch:'session-1'};
 h.props.connection.inputCapabilities = {version:1};
 h.props.connection.literal = {draft:'',busy:false,pending:null,
   send:async text => { h.props.connection.literal.pending = {text,receipt:{state:'rejected'}}; return {state:'rejected'}; },
   acknowledged:function() {this.pending=null;}, reviewed:async function() { this.pending = null; return true; }};
 h.props.connection.pressAction = action => { h.sent.push(action); return 'paste-1'; };
 h.props.connection.waitFinalActionReceipt = async () => ({state:'executed'});
 h.props.active = true; h.render(); h.type('dictado ¿?'); h.click('Enviar texto');
 await new Promise(resolve => setImmediate(resolve)); h.render();
 assert.equal(h.find('GlassButton','Consultar envío'), undefined);
 assert.equal(h.find('GlassButton','Pegar borrador en el equipo'), undefined);
 assert.deepEqual(h.clipboardOffers, ['dictado ¿?']);
 assert.equal(h.sent.at(-1).key, 'v');
 assert.equal(shownValue(h), '');
 assert.equal(h.sent.length,1);
});

test('configured clipboard delivery sends dictation and symbols on the first attempt without the conservative literal route',async()=>{
 const h=harness();h.props.connection.inputCapabilities={version:1,preferredDelivery:'clipboard-paste'};
 h.props.connection.capabilities={sessionEpoch:'test-one',hostPlatform:'linux'};h.props.connection.canClipboard=true;h.props.connection.canInput=true;
 let literalCalls=0;h.props.connection.literal={draft:'',pending:null,busy:false,send:async()=>{literalCalls++;return {state:'uncertain'};}};
 h.props.connection.pressAction=action=>{h.sent.push(action);return 'paste-first';};h.props.connection.waitFinalActionReceipt=async()=>({state:'executed'});
 h.props.active=true;h.render();h.type('Prueba ñ € ?@&$;:/- 👌🙌🏻');h.click('Enviar texto');await new Promise(r=>setImmediate(r));h.render();
 assert.equal(literalCalls,0);assert.equal(h.sent.length,1);assert.deepEqual(h.clipboardOffers,['Prueba ñ € ?@&$;:/- 👌🙌🏻']);
 assert.equal(shownValue(h),'');assert.equal(h.find('GlassButton','Ya revisé'),undefined);
});
test('uncertain text notice can collapse while navigation works and the retained draft cannot be resent blindly',async()=>{
 const h=harness();h.props.connection.inputCapabilities={version:1};h.props.connection.literal={draft:'',pending:null,busy:false,send:async()=>({state:'uncertain'})};
 h.props.active=true;h.render();h.type('conservar');h.click('Enviar texto');await new Promise(r=>setImmediate(r));h.render();
 assert.equal(h.find('Notice'),undefined);h.click('Revisar envío');h.click('Cerrar aviso');assert.equal(h.find('GlassButton','Ya revisé'),undefined);assert.ok(h.find('GlassButton','Revisar envío'));
 assert.equal(h.find('GlassButton','Enviar texto'),undefined); assert.ok(h.find('GlassButton','Revisar envío'));
 h.showShortcuts();h.click('Tab');assert.equal(h.sent.at(-1).key,'Tab');assert.equal(h.find('TextInput').props.value,'conservar');
 h.click('Revisar envío');h.click('Ya revisé');assert.equal(h.find('GlassButton','Enviar texto').props.disabled,false);
});
test('a stale identical native callback does not manufacture an error after confirmed delivery',async()=>{
 const h=harness();h.props.connection.inputCapabilities={version:1};h.props.connection.literal={draft:'',pending:null,busy:false,send:async()=>({state:'dispatched'})};
 h.props.active=true;h.render();h.type('una vez');const previous=h.find('TextInput');h.click('Enviar texto');await new Promise(r=>setImmediate(r));h.render();
 previous.props.onChangeText('una vez');h.render();assert.equal(shownValue(h),'');assert.equal(h.find('GlassButton','Ya revisé'),undefined);assert.equal(h.find('GlassButton','Usar este texto'),undefined);
});

test('stale native Backspace after a confirmed block never edits the remote field', async()=>{
 const h=harness();h.props.connection.inputCapabilities={version:1};h.props.connection.literal={draft:'',pending:null,busy:false,send:async()=>({state:'dispatched'})};
 h.props.active=true;h.render();const oldEditor=h.find('TextInput');
 h.type('confirmado');h.click('Enviar texto');await new Promise(resolve=>setImmediate(resolve));h.render();
 oldEditor.props.onKeyPress({nativeEvent:{key:'Backspace'}});assert.equal(h.sent.length,0);
 h.find('TextInput').props.onKeyPress({nativeEvent:{key:'Backspace'}});assert.equal(h.sent.at(-1).key,'Backspace');
});

function shownValue(h){const editor=h.find('TextInput');return editor.props.selectionColor==='transparent'?'':editor.props.value;}
function startRemoteCaret(h){
 h.props.connection.inputCapabilities={version:1};h.props.connection.literal={draft:'',pending:null,busy:false};
 h.props.active=true;h.render();h.showShortcuts();h.click('Portapapeles');h.render();
 const caret=controlFixture.load('lib/native-caret.ts');
 h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:caret.CARET_ORIGIN,end:caret.CARET_ORIGIN}}});
 return h.find('TextInput');
}
test('Space native selection moves remote text in both axes with an empty composer',()=>{
 const h=harness(),editor=startRemoteCaret(h),caret=controlFixture.load('lib/native-caret.ts');
 const origin=caret.CARET_ORIGIN;
 assert.equal(editor.props.value,caret.CARET_CONTEXT);assert.equal(editor.props.caretHidden,false);assert.equal(editor.props.selectionColor,'transparent');
 assert.equal(h.props.connection.literal.draft,'');assert.equal(h.sent.length,0);
 let position=origin;
 for(const [offset,key] of [[1,'ArrowRight'],[-1,'ArrowLeft'],[21,'ArrowDown'],[-21,'ArrowUp']]){
  position+=offset;h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:position,end:position}}});h.render();
  assert.equal(h.sent.at(-1).key,key);
 }
 assert.equal(h.sent.length,4);assert.equal(h.props.connection.literal.draft,'');
 const old=h.find('TextInput');h.props.active=false;h.render();
 old.props.onSelectionChange({nativeEvent:{selection:{start:origin+1,end:origin+1}}});assert.equal(h.sent.length,4);
});
test('native caret context never gets sent or saved when typing, dictating or deleting',()=>{
 const caret=controlFixture.load('lib/native-caret.ts');
 for(const text of ['dictado ñ € 👋',' ','@&$;:/- 👌🙌🏻']){
  const h=harness(),editor=startRemoteCaret(h);
  editor.props.onChangeText(caret.CARET_CONTEXT.slice(0,caret.CARET_ORIGIN)+text+caret.CARET_CONTEXT.slice(caret.CARET_ORIGIN));h.render();
  assert.equal(h.props.connection.literal.draft,text);assert.equal(h.find('TextInput').props.value,text);assert.equal(h.sent.length,0);
 }
 const h=harness(),editor=startRemoteCaret(h);
 editor.props.onKeyPress({nativeEvent:{key:'Backspace'}});
 editor.props.onChangeText(caret.CARET_CONTEXT.slice(0,caret.CARET_ORIGIN-1)+caret.CARET_CONTEXT.slice(caret.CARET_ORIGIN));h.render();
 h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:caret.CARET_ORIGIN,end:caret.CARET_ORIGIN}}});
 assert.equal(h.sent.length,1);assert.equal(h.sent[0].key,'Backspace');assert.equal(h.props.connection.literal.draft,'');
});
test('Space bridge cannot move the host after revocation, with a pending receipt, or with a local draft',()=>{
 const caret=controlFixture.load('lib/native-caret.ts');
 for(const change of [h=>{h.props.disabled=true;},h=>{h.props.connection.literal.pending={text:'pendiente'};},h=>{h.type('borrador');}]){
  const h=harness(),old=startRemoteCaret(h);change(h);h.render();h.render();
  old.props.onSelectionChange({nativeEvent:{selection:{start:caret.CARET_ORIGIN+1,end:caret.CARET_ORIGIN+1}}});
  assert.equal(h.sent.length,0);
 }
});

test('tapping the empty editor and boundary recenter callbacks never move the remote caret',()=>{
 const h=harness(),old=startRemoteCaret(h),caret=controlFixture.load('lib/native-caret.ts');
 old.props.onTouchStart();old.props.onSelectionChange({nativeEvent:{selection:{start:5,end:5}}});
 assert.equal(h.sent.length,0);
 old.props.onTouchEnd();h.render();h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:caret.CARET_ORIGIN,end:caret.CARET_ORIGIN}}});
 assert.equal(h.sent.length,0);
 const boundary=caret.CARET_ORIGIN+10;
 h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:boundary,end:boundary}}});h.render();
 assert.equal(h.sent.length,10);assert.equal(h.find('TextInput').props.selection.start,caret.CARET_ORIGIN);
 h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:caret.CARET_ORIGIN,end:caret.CARET_ORIGIN}}});h.render();
 assert.equal(h.sent.length,10);
 h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:caret.CARET_ORIGIN+1,end:caret.CARET_ORIGIN+1}}});
 assert.equal(h.sent.length,11);
});

test('delayed native focus selection cannot generate a burst of host arrows',()=>{
 const h=harness(),caret=controlFixture.load('lib/native-caret.ts');h.props.active=true;h.render();h.render();
 h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:0,end:0}}});h.render();
 assert.equal(h.sent.length,0);
 h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:caret.CARET_ORIGIN,end:caret.CARET_ORIGIN}}});h.render();
 assert.equal(h.sent.length,0);
 h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:caret.CARET_ORIGIN+1,end:caret.CARET_ORIGIN+1}}});
 assert.equal(h.sent.length,1);assert.equal(h.sent[0].key,'ArrowRight');
});

test('Return from the native keyboard acts once remotely only with an empty draft',()=>{
 const h=harness();startRemoteCaret(h);
 assert.equal(h.find('GlassButton','Enter'),undefined);
 h.type('\n');assert.equal(h.sent.length,1);assert.equal(h.sent[0].key,'Enter');
 assert.equal(h.props.connection.literal.draft,'');
 h.render();h.type('primera');h.type('primera\nsegunda');
 assert.equal(h.props.connection.literal.draft,'primera\nsegunda');assert.equal(h.sent.length,1);
});
test('landscape editor and attachments stay in their column without replacing the native input',()=>{
 const h=harness();h.props.connection.literal={draft:'',pending:null,busy:false};h.props.connection.inputCapabilities={version:1};
 h.props.active=true;h.render();h.type('borrador ñ');const original=h.find('TextInput');
 for(const width of [932,568,844]){
  h.resize({width,height:390});h.props.column={left:59,top:8,width:160,height:114};h.render();
  const scroll=h.nodes(h.tree()).find(n=>n.props?.testID==='phonepad-composer-column');
  assert.equal(scroll.props.style.maxHeight,114);
  scroll.props.onContentSizeChange(160,220);h.render();
  assert.equal(h.nodes(h.tree()).find(n=>n.props?.testID==='phonepad-composer-column').props.scrollEnabled,true);
  assert.equal(h.find('KeyboardStickyView').props.style.left,59);
  h.click('Agregar');assert.equal(h.find('ActionMenu').props.onPaste,undefined);
  assert.equal(h.find('ActionMenu').props.bounds,h.props.column);
  h.find('ActionMenu').props.close();h.find('ActionMenu').props.onDismiss();h.render();
  assert.equal(h.find('TextInput').type,original.type);assert.equal(h.find('TextInput').props.value,'borrador ñ');
 }
 h.props.column=undefined;h.resize({width:390,height:844});h.render();
 assert.equal(h.find('KeyboardStickyView').props.style.alignSelf,'center');assert.equal(h.sent.length,0);
});


test('late native Return cannot submit the host after blur, pending receipt, revocation or editor replacement',async()=>{
 const caret=controlFixture.load('lib/native-caret.ts');
 const newline=caret.CARET_CONTEXT.slice(0,caret.CARET_ORIGIN)+'\n'+caret.CARET_CONTEXT.slice(caret.CARET_ORIGIN);
 for(const update of [h=>{h.props.active=false;},h=>{h.props.disabled=true;},h=>{h.props.connection.literal.pending={text:'pending'};}]){
  const h=harness(),old=startRemoteCaret(h);update(h);h.render();old.props.onChangeText(newline);h.render();assert.equal(h.sent.length,0);
 }
 const h=harness(),old=startRemoteCaret(h);h.props.connection.literal.send=async()=>({state:'dispatched'});
 h.type('texto');h.click('Enviar texto');await new Promise(setImmediate);h.render();
 old.props.onChangeText(newline);h.render();assert.equal(h.sent.length,0);assert.equal(h.props.connection.literal.draft,'');
});

test('hidden native keyboard cannot leave the composer translated by a stale animation after rotation',()=>{
 const h=harness();h.props.active=true;h.keyboardState.isVisible=true;h.keyboardState.height=336;h.render();
 assert.equal(h.find('KeyboardStickyView').props.enabled,true);
 h.resize({width:844,height:390});h.keyboardState.height=176;h.render();
 h.resize({width:390,height:844});h.keyboardState.isVisible=false;h.render();
 const dock=h.find('KeyboardStickyView');assert.equal(dock.props.enabled,false);assert.equal(dock.props.offset.closed,0);
 assert.equal(dock.props.style.bottom,46);assert.equal(h.find('TextInput').props.style.height,44);
});
test('confirmed sends ignore old empty clears and blur callbacks without reopening review or closing the keyboard',async()=>{
 const h=harness();let finish;h.props.connection.inputCapabilities={version:1};
 h.props.connection.literal={draft:'',pending:null,busy:false,send:()=>new Promise(resolve=>{finish=resolve;}),reviewed(){}};
 h.props.active=true;h.render();h.type('texto confirmado');const old=h.find('TextInput');const focuses=h.focusCount();
 h.click('Enviar texto');assert.equal(h.find('TextInput').props.editable,true);finish({state:'dispatched'});
 await new Promise(resolve=>setImmediate(resolve));h.render();
 old.props.onChangeText('');old.props.onBlur();h.render();
 assert.equal(h.props.active,true);assert.equal(h.focusCount(),focuses);assert.equal(shownValue(h),'');
 assert.equal(h.find('GlassButton','Revisar envío'),undefined);assert.ok(h.find('GlassButton','Enviar texto'));
 assert.equal(h.find('TextInput').props.key,undefined);
 h.type('nuevo');old.props.onChangeText('');h.render();assert.equal(shownValue(h),'nuevo');
});

test('programmatic native caret context and obsolete content measurements cannot create a blank draft or inflate the editor',async()=>{
 const h=harness();let finish;h.props.connection.inputCapabilities={version:1};
 h.props.connection.literal={draft:'',pending:null,busy:false,send:()=>new Promise(resolve=>{finish=resolve;}),reviewed(){}};
 h.props.active=true;h.render();h.type('texto');const old=h.find('TextInput');h.click('Enviar texto');
 finish({state:'dispatched'});await new Promise(resolve=>setImmediate(resolve));h.render();
 old.props.onChangeText(controlFixture.load('lib/native-caret.ts').CARET_CONTEXT);
 old.props.onContentSizeChange({nativeEvent:{contentSize:{height:500}}});h.render();
 assert.equal(shownValue(h),'');assert.equal(h.find('TextInput').props.style.height,44);
 assert.equal(h.find('GlassButton','Revisar envío'),undefined);assert.equal(h.props.connection.literal.draft,'');
});

test('clearing the local draft during a confirmed send does not manufacture an uncertain empty delivery',async()=>{
 const h=harness();let finish;h.props.connection.inputCapabilities={version:1};
 h.props.connection.literal={draft:'',pending:null,busy:false,send:()=>new Promise(resolve=>{finish=resolve;}),reviewed(){}};
 h.props.active=true;h.render();h.type('snapshot');h.click('Enviar texto');h.type('');
 finish({state:'dispatched'});await new Promise(resolve=>setImmediate(resolve));h.render();
 assert.equal(shownValue(h),'');assert.equal(h.find('GlassButton','Revisar envío'),undefined);
 assert.equal(h.sent.length,0);
});

// UIKit preserves selection relative to the old end in RCTTextInputComponentView.
function nativeEditor(h){
 let text=h.find('TextInput').props.value,position=h.find('TextInput').props.selection?.start??(h.find('TextInput').props.selectionColor==='transparent'?controlFixture.load('lib/native-caret.ts').CARET_ORIGIN:text.length);
 const apply=()=>{
  const editor=h.find('TextInput');
  if(editor.props.value!==text){
   const fromEnd=text.length-position;
   text=editor.props.value;position=Math.max(0,text.length-fromEnd);
  }
  if(editor.props.selection)position=editor.props.selection.start;
 };
 return {insert(part){
  const editor=h.find('TextInput');
  editor.props.onKeyPress({nativeEvent:{key:part}});
  text=text.slice(0,position)+part+text.slice(position);position+=part.length;
  editor.props.onChangeText(text);h.render();apply();
  h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:position,end:position}}});h.render();apply();
 },value:()=>text,position:()=>position};
}
test('native replacement and selection callbacks type hola in order after empty Space context',()=>{
 const h=harness();startRemoteCaret(h);const native=nativeEditor(h);
 for(const letter of 'hola')native.insert(letter);
 assert.equal(native.value(),'hola');assert.equal(native.position(),4);
 assert.equal(h.props.connection.literal.draft,'hola');assert.equal(h.sent.length,0);
});
test('native dictation, emoji and subsequent typing keep the insertion point after virtual context replacement',()=>{
 for(const phrase of ['hola ñ € 👋','primera\nsegunda','👌🙌🏻']){
  const h=harness();startRemoteCaret(h);const native=nativeEditor(h);
  native.insert(phrase);native.insert('!');
  assert.equal(native.value(),phrase+'!');assert.equal(h.props.connection.literal.draft,phrase+'!');
 }
});
test('Space leaves native caret geometry intact and never controls each movement back to the old position',()=>{
 const h=harness();startRemoteCaret(h);const caret=controlFixture.load('lib/native-caret.ts');h.render();
 assert.equal(h.find('TextInput').props.caretHidden,false);
 assert.equal(h.find('TextInput').props.selection,undefined);
 for(const offset of [1,2,3,4]){
  h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:caret.CARET_ORIGIN+offset,end:caret.CARET_ORIGIN+offset}}});h.render();
  assert.equal(h.find('TextInput').props.selection,undefined);
 }
 assert.equal(h.sent.length,4);
});
test('a rejected send in an expanded landscape composer cannot change height or crop its action bar',async()=>{
 const h=harness();h.props.column={left:59,top:8,width:240,height:176};
 h.props.connection.inputCapabilities={version:1};h.props.connection.literal={draft:'',pending:null,busy:false,send:async()=>({state:'rejected'})};
 h.props.active=true;h.render();h.type('hola');
 const before=h.find('TextInput').props.style.height;
 h.click('Enviar texto');await new Promise(setImmediate);h.render();
 assert.equal(h.find('TextInput').props.style.height,before);assert.equal(h.find('Notice'),undefined);
 assert.ok(h.find('GlassButton','Agregar'));assert.ok(h.find('GlassButton','Revisar envío'));
 const column=h.nodes(h.tree()).find(n=>n.props?.testID==='phonepad-composer-column');
 assert.equal(h.nodes(column).filter(n=>n.type==='Notice').length,0);
 h.click('Revisar envío');const overlay=h.nodes(h.tree()).find(n=>n.props?.testID==='phonepad-composer-review');
 assert.equal(overlay.props.style.position,'absolute');assert.ok(overlay.props.style.maxHeight<176);
 assert.equal(h.find('TextInput').props.style.height,before);assert.equal(shownValue(h),'hola');
 h.click('Cerrar aviso');h.click('Enviar texto');await new Promise(setImmediate);h.render();assert.equal(shownValue(h),'hola');
});

test('Space moves without a synthetic acknowledgement for a Fabric programmatic selection reset',()=>{
 const h=harness(),caret=controlFixture.load('lib/native-caret.ts');
 h.props.connection.inputCapabilities={version:1};h.props.connection.literal={draft:'',pending:null,busy:false};
 h.props.active=true;h.render();h.render();
 h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:0,end:0}}});h.render();
 assert.equal(h.sent.length,0);
 h.find('TextInput').props.onSelectionChange({nativeEvent:{selection:{start:caret.CARET_ORIGIN+1,end:caret.CARET_ORIGIN+1}}});h.render();
 assert.equal(h.sent.length,1);assert.equal(h.sent[0].key,'ArrowRight');
 assert.equal(h.find('TextInput').props.selection,undefined);
});

test('restoring a saved local draft starts with UIKit selection, never a stale virtual offset',()=>{
 const h=harness({inputCapabilities:{version:1},literal:{draft:'hola',pending:null,busy:false}});
 h.props.active=true;h.render();assert.equal(h.find('TextInput').props.selection,undefined);
 const native=nativeEditor(h);native.insert('!');assert.equal(native.value(),'hola!');
});
test('Return and a consumed modifier shortcut restore the empty Space origin instead of leaving it at one',()=>{
 for(const part of ['\n','c']){
  const h=harness();startRemoteCaret(h);if(part==='c'){h.click('Modificadores y teclas');h.click('Ctrl');}
  h.type(part);assert.equal(shownValue(h),'');
  assert.equal(h.find('TextInput').props.selection.start,controlFixture.load('lib/native-caret.ts').CARET_ORIGIN);
 }
});
test('a stale virtual edit after delivery cannot move the insertion point of a newer draft',async()=>{
 const h=harness();const old=startRemoteCaret(h);h.props.connection.literal.send=async()=>({state:'dispatched'});
 h.type('enviar');h.click('Enviar texto');await new Promise(setImmediate);h.render();h.type('nuevo');
 const before=h.find('TextInput').props.selection;
 const caret=controlFixture.load('lib/native-caret.ts');
 old.props.onChangeText(caret.CARET_CONTEXT.slice(0,caret.CARET_ORIGIN)+'x'+caret.CARET_CONTEXT.slice(caret.CARET_ORIGIN));h.render();
 assert.deepEqual(h.find('TextInput').props.selection,before);assert.equal(shownValue(h),'nuevo');
});
