import { postReview, type PostReviewOptions } from '../src/post-review';

const mockCreateReview = jest.fn().mockResolvedValue({});

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: {
      pulls: {
        createReview: mockCreateReview,
      },
    },
  })),
}));

jest.mock(
  '@actions/core',
  () => ({
    info: jest.fn(),
    warning: jest.fn(),
  }),
  { virtual: true }
);

const MOCK_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1234567..abcdef0 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,5 @@
 const x = 1;
+const y = 2;
+const z = 3;
`;

const BASE_RESULT = {
  findings: [
    {
      type: 'security' as const,
      severity: 'high' as const,
      title: 'SQL Injection risk',
      description: 'User input passed directly to query.',
      file: 'src/app.ts',
      line: 2,
    },
  ],
  allFindings: [
    {
      type: 'security' as const,
      severity: 'high' as const,
      title: 'SQL Injection risk',
      description: 'User input passed directly to query.',
      file: 'src/app.ts',
      line: 2,
    },
  ],
  riskScore: 75,
  summary: 'High severity security issue detected.',
  agentResults: [
    {
      agentType: 'security' as const,
      findings: [],
      riskScore: 75,
      summary: '',
      model: 'claude-sonnet-4-6',
      tokens: 700,
      latencyMs: 10,
      status: 'completed' as const,
    },
  ],
  rawDiff: MOCK_DIFF,
  diffStats: { totalFiles: 1, totalAddedLines: 2, totalRemovedLines: 0 },
};

const BASE_OPTIONS: PostReviewOptions = {
  prContext: {
    owner: 'testorg',
    repo: 'testrepo',
    prNumber: 42,
    headSha: 'abc123',
    baseSha: 'def456',
    author: 'testuser',
    title: 'Test PR',
  },
  githubToken: 'ghp_test',
  result: BASE_RESULT,
  severityThreshold: 'low',
};

describe('postReview', () => {
  beforeEach(() => {
    mockCreateReview.mockClear();
    mockCreateReview.mockResolvedValue({});
  });

  it('posts a review with an inline comment when file and line are valid', async () => {
    await postReview(BASE_OPTIONS);

    expect(mockCreateReview).toHaveBeenCalledTimes(1);
    const call = mockCreateReview.mock.calls[0][0] as {
      comments: Array<{ path: string; line: number }>;
    };
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0].path).toBe('src/app.ts');
    expect(call.comments[0].line).toBe(2);
  });

  it('falls back to a body-only review when inline comments fail', async () => {
    mockCreateReview
      .mockRejectedValueOnce(new Error('Unprocessable Entity'))
      .mockResolvedValueOnce({});

    await postReview(BASE_OPTIONS);

    expect(mockCreateReview).toHaveBeenCalledTimes(2);
    const fallbackCall = mockCreateReview.mock.calls[1][0] as { comments?: unknown[] };
    expect(fallbackCall.comments).toBeUndefined();
  });

  it('puts a finding in the review body when the line is not in the diff', async () => {
    await postReview({
      ...BASE_OPTIONS,
      result: {
        ...BASE_RESULT,
        allFindings: [
          {
            ...BASE_RESULT.allFindings[0],
            line: 9999,
          },
        ],
      },
    });

    const call = mockCreateReview.mock.calls[0][0] as { comments: unknown[]; body: string };
    expect(call.comments).toHaveLength(0);
    expect(call.body).toContain('SQL Injection risk');
  });

  it('includes the risk score in the review body', async () => {
    await postReview(BASE_OPTIONS);

    const call = mockCreateReview.mock.calls[0][0] as { body: string };
    expect(call.body).toContain('75/100');
  });

  it('shows a no issues message when there are no findings', async () => {
    await postReview({
      ...BASE_OPTIONS,
      result: { ...BASE_RESULT, findings: [], allFindings: [] },
    });

    const call = mockCreateReview.mock.calls[0][0] as { body: string };
    expect(call.body).toContain('No issues found');
  });
});
