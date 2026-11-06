const { withInfoPlist } = require('expo/config-plugins');
// The phone is the computer's microphone and speaker while connected; the audio
// background mode keeps both alive when the screen locks.
module.exports = config => withInfoPlist(config, config => {
  config.modResults.NSCameraUsageDescription = "Tomar una foto para enviarla a tu computadora.";
  config.modResults.NSMicrophoneUsageDescription = "Usar el micrófono del iPhone como micrófono de tu computadora.";
  config.modResults.UIBackgroundModes = [...new Set([...(config.modResults.UIBackgroundModes || []), 'audio'])];
  return config;
});
