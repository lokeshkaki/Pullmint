// benchmarks/src/generators.ts
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { faker } from '@faker-js/faker';
import type { Finding, Signal, SignalType } from '../../services/shared/types';

/** Generates a realistic unified diff string. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
export function generateDiff(fileCount: number, linesPerFile: number): string {
  const chunks: string[] = [];

  for (let f = 0; f < fileCount; f++) {
    const dir = faker.system.directoryPath().replace(/^\//, '');
    const filename = faker.system.fileName({ extensionCount: 1 });
    const filePath = `${dir}/${filename}`;
    const startLine = faker.number.int({ min: 1, max: 500 });

    chunks.push(`diff --git a/${filePath} b/${filePath}`);
    chunks.push(
      `index ${faker.git.commitSha({ length: 7 })}..${faker.git.commitSha({ length: 7 })} 100644`
    );
    chunks.push(`--- a/${filePath}`);
    chunks.push(`+++ b/${filePath}`);

    // One or two hunks per file
    const hunkCount = faker.number.int({ min: 1, max: 2 });
    let lineOffset = startLine;

    for (let h = 0; h < hunkCount; h++) {
      const hunkLines = Math.floor(linesPerFile / hunkCount);
      const removedCount = Math.floor(hunkLines * 0.4);
      const addedCount = Math.floor(hunkLines * 0.6);
      const contextCount = Math.min(3, Math.floor(hunkLines * 0.1));

      chunks.push(
        `@@ -${lineOffset},${removedCount + contextCount} +${lineOffset},${addedCount + contextCount} @@`
      );

      // Context lines
      for (let i = 0; i < contextCount; i++) {
        chunks.push(` ${faker.lorem.words(faker.number.int({ min: 3, max: 8 }))}`);
      }
      // Removed lines
      for (let i = 0; i < removedCount; i++) {
        chunks.push(`-${faker.lorem.words(faker.number.int({ min: 3, max: 8 }))}`);
      }
      // Added lines
      for (let i = 0; i < addedCount; i++) {
        chunks.push(`+${faker.lorem.words(faker.number.int({ min: 3, max: 8 }))}`);
      }

      lineOffset += hunkLines + contextCount;
    }
  }

  return chunks.join('\n');
}

/** Generates an array of Finding objects for dedup/synthesis benchmarks. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
export function generateFindings(
  count: number,
  options: {
    withFiles?: boolean;
    sameFile?: boolean;
    duplicateRate?: number;
  } = {}
): Finding[] {
  const { withFiles = true, sameFile = false, duplicateRate = 0 } = options;
  const types: Finding['type'][] = ['architecture', 'security', 'performance', 'style'];
  const severities: Finding['severity'][] = ['critical', 'high', 'medium', 'low', 'info'];
  const sharedFile = sameFile ? `src/${faker.system.fileName()}` : undefined;

  const findings: Finding[] = [];

  for (let i = 0; i < count; i++) {
    // Introduce intentional duplicates at the specified rate
    if (duplicateRate > 0 && findings.length > 0 && Math.random() < duplicateRate) {
      const original = findings[Math.floor(Math.random() * findings.length)];
      findings.push({
        ...original,
        // Slightly vary the title to test Levenshtein dedup (not exact match)
        title: original.title + ' (variant)',
      });
      continue;
    }

    const type = types[i % types.length];
    const finding: Finding = {
      type,
      severity: severities[faker.number.int({ min: 0, max: 4 })],
      title: faker.lorem.sentence({ min: 4, max: 8 }).replace(/\.$/, ''),
      description: faker.lorem.paragraph(),
    };

    if (withFiles) {
      finding.file = sharedFile ?? `src/${faker.system.filePath().replace(/^\//, '')}`;
      finding.line = faker.number.int({ min: 1, max: 500 });
    }

    if (faker.datatype.boolean()) {
      finding.suggestion = faker.lorem.sentence();
    }

    findings.push(finding);
  }

  return findings;
}

/** Generates an array of Signal objects. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
export function generateSignals(
  types: SignalType[] = ['ci.result', 'time_of_day', 'author_history']
): Signal[] {
  return types.map((signalType) => {
    let value: number | boolean;

    switch (signalType) {
      case 'ci.result':
        value = faker.datatype.boolean({ probability: 0.8 });
        break;
      case 'ci.coverage':
        value = faker.number.int({ min: -30, max: 5 });
        break;
      case 'production.error_rate':
        value = faker.number.float({ min: 0, max: 25, fractionDigits: 1 });
        break;
      case 'production.latency':
        value = faker.number.int({ min: 0, max: 50 });
        break;
      case 'time_of_day':
        value = Date.now();
        break;
      case 'author_history':
        value = faker.number.float({ min: 0, max: 0.5, fractionDigits: 2 });
        break;
      case 'simultaneous_deploy':
        value = faker.datatype.boolean({ probability: 0.2 });
        break;
      default:
        value = 0;
    }

    return {
      signalType,
      value,
      source: faker.internet.domainName(),
      timestamp: Date.now() - faker.number.int({ min: 0, max: 60_000 }),
    };
  });
}

/** Generates a realistic diff of approximately `totalLines` changed lines spread across `fileCount` files. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
export function generateDiffBySize(preset: 'small' | 'medium' | 'large' | 'xl'): {
  fileCount: number;
  linesPerFile: number;
  raw: string;
} {
  const configs = {
    small: { fileCount: 5, linesPerFile: 10 },
    medium: { fileCount: 20, linesPerFile: 25 },
    large: { fileCount: 100, linesPerFile: 50 },
    xl: { fileCount: 500, linesPerFile: 40 },
  };

  const { fileCount, linesPerFile } = configs[preset];
  return { fileCount, linesPerFile, raw: generateDiff(fileCount, linesPerFile) };
}
