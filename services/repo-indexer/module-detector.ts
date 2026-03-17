import * as nodePath from 'path';

const ENTRY_POINT_NAMES = new Set([
  'index.ts',
  'index.js',
  'index.tsx',
  '__init__.py',
  'mod.rs',
  'main.ts',
  'main.go',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.py', '.go', '.rs']);
const MIN_FILES_PER_MODULE = 3;

export interface ModuleBoundary {
  modulePath: string;
  entryPoint: string;
  files: string[];
}

/**
 * Detect module boundaries from a flat file list.
 * A module is a directory with ≥MIN_FILES_PER_MODULE source files and a known entry point.
 */
export function detectModules(filePaths: string[]): ModuleBoundary[] {
  const dirMap = new Map<string, string[]>();

  for (const fp of filePaths) {
    const parts = fp.split('/');
    if (parts.length < 2) continue;
    const dir = parts.slice(0, -1).join('/');
    const existing = dirMap.get(dir) ?? [];
    existing.push(fp);
    dirMap.set(dir, existing);
  }

  const modules: ModuleBoundary[] = [];

  for (const [dir, files] of dirMap.entries()) {
    const sourceFiles = files.filter((f) => {
      const ext = nodePath.extname(f); // safely returns '' for extensionless files and dotfiles
      return SOURCE_EXTENSIONS.has(ext);
    });

    if (sourceFiles.length < MIN_FILES_PER_MODULE) continue;

    const entryPoint = sourceFiles.find((f) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const filename = f.split('/').pop()!;
      return ENTRY_POINT_NAMES.has(filename);
    });

    if (!entryPoint) continue;

    modules.push({ modulePath: dir, entryPoint, files: sourceFiles });
  }

  return modules;
}
