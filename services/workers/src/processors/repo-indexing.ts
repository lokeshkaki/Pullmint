import { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getGitHubInstallationClient } from '@pullmint/shared/github-app';
import { retryWithBackoff } from '@pullmint/shared/error-handling';
import { createLLMProvider, LLMProvider } from '@pullmint/shared/llm';
import * as nodePath from 'path';

type BatchModule = { modulePath: string; entryPoint: string; files: string[] };

type OctokitClient = {
  rest: {
    git: {
      getTree: (params: {
        owner: string;
        repo: string;
        tree_sha: string;
        recursive: 'true';
      }) => Promise<{ data: { tree: Array<{ type?: string; path?: string }> } }>;
    };
    repos: {
      get: (params: {
        owner: string;
        repo: string;
      }) => Promise<{ data: { default_branch: string } }>;
      listCommits: (params: {
        owner: string;
        repo: string;
        path?: string;
        since?: string;
        per_page?: number;
      }) => Promise<{
        data: Array<{
          sha: string;
          commit: {
            author?: { date?: string; name?: string };
            message: string;
          };
          author?: { login?: string };
        }>;
      }>;
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
      }) => Promise<{ data: unknown }>;
    };
    pulls: {
      listFiles: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
      }) => Promise<{ data: Array<{ filename: string }> }>;
    };
  };
};

type GitHubContentClient = {
  request: (
    route: string,
    params: Record<string, string>
  ) => Promise<{ data: { content?: string; encoding?: string } }>;
};

type FileCommitHistory = {
  filePath: string;
  churnRate30d: number;
  churnRate90d: number;
  bugFixCommitCount30d: number;
  authors: string[];
  lastCommitSha?: string;
};

type ModuleBoundary = {
  modulePath: string;
  entryPoint: string;
  files: string[];
};

type NarrativeInput = {
  modulePath: string;
  entryPoint: string;
  files: string[];
  entryPointContent: string;
};

const BUG_FIX_KEYWORDS = ['fix:', 'bug', 'hotfix', 'patch'];
const ENTRY_POINT_NAMES = new Set([
  'index.ts',
  'index.js',
  'index.tsx',
  '__init__.py',
  'mod.rs',
  'main.ts',
  'main.go',
]);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.py', '.go', '.rs']);
const MIN_FILES_PER_MODULE = 3;
const NARRATIVE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_ENTRY_POINT_CHARS = 3000;

let llmProvider: LLMProvider | null = null;

