import { reciprocalRankFusion } from '../../src/search/hybrid/reciprocal-rank-fusion';

describe('reciprocalRankFusion', () => {
  it('computes the weighted RRF formula for items present in both lists', () => {
    const lexical = [{ chunkId: 'a', score: 10 }, { chunkId: 'b', score: 5 }];
    const embedding = [{ chunkId: 'b', score: 0.9 }, { chunkId: 'a', score: 0.5 }];
    const result = reciprocalRankFusion(lexical, embedding, { rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 });

    const a = result.find((r) => r.chunkId === 'a')!;
    const b = result.find((r) => r.chunkId === 'b')!;
    // a: lexical rank 1, embedding rank 2 -> 1/(60+1) + 1/(60+2)
    expect(a.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    // b: lexical rank 2, embedding rank 1 -> 1/(60+2) + 1/(60+1)
    expect(b.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it('gives a chunk present only in one list just that list\'s contribution', () => {
    const lexical = [{ chunkId: 'only-lexical', score: 1 }];
    const embedding: typeof lexical = [];
    const result = reciprocalRankFusion(lexical, embedding, { rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].score).toBeCloseTo(1 / 61, 10);
    expect(result[0].embeddingRank).toBeUndefined();
  });

  it('applies lexicalWeight and embeddingWeight independently', () => {
    const lexical = [{ chunkId: 'x', score: 1 }];
    const embedding = [{ chunkId: 'x', score: 1 }];
    const unweighted = reciprocalRankFusion(lexical, embedding, { rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 });
    const weighted = reciprocalRankFusion(lexical, embedding, { rrfK: 60, lexicalWeight: 2, embeddingWeight: 0.5 });
    expect(weighted[0].score).toBeCloseTo(2 / 61 + 0.5 / 61, 10);
    expect(weighted[0].score).not.toBeCloseTo(unweighted[0].score, 10);
  });

  it('sorts results by descending combined score', () => {
    const lexical = [{ chunkId: 'low', score: 1 }, { chunkId: 'high', score: 10 }];
    const embedding = [{ chunkId: 'high', score: 0.9 }];
    const result = reciprocalRankFusion(lexical, embedding, { rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 });
    expect(result[0].chunkId).toBe('high');
  });

  it('a larger rrfK dampens the influence of rank position', () => {
    const lexical = [{ chunkId: 'a', score: 1 }, { chunkId: 'b', score: 1 }];
    const embedding: typeof lexical = [];
    const smallK = reciprocalRankFusion(lexical, embedding, { rrfK: 1, lexicalWeight: 1, embeddingWeight: 1 });
    const largeK = reciprocalRankFusion(lexical, embedding, { rrfK: 1000, lexicalWeight: 1, embeddingWeight: 1 });
    const smallKGap = smallK[0].score - smallK[1].score;
    const largeKGap = largeK[0].score - largeK[1].score;
    expect(smallKGap).toBeGreaterThan(largeKGap);
  });

  it('returns an empty array when both input lists are empty', () => {
    expect(reciprocalRankFusion([], [], { rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 })).toEqual([]);
  });
});
