const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/preview-zoom.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const previewZoom = {};
vm.runInNewContext(code, { exports: previewZoom, Number, Math });

test('zoom clamps to the candidate range and never exposes empty viewport space', () => {
  assert.equal(previewZoom.clampPreviewScale(Number.NaN), 1);
  assert.equal(previewZoom.clampPreviewScale(0.2), 1);
  assert.equal(previewZoom.clampPreviewScale(9), 4);
  const bounds = previewZoom.previewPanBounds({ width: 390, height: 844 }, 2);
  assert.equal(bounds.x, 195);
  assert.equal(bounds.y, 422);
  const pan = previewZoom.clampPreviewPan({ x: 500, y: -900 }, { width: 390, height: 844 }, 2);
  assert.equal(pan.x, 195);
  assert.equal(pan.y, -422);
});

test('reset scale has no pan and zero-sized viewports remain safe', () => {
  const bounds = previewZoom.previewPanBounds({ width: 0, height: 0 }, 1);
  assert.equal(bounds.x, 0);
  assert.equal(bounds.y, 0);
  const pan = previewZoom.clampPreviewPan({ x: 12, y: -4 }, { width: 0, height: 0 }, 1);
  assert.equal(pan.x, 0);
  assert.equal(pan.y, 0);
});
