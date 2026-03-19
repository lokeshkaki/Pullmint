import type { ModuleNarrative } from '../shared/types';

interface OpenSearchDoc {
  repoFullName: string;
  modulePath: string;
  narrativeText: string;
  generatedAtSha: string;
  version: number;
  embedding: number[];
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
  const docId = encodeURIComponent(`${narrative.repoFullName}/${narrative.modulePath}`);
  const doc: OpenSearchDoc = { ...narrative, embedding };
  const url = `${endpoint}/module-narrative-index/_doc/${docId}`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  });

  if (!response.ok) {
    throw new Error(`OpenSearch upsert failed: ${response.status}`);
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
  const url = `${endpoint}/module-narrative-index/_search`;
  // OpenSearch Serverless k-NN: filter goes inside the knn clause, not in bool.must
  const query = {
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
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });

  if (!response.ok) {
    throw new Error(`OpenSearch query failed: ${response.status}`);
  }

  const body = (await response.json()) as {
    hits: { hits: Array<{ _source: ModuleNarrative }> };
  };
  return body.hits.hits.map((h) => h._source);
}
