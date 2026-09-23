const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('switching computers remounts a fresh session and opens its preview', () => {
  const state = []; let cursor = 0;
  const modules = {
    react: { useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = value; }];
    } },
    'react/jsx-runtime': { jsx: (type, props, key) => ({type, props, key}) },
    '../screens/control': {Control: 'Control'},
    '../screens/host-picker': {HostPicker: 'HostPicker'},
  };
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/app/index.tsx'), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
  }).outputText;
  vm.runInNewContext(code, {exports, require: name => modules[name]});
  const render = () => { cursor = 0; return exports.default(); };
  let tree = render();
  assert.equal(tree.type, 'HostPicker');
  tree.props.onSelect('https://first.example'); tree = render();
  assert.equal(tree.type, 'Control');
  assert.equal(tree.props.initialPreview, false);
  assert.equal(tree.key, 'https://first.example');
  tree.props.onSelectHost('https://second.example'); tree = render();
  assert.equal(tree.props.origin, 'https://second.example');
  assert.equal(tree.key, 'https://second.example', 'a different host gets a fresh session and editor');
  assert.equal(tree.props.initialPreview, true);
});
