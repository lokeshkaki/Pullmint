export function cosineSimilarity(a: number[], b: number[]): number {
  const dimensions = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let index = 0; index < dimensions; index += 1) {
    dot += a[index] * b[index];
    magA += a[index] * a[index];
    magB += b[index] * b[index];
  }

  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}

export function rankBySimilarity<T>(
  queryVector: number[],
  items: T[],
  getEmbedding: (item: T) => number[] | undefined,
  topK: number
): T[] {
  return items
    .filter((item) => {
      const embedding = getEmbedding(item);
      return Array.isArray(embedding) && embedding.length === queryVector.length;
    })
    .map((item) => ({
      item,
      score: cosineSimilarity(queryVector, getEmbedding(item)!),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map(({ item }) => item);
}