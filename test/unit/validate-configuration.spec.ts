import { validateProfileConfigurationStructure } from '../../src/config/validate-configuration';
import { RagChunkingStrategy, RagDatabaseType, RagRetrievalMode } from '../../src/enums';
import { RagProfileConfiguration } from '../../src/interfaces/profile.interface';

function validConfig(): RagProfileConfiguration {
  return {
    name: 'default',
    retrieval: { defaultMode: RagRetrievalMode.LEXICAL },
    chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 512, chunkOverlap: 64 },
  };
}

describe('validateProfileConfigurationStructure', () => {
  it('accepts a minimal, valid lexical configuration', () => {
    const result = validateProfileConfigurationStructure(validConfig(), {
      dbType: RagDatabaseType.SQLITE,
      vectorColumnEnabled: false,
    });
    expect(result.errors).toEqual([]);
  });

  it('rejects a non-positive chunk size', () => {
    const config = { ...validConfig(), chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 0, chunkOverlap: 0 } };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.SQLITE, vectorColumnEnabled: false });
    expect(result.errors.some((e) => e.includes('chunkSize'))).toBe(true);
  });

  it('rejects a negative chunk overlap', () => {
    const config = { ...validConfig(), chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 100, chunkOverlap: -1 } };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.SQLITE, vectorColumnEnabled: false });
    expect(result.errors.some((e) => e.includes('chunkOverlap'))).toBe(true);
  });

  it('rejects an overlap that is not smaller than the chunk size', () => {
    const config = { ...validConfig(), chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 100, chunkOverlap: 100 } };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.SQLITE, vectorColumnEnabled: false });
    expect(result.errors.some((e) => e.includes('must be smaller than'))).toBe(true);
  });

  it('rejects embedding mode on a SQLite-backed profile', () => {
    const config: RagProfileConfiguration = {
      ...validConfig(),
      retrieval: {
        defaultMode: RagRetrievalMode.EMBEDDING,
        embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536 },
      },
    };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.SQLITE, vectorColumnEnabled: false });
    expect(result.errors.some((e) => e.toLowerCase().includes('sqlite'))).toBe(true);
  });

  it('rejects hybrid mode on a SQLite-backed profile', () => {
    const config: RagProfileConfiguration = {
      ...validConfig(),
      retrieval: {
        defaultMode: RagRetrievalMode.HYBRID,
        embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536 },
      },
    };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.SQLITE, vectorColumnEnabled: false });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('requires retrieval.embedding when mode is embedding on Postgres', () => {
    const config: RagProfileConfiguration = { ...validConfig(), retrieval: { defaultMode: RagRetrievalMode.EMBEDDING } };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.POSTGRES, vectorColumnEnabled: true });
    expect(result.errors.some((e) => e.includes('retrieval.embedding is required'))).toBe(true);
  });

  it('rejects embedding config on Postgres when the module has not enabled the vector column', () => {
    const config: RagProfileConfiguration = {
      ...validConfig(),
      retrieval: {
        defaultMode: RagRetrievalMode.EMBEDDING,
        embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536 },
      },
    };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.POSTGRES, vectorColumnEnabled: false });
    expect(result.errors.some((e) => e.includes('createVectorExtension'))).toBe(true);
  });

  it('rejects embedding config without the vector column even when the default mode is lexical', () => {
    const config: RagProfileConfiguration = {
      ...validConfig(),
      retrieval: {
        defaultMode: RagRetrievalMode.LEXICAL,
        embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536 },
      },
    };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.POSTGRES, vectorColumnEnabled: false });
    expect(result.errors.some((e) => e.includes('createVectorExtension'))).toBe(true);
  });

  it('accepts embedding config on Postgres when the vector column is enabled', () => {
    const config: RagProfileConfiguration = {
      ...validConfig(),
      retrieval: {
        defaultMode: RagRetrievalMode.EMBEDDING,
        embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536 },
      },
    };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.POSTGRES, vectorColumnEnabled: true });
    expect(result.errors).toEqual([]);
  });

  it('rejects a non-positive embedding dimension', () => {
    const config: RagProfileConfiguration = {
      ...validConfig(),
      retrieval: {
        defaultMode: RagRetrievalMode.EMBEDDING,
        embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 0 },
      },
    };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.POSTGRES, vectorColumnEnabled: true });
    expect(result.errors.some((e) => e.includes('dimensions'))).toBe(true);
  });

  it('flags an unregistered provider id when a registry is supplied', () => {
    const config: RagProfileConfiguration = {
      ...validConfig(),
      retrieval: {
        defaultMode: RagRetrievalMode.EMBEDDING,
        embedding: { providerId: 'unknown-provider', modelId: 'x', dimensions: 10 },
      },
    };
    const registry = { has: () => false } as any;
    const result = validateProfileConfigurationStructure(config, {
      dbType: RagDatabaseType.POSTGRES,
      vectorColumnEnabled: true,
      registry,
    });
    expect(result.errors.some((e) => e.includes('not a registered provider'))).toBe(true);
  });

  it('warns when candidateLimit is smaller than topK', () => {
    const config: RagProfileConfiguration = { ...validConfig(), searchDefaults: { topK: 20, candidateLimit: 5 } };
    const result = validateProfileConfigurationStructure(config, { dbType: RagDatabaseType.SQLITE, vectorColumnEnabled: false });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
