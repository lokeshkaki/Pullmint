export interface DiffHunk {
  filePath: string;
  header: string;
  content: string;
  addedLines: number;
  removedLines: number;
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  rawHeader: string;
  rawContent: string;
}

export interface ParsedDiff {
  files: DiffFile[];
  totalFiles: number;
  totalAddedLines: number;
  totalRemovedLines: number;
}

export interface FilteredDiff {
  diff: string;
  includedFiles: number;
  excludedFiles: number;
  excludedFilePaths: string[];
  wasTruncated: boolean;
  originalCharCount: number;
}

const EXCLUSION_PATTERNS: Record<string, string[]> = {
  architecture: ['*.lock', '*.min.js', '*.min.css', '*.generated.*'],
  security: ['__tests__', '__mocks__', '*.test.*', '*.spec.*', '*.stories.*', '*.mock.*'],
  performance: ['*.md', '*.txt', '*.lock', 'LICENSE', 'CHANGELOG*', '*.stories.*'],
  style: ['*.lock', '*.min.js', '*.min.css', '*.generated.*', 'package-lock.json', 'yarn.lock'],
};

function globToRegExp(pattern: string): RegExp {
  // Exact filenames — match the segment exactly
  if (!pattern.includes('*')) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}$`, 'i');
  }

  // Glob patterns — tested against each path segment individually
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function extractPathFromHeader(header: string): string {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  if (!match) {
    return 'unknown';
  }

  return match[2];
}

function parseHunks(filePath: string, lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.startsWith('@@')) {
      index += 1;
      continue;
    }

    const header = line;
    const hunkLines: string[] = [line];
    index += 1;

    while (index < lines.length && !lines[index].startsWith('@@')) {
      hunkLines.push(lines[index]);
      index += 1;
    }

    let addedLines = 0;
    let removedLines = 0;
    for (const hunkLine of hunkLines.slice(1)) {
      if (hunkLine.startsWith('+') && !hunkLine.startsWith('+++')) {
        addedLines += 1;
      } else if (hunkLine.startsWith('-') && !hunkLine.startsWith('---')) {
        removedLines += 1;
      }
    }

    hunks.push({
      filePath,
      header,
      content: hunkLines.join('\n'),
      addedLines,
      removedLines,
    });
  }

  return hunks;
}

export function parseDiff(raw: string): ParsedDiff {
  if (!raw) {
    return {
      files: [],
      totalFiles: 0,
      totalAddedLines: 0,
      totalRemovedLines: 0,
    };
  }

  const lines = raw.split('\n');
  const files: DiffFile[] = [];

  let currentHeader = '';
  let currentLines: string[] = [];

  const finalizeCurrentFile = () => {
    if (!currentHeader) {
      return;
    }

    const path = extractPathFromHeader(currentHeader);
    const rawContent = currentLines.join('\n');
    const hunks = parseHunks(path, currentLines);

    files.push({
      path,
      hunks,
      rawHeader: currentHeader,
      rawContent,
    });

    currentHeader = '';
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git a/')) {
      finalizeCurrentFile();
      currentHeader = line;
      currentLines = [line];
      continue;
    }

    if (currentHeader) {
      currentLines.push(line);
    }
  }

  finalizeCurrentFile();

  let totalAddedLines = 0;
  let totalRemovedLines = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      totalAddedLines += hunk.addedLines;
      totalRemovedLines += hunk.removedLines;
    }
  }

  return {
    files,
    totalFiles: files.length,
    totalAddedLines,
    totalRemovedLines,
  };
}

export function getFileExclusions(agentType: string): RegExp[] {
  const patterns = EXCLUSION_PATTERNS[agentType];
  if (!patterns) {
    return [];
  }

  return patterns.map(globToRegExp);
}

function getChangeCount(file: DiffFile): number {
  return file.hunks.reduce((total, hunk) => total + hunk.addedLines + hunk.removedLines, 0);
}

function matchesAnyExclusion(path: string, exclusions: RegExp[]): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const segments = normalizedPath.split('/');

  return exclusions.some((regex) => segments.some((segment) => regex.test(segment)));
}

export function filterDiff(parsed: ParsedDiff, agentType: string, maxChars: number): FilteredDiff {
  const originalCharCount = parsed.files.map((file) => file.rawContent).join('\n').length;
  if (parsed.files.length === 0) {
    return {
      diff: '',
      includedFiles: 0,
      excludedFiles: 0,
      excludedFilePaths: [],
      wasTruncated: false,
      originalCharCount,
    };
  }

  const exclusions = getFileExclusions(agentType);

  const indexedFiles = parsed.files.map((file, index) => ({
    file,
    index,
    changeCount: getChangeCount(file),
  }));

  const excludedByPattern = indexedFiles.filter(({ file }) =>
    matchesAnyExclusion(file.path, exclusions)
  );
  const candidates = indexedFiles.filter(({ file }) => !matchesAnyExclusion(file.path, exclusions));

  const prioritized = [...candidates].sort((a, b) => {
    if (b.changeCount !== a.changeCount) {
      return b.changeCount - a.changeCount;
    }

    return a.index - b.index;
  });

  const selectedIndices = new Set<number>();
  const excludedBySize: string[] = [];
  let wasTruncated = false;
  let usedChars = 0;

  for (const candidate of prioritized) {
    const fileSize = candidate.file.rawContent.length;
    const nextUsedChars = usedChars === 0 ? fileSize : usedChars + 1 + fileSize;

    if (nextUsedChars <= maxChars) {
      selectedIndices.add(candidate.index);
      usedChars = nextUsedChars;
      continue;
    }

    wasTruncated = true;
    excludedBySize.push(candidate.file.path);
  }

  const includedFilesInOriginalOrder = candidates.filter(({ index }) => selectedIndices.has(index));
  const diff = includedFilesInOriginalOrder.map(({ file }) => file.rawContent).join('\n');

  const excludedFilePaths = [...excludedByPattern.map(({ file }) => file.path), ...excludedBySize];

  return {
    diff,
    includedFiles: includedFilesInOriginalOrder.length,
    excludedFiles: excludedFilePaths.length,
    excludedFilePaths,
    wasTruncated,
    originalCharCount,
  };
}

export function getMaxDiffChars(agentType: string): number {
  const defaults: Record<string, number> = {
    architecture: 100_000,
    security: 100_000,
    performance: 60_000,
    style: 60_000,
  };

  const envKey = `LLM_MAX_DIFF_CHARS_${agentType.toUpperCase()}`;
  const envValue = process.env[envKey];

  if (envValue) {
    const parsedValue = parseInt(envValue, 10);
    if (Number.isFinite(parsedValue) && parsedValue > 0) {
      return parsedValue;
    }
  }

  return defaults[agentType] ?? 60_000;
}

/**
 * Checks whether an absolute line number in the new file falls within
 * a diff hunk for the given file path. GitHub's PR Review API requires
 * that inline comments reference lines present in the diff.
 */
export function isLineInDiff(parsed: ParsedDiff, filePath: string, absoluteLine: number): boolean {
  const file = parsed.files.find((f) => f.path === filePath);
  if (!file) {
    return false;
  }

  for (const hunk of file.hunks) {
    // Parse @@ -X,Y +A,B @@ header to extract new-file range
    const match = hunk.header.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) {
      continue;
    }

    const newStart = parseInt(match[1], 10);
    const newCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;

    if (absoluteLine >= newStart && absoluteLine < newStart + newCount) {
      return true;
    }
  }

  return false;
}
