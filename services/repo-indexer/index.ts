import type { SQSHandler, SQSEvent } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getItem, updateItem, putItem, atomicDecrement } from '../shared/dynamodb';
import { getSecret } from '../shared/secrets';
import { getGitHubInstallationClient } from '../shared/github-app';
import { fetchFileTree, fetchFileCommitHistory, aggregateAuthorProfiles } from './git-history';
import { detectModules } from './module-detector';
import { generateModuleNarrative } from './narrative-generator';
import { generateEmbedding } from './embeddings';
import { upsertNarrative } from './opensearch-client';
import type { RepoRegistryRecord, FileMetrics, ModuleNarrative } from '../shared/types';
import type { Octokit } from '@octokit/rest';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const REPO_REGISTRY_TABLE_NAME = process.env.REPO_REGISTRY_TABLE_NAME!;
const FILE_KNOWLEDGE_TABLE_NAME = process.env.FILE_KNOWLEDGE_TABLE_NAME!;
const AUTHOR_PROFILES_TABLE_NAME = process.env.AUTHOR_PROFILES_TABLE_NAME!;
const MODULE_NARRATIVES_TABLE_NAME = process.env.MODULE_NARRATIVES_TABLE_NAME!;
const EXECUTIONS_TABLE_NAME = process.env.EXECUTIONS_TABLE_NAME!;
const ANALYSIS_QUEUE_URL = process.env.ANALYSIS_QUEUE_URL!;
const ONBOARDING_QUEUE_URL = process.env.ONBOARDING_QUEUE_URL!;
const OPENSEARCH_ENDPOINT = process.env.OPENSEARCH_ENDPOINT!;
const ANTHROPIC_API_KEY_ARN = process.env.ANTHROPIC_API_KEY_ARN!;

const sqsClient = new SQSClient({});

type FullIndexMessage = {
  mode: 'full-index';
  repoFullName: string;
  installationId: number;
};

type IncrementalMessage = {
  mode: 'incremental';
  repoFullName: string;
  changedFiles: string[];
  author?: string;
  executionId?: string;
};

type BatchMessage = {
  mode: 'batch';
  repoFullName: string;
  modules: Array<{ modulePath: string; entryPoint: string; files: string[] }>;
  headSha: string;
};

type IndexerMessage = FullIndexMessage | IncrementalMessage | BatchMessage;

export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    const parsed = JSON.parse(record.body) as Record<string, unknown>;

    // Direct indexer message (from onboarding queue)
    if ('mode' in parsed) {
      const message = parsed as IndexerMessage;
      if (message.mode === 'full-index') {
        await handleFullIndex(message);
      } else if (message.mode === 'batch') {
        await handleBatch(message);
      } else if (message.mode === 'incremental') {
        await handleIncremental(message);
      }
      continue;
    }

    // EventBridge envelope (from knowledge-update queue via pr.merged rule)
    if (parsed['detail-type'] === 'pr.merged' && parsed.detail) {
      const detail = parsed.detail as {
        repoFullName: string;
        prNumber?: number;
        changedFiles?: string[];
        author?: string;
        executionId?: string;
      };

      if (!detail.repoFullName) {
        console.warn('[repo-indexer] pr.merged event missing repoFullName', {
          body: record.body.substring(0, 200),
        });
        continue;
      }

      // PRMergedEvent does not include changedFiles — fetch from GitHub PR API
      let changedFiles = detail.changedFiles ?? [];
      if (changedFiles.length === 0 && detail.prNumber) {
        try {
          const [owner, repo] = detail.repoFullName.split('/');
          const octokit = (await getGitHubInstallationClient(
            detail.repoFullName
          )) as unknown as Octokit;
          const { data: files } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: detail.prNumber,
            per_page: 100,
          });
          changedFiles = files.map((f: { filename: string }) => f.filename);
        } catch (err) {
          console.warn('[repo-indexer] Failed to fetch PR changed files', {
            repoFullName: detail.repoFullName,
            prNumber: detail.prNumber,
            error: (err as Error).message,
          });
        }
      }

      await handleIncremental({
        mode: 'incremental',
        repoFullName: detail.repoFullName,
        changedFiles,
        author: detail.author,
        executionId: detail.executionId,
      });
      continue;
    }

    console.warn('[repo-indexer] Unrecognized message format', {
      body: record.body.substring(0, 200),
    });
  }
};

