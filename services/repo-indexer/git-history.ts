import type { Octokit } from '@octokit/rest';
import type { AuthorProfile } from '../shared/types';

export interface FileCommitHistory {
  filePath: string;
  churnRate30d: number;
  churnRate90d: number;
  bugFixCommitCount30d: number;
  authors: string[];
  lastCommitSha?: string;
}

const BUG_FIX_KEYWORDS = ['fix:', 'bug', 'hotfix', 'patch'];

/**
 * Fetch the full recursive file tree for a repo at a given ref.
 * Returns only blob (file) paths — no tree entries.
 */
export async function fetchFileTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<string[]> {
  const { data } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: ref,
    recursive: 'true',
  });
  return data.tree
    .filter((entry) => entry.type === 'blob' && entry.path)
    .map((entry) => entry.path as string);
}

/**
 * Fetch commit history for a single file, compute churn and bug-fix metrics.
 */
export async function fetchFileCommitHistory(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
  lookbackDays: number
): Promise<FileCommitHistory> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: commits } = await octokit.rest.repos.listCommits({
    owner,
    repo,
    path: filePath,
    since,
    per_page: 100,
  });

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const authorSet = new Set<string>();
  let churnRate30d = 0;
  let bugFixCommitCount30d = 0;

  for (const commit of commits) {
    const authorDate = commit.commit.author?.date
      ? new Date(commit.commit.author.date).getTime()
      : 0;
    const msg = commit.commit.message.toLowerCase();
    const authorName = commit.author?.login ?? commit.commit.author?.name ?? 'unknown';
    authorSet.add(authorName);

    if (authorDate >= thirtyDaysAgo) {
      churnRate30d++;
      if (BUG_FIX_KEYWORDS.some((kw) => msg.includes(kw))) {
        bugFixCommitCount30d++;
      }
    }
  }

  return {
    filePath,
    churnRate30d,
    churnRate90d: commits.length,
    bugFixCommitCount30d,
    authors: Array.from(authorSet),
    lastCommitSha: commits[0]?.sha,
  };
}

/**
 * Aggregate per-file commit histories into author-level profiles.
 * Accepts a Pick of FileCommitHistory — only filePath, authors, and churnRate30d are read.
 * This keeps callers flexible: any superset of these fields (including full FileCommitHistory) is accepted.
 */
export function aggregateAuthorProfiles(
  repoFullName: string,
  fileHistories: Pick<FileCommitHistory, 'filePath' | 'authors' | 'churnRate30d'>[]
): AuthorProfile[] {
  const authorMap = new Map<string, { files: Set<string>; commitCount: number }>();

  for (const fh of fileHistories) {
    for (const author of fh.authors) {
      const existing = authorMap.get(author) ?? { files: new Set(), commitCount: 0 };
      existing.files.add(fh.filePath);
      existing.commitCount += fh.churnRate30d;
      authorMap.set(author, existing);
    }
  }

  return Array.from(authorMap.entries()).map(([authorLogin, data]) => ({
    repoFullName,
    authorLogin,
    rollbackRate: 0, // populated from Executions table cross-reference
    mergeCount30d: data.commitCount,
    avgRiskScore: 0, // populated from Executions table cross-reference
    frequentFiles: Array.from(data.files).slice(0, 20),
  }));
}
