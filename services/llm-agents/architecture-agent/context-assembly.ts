import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  BatchGetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import type {
  PREvent,
  FileMetrics,
  AuthorProfile,
  ModuleNarrative,
  ContextPackage,
} from '../../shared/types';
import { getValidatedItem } from '../../shared/dynamodb';
import {
  RepoRegistryRecordSchema,
  FileMetricsSchema,
  AuthorProfileSchema,
  ModuleNarrativeSchema,
} from '../../shared/schemas';
import type { Octokit } from '@octokit/rest';
import { rankBySimilarity } from './vector-search';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrockClient = new BedrockRuntimeClient({});

const NARRATIVE_SEARCH_TIMEOUT_MS = 3000;
const PREFIX_FALLBACK_TIMEOUT_MS = 5000;
const TOP_K_NARRATIVES = 5;

const RepoRegistryContextVersionSchema = RepoRegistryRecordSchema.or(
  z
    .object({
      repoFullName: z.string(),
      contextVersion: z.number().optional(),
    })
    .passthrough()
);

function timeoutRace<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

export interface ContextConfig {
  repoRegistryTable: string;
  fileKnowledgeTable: string;
  authorProfilesTable: string;
  moduleNarrativesTable: string;
}

/**
 * Assemble rich context for a PR review from DynamoDB-backed knowledge tables.
 * Gracefully degrades on partial failures.
 */
export async function assembleContext(
  octokit: Octokit,
  prEvent: PREvent & { executionId: string },
  changedFiles: string[],
  diff: string,
  config: ContextConfig
): Promise<ContextPackage & { contextVersion: number }> {
  const [owner, repo] = prEvent.repoFullName.split('/');
  let contextQuality: 'full' | 'partial' | 'none' = 'full';
  const results = await Promise.allSettled([
    fetchContextVersion(prEvent.repoFullName, config.repoRegistryTable),
    fetchFileMetrics(prEvent.repoFullName, changedFiles, config.fileKnowledgeTable),
    fetchAuthorProfile(prEvent.repoFullName, prEvent.author, config.authorProfilesTable),
    fetchModuleNarratives(prEvent.repoFullName, prEvent.title, changedFiles, config),
    fetchPRDescription(octokit, owner, repo, prEvent.prNumber),
    Promise.resolve(runStaticAnalysis(diff)),
  ]);

  const [cvResult, metricsResult, authorResult, narrativesResult, descResult, staticResult] =
    results;

  const contextVersion = cvResult.status === 'fulfilled' ? cvResult.value : 1;
  const fileMetrics = metricsResult.status === 'fulfilled' ? metricsResult.value : [];
  const authorProfile = authorResult.status === 'fulfilled' ? authorResult.value : null;
  const { narratives, degraded } =
    narrativesResult.status === 'fulfilled'
      ? narrativesResult.value
      : { narratives: [], degraded: false };
  const prDescription = descResult.status === 'fulfilled' ? descResult.value : '';
  const staticFindings = staticResult.status === 'fulfilled' ? staticResult.value : [];

  if (degraded || results.some((r) => r.status === 'rejected')) {
    contextQuality = 'partial';
  }
  if (fileMetrics.length === 0 && narratives.length === 0 && !authorProfile) {
    contextQuality = 'none';
  }

  return {
    fileMetrics,
    authorProfile,
    moduleNarratives: narratives,
    staticFindings,
    prDescription,
    contextQuality,
    contextVersion,
  };
}

async function fetchContextVersion(repoFullName: string, table: string): Promise<number> {
  const registry = await getValidatedItem(
    table,
    { repoFullName },
    RepoRegistryContextVersionSchema
  );
  return registry?.contextVersion ?? 1;
}

async function fetchFileMetrics(
  repoFullName: string,
  changedFiles: string[],
  table: string
): Promise<FileMetrics[]> {
  if (!changedFiles.length) return [];
  // DynamoDB BatchGetCommand supports max 100 keys per request
  const capped = changedFiles.slice(0, 100);
  if (changedFiles.length > 100) {
    console.warn(`PR touches ${changedFiles.length} files — file metrics capped at 100`);
  }
  const keys = capped.map((f) => ({ pk: `${repoFullName}#${f}` }));
  const result = await docClient.send(
    new BatchGetCommand({
      RequestItems: { [table]: { Keys: keys } },
    })
  );
  const items = result.Responses?.[table] ?? [];
  return items
    .map((item) => FileMetricsSchema.safeParse(item))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
}

async function fetchAuthorProfile(
  repoFullName: string,
  author: string,
  table: string
): Promise<AuthorProfile | null> {
  return getValidatedItem(
    table,
    { pk: `${repoFullName}#${author}` },
    AuthorProfileSchema
  );
}

