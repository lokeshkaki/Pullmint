// mockCreate must be declared before jest.mock() hoisting evaluates the factory.
// Using a let with a getter pattern so the factory captures the reference.
let mockCreate: jest.Mock;

// Mock shared modules BEFORE imports
jest.mock('@pullmint/shared/config', () => ({
  getConfig: jest.fn((key: string) => {
    if (key === 'ANTHROPIC_API_KEY') return 'test-api-key';
    return 'test-value';
  }),
}));
jest.mock('@pullmint/shared/storage', () => ({
  getObject: jest.fn().mockResolvedValue('diff --git a/file.ts b/file.ts\n+added line'),
}));
jest.mock('@pullmint/shared/db', () => ({
  getDb: jest.fn().mockReturnValue({}),
  schema: { tokenUsage: {} },
}));
jest.mock('@pullmint/shared/tracing', () => ({
  addTraceAnnotations: jest.fn(),
}));
jest.mock('@pullmint/shared/cost-tracker', () => ({
  recordTokenUsage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@pullmint/shared/error-handling', () => ({
  retryWithBackoff: jest.fn((fn: () => Promise<unknown>) => fn()),
  createStructuredError: jest.fn(),
}));
jest.mock('@pullmint/shared/llm', () => ({
  createLLMProvider: jest.fn(() => ({
    chat: jest.fn((...args: unknown[]) => mockCreate(...args)),
  })),
}));

import { processAgentJob, AgentJobData } from '../src/processors/agent';
import { Job } from 'bullmq';
import { getObject } from '@pullmint/shared/storage';
import { recordTokenUsage } from '@pullmint/shared/cost-tracker';

const DEFAULT_ARCH_RESPONSE = {
  text: JSON.stringify({
    findings: [
      {
        type: 'architecture',
        severity: 'high',
        title: 'Tight coupling detected',
        description: 'Module A is tightly coupled to Module B',
        file: 'src/moduleA.ts',
        line: 42,
        suggestion: 'Introduce an interface',
      },
    ],
    riskScore: 45,
    summary: 'One architectural concern found',
  }),
  inputTokens: 150,
  outputTokens: 60,
};

function makeAgentJob(agentType: string, overrides?: Partial<AgentJobData>): Job<AgentJobData> {
  return {
    id: `test-agent-${agentType}`,
    name: agentType,
    data: {
      executionId: 'owner/repo#1#abc1234',
      prEvent: {
        prNumber: 1,
        repoFullName: 'owner/repo',
        headSha: 'abc1234',
        baseSha: 'def5678',
        author: 'testuser',
        title: 'feat: test PR',
        orgId: 'org-1',
      },
      agentType,
      diffRef: 'diffs/test-diff.txt',
      ...overrides,
    },
  } as unknown as Job<AgentJobData>;
}