async function handleFullIndex(msg: FullIndexMessage): Promise<void> {
  const { repoFullName } = msg;
  console.info('[repo-indexer] full-index start', { repoFullName });
  const [owner, repo] = repoFullName.split('/');

  // Mark as indexing
  await updateItem(
    REPO_REGISTRY_TABLE_NAME,
    { repoFullName },
    { indexingStatus: 'indexing', pendingBatches: 0 }
  );

  const octokit = (await getGitHubInstallationClient(repoFullName)) as unknown as Octokit;
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoData.default_branch;

  const filePaths = await fetchFileTree(octokit, owner, repo, defaultBranch);
  const modules = detectModules(filePaths);

  // Fetch commit history once per file — reuse for both metrics and author profiles
  const fileHistories: Awaited<ReturnType<typeof fetchFileCommitHistory>>[] = [];
  for (const filePath of filePaths.slice(0, 200)) {
    // cap to avoid API rate limits
    try {
      const history = await fetchFileCommitHistory(octokit, owner, repo, filePath, 90);
      fileHistories.push(history);
      const metrics: FileMetrics = {
        repoFullName,
        filePath,
        churnRate30d: history.churnRate30d,
        churnRate90d: history.churnRate90d,
        bugFixCommitCount30d: history.bugFixCommitCount30d,
        ownerLogins: history.authors.slice(0, 5),
        lastModifiedSha: history.lastCommitSha ?? defaultBranch,
      };
      await putItem(FILE_KNOWLEDGE_TABLE_NAME, { ...metrics, pk: `${repoFullName}#${filePath}` });
    } catch {
      // skip individual file failures
    }
  }

  // Bootstrap author profiles from the already-fetched commit histories
  const authorProfiles = aggregateAuthorProfiles(repoFullName, fileHistories);
  for (const profile of authorProfiles) {
    await putItem(AUTHOR_PROFILES_TABLE_NAME, {
      ...profile,
      pk: `${repoFullName}#${profile.authorLogin}`,
    });
  }

  // Split modules into batches of 5 and publish to SQS
  const batches: BatchMessage[] = [];
  for (let i = 0; i < modules.length; i += 5) {
    batches.push({
      mode: 'batch',
      repoFullName,
      modules: modules.slice(i, i + 5),
      headSha: defaultBranch,
    });
  }

  // Write pendingBatches count before publishing
  await updateItem(REPO_REGISTRY_TABLE_NAME, { repoFullName }, { pendingBatches: batches.length });

  for (const batch of batches) {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: ONBOARDING_QUEUE_URL,
        MessageBody: JSON.stringify(batch),
      })
    );
  }

  console.info('[repo-indexer] full-index complete', {
    repoFullName,
    filesIndexed: fileHistories.length,
    modulesDetected: modules.length,
    batchesPublished: batches.length,
  });

  // If no modules, mark indexed immediately
  if (batches.length === 0) {
    await updateItem(
      REPO_REGISTRY_TABLE_NAME,
      { repoFullName },
      { indexingStatus: 'indexed', contextVersion: 1 }
    );
    await releaseQueuedPRs(repoFullName);
  }
}