// Inline Bedrock embedding call to avoid cross-Lambda-bundle imports.
async function generateEmbeddingLocal(text: string): Promise<number[]> {
  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: 'amazon.titan-embed-text-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(JSON.stringify({ inputText: text })),
    })
  );
  const decoded = JSON.parse(Buffer.from(response.body).toString()) as { embedding: number[] };
  return decoded.embedding;
}

async function fetchModuleNarratives(
  repoFullName: string,
  prTitle: string,
  changedFiles: string[],
  config: ContextConfig
): Promise<{ narratives: ModuleNarrative[]; degraded: boolean }> {
  const queryText = `${prTitle} ${changedFiles.join(' ')}`.trim();

  let queryEmbedding: number[];
  try {
    queryEmbedding = await timeoutRace(
      generateEmbeddingLocal(queryText),
      NARRATIVE_SEARCH_TIMEOUT_MS,
      'embedding timeout'
    );
  } catch (embeddingError) {
    console.warn('[context-assembly] Embedding generation failed, falling back to prefix search', {
      error: embeddingError instanceof Error ? embeddingError.message : 'unknown',
    });

    return {
      narratives: await fetchNarrativesByPrefix(repoFullName, changedFiles, config),
      degraded: true,
    };
  }

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: config.moduleNarrativesTable,
        IndexName: 'repoFullName-index',
        KeyConditionExpression: 'repoFullName = :repo',
        ExpressionAttributeValues: {
          ':repo': repoFullName,
        },
      })
    );

    const rawNarratives = result.Items ?? [];
    const narratives = rawNarratives
      .map((item) => ModuleNarrativeSchema.safeParse(item))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data);
    const rankedNarratives = rankBySimilarity(
      queryEmbedding,
      narratives,
      (narrative) => narrative.embedding,
      TOP_K_NARRATIVES
    );

    if (rankedNarratives.length > 0 || rawNarratives.length === 0) {
      return { narratives: rankedNarratives, degraded: false };
    }

    console.warn(
      '[context-assembly] Repo narratives missing embeddings, falling back to prefix search',
      {
        repoFullName,
        narrativeCount: narratives.length,
      }
    );

    return {
      narratives: await fetchNarrativesByPrefix(repoFullName, changedFiles, config),
      degraded: true,
    };
  } catch (ddbError) {
    console.warn(
      '[context-assembly] DynamoDB repo narrative query failed, falling back to prefix search',
      {
        error: ddbError instanceof Error ? ddbError.message : 'unknown',
      }
    );

    return {
      narratives: await fetchNarrativesByPrefix(repoFullName, changedFiles, config),
      degraded: true,
    };
  }
}

async function fetchNarrativesByPrefix(
  repoFullName: string,
  changedFiles: string[],
  config: ContextConfig
): Promise<ModuleNarrative[]> {
  const fallbackStart = Date.now();
  const modulePathPrefixes = new Set(
    changedFiles.map((filePath) => filePath.split('/').slice(0, -1).join('/')).filter(Boolean)
  );
  const totalPrefixes = modulePathPrefixes.size;
  const narratives: ModuleNarrative[] = [];
  let processedPrefixes = 0;

  for (const prefix of modulePathPrefixes) {
    if (Date.now() - fallbackStart > PREFIX_FALLBACK_TIMEOUT_MS) {
      console.warn('[context-assembly] DynamoDB fallback loop timed out', {
        fetchedCount: narratives.length,
        remainingPrefixes: Math.max(totalPrefixes - processedPrefixes, 0),
      });
      break;
    }

    processedPrefixes += 1;
    try {
      const result = await docClient.send(
        new GetCommand({
          TableName: config.moduleNarrativesTable,
          Key: { pk: `${repoFullName}#${prefix}` },
        })
      );
      const parsed = ModuleNarrativeSchema.safeParse(result.Item);
      if (parsed.success) {
        narratives.push(parsed.data);
      }
    } catch (ddbError) {
      console.warn('[context-assembly] DynamoDB fallback fetch failed for prefix', {
        prefix,
        error: ddbError instanceof Error ? ddbError.message : 'unknown',
      });
    }
  }

  return narratives;
}

async function fetchPRDescription(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<string> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  return (data as { body?: string | null }).body ?? '';
}

function runStaticAnalysis(_diff: string): string[] {
  // Runs regex patterns over diff content to detect mechanical issues cheaply.
  // Currently a stub — extend with patterns for hardcoded secrets, SQL concatenation, etc.
  return [];
}
