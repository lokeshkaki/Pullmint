import {
  parseDiff,
  getFileExclusions,
  filterDiff,
  getMaxDiffChars,
  isLineInDiff,
  type ParsedDiff,
} from '../src/diff-filter';

describe('parseDiff', () => {
  it('parses a simple two-file diff into DiffFile objects', () => {
    const raw = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '+added line',
      ' line3',
      'diff --git a/src/utils.ts b/src/utils.ts',
      '--- a/src/utils.ts',
      '+++ b/src/utils.ts',
      '@@ -10,3 +10,2 @@',
      ' existing',
      '-removed',
      ' after',
    ].join('\n');

    const result = parseDiff(raw);
    expect(result.totalFiles).toBe(2);
    expect(result.files[0].path).toBe('src/index.ts');
    expect(result.files[1].path).toBe('src/utils.ts');
    expect(result.totalAddedLines).toBe(1);
    expect(result.totalRemovedLines).toBe(1);
  });

  it('handles empty diff string', () => {
    const result = parseDiff('');
    expect(result.totalFiles).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('handles diff with multiple hunks per file', () => {
    const raw = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,2 +1,3 @@',
      ' line1',
      '+add one',
      '@@ -10,2 +11,3 @@',
      ' line10',
      '-remove one',
      '+add two',
    ].join('\n');

    const result = parseDiff(raw);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].hunks).toHaveLength(2);
    expect(result.totalAddedLines).toBe(2);
    expect(result.totalRemovedLines).toBe(1);
  });
});

describe('getFileExclusions', () => {
  it('returns test-related patterns for security agent', () => {
    const exclusions = getFileExclusions('security');
    // Matches test files by extension
    expect(exclusions.some((re) => re.test('foo.test.ts'))).toBe(true);
    expect(exclusions.some((re) => re.test('foo.spec.ts'))).toBe(true);
    // Matches __tests__ directory segment
    expect(exclusions.some((re) => re.test('__tests__'))).toBe(true);
    // Does NOT match normal source files
    expect(exclusions.some((re) => re.test('index.ts'))).toBe(false);
    // Does NOT false-positive on filenames containing "test" as substring
    expect(exclusions.some((re) => re.test('latest-config.ts'))).toBe(false);
    expect(exclusions.some((re) => re.test('attest.ts'))).toBe(false);
  });

  it('returns lock file patterns for style agent', () => {
    const exclusions = getFileExclusions('style');
    expect(exclusions.some((re) => re.test('package-lock.json'))).toBe(true);
  });

  it('returns empty array for unknown agent type', () => {
    expect(getFileExclusions('unknown')).toEqual([]);
  });
});

function buildParsedDiff(
  files: Array<{ path: string; body: string; changeCount?: number }>
): ParsedDiff {
  const parsedFiles = files.map((file) => {
    const hunk = [
      '@@ -1,1 +1,1 @@',
      ...Array.from({ length: file.changeCount ?? 1 }, (_, i) => `+line ${i}`),
    ].join('\n');
    const rawContent = [
      `diff --git a/${file.path} b/${file.path}`,
      `--- a/${file.path}`,
      `+++ b/${file.path}`,
      hunk,
      file.body,
    ].join('\n');

    return {
      path: file.path,
      rawHeader: `diff --git a/${file.path} b/${file.path}`,
      rawContent,
      hunks: [
        {
          filePath: file.path,
          header: '@@ -1,1 +1,1 @@',
          content: hunk,
          addedLines: file.changeCount ?? 1,
          removedLines: 0,
        },
      ],
    };
  });

  return {
    files: parsedFiles,
    totalFiles: parsedFiles.length,
    totalAddedLines: parsedFiles.reduce((sum, file) => sum + file.hunks[0].addedLines, 0),
    totalRemovedLines: 0,
  };
}

