const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  { files: ['tests/**/*.cjs', 'scripts/**/*.cjs', 'plugins/**/*.{js,cjs}'], languageOptions: { globals: globals.node } },
  {
    // These rules check code for the React Compiler, which the app does not use.
    // They flag every Reanimated shared value write as a mutation.
    rules: {
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/use-memo': 'off',
    },
  },
  { ignores: ['dist/*', 'ios/*', 'android/*', 'web-core/*', 'vendor/*'] },
]);
