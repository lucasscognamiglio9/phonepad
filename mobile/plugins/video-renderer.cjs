const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod, withInfoPlist } = require('expo/config-plugins');
const marker = '// PHONEPAD_VIDEO_RENDERER_V1';

function patchRenderer(source, implementation) {
  if (source.includes(marker)) return source;
  const anchor = '@interface RTCVideoView : RCTView<RTCVideoViewDelegate>';
  const allocation = 'RTCMTLVideoView *subview = [[RTCMTLVideoView alloc] initWithFrame:CGRectZero];';
  if (source.split(anchor).length !== 2 || source.split(allocation).length !== 2) {
    throw Error('Phonepad: WebRTC renderer changed; review native integration before building.');
  }
  return source.replace(anchor, `${marker}\n#import <MetalKit/MetalKit.h>\n#import <math.h>\n${implementation}\n${anchor}`)
    .replace(allocation, 'RTCMTLVideoView *subview = [[PhonepadVideoView alloc] initWithFrame:CGRectZero];');
}

module.exports = config => {
  config = withInfoPlist(config, config => {
    config.modResults.CADisableMinimumFrameDurationOnPhone = true;
    return config;
  });
  return withDangerousMod(config, ['ios', async config => {
    const packageFile = require.resolve('@livekit/react-native-webrtc/package.json', {
      paths: [config.modRequest.projectRoot],
    });
    const target = path.join(path.dirname(packageFile), 'ios/RCTWebRTC/RTCVideoViewManager.m');
    const implementation = fs.readFileSync(path.join(__dirname, 'PhonepadVideoView.inc'), 'utf8');
    const original = fs.readFileSync(target, 'utf8');
    const patched = patchRenderer(original, implementation);
    if (patched !== original) fs.writeFileSync(target, patched);
    return config;
  }]);
};
module.exports.patchRenderer = patchRenderer;
