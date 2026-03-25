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
jest.mock('@pullmint/shared/tracing', () => ({
  addTraceAnnotations: jest.fn(),
}));
jest.mock('@pullmint/shared/error-handling', () => ({
  retryWithBackoff: jest.fn((fn: () => Promise<unknown>) => fn()),
  createStructuredError: jest.fn(),
}));
jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: {
        // Lazily dereference mockCreate so tests can override via mockResolvedValueOnce
        create: jest.fn((...args: unknown[]) => mockCreate(...args)),
      },
    })),
  };
});

import { processAgentJob, AgentJobData } from '../src/processors/agent';
import { Job } from 'bullmq';
import { getObject } from '@pullmint/shared/storage';

const DEFAULT_ARCH_RESPONSE = {
  content: [
    {
      type: 'text',
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
    },
  ],
  usage: { input_tokens: 150, output_tokens: 60 },
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

  it('should filter out findings with wrong type', async () => {
    // Override mockCreate to return mixed-type findings for this test
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
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
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await processAgentJob(makeAgentJob('architecture'));
    // Security finding should be filtered out; only architecture finding kept
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].type).toBe('architecture');
  });

  it('should return empty findings on parse failure', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json at all !!!!' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });

    const result = await processAgentJob(makeAgentJob('security'));
    expect(result.findings).toHaveLength(0);
    expect(result.riskScore).toBe(50);
  });

  it('should throw for unknown agent type', async () => {
    await expect(processAgentJob(makeAgentJob('unknown'))).rejects.toThrow('Unknown agent type');
  });

  it('should fetch diff from MinIO using diffRef', async () => {
    await processAgentJob(makeAgentJob('architecture'));
    expect(getObject as jest.Mock).toHaveBeenCalledWith(expect.any(String), 'diffs/test-diff.txt');
  });

  it('should include repoKnowledge in user prompt when provided', async () => {
    // Capture what was passed to the LLM create call
    let capturedInput: { messages?: Array<{ content: string }> } | undefined;
    mockCreate.mockImplementationOnce((input: { messages?: Array<{ content: string }> }) => {
      capturedInput = input;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ findings: [], riskScore: 10, summary: 'No issues' }),
          },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      };
    });

    await processAgentJob(
      makeAgentJob('architecture', {
        repoKnowledge: '<repo_knowledge>test knowledge</repo_knowledge>',
      })
    );

    expect(capturedInput?.messages?.[0]?.content).toContain('test knowledge');
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
