module.exports = function mediaFixture(epoch = 1, source = 'source-a') {
  return {version: 1, source: {state: 'available', id: source, kind: 'portal'},
    geometry: {state: 'available', epoch, width: 2731, height: 1537, encodedWidth: 1920, encodedHeight: 1080},
    video: {state: 'available', codecs: ['H264'], selectedCodec: 'H264'}};
};
