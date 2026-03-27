import { runAnalysis, type RunAnalysisOptions } from '../src/run-analysis';

const MOCK_DIFF = `diff --git a/src/App.tsx b/src/App.tsx
index 1234567..abcdef0 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -40,6 +40,10 @@ export function App() {
   const data = fetchData();
+  // render data
+  return <div>{data}</div>;
 }
`.repeat(40);

const mockChat = jest.fn();
const mockPullGet = jest.fn();
const mockCreateReview = jest.fn();

jest.mock('../../services/shared/llm', () => ({
  createLLMProvider: () => ({
    chat: mockChat,
  }),
}));

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: {
      pulls: {
        get: mockPullGet,
        createReview: mockCreateReview,
      },
    },
  })),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
}));

const BASE_OPTIONS: RunAnalysisOptions = {
  prContext: {
    owner: 'testorg',
    repo: 'testrepo',
    prNumber: 42,
    headSha: 'abc123',
    baseSha: 'def456',
    author: 'testuser',
    title: 'Add error handling',
  },
  githubToken: 'ghp_test',
  severityThreshold: 'low',
  configPath: '.pullmint.yml',
  agentsInput: 'all',
};

describe('runAnalysis', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.LLM_PROVIDER = 'anthropic';

    mockChat.mockReset();
    mockPullGet.mockReset();
    mockCreateReview.mockReset();

    mockChat.mockResolvedValue({
      text: JSON.stringify({
        findings: [
          {
            type: 'architecture',
            severity: 'high',
            title: 'Missing error boundary',
            description: 'Component renders without error handling.',
            file: 'src/App.tsx',
            line: 42,
          },
        ],
        riskScore: 65,
        summary: 'Architectural concerns in error handling.',
      }),
      inputTokens: 500,
      outputTokens: 200,
    });
    mockPullGet.mockResolvedValue({ data: MOCK_DIFF });
    mockCreateReview.mockResolvedValue({});

    const fsModule = jest.requireMock('fs') as {
      existsSync: jest.Mock;
      readFileSync: jest.Mock;
    };
    fsModule.existsSync.mockReturnValue(false);
    fsModule.readFileSync.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LLM_PROVIDER;
  });

  it('returns risk score and findings', async () => {
    const result = await runAnalysis(BASE_OPTIONS);

    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(100);
    expect(Array.isArray(result.findings)).toBe(true);
  });

  it('runs only architecture and security for small diffs', async () => {
    const smallDiff = `diff --git a/src/app.ts b/src/app.ts
index 1234..5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
+const x = 1;
`;
    mockPullGet.mockResolvedValue({ data: smallDiff });

    await runAnalysis(BASE_OPTIONS);

    expect(mockChat.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('respects agentsInput and keeps security as the minimum fallback', async () => {
    const result = await runAnalysis({ ...BASE_OPTIONS, agentsInput: 'architecture' });

    expect(result.agentResults.map((agentResult) => agentResult.agentType)).toEqual([
      'architecture',
      'security',
    ]);
  });

  it('applies severity threshold filter to returned findings', async () => {
    const result = await runAnalysis({ ...BASE_OPTIONS, severityThreshold: 'high' });

    for (const finding of result.findings) {
      expect(['high', 'critical']).toContain(finding.severity);
    }
  });

  it('computes weighted risk score proportionally for the active agents', async () => {
    const result = await runAnalysis({ ...BASE_OPTIONS, agentsInput: 'security' });

    expect(result.agentResults.map((agentResult) => agentResult.agentType)).toEqual(['security']);
    expect(result.riskScore).toBe(65);
  });

  it('continues if one agent fails and uses remaining results', async () => {
    mockChat
      .mockImplementationOnce(() => {
        throw new Error('bad request');
      })
      .mockResolvedValue({
        text: JSON.stringify({
          findings: [],
          riskScore: 40,
          summary: 'Recovered response.',
        }),
        inputTokens: 300,
        outputTokens: 150,
      });

    const result = await runAnalysis(BASE_OPTIONS);

    expect(result.agentResults.some((agentResult) => agentResult.status === 'failed')).toBe(true);
    expect(result.agentResults.some((agentResult) => agentResult.status === 'completed')).toBe(
      true
    );
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
  });

  it('loads .pullmint.yml from the filesystem when it exists', async () => {
    const fsModule = jest.requireMock('fs') as {
      existsSync: jest.Mock;
      readFileSync: jest.Mock;
    };
    fsModule.existsSync.mockReturnValue(true);
    fsModule.readFileSync.mockReturnValue(`
severity_threshold: high
agents:
  architecture: true
  security: true
  performance: false
  style: false
`);

    const result = await runAnalysis(BASE_OPTIONS);

    expect(
      result.agentResults.every((agentResult) => agentResult.agentType !== 'performance')
    ).toBe(true);
    expect(result.agentResults.every((agentResult) => agentResult.agentType !== 'style')).toBe(
      true
    );
  });
});
