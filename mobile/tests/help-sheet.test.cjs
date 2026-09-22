const appearanceModule = require('./appearance-fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/components/help-sheet.tsx'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function load() {
  const exports = {};
  const jsx = (type, props) => ({ type, props: props || {} });
  const modules = { './appearance': appearanceModule, '../components/appearance': appearanceModule,
    'react-native': {
      Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', StyleSheet: { create: styles => styles },
      Text: 'Text', View: 'View',
    },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 10, right: 4, bottom: 12, left: 6 }) },
    './glass-button': {GlassButton: 'GlassButton'}, './glass-surface': { GlassSurface: 'GlassSurface' },
    'react/jsx-runtime': { jsx, jsxs: jsx },
  };
  vm.runInNewContext(code, { exports, require: name => modules[name] });
  return exports.HelpSheet;
}

function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}

test('help sheet is accessible, describes visible controls, and closes without side effects', () => {
  const HelpSheet = load();
  let closes = 0;
  const tree = HelpSheet({ visible: true, close: () => { closes++; }, mode: 'trackpad' });
  const all = nodes(tree);
  const modal = all.find(node => node.type === 'Modal');
  assert.equal(modal.props.visible, true);
  assert.equal(modal.props.presentationStyle, 'pageSheet');
  assert.equal(modal.props.supportedOrientations.join(','), 'portrait,landscape');
  assert.equal(all.find(node => node.type === 'ScrollView').props.accessibilityLabel, 'Ayuda de PhonePad');
  const text = all.filter(node => node.type === 'Text').map(node => node.props.children).filter(value => typeof value === 'string').join(' ');
  assert.match(text, /Modos y zoom/);
  assert.match(text, /Escribir y pegar/);
  const close = all.find(node => node.props.label === 'Cerrar ayuda');
  close.props.onPress();
  assert.equal(closes, 1);
});

test('hidden help sheet remains unpresented and direct mode copy is explicit', () => {
  const HelpSheet = load();
  const tree = HelpSheet({ visible: false, close() {}, mode: 'direct' });
  const all = nodes(tree);
  assert.equal(all.find(node => node.type === 'Modal').props.visible, false);
  const text = JSON.stringify(all.filter(node => node.type === 'Text').map(node => node.props.children));
  assert.match(text, /Directo/);
});
