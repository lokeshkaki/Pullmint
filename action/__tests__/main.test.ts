const mockSetOutput = jest.fn();
const mockSetFailed = jest.fn();
const mockGetInput = jest.fn();
const mockInfo = jest.fn();
const mockWarning = jest.fn();

const mockContext = {
  repo: { owner: 'testorg', repo: 'testrepo' },
  payload: {
    pull_request: {
      number: 42,
      title: 'Test PR',
      head: { sha: 'abc123' },
      base: { sha: 'def456' },
      user: { login: 'testuser' },
    },
  },
};

const mockRunAnalysis = jest.fn();
const mockPostReview = jest.fn();

jest.mock('@actions/core', () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
  warning: mockWarning,
}));

jest.mock('@actions/github', () => ({
  context: mockContext,
}));

jest.mock('../src/run-analysis', () => ({
  runAnalysis: mockRunAnalysis,
}));

jest.mock('../src/post-review', () => ({
  postReview: mockPostReview,
}));

function setInputs(overrides: Record<string, string> = {}): void {
  const defaults: Record<string, string> = {
    'anthropic-api-key': 'test-key',
    'openai-api-key': '',
    'google-api-key': '',
    'llm-provider': 'anthropic',
    'github-token': 'ghp_test',
    'severity-threshold': 'low',
    'config-path': '.pullmint.yml',
    'fail-on-risk-score': '',
    'post-review': 'true',
    agents: 'all',
  };

  const values = { ...defaults, ...overrides };
  mockGetInput.mockImplementation((key: string) => values[key] ?? '');
}

async function loadMainModule(): Promise<void> {
  await jest.isolateModulesAsync(async () => {
    await import('../src/main');
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

describe('main action entry point', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setInputs();

    mockRunAnalysis.mockResolvedValue({
      findings: [{ type: 'security', severity: 'high', title: 'Test', description: 'Desc' }],
      allFindings: [{ type: 'security', severity: 'high', title: 'Test', description: 'Desc' }],
      riskScore: 60,
      summary: 'One security finding.',
      agentResults: [],
      rawDiff: 'diff --git...',
      diffStats: { totalFiles: 1, totalAddedLines: 5, totalRemovedLines: 0 },
    });
    mockPostReview.mockResolvedValue(undefined);
  });

  it('sets risk-score, findings-count, and findings-json outputs', async () => {
    await loadMainModule();

    expect(mockSetOutput).toHaveBeenCalledWith('risk-score', '60');
    expect(mockSetOutput).toHaveBeenCalledWith('findings-count', '1');
    expect(mockSetOutput).toHaveBeenCalledWith(
      'findings-json',
      expect.stringContaining('security')
    );
  });

  it('calls setFailed when the risk score meets the fail threshold', async () => {
    setInputs({ 'fail-on-risk-score': '50' });

    await loadMainModule();

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('60'));
  });

  it('does not call setFailed when the risk score is below the threshold', async () => {
    setInputs({ 'fail-on-risk-score': '80' });

    await loadMainModule();

    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('skips postReview when post-review is false', async () => {
    setInputs({ 'post-review': 'false' });

    await loadMainModule();

    expect(mockPostReview).not.toHaveBeenCalled();
  });

  it('calls setFailed with the error message when runAnalysis throws', async () => {
    mockRunAnalysis.mockRejectedValueOnce(new Error('LLM rate limit exceeded'));

    await loadMainModule();

    expect(mockSetFailed).toHaveBeenCalledWith('LLM rate limit exceeded');
  });
});
