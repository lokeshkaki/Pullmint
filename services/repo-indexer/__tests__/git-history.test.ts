import { fetchFileTree, fetchFileCommitHistory, aggregateAuthorProfiles } from '../git-history';

const mockOctokit = {
  rest: {
    git: {
      getTree: jest.fn(),
    },
    repos: {
      listCommits: jest.fn(),
    },
  },
};

beforeEach(() => jest.resetAllMocks());

describe('fetchFileTree', () => {
  it('returns flat list of blob file paths', async () => {
    mockOctokit.rest.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { type: 'blob', path: 'src/index.ts' },
          { type: 'tree', path: 'src' },
          { type: 'blob', path: 'src/utils.ts' },
        ],
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchFileTree(mockOctokit as any, 'owner', 'repo', 'main');
    expect(result).toEqual(['src/index.ts', 'src/utils.ts']);
  });
});

describe('fetchFileCommitHistory', () => {
  it('computes churn rate and bug-fix count from commits', async () => {
    const now = Date.now();
    const recent = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const older = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago — within 90d but not 30d
    mockOctokit.rest.repos.listCommits.mockResolvedValue({
      data: [
        { commit: { message: 'fix: auth bug', author: { date: recent, name: 'alice' } } },
        { commit: { message: 'feat: add login', author: { date: recent, name: 'bob' } } },
        { commit: { message: 'fix: typo', author: { date: recent, name: 'alice' } } },
        { commit: { message: 'chore: cleanup', author: { date: older, name: 'carol' } } },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchFileCommitHistory(
      mockOctokit as any,
      'owner',
      'repo',
      'src/auth.ts',
      90
    );
    expect(result.churnRate30d).toBe(3); // only the 3 recent commits
    expect(result.churnRate90d).toBe(4); // all 4 commits returned by the API
    expect(result.bugFixCommitCount30d).toBe(2);
    expect(result.authors).toContain('alice');
    expect(result.authors).toContain('carol'); // older commit author still captured
  });
});

describe('fetchFileCommitHistory with missing author fields', () => {
  it('handles commits with no author object (uses unknown fallback and treats date as 0)', async () => {
    mockOctokit.rest.repos.listCommits.mockResolvedValue({
      data: [
        // no author property — exercises the `?? 'unknown'` and `?: 0` branches
        { commit: { message: 'fix: something', author: undefined }, sha: 'abc' },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchFileCommitHistory(
      mockOctokit as any,
      'owner',
      'repo',
      'src/a.ts',
      90
    );
    // authorDate = 0, which is < thirtyDaysAgo, so churnRate30d stays 0
    expect(result.churnRate30d).toBe(0);
    expect(result.authors).toContain('unknown');
    expect(result.lastCommitSha).toBe('abc');
  });
});

describe('aggregateAuthorProfiles', () => {
  it('groups commit counts by author across multiple files', () => {
    const fileHistories = [
      { filePath: 'src/a.ts', authors: ['alice', 'bob'], churnRate30d: 2, bugFixCommitCount30d: 0 },
      { filePath: 'src/b.ts', authors: ['alice'], churnRate30d: 1, bugFixCommitCount30d: 0 },
    ];
    const profiles = aggregateAuthorProfiles('org/repo', fileHistories);
    const alice = profiles.find((p) => p.authorLogin === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.frequentFiles).toContain('src/a.ts');
    expect(alice!.mergeCount30d).toBe(3);
  });
});
