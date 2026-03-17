import { detectModules } from '../module-detector';

describe('detectModules', () => {
  it('identifies directories with an entry point and ≥3 source files as modules', () => {
    const files = [
      'src/auth/index.ts',
      'src/auth/middleware.ts',
      'src/auth/jwt.ts',
      'src/auth/types.ts',
      'src/utils.ts', // top-level, not a module
    ];
    const modules = detectModules(files);
    expect(modules).toHaveLength(1);
    expect(modules[0].modulePath).toBe('src/auth');
    expect(modules[0].entryPoint).toBe('src/auth/index.ts');
    expect(modules[0].files).toHaveLength(4);
  });

  it('requires an entry point file to qualify as a module', () => {
    const files = [
      'src/helpers/a.ts',
      'src/helpers/b.ts',
      'src/helpers/c.ts',
      // no index.ts
    ];
    const modules = detectModules(files);
    expect(modules).toHaveLength(0);
  });

  it('ignores non-source files and dotfiles when counting module files', () => {
    const files = [
      'src/auth/index.ts',
      'src/auth/middleware.ts',
      'src/auth/jwt.ts',
      'src/auth/.gitkeep', // dotfile — not a source file
      'src/auth/README', // extensionless — not a source file
    ];
    const modules = detectModules(files);
    expect(modules).toHaveLength(1);
    expect(modules[0].files).toHaveLength(3); // only the 3 .ts files
  });

  it('skips top-level files with no parent directory', () => {
    // 'README.md' has only one path segment — no directory to group into
    const files = ['README.md', 'src/auth/index.ts', 'src/auth/middleware.ts', 'src/auth/jwt.ts'];
    const modules = detectModules(files);
    expect(modules).toHaveLength(1);
    expect(modules[0].modulePath).toBe('src/auth');
  });

  it('handles multiple modules at different nesting levels', () => {
    const files = [
      'services/auth/index.ts',
      'services/auth/handler.ts',
      'services/auth/utils.ts',
      'services/billing/index.ts',
      'services/billing/handler.ts',
      'services/billing/stripe.ts',
    ];
    const modules = detectModules(files);
    expect(modules).toHaveLength(2);
    expect(modules.map((m) => m.modulePath).sort()).toEqual(['services/auth', 'services/billing']);
  });
});
