const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const fixture = require('./media-fixture.cjs');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/media-capabilities.ts'), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports: exportsObject});
const {parseMediaCapabilities, selectVideoCodec, MediaBinding} = exportsObject;

test('legacy metadata remains absent and measured capture pixels differ from encoder bounds', () => {
  assert.equal(parseMediaCapabilities(undefined), null);
  const media = parseMediaCapabilities(fixture());
  assert.equal(media.geometry.width, 2731);
  assert.equal(media.geometry.encodedWidth, 1920);
  assert.equal(selectVideoCodec(media), 'H264');
});

test('metadata rejects invented, inconsistent, unsafe or explicitly null geometry', () => {
  for (const mutate of [m => {m.version = 2;}, m => {m.source.id = '../node';}, m => {m.geometry.epoch = 0;},
    m => {m.geometry.epoch = Number.MAX_SAFE_INTEGER + 1;}, m => {m.geometry.width = 0;},
    m => {m.geometry.width = 32769;}, m => {m.geometry.height = 10.2;}, m => {m.geometry.state = 'unknown';},
    m => {m.source.state = 'unavailable';}, m => {m.video.selectedCodec = 'H265';}, m => {m.video.codecs = [];},
    m => {m.video.codecs = ['H264', 'H264'];}, m => {m.geometry.reason = null;}]) {
    const media = fixture(); mutate(media); assert.throws(() => parseMediaCapabilities(media));
  }
  assert.throws(() => parseMediaCapabilities(null));
  const unknown = {version: 1, source: {state: 'unknown'}, geometry: {state: 'unknown'}, video: {state: 'unknown'}};
  assert.equal(parseMediaCapabilities(unknown).geometry.width, undefined);
  assert.equal(selectVideoCodec(unknown), 'H264');
  unknown.video = {state: 'available', codecs: ['H265']};
  assert.throws(() => selectVideoCodec(parseMediaCapabilities(unknown)));
});

test('source binding never applies geometry from another source or reuses an epoch with different dimensions', () => {
  const binding = new MediaBinding(); binding.accept(fixture());
  assert.equal(binding.coordinates().sourceId, 'source-a');
  assert.equal(binding.coordinates().geometryEpoch, 1);
  const changed = fixture(); changed.geometry.width = 3000;
  assert.throws(() => binding.accept(changed));
  changed.geometry.epoch = 2; binding.accept(changed);
  assert.equal(binding.coordinates().geometryEpoch, 2);
  assert.throws(() => binding.accept(fixture()));
  assert.throws(() => binding.accept(fixture(3, 'source-b')));
  assert.throws(() => binding.accept(undefined));
  binding.accept({version: 1, source: {state: 'unknown'}, geometry: {state: 'unknown'}, video: {state: 'unknown'}});
  assert.equal(binding.coordinates().geometryEpoch, undefined);
  assert.throws(() => binding.accept(fixture(1, 'source-b')));
});
