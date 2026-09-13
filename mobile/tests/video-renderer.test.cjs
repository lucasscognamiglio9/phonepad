const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { patchRenderer } = require('../plugins/video-renderer.cjs');
const implementation = fs.readFileSync(path.join(__dirname, '../plugins/PhonepadVideoView.inc'), 'utf8');
const source = fs.readFileSync(require.resolve('@livekit/react-native-webrtc/ios/RCTWebRTC/RTCVideoViewManager.m'), 'utf8');
test('native renderer patch matches the installed dependency and is idempotent', () => {
  const patched = patchRenderer(source, implementation);
  assert.match(patched, /\[\[PhonepadVideoView alloc\]/);
  assert.equal(patchRenderer(patched, implementation), patched);
});
test('an upstream renderer change fails the build instead of silently retaining a cap', () => {
  assert.throws(() => patchRenderer('', implementation), /renderer changed/);
});
