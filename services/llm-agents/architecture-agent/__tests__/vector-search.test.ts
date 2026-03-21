import { cosineSimilarity, rankBySimilarity } from '../vector-search';

describe('vector-search', () => {
  it('should compute cosine similarity of identical vectors as 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it('should compute cosine similarity of orthogonal vectors as 0', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it('should compute cosine similarity of opposite vectors as -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it('should return 0 for zero-length vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it('should rank narratives by similarity and return top-k', () => {
    const query = [1, 0, 0];
    const items = [
      { embedding: [0, 1, 0], data: 'orthogonal' },
      { embedding: [1, 0, 0], data: 'identical' },
      { embedding: [0.9, 0.1, 0], data: 'close' },
    ];

    const ranked = rankBySimilarity(query, items, (item) => item.embedding, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].data).toBe('identical');
    expect(ranked[1].data).toBe('close');
  });
});
