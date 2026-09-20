const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('one app switches between saved origins and returning to the picker does not reconnect automatically', () => {
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
  assert.equal(tree.props.autoSelect, true);
  for (const origin of ['https://first.example', 'https://second.example:8443']) {
    tree.props.onSelect(origin); tree = render();
    assert.equal(tree.type, 'Control');
    assert.equal(tree.props.origin, origin);
    assert.equal(tree.key, origin, 'a different host gets a fresh session and editor');
    tree.props.onChangeHost(); tree = render();
    assert.equal(tree.type, 'HostPicker');
    assert.equal(tree.props.autoSelect, false);
  }
});
