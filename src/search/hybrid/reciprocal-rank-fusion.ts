import { RagSearchHit } from '../search.types';

export interface RagRrfOptions {
  rrfK: number;
  lexicalWeight: number;
  embeddingWeight: number;
}

export interface RagRrfResult {
  chunkId: string;
  score: number;
  lexicalScore?: number;
  embeddingScore?: number;
  lexicalRank?: number;
  embeddingRank?: number;
}

/**
 * Weighted Reciprocal Rank Fusion (design doc section 23):
 *
 *   combinedScore(item) = lexicalWeight / (rrfK + lexicalRank)
 *                        + embeddingWeight / (rrfK + embeddingRank)
 *
 * Deliberately rank-based, not a blend of raw lexical/vector scores — those
 * two scores live on incomparable scales (BM25-ish vs. cosine similarity),
 * so averaging them directly would be meaningless. A chunk that only
 * appears in one of the two result lists simply contributes zero for the
 * list it's missing from.
 */
export function reciprocalRankFusion(
  lexicalHits: RagSearchHit[],
  embeddingHits: RagSearchHit[],
  options: RagRrfOptions,
): RagRrfResult[] {
  const results = new Map<string, RagRrfResult>();

  lexicalHits.forEach((hit, index) => {
    const rank = index + 1;
    const entry = results.get(hit.chunkId) ?? { chunkId: hit.chunkId, score: 0 };
    entry.lexicalScore = hit.score;
    entry.lexicalRank = rank;
    entry.score += options.lexicalWeight / (options.rrfK + rank);
    results.set(hit.chunkId, entry);
  });

  embeddingHits.forEach((hit, index) => {
    const rank = index + 1;
    const entry = results.get(hit.chunkId) ?? { chunkId: hit.chunkId, score: 0 };
    entry.embeddingScore = hit.score;
    entry.embeddingRank = rank;
    entry.score += options.embeddingWeight / (options.rrfK + rank);
    results.set(hit.chunkId, entry);
  });

  return [...results.values()].sort((a, b) => b.score - a.score);
}
