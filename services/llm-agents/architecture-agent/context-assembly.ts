import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type {
  PREvent,
  FileMetrics,
  AuthorProfile,
  ModuleNarrative,
  ContextPackage,
  RepoRegistryRecord,
} from '../../shared/types';
import type { Octokit } from '@octokit/rest';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrockClient = new BedrockRuntimeClient({});

const OPENSEARCH_TIMEOUT_MS = 3000;
const TOP_K_NARRATIVES = 5;

function timeoutReject(ms: number, message: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

export interface ContextConfig {
  repoRegistryTable: string;
  fileKnowledgeTable: string;
  authorProfilesTable: string;
  moduleNarrativesTable: string;
  opensearchEndpoint: string;
}

/**
 * Assemble rich context for a PR review from DynamoDB and OpenSearch.
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
    fetchModuleNarrativesWithFallback(prEvent.repoFullName, prEvent.title, changedFiles, config),
    fetchPRDescription(octokit, owner, repo, prEvent.prNumber),
    Promise.resolve(runStaticAnalysis(diff)),
  ]);

  const [cvResult, metricsResult, authorResult, narrativesResult, descResult, staticResult] =
    results;

  const contextVersion = cvResult.status === 'fulfilled' ? cvResult.value : 1;
  const fileMetrics = metricsResult.status === 'fulfilled' ? metricsResult.value : [];
  const authorProfile = authorResult.status === 'fulfilled' ? authorResult.value : null;
  const { narratives, usedFallback } =
    narrativesResult.status === 'fulfilled'
      ? narrativesResult.value
      : { narratives: [], usedFallback: false };
  const prDescription = descResult.status === 'fulfilled' ? descResult.value : '';
  const staticFindings = staticResult.status === 'fulfilled' ? staticResult.value : [];

  if (usedFallback || results.some((r) => r.status === 'rejected')) {
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
  const result = await docClient.send(new GetCommand({ TableName: table, Key: { repoFullName } }));
  return (result.Item as RepoRegistryRecord | undefined)?.contextVersion ?? 1;
}

async function fetchFileMetrics(
  repoFullName: string,
  changedFiles: string[],
  table: string
): Promise<FileMetrics[]> {
  if (!changedFiles.length) return [];
  const keys = changedFiles.map((f) => ({ pk: `${repoFullName}#${f}` }));
  const result = await docClient.send(
    new BatchGetCommand({
      RequestItems: { [table]: { Keys: keys } },
    })
  );
  return (result.Responses?.[table] ?? []) as FileMetrics[];
}

async function fetchAuthorProfile(
  repoFullName: string,
  author: string,
  table: string
): Promise<AuthorProfile | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: table,
      Key: { pk: `${repoFullName}#${author}` },
    })
  );
  return (result.Item as AuthorProfile | undefined) ?? null;
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

async function fetchModuleNarrativesWithFallback(
  repoFullName: string,
  prTitle: string,
  changedFiles: string[],
  config: ContextConfig
): Promise<{ narratives: ModuleNarrative[]; usedFallback: boolean }> {
  // Try OpenSearch semantic query first with timeout
  try {
    const queryText = `${prTitle} ${changedFiles.join(' ')}`;
    const embedding = await Promise.race([
      generateEmbeddingLocal(queryText),
      timeoutReject(OPENSEARCH_TIMEOUT_MS, 'embedding timeout'),
    ]);

    const url = `${config.opensearchEndpoint}/module-narrative-index/_search`;
    const response = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          size: TOP_K_NARRATIVES,
          query: {
            knn: {
              embedding: {
                vector: embedding,
                k: TOP_K_NARRATIVES,
                filter: { term: { repoFullName } },
              },
            },
          },
        }),
      }),
      timeoutReject(OPENSEARCH_TIMEOUT_MS, 'opensearch timeout'),
    ]);

    if (!response.ok) throw new Error(`OpenSearch ${response.status}`);
    const body = (await response.json()) as { hits: { hits: Array<{ _source: ModuleNarrative }> } };
    return { narratives: body.hits.hits.map((h) => h._source), usedFallback: false };
  } catch {
    // Fallback: exact-match from DynamoDB for files in the diff
    const modulePathPrefixes = new Set(
      changedFiles.map((f) => f.split('/').slice(0, -1).join('/'))
    );
    const narratives: ModuleNarrative[] = [];
    for (const prefix of modulePathPrefixes) {
      if (!prefix) continue;
      try {
        const result = await docClient.send(
          new GetCommand({
            TableName: config.moduleNarrativesTable,
            Key: { pk: `${repoFullName}#${prefix}` },
          })
        );
        if (result.Item) narratives.push(result.Item as ModuleNarrative);
      } catch {
        /* skip */
      }
    }
    return { narratives, usedFallback: true };
  }
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
