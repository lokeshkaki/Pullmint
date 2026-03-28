module.exports = {
  extends: ['../../.eslintrc.json'],
  parserOptions: {
    project: './tsconfig.eslint.json',
    tsconfigRootDir: __dirname
  },
  ignorePatterns: ['dist', 'node_modules']
};
