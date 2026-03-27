module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  moduleNameMapper: {
    '^@pullmint/shared/(.+)$': '<rootDir>/../services/shared/$1',
    '^@pullmint/shared$': '<rootDir>/../services/shared/index'
  }
};