describe('filterDiff', () => {
  it('excludes files matching agent-specific patterns', () => {
    const parsed = buildParsedDiff([
      { path: 'src/__tests__/foo.test.ts', body: 'test body' },
      { path: 'src/main.ts', body: 'main body' },
    ]);

    const result = filterDiff(parsed, 'security', 50_000);

    expect(result.diff).toContain('src/main.ts');
    expect(result.diff).not.toContain('src/__tests__/foo.test.ts');
    expect(result.excludedFiles).toBe(1);
    expect(result.excludedFilePaths).toContain('src/__tests__/foo.test.ts');
  });

  it('truncates by dropping least-changed files when over maxChars', () => {
    const parsed = buildParsedDiff([
      { path: 'src/largest.ts', body: 'A'.repeat(220), changeCount: 10 },
      { path: 'src/medium.ts', body: 'B'.repeat(140), changeCount: 6 },
      { path: 'src/small.ts', body: 'C'.repeat(40), changeCount: 1 },
    ]);

    const maxChars = parsed.files[0].rawContent.length + parsed.files[1].rawContent.length + 1;
    const result = filterDiff(parsed, 'architecture', maxChars);

    expect(result.diff).toContain('src/largest.ts');
    expect(result.diff).toContain('src/medium.ts');
    expect(result.diff).not.toContain('src/small.ts');
    expect(result.excludedFilePaths).toContain('src/small.ts');
    expect(result.wasTruncated).toBe(true);
  });

  it('never splits hunks within a file', () => {
    const parsed = buildParsedDiff([
      { path: 'src/large.ts', body: 'X'.repeat(800), changeCount: 25 },
    ]);
    const result = filterDiff(parsed, 'architecture', 100);

    expect(result.diff).toBe('');
    expect(result.includedFiles).toBe(0);
    expect(result.excludedFilePaths).toContain('src/large.ts');
    expect(result.wasTruncated).toBe(true);
  });

  it('returns complete diff when under maxChars', () => {
    const parsed = buildParsedDiff([
      { path: 'src/one.ts', body: 'small', changeCount: 1 },
      { path: 'src/two.ts', body: 'small', changeCount: 1 },
    ]);

    const result = filterDiff(parsed, 'architecture', 50_000);

    expect(result.wasTruncated).toBe(false);
    expect(result.excludedFiles).toBe(0);
    expect(result.includedFiles).toBe(2);
  });

  it('excludes files matching user ignore paths', () => {
    const parsed = buildParsedDiff([
      { path: 'generated/client.ts', body: 'generated body', changeCount: 3 },
      { path: 'src/app.ts', body: 'app body', changeCount: 2 },
    ]);

    const result = filterDiff(parsed, 'architecture', 50_000, ['generated/**']);

    expect(result.diff).toContain('src/app.ts');
    expect(result.diff).not.toContain('generated/client.ts');
    expect(result.excludedFilePaths).toContain('generated/client.ts');
  });

  it('does not change behavior for an empty ignore path list', () => {
    const parsed = buildParsedDiff([
      { path: 'src/one.ts', body: 'small', changeCount: 1 },
      { path: 'src/two.ts', body: 'small', changeCount: 1 },
    ]);

    const withoutIgnorePaths = filterDiff(parsed, 'architecture', 50_000);
    const withEmptyIgnorePaths = filterDiff(parsed, 'architecture', 50_000, []);

    expect(withEmptyIgnorePaths).toEqual(withoutIgnorePaths);
  });

  it('does not change behavior when ignore paths are undefined', () => {
    const parsed = buildParsedDiff([
      { path: 'src/one.ts', body: 'small', changeCount: 1 },
      { path: 'src/two.ts', body: 'small', changeCount: 1 },
    ]);

    const withoutIgnorePaths = filterDiff(parsed, 'architecture', 50_000);
    const withUndefinedIgnorePaths = filterDiff(parsed, 'architecture', 50_000, undefined);

    expect(withUndefinedIgnorePaths).toEqual(withoutIgnorePaths);
  });

  it('preserves original diff ordering in output', () => {
    const parsed = buildParsedDiff([
      { path: 'src/first.ts', body: 'first body', changeCount: 2 },
      { path: 'src/second.ts', body: 'second body', changeCount: 12 },
      { path: 'src/third.ts', body: 'third body', changeCount: 4 },
    ]);

    const result = filterDiff(parsed, 'architecture', 50_000);
    const firstIndex = result.diff.indexOf('src/first.ts');
    const secondIndex = result.diff.indexOf('src/second.ts');
    const thirdIndex = result.diff.indexOf('src/third.ts');

    expect(firstIndex).toBeLessThan(secondIndex);
    expect(secondIndex).toBeLessThan(thirdIndex);
  });
});

describe('isLineInDiff', () => {
  const rawDiff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,5 +10,7 @@ function existing() {
 unchanged line
+added line 1
+added line 2
 unchanged line
`;

  it('returns true for a line within a hunk range', () => {
    const parsed = parseDiff(rawDiff);
    expect(isLineInDiff(parsed, 'src/foo.ts', 11)).toBe(true);
  });

  it('returns false for a line outside all hunks', () => {
    const parsed = parseDiff(rawDiff);
    expect(isLineInDiff(parsed, 'src/foo.ts', 50)).toBe(false);
  });

  it('returns false for an unknown file path', () => {
    const parsed = parseDiff(rawDiff);
    expect(isLineInDiff(parsed, 'src/bar.ts', 11)).toBe(false);
  });

  it('returns false for empty parsed diff', () => {
    const empty: ParsedDiff = {
      files: [],
      totalFiles: 0,
      totalAddedLines: 0,
      totalRemovedLines: 0,
    };
    expect(isLineInDiff(empty, 'src/foo.ts', 10)).toBe(false);
  });
});

describe('getMaxDiffChars', () => {
  afterEach(() => {
    delete process.env.LLM_MAX_DIFF_CHARS_SECURITY;
    delete process.env.LLM_MAX_DIFF_CHARS_PERFORMANCE;
  });

  it('returns 100000 for architecture agent by default', () => {
    expect(getMaxDiffChars('architecture')).toBe(100_000);
  });

  it('reads from environment variable when set', () => {
    process.env.LLM_MAX_DIFF_CHARS_SECURITY = '50000';
    expect(getMaxDiffChars('security')).toBe(50_000);
  });

  it('ignores invalid environment values', () => {
    process.env.LLM_MAX_DIFF_CHARS_PERFORMANCE = 'not-a-number';
    expect(getMaxDiffChars('performance')).toBe(60_000);
  });
});
