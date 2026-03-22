module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/main.ts',
    '!src/**/*.d.ts',
    '!src/processors/repo-indexing.ts',
  ],
  moduleNameMapper: {
    '^@pullmint/shared/(.+)$': '<rootDir>/../shared/$1',
    '^@pullmint/shared$': '<rootDir>/../shared/index',
  },
  coverageThreshold: {
    global: {
      branches: 76,
      functions: 91,
      lines: 95,
      statements: 94,
    },
  },
};