describe('processAgentJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mockCreate to return the default architecture response
    mockCreate = jest.fn().mockResolvedValue(DEFAULT_ARCH_RESPONSE);
  });

  it('should call LLM with correct model for architecture agent', async () => {
    const result = await processAgentJob(makeAgentJob('architecture'));
    expect(result.agentType).toBe('architecture');
    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].type).toBe('architecture');
    expect(result.riskScore).toBe(45);
  });

  it('calls recordTokenUsage after a successful LLM call', async () => {
    const job = makeAgentJob('architecture');
    await processAgentJob(job);

    expect(recordTokenUsage).toHaveBeenCalledTimes(1);
    const callArgs = (recordTokenUsage as jest.Mock).mock.calls[0][1];
    expect(callArgs.agentType).toBe('architecture');
    expect(callArgs.repoFullName).toBe('owner/repo');
    expect(callArgs.inputTokens).toBe(150);
    expect(callArgs.outputTokens).toBe(60);
  });

  it('should filter out findings with wrong type', async () => {
    // Override mockCreate to return mixed-type findings for this test
    mockCreate.mockResolvedValueOnce({
      text: JSON.stringify({
        findings: [
          {
            type: 'security',
            severity: 'critical',
            title: 'Injection vulnerability',
            description: 'SQL injection risk',
            file: null,
            line: null,
            suggestion: 'Use parameterized queries',
          },
          {
            type: 'architecture',
            severity: 'medium',
            title: 'Coupling violation',
            description: 'Modules are too tightly coupled',
            file: null,
            line: null,
            suggestion: 'Decouple via interface',
          },
        ],
        riskScore: 60,
        summary: 'Mixed findings returned',
      }),
      inputTokens: 100,
      outputTokens: 50,
    });

    const result = await processAgentJob(makeAgentJob('architecture'));
    // Security finding should be filtered out; only architecture finding kept
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].type).toBe('architecture');
  });

  it('should return empty findings on parse failure', async () => {
    mockCreate.mockResolvedValueOnce({
      text: 'not valid json at all !!!!',
      inputTokens: 100,
      outputTokens: 10,
    });

    const result = await processAgentJob(makeAgentJob('security'));
    expect(result.findings).toHaveLength(0);
    expect(result.riskScore).toBe(50);
  });

  it('should throw for unknown agent type', async () => {
    await expect(processAgentJob(makeAgentJob('unknown'))).rejects.toThrow(
      'Custom agent type "unknown" has no customAgentConfig in job data'
    );
  });

  it('should fetch diff from MinIO using diffRef', async () => {
    await processAgentJob(makeAgentJob('architecture'));
    expect(getObject as jest.Mock).toHaveBeenCalledWith(expect.any(String), 'diffs/test-diff.txt');
  });

  it('should include repoKnowledge in user prompt when provided', async () => {
    // Capture what was passed to the LLM create call
    let capturedInput:
      | {
          userMessage?: string;
        }
      | undefined;
    mockCreate.mockImplementationOnce((input: { userMessage?: string }) => {
      capturedInput = input;
      return {
        text: JSON.stringify({ findings: [], riskScore: 10, summary: 'No issues' }),
        inputTokens: 50,
        outputTokens: 20,
      };
    });

    await processAgentJob(
      makeAgentJob('architecture', {
        repoKnowledge: '<repo_knowledge>test knowledge</repo_knowledge>',
      })
    );

    expect(capturedInput?.userMessage).toContain('test knowledge');
  });

  it('injects info finding when diff is truncated', async () => {
    const largeDiff = Array.from({ length: 200 }, (_, index) => {
      return [
        `diff --git a/src/file${index}.ts b/src/file${index}.ts`,
        `--- a/src/file${index}.ts`,
        `+++ b/src/file${index}.ts`,
        '@@ -1,1 +1,2 @@',
        ` line ${index}`,
        `+added line ${'x'.repeat(40)}`,
      ].join('\n');
    }).join('\n');

    (getObject as jest.Mock).mockResolvedValueOnce(largeDiff);
    process.env.LLM_MAX_DIFF_CHARS_ARCHITECTURE = '500';

    try {
      const result = await processAgentJob(makeAgentJob('architecture'));
      const partialInfoFinding = result.findings.find(
        (finding) => finding.severity === 'info' && finding.title === 'Partial diff analysis'
      );

      expect(partialInfoFinding).toBeDefined();
      expect(partialInfoFinding?.description).toContain(
        'excluded by relevance filter or size limit'
      );
    } finally {
      delete process.env.LLM_MAX_DIFF_CHARS_ARCHITECTURE;
    }
  });
});

