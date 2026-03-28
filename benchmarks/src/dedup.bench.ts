// benchmarks/src/dedup.bench.ts
import { registerSuite } from './harness';
import { generateFindings } from './generators';
import {
  deduplicateFindings,
  normalizedLevenshtein,
} from '../../services/shared/dedup';

// Generate finding sets of varying sizes with 20% duplicate rate
const findings10 = generateFindings(10, { withFiles: true, duplicateRate: 0.2 });
const findings50 = generateFindings(50, { withFiles: true, duplicateRate: 0.2 });
const findings200 = generateFindings(200, {
  withFiles: true,
  duplicateRate: 0.2,
});

// Generate no-file findings (dedup falls through to Levenshtein path less often)
const findings50noFile = generateFindings(50, { withFiles: false });

// For string distance benchmarks
const shortA = 'SQL injection vulnerability in query builder';
const shortB = 'SQL injection risk in query construction';
const longA =
  'A'.repeat(250) +
  ' potential race condition in async handler when multiple requests are processed concurrently';
const longB =
  'A'.repeat(250) +
  ' potential deadlock in async handler when multiple requests are processed simultaneously';

registerSuite({
  name: 'deduplication',
  iterations: 500,
  tasks: [
    {
      name: 'deduplicateFindings — 10 findings (20% dup rate)',
      tags: ['cpu'],
      fn: () => {
        deduplicateFindings(findings10);
      },
    },
    {
      name: 'deduplicateFindings — 50 findings (20% dup rate)',
      tags: ['cpu'],
      fn: () => {
        deduplicateFindings(findings50);
      },
    },
    {
      name: 'deduplicateFindings — 200 findings (20% dup rate)',
      tags: ['cpu'],
      fn: () => {
        deduplicateFindings(findings200);
      },
    },
    {
      name: 'deduplicateFindings — 50 findings, no file/line (title-only comparison)',
      tags: ['cpu'],
      fn: () => {
        deduplicateFindings(findings50noFile);
      },
    },
    {
      name: 'normalizedLevenshtein — short strings (~50 chars)',
      tags: ['cpu'],
      fn: () => {
        normalizedLevenshtein(shortA, shortB);
      },
    },
    {
      name: 'normalizedLevenshtein — long strings (~500 chars)',
      tags: ['cpu'],
      fn: () => {
        normalizedLevenshtein(longA, longB);
      },
    },
    {
      name: 'normalizedLevenshtein — identical strings (early exit)',
      tags: ['cpu'],
      fn: () => {
        normalizedLevenshtein(shortA, shortA);
      },
    },
    {
      name: 'normalizedLevenshtein — completely different strings',
      tags: ['cpu'],
      fn: () => {
        normalizedLevenshtein('aaaaaaaaaaaa', 'bbbbbbbbbbbb');
      },
    },
  ],
});
