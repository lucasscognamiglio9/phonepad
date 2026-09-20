const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

function loadLandscapeControls(overrides = {}) {
  const source = ts.transpileModule(fs.readFileSync(
    path.join(__dirname, '../src/components/landscape-controls.tsx'), 'utf8',
  ), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const modules = {
    'react-native': {
      ScrollView: 'ScrollView',
      StyleSheet: { absoluteFill: { position: 'absolute' }, create: value => value },
      View: 'View',
      useWindowDimensions: () => ({ height: 390 }),
    },
    './glass-button': { GlassButton: 'GlassButton' },
    './glass-surface': { GlassSurface: 'GlassSurface' },
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
  };
  Object.assign(modules, overrides);
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => modules[name], Number });
  return exports;
}

const controls = loadLandscapeControls();

test('keeps the rail and handle inside the landscape safe area, applying the right inset once', () => {
  const frame = controls.getLandscapeControlsFrame(390, { top: 0, right: 59, bottom: 21, left: 0 });
  assert.equal(frame.top, 8);
  assert.equal(frame.right, 67);
  assert.equal(frame.height, controls.LANDSCAPE_CONTROLS_CONTENT_HEIGHT);
  assert.equal(frame.handleTop, 173);
});

test('short landscape gets a bounded scroll frame instead of overflowing below the safe area', () => {
  const frame = controls.getLandscapeControlsFrame(180, { top: 24, right: 10, bottom: 16, left: 0 });
  assert.equal(frame.top, 32);
  assert.equal(frame.right, 18);
  assert.equal(frame.height, 124);
  assert.ok(frame.top + frame.height <= 180 - 24);
  assert.ok(frame.height < controls.LANDSCAPE_CONTROLS_CONTENT_HEIGHT);
});

function componentHarness({ height = 390, visible = false } = {}) {
  const calls = [];
  const modules = {
    'react-native': {
      ScrollView: 'ScrollView',
      StyleSheet: { absoluteFill: { position: 'absolute' }, create: value => value },
      View: 'View',
      useWindowDimensions: () => ({ height }),
    },
    './glass-button': { GlassButton: 'GlassButton' },
    './glass-surface': { GlassSurface: 'GlassSurface' },
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
  };
  const componentExports = loadLandscapeControls(modules);
  const props = {
    visible,
    show: () => calls.push('show'),
    hide: () => calls.push('hide'),
    openKeyboard: () => calls.push('keyboard'),
    reconnect: () => calls.push('reconnect'),
    exitPreview: () => calls.push('exit'),
    disabled: true,
    insets: { top: 0, right: 59, bottom: 21, left: 0 },
  };
  const tree = componentExports.LandscapeControls(props);
  const nodes = node => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  };
  return { tree, calls, nodes: () => nodes(tree) };
}

test('hidden mode exposes only a safe glass handle and its press is UI-only', () => {
  const h = componentHarness();
  const buttons = h.nodes().filter(node => node.type === 'GlassButton');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.label, 'Mostrar controles');
  assert.equal(buttons[0].props.action, 'showControls');
  buttons[0].props.onPress();
  assert.deepEqual(h.calls, ['show']);
  const roots = h.nodes().filter(node => node.type === 'View');
  assert.ok(roots.every(node => node.props.pointerEvents === 'box-none'));
});

test('visible mode keeps four controls in one scrollable glass capsule', () => {
  const h = componentHarness({ height: 180, visible: true });
  const buttons = h.nodes().filter(node => node.type === 'GlassButton');
  assert.deepEqual(buttons.map(node => node.props.label), [
    'Ocultar controles', 'Teclado', 'Reconectar', 'Ocultar pantalla',
  ]);
  assert.deepEqual(buttons.map(node => node.props.action), [
    'hideControls', 'keyboard', 'reconnect', 'screen',
  ]);
  assert.equal(buttons[1].props.disabled, true);
  assert.equal(h.nodes().filter(node => node.type === 'GlassSurface').length, 1);
  assert.ok(buttons.every(node => node.props.compact), 'buttons share the capsule material');
  const scroll = h.nodes().find(node => node.type === 'ScrollView');
  assert.equal(scroll.props.keyboardShouldPersistTaps, 'always');
  assert.equal(scroll.props.keyboardDismissMode, 'none');
  assert.ok(scroll.props.style.some(style => style.height === 143));
  buttons.forEach(button => button.props.onPress());
  assert.deepEqual(h.calls, ['hide', 'keyboard', 'reconnect', 'exit']);
});
