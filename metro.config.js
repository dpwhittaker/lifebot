const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // whisper.rn ships a malformed package.json `exports` field (the "react-native"
    // condition value is missing the leading "./"), which makes Metro fail on deep
    // subpath imports like `whisper.rn/realtime-transcription/adapters/...`.
    // Disabling package exports falls back to the legacy `react-native`/`main` field
    // resolution, which handles whisper.rn's subpaths correctly.
    unstable_enablePackageExports: false,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