describe('custom agent processing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate = jest.fn().mockResolvedValue({
      text: JSON.stringify({
        findings: [
          {
            type: 'accessibility',
            severity: 'high',
            title: 'Missing alt text',
            description: 'Image element lacks alt attribute',
            file: 'src/components/Logo.tsx',
            line: 12,
          },
        ],
        riskScore: 30,
        summary: 'One accessibility issue found.',
      }),
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  function makeCustomAgentJob(overrides?: Partial<AgentJobData>): Job<AgentJobData> {
    return {
      id: 'test-custom-agent',
      name: 'accessibility',
      data: {
        executionId: 'owner/repo#1#abc1234',
        prEvent: {
          prNumber: 1,
          repoFullName: 'owner/repo',
          headSha: 'abc1234',
          baseSha: 'def5678',
          author: 'testuser',
          title: 'feat: add accessible button',
          orgId: 'org-1',
        },
        agentType: 'accessibility',
        diffRef: 'diffs/test-diff.txt',
        customAgentConfig: {
          prompt: 'You are an accessibility expert. Analyze the code changes for WCAG compliance issues and missing ARIA attributes in all changed components.',
          model: 'claude-haiku-4-5-20251001',
          includePaths: ['src/components/**', '**/*.css'],
          excludePaths: ['**/*.test.*'],
          maxDiffChars: 50000,
        },
        ...overrides,
      },
    } as unknown as Job<AgentJobData>;
  }

  it('routes custom agentType to custom prompt instead of throwing', async () => {
    const result = await processAgentJob(makeCustomAgentJob());
    expect(result.agentType).toBe('accessibility');
    expect(result.status).toBe('completed');
  });

  it('wraps custom prompt with response format frame before sending to LLM', async () => {
    let capturedSystemPrompt: string | undefined;
    mockCreate.mockImplementationOnce((input: { systemPrompt?: string }) => {
      capturedSystemPrompt = input.systemPrompt;
      return {
        text: JSON.stringify({ findings: [], riskScore: 0, summary: '' }),
        inputTokens: 10,
        outputTokens: 10,
      };
    });

    await processAgentJob(makeCustomAgentJob());

    expect(capturedSystemPrompt).toContain('accessibility expert');
    expect(capturedSystemPrompt).toContain('Response Format');
    expect(capturedSystemPrompt).toContain('"type": must be "accessibility"');
  });

  it('filters findings that do not match the custom agentType', async () => {
    mockCreate.mockResolvedValueOnce({
      text: JSON.stringify({
        findings: [
          { type: 'accessibility', severity: 'high', title: 'Missing alt', description: 'img lacks alt' },
          { type: 'security', severity: 'critical', title: 'XSS', description: 'Input not sanitized' },
        ],
        riskScore: 60,
        summary: 'Mixed findings.',
      }),
      inputTokens: 100,
      outputTokens: 50,
    });

    const result = await processAgentJob(makeCustomAgentJob());
    // Expecting 2: the main accessibility finding + the info finding about partial diff analysis
    expect(result.findings).toHaveLength(2);
    const accessibilityFinding = result.findings.find((f) => f.type === 'accessibility' && f.severity === 'high');
    expect(accessibilityFinding).toBeDefined();
    expect(accessibilityFinding?.title).toBe('Missing alt');
    // Security finding should be filtered out; only accessibility findings kept
    const securityFinding = result.findings.find((f) => f.type === 'security');
    expect(securityFinding).toBeUndefined();
  });

  it('throws when customAgentConfig is missing for unknown agentType', async () => {
    const job = makeCustomAgentJob({ customAgentConfig: undefined });
    await expect(processAgentJob(job)).rejects.toThrow(
      'Custom agent type "accessibility" has no customAgentConfig in job data'
    );
  });

  it('uses custom model from customAgentConfig', async () => {
    let capturedModel: string | undefined;
    mockCreate.mockImplementationOnce((input: { model?: string }) => {
      capturedModel = input.model;
      return {
        text: JSON.stringify({ findings: [], riskScore: 0, summary: '' }),
        inputTokens: 10,
        outputTokens: 10,
      };
    });

    await processAgentJob(makeCustomAgentJob());
    expect(capturedModel).toBe('claude-haiku-4-5-20251001');
  });

  it('uses DEFAULT_CUSTOM_AGENT_MODEL when model is not specified in config', async () => {
    let capturedModel: string | undefined;
    mockCreate.mockImplementationOnce((input: { model?: string }) => {
      capturedModel = input.model;
      return {
        text: JSON.stringify({ findings: [], riskScore: 0, summary: '' }),
        inputTokens: 10,
        outputTokens: 10,
      };
    });

    const job = makeCustomAgentJob();
    job.data.customAgentConfig!.model = undefined;
    await processAgentJob(job);

    // Should use env var or hardcoded default
    expect(capturedModel).toBe(process.env.LLM_CUSTOM_AGENT_MODEL ?? 'claude-haiku-4-5-20251001');
  });
});
