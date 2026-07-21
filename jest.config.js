/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/index.ts'],
  coverageDirectory: '<rootDir>/coverage',
  setupFilesAfterEnv: [],
  testTimeout: 30000,
  verbose: true,
  // `ai` and `@chonkiejs/*` ship ESM-only builds with no CommonJS entry
  // point, so the default "don't transform node_modules" behavior breaks
  // `require()`. We transform our own TS with ts-jest and transform just
  // those specific ESM packages (plus their ESM-only transitive deps) with
  // babel-jest, converting them to CommonJS on the fly for Jest.
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.jsx?$': 'babel-jest',
  },
  // `ai` and `@chonkiejs/*` pull in a deep, ever-changing tree of ESM-only
  // transitive dependencies (`@ai-sdk/*`, `@workflow/*`, ...) with no
  // CommonJS build. Rather than chase each one by name, transform all of
  // node_modules — babel-jest is a safe no-op-ish pass over already-valid
  // CommonJS code, and the one-time cost is amortized by Jest's transform
  // cache across runs.
  transformIgnorePatterns: [],
};
