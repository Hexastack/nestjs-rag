import { analyzeConfigurationChange } from '../../src/config/change-impact.analyzer';
import { RagChangeImpact, RagChunkingStrategy, RagRetrievalMode } from '../../src/enums';
import { RagProfileConfiguration } from '../../src/interfaces/profile.interface';

function baseConfig(overrides: Partial<RagProfileConfiguration> = {}): RagProfileConfiguration {
  return {
    name: 'default',
    retrieval: {
      defaultMode: RagRetrievalMode.HYBRID,
      lexical: { language: 'english' },
      embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536, batchSize: 64 },
      hybrid: { strategy: 'rrf', rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 },
    },
    chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 512, chunkOverlap: 64 },
    searchDefaults: { topK: 10, candidateLimit: 50, minScore: 0 },
    ...overrides,
  };
}

describe('analyzeConfigurationChange', () => {
  it('returns NONE / canApplyImmediately for an unchanged configuration', () => {
    const current = baseConfig();
    const result = analyzeConfigurationChange(current, baseConfig());
    expect(result.impact).toBe(RagChangeImpact.NONE);
    expect(result.changedPaths).toEqual([]);
    expect(result.canApplyImmediately).toBe(true);
  });

  it('returns NONE when there is no prior revision to diff against', () => {
    const result = analyzeConfigurationChange(null, baseConfig());
    expect(result.impact).toBe(RagChangeImpact.NONE);
  });

  describe('query-only changes', () => {
    it.each([
      ['searchDefaults.topK', (c: RagProfileConfiguration) => ({ ...c, searchDefaults: { ...c.searchDefaults, topK: 25 } })],
      ['searchDefaults.candidateLimit', (c: RagProfileConfiguration) => ({ ...c, searchDefaults: { ...c.searchDefaults, candidateLimit: 100 } })],
      ['searchDefaults.minScore', (c: RagProfileConfiguration) => ({ ...c, searchDefaults: { ...c.searchDefaults, minScore: 0.5 } })],
      ['retrieval.hybrid.rrfK', (c: RagProfileConfiguration) => ({ ...c, retrieval: { ...c.retrieval, hybrid: { ...c.retrieval.hybrid, rrfK: 80 } } })],
      ['retrieval.hybrid.lexicalWeight', (c: RagProfileConfiguration) => ({ ...c, retrieval: { ...c.retrieval, hybrid: { ...c.retrieval.hybrid, lexicalWeight: 1.5 } } })],
      ['retrieval.hybrid.embeddingWeight', (c: RagProfileConfiguration) => ({ ...c, retrieval: { ...c.retrieval, hybrid: { ...c.retrieval.hybrid, embeddingWeight: 0.5 } } })],
      ['retrieval.defaultMode', (c: RagProfileConfiguration) => ({ ...c, retrieval: { ...c.retrieval, defaultMode: RagRetrievalMode.LEXICAL } })],
    ])('classifies %s as query-only and immediately applicable', (_name, mutate) => {
      const current = baseConfig();
      const result = analyzeConfigurationChange(current, mutate(current));
      expect(result.impact).toBe(RagChangeImpact.QUERY_ONLY);
      expect(result.canApplyImmediately).toBe(true);
    });
  });

  describe('re-index-required changes', () => {
    it.each([
      ['chunking.strategy', (c: RagProfileConfiguration) => ({ ...c, chunking: { ...c.chunking, strategy: RagChunkingStrategy.RECURSIVE } })],
      ['chunking.chunkSize', (c: RagProfileConfiguration) => ({ ...c, chunking: { ...c.chunking, chunkSize: 800 } })],
      ['chunking.chunkOverlap', (c: RagProfileConfiguration) => ({ ...c, chunking: { ...c.chunking, chunkOverlap: 100 } })],
      ['retrieval.lexical.language', (c: RagProfileConfiguration) => ({ ...c, retrieval: { ...c.retrieval, lexical: { language: 'french' } } })],
      ['retrieval.embedding.providerId', (c: RagProfileConfiguration) => ({ ...c, retrieval: { ...c.retrieval, embedding: { ...c.retrieval.embedding!, providerId: 'google' } } })],
      ['retrieval.embedding.modelId', (c: RagProfileConfiguration) => ({ ...c, retrieval: { ...c.retrieval, embedding: { ...c.retrieval.embedding!, modelId: 'text-embedding-004' } } })],
      ['retrieval.embedding.providerOptions', (c: RagProfileConfiguration) => ({ ...c, retrieval: { ...c.retrieval, embedding: { ...c.retrieval.embedding!, providerOptions: { taskType: 'RETRIEVAL_DOCUMENT' } } } })],
    ])('classifies %s as reindex-required and NOT immediately applicable', (_name, mutate) => {
      const current = baseConfig();
      const result = analyzeConfigurationChange(current, mutate(current));
      expect(result.impact).toBe(RagChangeImpact.REINDEX_REQUIRED);
      expect(result.canApplyImmediately).toBe(false);
      expect(result.reasons.length).toBeGreaterThan(0);
    });
  });

  describe('schema-change-required changes', () => {
    it('classifies embedding dimension changes as schema-change-required', () => {
      const current = baseConfig();
      const proposed = { ...current, retrieval: { ...current.retrieval, embedding: { ...current.retrieval.embedding!, dimensions: 3072 } } };
      const result = analyzeConfigurationChange(current, proposed);
      expect(result.impact).toBe(RagChangeImpact.SCHEMA_CHANGE_REQUIRED);
      expect(result.canApplyImmediately).toBe(false);
    });
  });

  it('takes the worst-case impact when multiple paths change at once', () => {
    const current = baseConfig();
    const proposed: RagProfileConfiguration = {
      ...current,
      chunking: { ...current.chunking, chunkSize: 900 }, // reindex-required
      searchDefaults: { ...current.searchDefaults, topK: 20 }, // query-only
    };
    const result = analyzeConfigurationChange(current, proposed);
    expect(result.impact).toBe(RagChangeImpact.REINDEX_REQUIRED);
    expect(result.changedPaths.sort()).toEqual(['chunking.chunkSize', 'searchDefaults.topK'].sort());
  });

  describe('defensive fallback for unrecognized paths', () => {
    it('classifies a changed path missing from the classification table as reindex-required', () => {
      const current = baseConfig();
      const proposed = {
        ...current,
        chunking: { ...current.chunking, futureKnob: 'anything' },
      } as unknown as RagProfileConfiguration;
      const result = analyzeConfigurationChange(current, proposed);
      expect(result.impact).toBe(RagChangeImpact.REINDEX_REQUIRED);
      expect(result.canApplyImmediately).toBe(false);
      expect(result.changedPaths).toContain('chunking.futureKnob');
      expect(result.reasons.some((r) => r.includes('not covered'))).toBe(true);
    });

    it('does not double-flag children of a table-covered whole-object path', () => {
      const current = baseConfig();
      const proposed = {
        ...current,
        retrieval: {
          ...current.retrieval,
          embedding: { ...current.retrieval.embedding!, someNewSetting: true },
        },
      } as unknown as RagProfileConfiguration;
      const result = analyzeConfigurationChange(current, proposed);
      // Covered by the `retrieval.embedding` whole-object entry.
      expect(result.impact).toBe(RagChangeImpact.REINDEX_REQUIRED);
      expect(result.changedPaths).toContain('retrieval.embedding');
      expect(result.changedPaths).not.toContain('retrieval.embedding.someNewSetting');
    });
  });

  it('classifies a description-only change as NONE impact and immediately applicable', () => {
    const current = baseConfig();
    const proposed = { ...current, description: 'a new human-readable description' };
    const result = analyzeConfigurationChange(current, proposed);
    expect(result.impact).toBe(RagChangeImpact.NONE);
    expect(result.canApplyImmediately).toBe(true);
  });
});
