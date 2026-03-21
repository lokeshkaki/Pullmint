import {
  PRExecutionSchema,
  CheckpointRecordSchema,
  SignalSchema,
  FileMetricsSchema,
  AuthorProfileSchema,
  ModuleNarrativeSchema,
  RepoRegistryRecordSchema,
} from '../schemas';

describe('schemas', () => {
  describe('SignalSchema', () => {
    it('should parse a valid signal', () => {
      const signal = {
        signalType: 'ci.coverage',
        value: 92,
        source: 'ci',
        timestamp: Date.now(),
      };
      const result = SignalSchema.safeParse(signal);
      expect(result.success).toBe(true);
    });
  });

  describe('PRExecutionSchema', () => {
    it('should parse a valid execution record', () => {
      const record = {
        executionId: 'exec-123',
        repoFullName: 'org/repo',
        prNumber: 42,
        headSha: 'abc123',
        status: 'completed',
      };
      const result = PRExecutionSchema.safeParse(record);
      expect(result.success).toBe(true);
    });

    it('should reject a record with missing required fields', () => {
      const record = { executionId: 'exec-123' };
      const result = PRExecutionSchema.safeParse(record);
      expect(result.success).toBe(false);
    });

    it('should reject a record with invalid status', () => {
      const record = {
        executionId: 'exec-123',
        repoFullName: 'org/repo',
        prNumber: 42,
        headSha: 'abc123',
        status: 'invalid-status',
      };
      const result = PRExecutionSchema.safeParse(record);
      expect(result.success).toBe(false);
    });

    it('should accept optional fields as undefined', () => {
      const record = {
        executionId: 'exec-123',
        repoFullName: 'org/repo',
        prNumber: 42,
        headSha: 'abc123',
        status: 'pending',
      };
      const result = PRExecutionSchema.safeParse(record);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.findings).toBeUndefined();
        expect(result.data.riskScore).toBeUndefined();
      }
    });
  });

  describe('CheckpointRecordSchema', () => {
    it('should parse a valid checkpoint', () => {
      const checkpoint = {
        type: 'analysis',
        score: 25,
        confidence: 0.8,
        missingSignals: ['ci.coverage'],
        signals: [],
        decision: 'approved',
        reason: 'Low risk',
        evaluatedAt: Date.now(),
      };
      const result = CheckpointRecordSchema.safeParse(checkpoint);
      expect(result.success).toBe(true);
    });
  });

  describe('FileMetricsSchema', () => {
    it('should parse valid file metrics', () => {
      const metrics = {
        repoFullName: 'org/repo',
        filePath: 'src/index.ts',
        churnRate30d: 5,
        churnRate90d: 12,
        bugFixCommitCount30d: 2,
        ownerLogins: ['alice', 'bob'],
        lastModifiedSha: 'abc',
      };
      const result = FileMetricsSchema.safeParse(metrics);
      expect(result.success).toBe(true);
    });
  });

  describe('AuthorProfileSchema', () => {
    it('should parse a valid author profile', () => {
      const profile = {
        repoFullName: 'org/repo',
        authorLogin: 'alice',
        rollbackRate: 0.1,
        mergeCount30d: 15,
        avgRiskScore: 22,
        frequentFiles: ['src/auth.ts'],
      };
      const result = AuthorProfileSchema.safeParse(profile);
      expect(result.success).toBe(true);
    });
  });

  describe('ModuleNarrativeSchema', () => {
    it('should parse a valid module narrative', () => {
      const narrative = {
        repoFullName: 'org/repo',
        modulePath: 'src/auth',
        narrativeText: 'Authentication module handles tokens',
        generatedAtSha: 'def456',
        version: 2,
      };
      const result = ModuleNarrativeSchema.safeParse(narrative);
      expect(result.success).toBe(true);
    });
  });

  describe('RepoRegistryRecordSchema', () => {
    it('should parse a valid registry record', () => {
      const record = {
        repoFullName: 'org/repo',
        indexingStatus: 'indexed',
        contextVersion: 3,
        pendingBatches: 0,
        queuedExecutionIds: [],
      };
      const result = RepoRegistryRecordSchema.safeParse(record);
      expect(result.success).toBe(true);
    });

    it('should reject invalid indexing status', () => {
      const record = {
        repoFullName: 'org/repo',
        indexingStatus: 'unknown',
        contextVersion: 3,
        pendingBatches: 0,
        queuedExecutionIds: [],
      };
      const result = RepoRegistryRecordSchema.safeParse(record);
      expect(result.success).toBe(false);
    });
  });
});
