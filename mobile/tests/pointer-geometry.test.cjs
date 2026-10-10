const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load() {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(
    path.join(__dirname, '../src/lib/pointer-geometry.ts'), 'utf8',
  ), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, Number, Math });
  return exports;
}

const { LEGACY_POINTER_GEOMETRY, SQUARE_POINTER_GEOMETRY, mapPointerToContact, selectPointerGeometry } = load();

function capabilities(pointerGeometry) {
  return { input: { pointerGeometry } };
}

test('pointer geometry consumes only the applied server profile', () => {
  const selection = selectPointerGeometry(capabilities({
    version: 1,
    supportedProfiles: [{ id: 'square-centered', kind: 'square-centered', sideMm: 100, gainMmPerPoint: .12,
      gainSource: 'calibrated', gainMinMmPerPoint: .08, gainMaxMmPerPoint: .16 }],
    applied: { id: 'legacy-100x70', geometryEpoch: 4 },
  }));
  assert.equal(selection.profileId, 'legacy-100x70');
  assert.equal(selection.geometryEpoch, 4);
  assert.deepEqual(selection.geometry, LEGACY_POINTER_GEOMETRY);
});

test('pointer geometry accepts a calibrated applied square profile within bounds', () => {
  const selection = selectPointerGeometry(capabilities({
    version: 1,
    supportedProfiles: [{ id: 'square-centered', kind: 'square-centered', sideMm: 100, gainMmPerPoint: .12,
      gainSource: 'calibrated', gainMinMmPerPoint: .08, gainMaxMmPerPoint: .16 }],
    applied: { id: 'square-centered', geometryEpoch: 9 },
  }));
  assert.equal(selection.profileId, 'square-centered');
  assert.equal(selection.geometryEpoch, 9);
  assert.deepEqual(JSON.parse(JSON.stringify(selection.geometry)), { kind: 'square-centered', sideMm: 100, gainMmPerPoint: .12 });
});

test('fixture gain or an out-of-range applied profile never activates square mapping', () => {
  for (const profile of [
    { id: 'square-centered', kind: 'square-centered', sideMm: 100, gainMmPerPoint: 100 / 844,
      gainSource: 'fixture', gainMinMmPerPoint: .08, gainMaxMmPerPoint: .16 },
    { id: 'square-centered', kind: 'square-centered', sideMm: 100, gainMmPerPoint: .2,
      gainSource: 'calibrated', gainMinMmPerPoint: .08, gainMaxMmPerPoint: .16 },
  ]) {
    const selection = selectPointerGeometry(capabilities({ version: 1,
      supportedProfiles: [profile], applied: { id: 'square-centered', geometryEpoch: 3 } }));
    assert.equal(selection.profileId, 'legacy-100x70');
    assert.deepEqual(selection.geometry, LEGACY_POINTER_GEOMETRY);
  }
});

test('square mapper clamps malformed points to the protocol contact range', () => {
  const below = mapPointerToContact({id: 1, x: -100, y: -1}, {width: 844, height: 844}, SQUARE_POINTER_GEOMETRY);
  const above = mapPointerToContact({id: 1, x: 1200, y: 1200}, {width: 844, height: 844}, SQUARE_POINTER_GEOMETRY);
  assert.deepEqual(JSON.parse(JSON.stringify(below)), {id: 1, x: 0, y: 0});
  assert.deepEqual(JSON.parse(JSON.stringify(above)), {id: 1, x: 1, y: 1});
});
