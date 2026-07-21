// Only used by Jest, and only to transpile the handful of ESM-only
// node_modules packages (`ai`, `@ai-sdk/*`, `@chonkiejs/*`) that ship no
// CommonJS build — see jest.config.js's `transformIgnorePatterns`. Our own
// source is compiled by ts-jest, not Babel.
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }], '@babel/preset-typescript'],
  // @chonkiejs/chunk references `import.meta.url` (for WASM asset loading);
  // preset-env's commonjs transform doesn't rewrite that expression on its
  // own, so without this plugin the transpiled output still throws at
  // runtime under Node's CommonJS loader.
  plugins: ['babel-plugin-transform-import-meta'],
};
