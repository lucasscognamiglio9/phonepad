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
    './appearance': require('./appearance-fixture.cjs'),
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
    './appearance': require('./appearance-fixture.cjs'),
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
    openOptions: () => calls.push('mouse'),
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

test('three permanent actions share real glass while exit stays separate',()=>{
 const h=componentHarness();const buttons=h.nodes().filter(n=>n.type==='GlassButton');
 assert.deepEqual(buttons.map(n=>n.props.label),['Teclado','Reconectar','Mouse','Ocultar pantalla']);
 const scroll=h.nodes().find(n=>n.type==='ScrollView');
 assert.deepEqual(Array.from(scroll.props.children,n=>n.props.action),['keyboard','reconnect','mouse']);
 buttons.forEach(n=>n.props.onPress());assert.deepEqual(h.calls,['keyboard','reconnect','mouse','exit']);
 assert.equal(h.nodes().filter(n=>n.type==='GlassSurface').length,1);
});
