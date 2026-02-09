module.exports = {
  projects: [
    '<rootDir>/services/*/jest.config.js',
    '<rootDir>/services/llm-agents/*/jest.config.js',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/cdk.out/',
    '/coverage/',
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/cdk.out/',
    '/coverage/',
  ],
};
