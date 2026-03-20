import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { ModuleNarrative } from '../shared/types';

let client: Client | undefined;

function getClient(endpoint: string): Client {
  if (!client) {
    client = new Client({
      ...AwsSigv4Signer({
        region: process.env.AWS_REGION ?? 'us-east-1',
        service: 'aoss',
        getCredentials: defaultProvider(),
      }),
      node: endpoint,
    });
  }
  return client;
}

/**
 * Upsert a module narrative and its embedding into OpenSearch.
 * Document ID is URL-encoded "repoFullName/modulePath" for deterministic updates.
 */
export async function upsertNarrative(
  endpoint: string,
  narrative: ModuleNarrative,
  embedding: number[]
): Promise<void> {
  const osClient = getClient(endpoint);
  const docId = encodeURIComponent(`${narrative.repoFullName}/${narrative.modulePath}`);

  try {
    await osClient.index({
      index: 'module-narrative-index',
      id: docId,
      body: { ...narrative, embedding },
      refresh: false,
    });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    throw new Error(`OpenSearch upsert failed: ${statusCode ?? 'unknown'}`);
  }
}

/**
 * Query OpenSearch for top-k narratives semantically similar to a query embedding.
 * Filters results to the specified repo.
 */
export async function queryNarratives(
  endpoint: string,
  repoFullName: string,
  queryEmbedding: number[],
  k: number
): Promise<ModuleNarrative[]> {
  const osClient = getClient(endpoint);

  try {
    const response = await osClient.search({
      index: 'module-narrative-index',
      body: {
        size: k,
        query: {
          knn: {
            embedding: {
              vector: queryEmbedding,
              k,
              filter: { term: { repoFullName } },
            },
          },
        },
      },
    });

    const hits = (response.body?.hits?.hits ?? []) as unknown as Array<{
      _source: ModuleNarrative;
    }>;
    return hits.map((h) => h._source);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    throw new Error(`OpenSearch query failed: ${statusCode ?? 'unknown'}`);
  }
}