async function fetchFileTree(
  octokit: OctokitClient,
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

async function fetchFileCommitHistory(
  octokit: OctokitClient,
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
    const message = commit.commit.message.toLowerCase();
    const authorName = commit.author?.login ?? commit.commit.author?.name ?? 'unknown';
    authorSet.add(authorName);

    if (authorDate >= thirtyDaysAgo) {
      churnRate30d += 1;
      if (BUG_FIX_KEYWORDS.some((keyword) => message.includes(keyword))) {
        bugFixCommitCount30d += 1;
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

function aggregateAuthorProfiles(
  repoFullName: string,
  fileHistories: Pick<FileCommitHistory, 'filePath' | 'authors' | 'churnRate30d'>[]
): Array<{
  repoFullName: string;
  authorLogin: string;
  rollbackRate: number;
  mergeCount30d: number;
  avgRiskScore: number;
  frequentFiles: string[];
}> {
  const authorMap = new Map<string, { files: Set<string>; commitCount: number }>();

  for (const history of fileHistories) {
    for (const author of history.authors) {
      const existing = authorMap.get(author) ?? { files: new Set<string>(), commitCount: 0 };
      existing.files.add(history.filePath);
      existing.commitCount += history.churnRate30d;
      authorMap.set(author, existing);
    }
  }

  return Array.from(authorMap.entries()).map(([authorLogin, profile]) => ({
    repoFullName,
    authorLogin,
    rollbackRate: 0,
    mergeCount30d: profile.commitCount,
    avgRiskScore: 0,
    frequentFiles: Array.from(profile.files).slice(0, 20),
  }));
}

function detectModules(filePaths: string[]): ModuleBoundary[] {
  const byDirectory = new Map<string, string[]>();

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    if (parts.length < 2) {
      continue;
    }
    const directory = parts.slice(0, -1).join('/');
    const existing = byDirectory.get(directory) ?? [];
    existing.push(filePath);
    byDirectory.set(directory, existing);
  }

  const modules: ModuleBoundary[] = [];

  for (const [directory, files] of byDirectory.entries()) {
    const sourceFiles = files.filter((filePath) => {
      const fileName = filePath.split('/').pop() ?? '';
      if (fileName.startsWith('.')) {
        return false;
      }
      return SOURCE_EXTENSIONS.has(nodePath.extname(filePath));
    });

    if (sourceFiles.length < MIN_FILES_PER_MODULE) {
      continue;
    }

    const entryPoint = sourceFiles.find((filePath) => {
      const fileName = filePath.split('/').pop() ?? '';
      return ENTRY_POINT_NAMES.has(fileName);
    });

    if (!entryPoint) {
      continue;
    }

    modules.push({ modulePath: directory, entryPoint, files: sourceFiles });
  }

  return modules;
}

async function generateModuleNarrative(
  client: LLMProvider,
  input: NarrativeInput
): Promise<string> {
  const entryPointContent =
    input.entryPointContent.length > MAX_ENTRY_POINT_CHARS
      ? `${input.entryPointContent.substring(0, MAX_ENTRY_POINT_CHARS)}\n// [truncated]`
      : input.entryPointContent;

  const userMessage = `Module path: ${input.modulePath}
Files: ${input.files.join(', ')}

Entry point content:
\`\`\`
${entryPointContent}
\`\`\`

Write a concise architecture narrative (150-200 words) covering: purpose, key responsibilities, known risk areas, and what breaks when this module changes.`;

  const fallbackNarrative = `Module at ${input.modulePath} containing ${input.files.length} files: ${input.files.join(', ')}.`;

  try {
    const response = await client.chat({
      model: NARRATIVE_MODEL,
      maxTokens: 400,
      systemPrompt:
        'You are a senior software architect writing codebase documentation. Write concise, factual architecture narratives. Do not use bullet points. Write in prose.',
      userMessage,
    });

    return response.text || fallbackNarrative;
  } catch {
    // Fall back to deterministic narrative below.
  }

  return fallbackNarrative;
}

function generateEmbedding(text: string): number[] {
  const dimensions = 256;
  const vector = new Array<number>(dimensions).fill(0);

  for (let i = 0; i < text.length; i += 1) {
    const codePoint = text.charCodeAt(i);
    vector[i % dimensions] += codePoint / 255;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

export async function processRepoIndexingJob(job: Job): Promise<void> {
  const jobName = job.name;
  const data = job.data as Record<string, unknown>;

  if (jobName === 'dependency-scanner') {
    await handleDependencyScanner();
    return;
  }

  if (jobName === 'full-index') {
    await handleFullIndex(data as { repoFullName: string });
    return;
  }

  if (jobName === 'batch') {
    await handleBatch(data as { repoFullName: string; modules: BatchModule[]; headSha: string });
    return;
  }

  if (jobName === 'incremental' || jobName === 'pr.merged') {
    await handleIncremental(
      data as {
        repoFullName: string;
        changedFiles?: string[];
        prNumber?: number;
        author?: string;
        executionId?: string;
      }
    );
    return;
  }

  console.warn('[repo-indexing] Unrecognized job type:', jobName);
}

async function handleFullIndex(msg: { repoFullName: string }): Promise<void> {
  const { repoFullName } = msg;
  const db = getDb();

  try {
    console.info('[repo-indexing] full-index start', { repoFullName });
    const [owner, repo] = repoFullName.split('/');

    await db
      .update(schema.repoRegistry)
      .set({ indexingStatus: 'indexing', pendingBatches: 0, updatedAt: new Date() })
      .where(eq(schema.repoRegistry.repoFullName, repoFullName));

    const octokit = (await getGitHubInstallationClient(repoFullName)) as unknown as OctokitClient;
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;

    const filePaths = await fetchFileTree(octokit, owner, repo, defaultBranch);
    const modules = detectModules(filePaths);

    // Fetch commit history for files (capped to avoid rate limits)
    const fileHistories: Awaited<ReturnType<typeof fetchFileCommitHistory>>[] = [];
    for (const filePath of filePaths.slice(0, 200)) {
      try {
        const history = await fetchFileCommitHistory(octokit, owner, repo, filePath, 90);
        fileHistories.push(history);
        await db
          .insert(schema.fileKnowledge)
          .values({
            id: `${repoFullName}#${filePath}`,
            repoFullName,
            filePath,
            changeFrequency: history.bugFixCommitCount30d,
            lastModifiedBy: history.authors[0] ?? null,
            avgChangesPerMonth: history.churnRate30d,
            contributorCount: history.authors.length,
          })
          .onConflictDoUpdate({
            target: schema.fileKnowledge.id,
            set: {
              changeFrequency: history.bugFixCommitCount30d,
              lastModifiedBy: history.authors[0] ?? null,
              avgChangesPerMonth: history.churnRate30d,
              contributorCount: history.authors.length,
              updatedAt: new Date(),
            },
          });
      } catch {
        // Skip individual file failures
      }
    }

    // Bootstrap author profiles
    const authorProfileList = aggregateAuthorProfiles(repoFullName, fileHistories);
    for (const profile of authorProfileList) {
      await db
        .insert(schema.authorProfiles)
        .values({
          id: `${repoFullName}#${profile.authorLogin}`,
          repoFullName,
          author: profile.authorLogin,
          totalCommits: profile.mergeCount30d,
          topFiles: profile.frequentFiles,
          rollbackRate: profile.rollbackRate,
          totalFilesChanged: profile.frequentFiles.length,
        })
        .onConflictDoUpdate({
          target: schema.authorProfiles.id,
          set: {
            totalCommits: profile.mergeCount30d,
            topFiles: profile.frequentFiles,
            updatedAt: new Date(),
          },
        });
    }

    // Split modules into batches of 5 and enqueue
    const batches: Array<{ repoFullName: string; modules: BatchModule[]; headSha: string }> = [];
    for (let i = 0; i < modules.length; i += 5) {
      batches.push({ repoFullName, modules: modules.slice(i, i + 5), headSha: defaultBranch });
    }

    await db
      .update(schema.repoRegistry)
      .set({ pendingBatches: batches.length, updatedAt: new Date() })
      .where(eq(schema.repoRegistry.repoFullName, repoFullName));

    for (const batch of batches) {
      await addJob(QUEUE_NAMES.REPO_INDEXING, 'batch', batch as unknown as Record<string, unknown>);
    }

    console.info('[repo-indexing] full-index complete', {
      repoFullName,
      filesIndexed: fileHistories.length,
      modulesDetected: modules.length,
      batchesPublished: batches.length,
    });

    if (batches.length === 0) {
      await db
        .update(schema.repoRegistry)
        .set({ indexingStatus: 'indexed', contextVersion: 1, updatedAt: new Date() })
        .where(eq(schema.repoRegistry.repoFullName, repoFullName));
    }
  } catch (error) {
    console.error('[repo-indexing] full-index failed', { repoFullName, error });
    await db
      .update(schema.repoRegistry)
      .set({ indexingStatus: 'failed', updatedAt: new Date() })
      .where(eq(schema.repoRegistry.repoFullName, repoFullName));
    throw error;
  }
}

async function handleBatch(msg: {
  repoFullName: string;
  modules: BatchModule[];
  headSha: string;
}): Promise<void> {
  const { repoFullName, modules } = msg;
  console.info('[repo-indexing] batch start', { repoFullName, moduleCount: modules.length });

  if (!llmProvider) {
    llmProvider = createLLMProvider();
  }

  const octokit = (await getGitHubInstallationClient(repoFullName)) as unknown as OctokitClient;
  const [owner, repo] = repoFullName.split('/');
  const db = getDb();

  for (const mod of modules) {
    try {
      let entryPointContent = '';
      try {
        const response = await octokit.rest.repos.getContent({ owner, repo, path: mod.entryPoint });
        const data = response.data as { content?: string };
        if (data.content) {
          entryPointContent = Buffer.from(data.content, 'base64').toString('utf-8');
        }
      } catch {
        // Proceed without entry point content
      }

      const narrativeText = await generateModuleNarrative(llmProvider, {
        modulePath: mod.modulePath,
        entryPoint: mod.entryPoint,
        files: mod.files,
        entryPointContent,
      });

      const embedding = generateEmbedding(narrativeText);

      await db
        .insert(schema.moduleNarratives)
        .values({
          id: `${repoFullName}#${mod.modulePath}`,
          repoFullName,
          modulePath: mod.modulePath,
          narrative: narrativeText,
          embedding,
          contextVersion: 1,
        })
        .onConflictDoUpdate({
          target: schema.moduleNarratives.id,
          set: {
            narrative: narrativeText,
            embedding,
            updatedAt: new Date(),
          },
        });
    } catch {
      // Skip individual module failures
    }
  }

  console.info('[repo-indexing] batch complete', {
    repoFullName,
    modulesProcessed: modules.length,
  });

  // Decrement pendingBatches; if 0, mark indexed
  const result = await db
    .update(schema.repoRegistry)
    .set({
      pendingBatches: sql`GREATEST(COALESCE(pending_batches, 0) - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.repoRegistry.repoFullName, repoFullName))
    .returning({ pendingBatches: schema.repoRegistry.pendingBatches });

  const remaining = result[0]?.pendingBatches ?? 0;
  if (remaining <= 0) {
    await db
      .update(schema.repoRegistry)
      .set({ indexingStatus: 'indexed', contextVersion: 1, updatedAt: new Date() })
      .where(eq(schema.repoRegistry.repoFullName, repoFullName));
  }
}

async function handleIncremental(msg: {
  repoFullName: string;
  changedFiles?: string[];
  prNumber?: number;
  author?: string;
  executionId?: string;
}): Promise<void> {
  const { repoFullName, author } = msg;
  let changedFiles = msg.changedFiles ?? [];

  console.info('[repo-indexing] incremental start', { repoFullName, author });
  const [owner, repo] = repoFullName.split('/');
  const octokit = (await getGitHubInstallationClient(repoFullName)) as unknown as OctokitClient;
  const db = getDb();

  // Fetch changed files if not provided (pr.merged event)
  if (changedFiles.length === 0 && msg.prNumber) {
    try {
      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: msg.prNumber,
        per_page: 100,
      });
      changedFiles = files.map((f: { filename: string }) => f.filename);
    } catch (err) {
      console.warn('[repo-indexing] Failed to fetch PR changed files', {
        repoFullName,
        prNumber: msg.prNumber,
        error: (err as Error).message,
      });
    }
  }

  // Update file metrics for changed files
  for (const filePath of changedFiles) {
    try {
      const history = await fetchFileCommitHistory(octokit, owner, repo, filePath, 90);
      await db
        .insert(schema.fileKnowledge)
        .values({
          id: `${repoFullName}#${filePath}`,
          repoFullName,
          filePath,
          changeFrequency: history.bugFixCommitCount30d,
          lastModifiedBy: history.authors[0] ?? null,
          avgChangesPerMonth: history.churnRate30d,
          contributorCount: history.authors.length,
        })
        .onConflictDoUpdate({
          target: schema.fileKnowledge.id,
          set: {
            changeFrequency: history.bugFixCommitCount30d,
            lastModifiedBy: history.authors[0] ?? null,
            avgChangesPerMonth: history.churnRate30d,
            contributorCount: history.authors.length,
            updatedAt: new Date(),
          },
        });
    } catch {
      // Skip per-file failures
    }
  }

  // Update author profile
  if (author) {
    await db
      .insert(schema.authorProfiles)
      .values({
        id: `${repoFullName}#${author}`,
        repoFullName,
        author,
        totalCommits: 1,
        topFiles: changedFiles.slice(0, 20),
        totalFilesChanged: changedFiles.length,
      })
      .onConflictDoUpdate({
        target: schema.authorProfiles.id,
        set: {
          totalCommits: sql`COALESCE(total_commits, 0) + 1`,
          topFiles: changedFiles.slice(0, 20),
          updatedAt: new Date(),
        },
      });
  }

  // Regenerate narratives for modules containing changed files
  const allFiles = await fetchFileTree(octokit, owner, repo, 'HEAD').catch(() => changedFiles);
  const allModules = detectModules(allFiles);
  const affectedModules = allModules.filter((m) =>
    changedFiles.some((f) => f.startsWith(m.modulePath + '/'))
  );

  if (affectedModules.length > 0) {
    if (!llmProvider) {
      llmProvider = createLLMProvider();
    }

    for (const mod of affectedModules) {
      try {
        let entryPointContent = '';
        try {
          const response = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: mod.entryPoint,
          });
          const data = response.data as { content?: string };
          if (data.content) {
            entryPointContent = Buffer.from(data.content, 'base64').toString('utf-8');
          }
        } catch {
          // Proceed without entry point content
        }

        const narrativeText = await generateModuleNarrative(llmProvider, {
          modulePath: mod.modulePath,
          entryPoint: mod.entryPoint,
          files: mod.files,
          entryPointContent,
        });

        const embedding = generateEmbedding(narrativeText);

        await db
          .insert(schema.moduleNarratives)
          .values({
            id: `${repoFullName}#${mod.modulePath}`,
            repoFullName,
            modulePath: mod.modulePath,
            narrative: narrativeText,
            embedding,
            contextVersion: 1,
          })
          .onConflictDoUpdate({
            target: schema.moduleNarratives.id,
            set: {
              narrative: narrativeText,
              embedding,
              contextVersion: sql`COALESCE(context_version, 0) + 1`,
              updatedAt: new Date(),
            },
          });
      } catch {
        // Skip individual module failures
      }
    }
  }

  // Increment contextVersion atomically
  await db
    .update(schema.repoRegistry)
    .set({
      contextVersion: sql`COALESCE(context_version, 0) + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.repoRegistry.repoFullName, repoFullName));
}

async function handleDependencyScanner(): Promise<void> {
  console.info('[repo-indexing] dependency-scanner start');
  const db = getDb();

  // 1. Get all known repos
  const registryItems = await db
    .select({ repoFullName: schema.repoRegistry.repoFullName })
    .from(schema.repoRegistry);

  const distinctRepos = registryItems
    .map((r) => r.repoFullName)
    .filter((r): r is string => Boolean(r));

  // 2. Scan each repo
  for (const repoFullName of distinctRepos) {
    try {
      await scanRepoForDependencies(repoFullName, distinctRepos);
    } catch (error) {
      console.error(`Failed to scan repo ${repoFullName}:`, error);
      // Continue with next repo
    }
  }

  console.info('[repo-indexing] dependency-scanner complete', {
    reposScanned: distinctRepos.length,
  });
}

async function scanRepoForDependencies(repoFullName: string, knownRepos: string[]): Promise<void> {
  const [owner, repo] = repoFullName.split('/');
  const db = getDb();

  const client = (await getGitHubInstallationClient(
    repoFullName
  )) as unknown as GitHubContentClient;

  let packageJson: Record<string, unknown>;
  try {
    const response = await retryWithBackoff(() =>
      client.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: 'package.json',
      })
    );
    const content = response.data.content ?? '';
    const decoded = Buffer.from(content, 'base64').toString('utf-8');
    packageJson = JSON.parse(decoded) as Record<string, unknown>;
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  const allDeps = (packageJson.dependencies as Record<string, string> | undefined) ?? {};
  const orgPrefix = repoFullName.split('/')[0];
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

  for (const depName of Object.keys(allDeps)) {
    const upstreamRepo = resolveRepoFromPackageName(depName, orgPrefix, knownRepos);
    if (!upstreamRepo || upstreamRepo === repoFullName) continue;

    await db
      .insert(schema.dependencyGraphs)
      .values({
        id: `${upstreamRepo}#${repoFullName}`,
        upstreamRepo,
        downstreamRepo: repoFullName,
        expiresAt,
      })
      .onConflictDoNothing();
  }
}

function resolveRepoFromPackageName(
  packageName: string,
  orgPrefix: string,
  knownRepos: string[]
): string | undefined {
  if (packageName.startsWith('@')) {
    const withoutAt = packageName.slice(1);
    if (knownRepos.includes(withoutAt)) return withoutAt;
    return undefined;
  }
  return knownRepos.find((r) => r === `${orgPrefix}/${packageName}`);
}

function isNotFoundError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  const message = (error as Error)?.message ?? '';
  return status === 404 || message.includes('Not Found') || message.includes('404');
}
