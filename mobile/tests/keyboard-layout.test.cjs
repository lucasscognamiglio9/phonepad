const appearanceModule = require('./appearance-fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/components/keyboard-layout.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const layout = {};
vm.runInNewContext(compiled, { exports: layout, require: () => appearanceModule });

test('available height is measured from window, safe area and current keyboard overlap', () => {
  assert.equal(layout.keyboardOverlap(320, 844), 320);
  assert.equal(layout.keyboardOverlap(1200, 844), 844);
  assert.equal(layout.keyboardOverlap(336, 508, 336), 0);
  assert.equal(layout.keyboardOverlap(Number.NaN, 844), 0);
  assert.equal(layout.keyboardWindowResize(844, 508, true), 336);
  assert.equal(layout.keyboardWindowResize(844, 508, false), 0);
  assert.equal(layout.keyboardStickyOpenedOffset(336, 46), 374);
  assert.equal(layout.keyboardAvailableHeight({
    viewportHeight: 844, safeAreaTop: 54, keyboardHeight: 0, closedBottomInset: 46,
  }), 744);
  assert.equal(layout.keyboardAvailableHeight({
    viewportHeight: 844, safeAreaTop: 54, keyboardHeight: 336, closedBottomInset: 46,
  }), 446);
  assert.equal(layout.keyboardAvailableHeight({
    viewportHeight: 390, safeAreaTop: 0, keyboardHeight: 600, closedBottomInset: 46,
  }), 0);
});

test('editor and extras budgets follow measured action bar instead of orientation caps', () => {
  const portrait = layout.keyboardAvailableHeight({
    viewportHeight: 844, safeAreaTop: 54, keyboardHeight: 336, closedBottomInset: 46,
  });
  const landscape = layout.keyboardAvailableHeight({
    viewportHeight: 390, safeAreaTop: 0, keyboardHeight: 260, closedBottomInset: 46,
  });
  assert.equal(layout.editorMaxHeight(portrait, 52), 386);
  assert.equal(layout.editorMaxHeight(landscape, 52), 62);
  assert.equal(layout.extrasMaxHeight(portrait, 96, 52), 290);
  assert.equal(layout.extrasMaxHeight(landscape, 96, 52), 0);
  assert.ok(layout.editorMaxHeight(0, 0) >= layout.MIN_TOUCH_TARGET);
  assert.equal(layout.extrasMaxHeight(-1, 100, 60), 0);
});
