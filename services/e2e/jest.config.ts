import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  globalSetup: './src/setup.ts',
  globalTeardown: './src/teardown.ts',
  setupFiles: ['./src/test-env.ts'],
  testTimeout: 90000,
  moduleNameMapper: {
    '^@pullmint/shared/(.+)$': '<rootDir>/../shared/$1',
    '^@pullmint/shared$': '<rootDir>/../shared/index',
  },
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  // Sequential: shared infra, unique IDs per test but avoid concurrency issues
  maxWorkers: 1,
};

export default config;
