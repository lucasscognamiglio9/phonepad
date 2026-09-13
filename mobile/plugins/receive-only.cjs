const { withInfoPlist } = require('expo/config-plugins');
// Desktop video is receive-only. Camera is used only for an explicit photo.
module.exports = config => withInfoPlist(config, config => {
  config.modResults.NSCameraUsageDescription = "Tomar una foto para enviarla a tu computadora.";
  delete config.modResults.NSMicrophoneUsageDescription;
  return config;
});
