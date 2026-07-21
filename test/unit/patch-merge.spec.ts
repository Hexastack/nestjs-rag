import { applyProfilePatch, resolveEffectiveChunking, resolveEffectiveRetrieval, withProfileDefaults } from '../../src/config/patch-merge.util';
import { RagChunkingStrategy, RagRetrievalMode } from '../../src/enums';
import { RagProfileConfiguration } from '../../src/interfaces/profile.interface';

function baseConfig(): RagProfileConfiguration {
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
  };
}

describe('applyProfilePatch', () => {
  it('does not mutate the base configuration', () => {
    const base = baseConfig();
    const snapshot = JSON.parse(JSON.stringify(base));
    applyProfilePatch(base, { chunking: { chunkSize: 999 } });
    expect(base).toEqual(snapshot);
  });

  it('merges a partial chunking patch, leaving unspecified fields untouched', () => {
    const base = baseConfig();
    const patched = applyProfilePatch(base, { chunking: { chunkSize: 800 } });
    expect(patched.chunking).toEqual({ strategy: RagChunkingStrategy.TOKEN, chunkSize: 800, chunkOverlap: 64 });
  });

  it('merges a partial embedding patch onto the existing embedding config', () => {
    const base = baseConfig();
    const patched = applyProfilePatch(base, {
      retrieval: { embedding: { modelId: 'text-embedding-3-large', dimensions: 3072 } },
    });
    expect(patched.retrieval.embedding).toEqual({
      providerId: 'openai',
      modelId: 'text-embedding-3-large',
      dimensions: 3072,
      batchSize: 64,
    });
  });

  it('merges hybrid weight patches independently', () => {
    const base = baseConfig();
    const patched = applyProfilePatch(base, { retrieval: { hybrid: { lexicalWeight: 1.5 } } });
    expect(patched.retrieval.hybrid).toEqual({ strategy: 'rrf', rrfK: 60, lexicalWeight: 1.5, embeddingWeight: 1 });
  });

  it('replaces defaultMode when patched', () => {
    const base = baseConfig();
    const patched = applyProfilePatch(base, { retrieval: { defaultMode: RagRetrievalMode.LEXICAL } });
    expect(patched.retrieval.defaultMode).toBe(RagRetrievalMode.LEXICAL);
    // Untouched sections stay intact.
    expect(patched.retrieval.embedding).toEqual(base.retrieval.embedding);
  });

  it('preserves name and only overrides description when given', () => {
    const base = baseConfig();
    const patched = applyProfilePatch(base, { description: 'updated' });
    expect(patched.name).toBe(base.name);
    expect(patched.description).toBe('updated');
  });
});

describe('withProfileDefaults', () => {
  it('fills in hybrid defaults only when defaultMode is hybrid', () => {
    const lexicalOnly = withProfileDefaults({
      name: 'x',
      retrieval: { defaultMode: RagRetrievalMode.LEXICAL },
      chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 100, chunkOverlap: 10 },
    });
    expect(lexicalOnly.retrieval.hybrid).toBeUndefined();

    const hybrid = withProfileDefaults({
      name: 'x',
      retrieval: { defaultMode: RagRetrievalMode.HYBRID },
      chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 100, chunkOverlap: 10 },
    });
    expect(hybrid.retrieval.hybrid).toEqual({ strategy: 'rrf', rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 });
  });

  it('fills in search defaults', () => {
    const result = withProfileDefaults({
      name: 'x',
      retrieval: { defaultMode: RagRetrievalMode.LEXICAL },
      chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 100, chunkOverlap: 10 },
    });
    expect(result.searchDefaults).toEqual({ topK: 10, candidateLimit: 50, minScore: 0 });
  });
});

describe('resolveEffectiveChunking', () => {
  it('layers profile -> source override -> per-operation override, per-operation wins', () => {
    const profile = { strategy: RagChunkingStrategy.TOKEN, chunkSize: 512, chunkOverlap: 64 };
    const source = { chunkSize: 300 };
    const operation = { chunkSize: 150 };
    expect(resolveEffectiveChunking(profile, source, operation)).toEqual({
      strategy: RagChunkingStrategy.TOKEN,
      chunkSize: 150,
      chunkOverlap: 64,
    });
  });

  it('falls back to the profile configuration when no overrides are given', () => {
    const profile = { strategy: RagChunkingStrategy.SENTENCE, chunkSize: 256, chunkOverlap: 32 };
    expect(resolveEffectiveChunking(profile)).toEqual(profile);
  });
});

describe('resolveEffectiveRetrieval', () => {
  it('merges a source-level embedding override onto the profile embedding config', () => {
    const base = baseConfig().retrieval;
    const effective = resolveEffectiveRetrieval(base, { embedding: { ...base.embedding!, batchSize: 16 } });
    expect(effective.embedding).toEqual({ ...base.embedding, batchSize: 16 });
  });

  it('returns the profile retrieval unchanged when no source override is given', () => {
    const base = baseConfig().retrieval;
    expect(resolveEffectiveRetrieval(base)).toBe(base);
  });
});
