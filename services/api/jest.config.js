module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/server.ts',
  ],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    './src/routes/dashboard.ts': {
      branches: 65,
      functions: 100,
      lines: 85,
      statements: 85,
    },
    './src/routes/webhook.ts': {
      branches: 75,
      functions: 100,
      lines: 95,
      statements: 95,
    },
    './src/routes/signals.ts': {
      branches: 80,
      functions: 100,
      lines: 95,
      statements: 95,
    },
    './src/routes/health.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};
