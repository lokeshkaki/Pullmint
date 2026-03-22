import { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@pullmint/shared/db';
import { addJob, QUEUE_NAMES } from '@pullmint/shared/queue';
import { getConfig } from '@pullmint/shared/config';
import { getGitHubInstallationClient } from '@pullmint/shared/github-app';
import { retryWithBackoff } from '@pullmint/shared/error-handling';
import {
  fetchFileTree,
  fetchFileCommitHistory,
  aggregateAuthorProfiles,
} from '../../../repo-indexer/git-history';
import { detectModules } from '../../../repo-indexer/module-detector';
import { generateModuleNarrative } from '../../../repo-indexer/narrative-generator';
import { generateEmbedding } from '../../../repo-indexer/embeddings';
import type { Octokit } from '@octokit/rest';

type AnthropicConstructor = new (options: {
  apiKey: string;
}) => Parameters<typeof generateModuleNarrative>[0];

type BatchModule = { modulePath: string; entryPoint: string; files: string[] };

type GitHubContentClient = {
  request: (
    route: string,
    params: Record<string, string>
  ) => Promise<{ data: { content?: string; encoding?: string } }>;
};

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

    const octokit = (await getGitHubInstallationClient(repoFullName)) as unknown as Octokit;
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

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const anthropicModule = require('@anthropic-ai/sdk') as { default: AnthropicConstructor };
  const apiKey = getConfig('ANTHROPIC_API_KEY');
  const anthropicClient = new anthropicModule.default({ apiKey });

  const octokit = (await getGitHubInstallationClient(repoFullName)) as unknown as Octokit;
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

      const narrativeText = await generateModuleNarrative(anthropicClient, {
        modulePath: mod.modulePath,
        entryPoint: mod.entryPoint,
        files: mod.files,
        entryPointContent,
      });

      const embedding = await generateEmbedding(narrativeText);

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
  const octokit = (await getGitHubInstallationClient(repoFullName)) as unknown as Octokit;
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const anthropicModule = require('@anthropic-ai/sdk') as { default: AnthropicConstructor };
    const apiKey = getConfig('ANTHROPIC_API_KEY');
    const anthropicClient = new anthropicModule.default({ apiKey });

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

        const narrativeText = await generateModuleNarrative(anthropicClient, {
          modulePath: mod.modulePath,
          entryPoint: mod.entryPoint,
          files: mod.files,
          entryPointContent,
        });

        const embedding = await generateEmbedding(narrativeText);

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
