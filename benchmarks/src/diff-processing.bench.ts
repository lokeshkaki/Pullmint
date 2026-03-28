// benchmarks/src/diff-processing.bench.ts
import { registerSuite } from './harness';
import { generateDiff, generateDiffBySize } from './generators';
import {
  parseDiff,
  filterDiff,
  getChangedFiles,
  isLineInDiff,
} from '../../services/shared/diff-filter';

// Pre-generate diffs outside benchmark loops to measure only the function under test
const smallRaw = generateDiffBySize('small').raw;
const mediumRaw = generateDiffBySize('medium').raw;
const largeRaw = generateDiffBySize('large').raw;
const xlRaw = generateDiffBySize('xl').raw;

const mediumParsed = parseDiff(mediumRaw);
const largeParsed = parseDiff(largeRaw);

// For getChangedFiles: generate two diffs with ~10% and ~90% overlap
const baseRaw = generateDiff(50, 30);
const baseParsed = parseDiff(baseRaw);
// Similar diff: regenerate same files with minor changes
const similarRaw = baseRaw.replace(/\+word/g, '+wordx');
const similarParsed = parseDiff(similarRaw);
// Very different diff: entirely new files
const differentRaw = generateDiff(50, 30);
const differentParsed = parseDiff(differentRaw);

registerSuite({
  name: 'diff-processing',
  iterations: 200,
  tasks: [
    {
      name: 'parseDiff — small (5 files, ~50 lines)',
      tags: ['cpu'],
      fn: () => {
        parseDiff(smallRaw);
      },
    },
    {
      name: 'parseDiff — medium (20 files, ~500 lines)',
      tags: ['cpu'],
      fn: () => {
        parseDiff(mediumRaw);
      },
    },
    {
      name: 'parseDiff — large (100 files, ~5000 lines)',
      tags: ['cpu'],
      fn: () => {
        parseDiff(largeRaw);
      },
    },
    {
      name: 'parseDiff — XL (500 files, ~20000 lines)',
      tags: ['cpu'],
      fn: () => {
        parseDiff(xlRaw);
      },
    },
    {
      name: 'filterDiff — architecture agent, medium diff, no truncation',
      tags: ['cpu'],
      fn: () => {
        filterDiff(mediumParsed, 'architecture', 100_000);
      },
    },
    {
      name: 'filterDiff — security agent, medium diff, no truncation',
      tags: ['cpu'],
      fn: () => {
        filterDiff(mediumParsed, 'security', 100_000);
      },
    },
    {
      name: 'filterDiff — performance agent, medium diff, 60K char limit',
      tags: ['cpu'],
      fn: () => {
        filterDiff(mediumParsed, 'performance', 60_000);
      },
    },
    {
      name: 'filterDiff — style agent, large diff, aggressive truncation (10K)',
      tags: ['cpu'],
      fn: () => {
        filterDiff(largeParsed, 'style', 10_000);
      },
    },
    {
      name: 'filterDiff — architecture, large diff, with userIgnorePaths',
      tags: ['cpu'],
      fn: () => {
        filterDiff(largeParsed, 'architecture', 100_000, ['generated/**', 'vendor/**', '*.lock']);
      },
    },
    {
      name: 'getChangedFiles — similar diffs (~10% changed)',
      tags: ['cpu'],
      fn: () => {
        getChangedFiles(baseParsed, similarParsed);
      },
    },
    {
      name: 'getChangedFiles — very different diffs (~90% changed)',
      tags: ['cpu'],
      fn: () => {
        getChangedFiles(baseParsed, differentParsed);
      },
    },
    {
      name: 'isLineInDiff — 1000 random lookups on large diff',
      tags: ['cpu'],
      fn: () => {
        for (let i = 0; i < 1000; i++) {
          const fileIdx = i % largeParsed.files.length;
          const file = largeParsed.files[fileIdx];
          isLineInDiff(largeParsed, file?.path ?? '', (i % 500) + 1);
        }
      },
    },
  ],
});