async function handleBatch(msg: BatchMessage): Promise<void> {
  const { repoFullName, modules, headSha } = msg;
  console.info('[repo-indexer] batch start', { repoFullName, moduleCount: modules.length });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const anthropicModule = require('@anthropic-ai/sdk') as {
    default: new (o: { apiKey: string }) => {
      messages: { create: (...args: unknown[]) => Promise<unknown> };
    };
  };
  const apiKey = await getSecret(ANTHROPIC_API_KEY_ARN);
  const anthropicClient = new anthropicModule.default({ apiKey });

  const octokit = (await getGitHubInstallationClient(repoFullName)) as unknown as Octokit;
  const [owner, repo] = repoFullName.split('/');

  for (const mod of modules) {
    try {
      // Fetch entry point content
      let entryPointContent = '';
      try {
        const response = await octokit.rest.repos.getContent({ owner, repo, path: mod.entryPoint });
        const data = response.data as { content?: string };
        if (data.content) {
          entryPointContent = Buffer.from(data.content, 'base64').toString('utf-8');
        }
      } catch {
        // proceed without content
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      const narrativeText = await generateModuleNarrative(anthropicClient as any, {
        modulePath: mod.modulePath,
        entryPoint: mod.entryPoint,
        files: mod.files,
        entryPointContent,
      });

      const narrative: ModuleNarrative = {
        repoFullName,
        modulePath: mod.modulePath,
        narrativeText,
        generatedAtSha: headSha,
        version: 1,
      };

      await putItem(MODULE_NARRATIVES_TABLE_NAME, {
        ...narrative,
        pk: `${repoFullName}#${mod.modulePath}`,
      });

      const embedding = await generateEmbedding(narrativeText);
      await upsertNarrative(OPENSEARCH_ENDPOINT, narrative, embedding);
    } catch {
      // skip individual module failures — batch continues
    }
  }

  console.info('[repo-indexer] batch complete', { repoFullName, modulesProcessed: modules.length });

  // Decrement pendingBatches; if 0, mark indexed
  const remaining = await atomicDecrement(
    REPO_REGISTRY_TABLE_NAME,
    { repoFullName },
    'pendingBatches'
  );
  if (remaining <= 0) {
    await updateItem(
      REPO_REGISTRY_TABLE_NAME,
      { repoFullName },
      { indexingStatus: 'indexed', contextVersion: 1 }
    );
    await releaseQueuedPRs(repoFullName);
  }
}

async function handleIncremental(msg: IncrementalMessage): Promise<void> {
  const { repoFullName, changedFiles, author } = msg;
  console.info('[repo-indexer] incremental start', { repoFullName, changedFiles, author });
  const [owner, repo] = repoFullName.split('/');
  const octokit = (await getGitHubInstallationClient(repoFullName)) as unknown as Octokit;

  // Update file metrics for changed files
  for (const filePath of changedFiles) {
    try {
      const history = await fetchFileCommitHistory(octokit, owner, repo, filePath, 90);
      const metrics: FileMetrics = {
        repoFullName,
        filePath,
        churnRate30d: history.churnRate30d,
        churnRate90d: history.churnRate90d,
        bugFixCommitCount30d: history.bugFixCommitCount30d,
        ownerLogins: history.authors.slice(0, 5),
        lastModifiedSha: history.lastCommitSha ?? 'unknown',
      };
      await putItem(FILE_KNOWLEDGE_TABLE_NAME, { ...metrics, pk: `${repoFullName}#${filePath}` });
    } catch {
      /* skip */
    }
  }

  // Update author profile (partial update to preserve rollbackRate and avgRiskScore)
  if (author) {
    await docClient.send(
      new UpdateCommand({
        TableName: AUTHOR_PROFILES_TABLE_NAME,
        Key: { pk: `${repoFullName}#${author}` },
        UpdateExpression:
          'SET repoFullName = :repo, authorLogin = :author, ' +
          'frequentFiles = :files, updatedAt = :now ' +
          'ADD mergeCount30d :one',
        ExpressionAttributeValues: {
          ':repo': repoFullName,
          ':author': author,
          ':files': changedFiles.slice(0, 20),
          ':now': Date.now(),
          ':one': 1,
        },
      })
    );
  }

  // Regenerate narratives for modules containing changed files
  const allFiles = await fetchFileTree(octokit, owner, repo, 'HEAD').catch(() => changedFiles);
  const allModules = detectModules(allFiles);
  const affectedModules = allModules.filter((m) =>
    changedFiles.some((f) => f.startsWith(m.modulePath + '/'))
  );

  if (affectedModules.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const anthropicModule = require('@anthropic-ai/sdk') as {
      default: new (o: { apiKey: string }) => {
        messages: { create: (...args: unknown[]) => Promise<unknown> };
      };
    };
    const apiKey = await getSecret(ANTHROPIC_API_KEY_ARN);
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
          if (data.content)
            entryPointContent = Buffer.from(data.content, 'base64').toString('utf-8');
        } catch {
          /* proceed without */
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        const narrativeText = await generateModuleNarrative(anthropicClient as any, {
          modulePath: mod.modulePath,
          entryPoint: mod.entryPoint,
          files: mod.files,
          entryPointContent,
        });

        const narrative: ModuleNarrative = {
          repoFullName,
          modulePath: mod.modulePath,
          narrativeText,
          generatedAtSha: 'HEAD',
          version: Date.now(),
        };
        await putItem(MODULE_NARRATIVES_TABLE_NAME, {
          ...narrative,
          pk: `${repoFullName}#${mod.modulePath}`,
        });
        const embedding = await generateEmbedding(narrativeText);
        await upsertNarrative(OPENSEARCH_ENDPOINT, narrative, embedding);
      } catch {
        /* skip */
      }
    }
  }

  // Increment contextVersion using ADD (same pattern as atomicDecrement but +1)
  await docClient.send(
    new UpdateCommand({
      TableName: REPO_REGISTRY_TABLE_NAME,
      Key: { repoFullName },
      UpdateExpression: 'ADD #cv :inc',
      ExpressionAttributeNames: { '#cv': 'contextVersion' },
      ExpressionAttributeValues: { ':inc': 1 },
    })
  );
}

async function releaseQueuedPRs(repoFullName: string): Promise<void> {
  const registry = await getItem<RepoRegistryRecord>(REPO_REGISTRY_TABLE_NAME, { repoFullName });
  if (!registry?.queuedExecutionIds?.length) return;

  // Re-publish each queued execution to the analysis queue
  for (const executionId of registry.queuedExecutionIds) {
    try {
      const execution = await getItem<Record<string, unknown>>(EXECUTIONS_TABLE_NAME, {
        executionId,
      });
      if (execution) {
        const detail = {
          executionId,
          prNumber: execution.prNumber,
          repoFullName: execution.repoFullName,
          headSha: execution.headSha,
          baseSha: execution.baseSha,
          author: execution.author ?? '',
          title: execution.title ?? '',
          orgId: execution.orgId ?? '',
        };
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: ANALYSIS_QUEUE_URL,
            MessageBody: JSON.stringify({ detail }),
          })
        );
      }
    } catch {
      /* skip individual failures */
    }
  }

  // Clear the queue
  await updateItem(REPO_REGISTRY_TABLE_NAME, { repoFullName }, { queuedExecutionIds: [] });
}
