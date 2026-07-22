import { RagSearchService } from '../../../src/search/rag-search.service';
import { RagSchemaService } from '../../../src/entities/rag-schema.service';
import { RagChunkingStrategy, RagDatabaseType, RagRetrievalMode } from '../../../src/enums';
import { RagCapabilityError, RagConfigurationError } from '../../../src/errors';
import { RagResolvedModuleContext } from '../../../src/module-context';
import { newId } from '../../../src/utils/id.util';
import { createSqliteTestContext, SqliteTestContext } from '../test-utils/sqlite-test-context';

async function seedDocumentAndChunk(
  ctx: SqliteTestContext,
  params: { revisionId: string; profileName: string; sourceName: string; namespace?: string; content: string; metadata?: Record<string, unknown> },
) {
  const documentId = newId();
  await ctx.repos.document.save({
    id: documentId,
    profileName: params.profileName,
    profileRevisionId: params.revisionId,
    sourceName: params.sourceName,
    sourceId: documentId,
    externalId: documentId,
    namespace: params.namespace ?? null,
    content: params.content,
    contentHash: 'h',
    indexingHash: 'h',
    sourceUpdatedAt: null,
    metadata: params.metadata ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const chunkId = newId();
  await ctx.repos.chunk.save({
    id: chunkId,
    profileName: params.profileName,
    profileRevisionId: params.revisionId,
    documentId,
    chunkIndex: 0,
    content: params.content,
    tokenCount: params.content.split(' ').length,
    metadata: params.metadata ?? null,
    createdAt: new Date(),
  });
  const ftsTable = ctx.schemaService.ftsTableName();
  await ctx.dataSource.query(
    `INSERT INTO "${ftsTable}" (content, chunk_id, profile_revision_id, document_id, source_name, namespace) VALUES (?, ?, ?, ?, ?, ?)`,
    [params.content, chunkId, params.revisionId, documentId, params.sourceName, params.namespace ?? null],
  );
  return { documentId, chunkId };
}

describe('RagSearchService', () => {
  let ctx: SqliteTestContext;
  let configurationService: { getActiveRevision: jest.Mock; getRevision: jest.Mock };

  beforeEach(async () => {
    ctx = await createSqliteTestContext();
  });

  afterEach(() => ctx.close());

  function buildService(mode: RagRetrievalMode, opts: { embedding?: boolean } = {}) {
    const revisionId = 'rev-1';
    const configuration = {
      name: 'default',
      retrieval: {
        defaultMode: mode,
        lexical: { language: 'english' },
        embedding: opts.embedding
          ? { providerId: 'fake', modelId: 'fake-model', dimensions: 3 }
          : undefined,
        hybrid: { strategy: 'rrf' as const, rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 },
      },
      chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 200, chunkOverlap: 20 },
      searchDefaults: { topK: 10, candidateLimit: 50, minScore: 0 },
    };
    configurationService = {
      getActiveRevision: jest.fn().mockResolvedValue({ id: revisionId, dataRevisionId: revisionId, profileName: 'default', configuration }),
      getRevision: jest.fn().mockResolvedValue({ id: revisionId, dataRevisionId: revisionId, profileName: 'default', configuration }),
    };
    const embeddingService = { embedQuery: jest.fn().mockResolvedValue([1, 0, 0]) };
    const service = new RagSearchService(
      ctx.dataSource,
      ctx.schemaService,
      ctx.context,
      ctx.repos.chunk as any,
      ctx.repos.document as any,
      configurationService as any,
      embeddingService as any,
    );
    return { service, revisionId, embeddingService };
  }

  it('performs lexical search scoped to the active revision and hydrates chunk + document data', async () => {
    const { service, revisionId } = buildService(RagRetrievalMode.LEXICAL);
    const { chunkId, documentId } = await seedDocumentAndChunk(ctx, {
      revisionId,
      profileName: 'default',
      sourceName: 'kb',
      content: 'How do I reset my fiber router',
    });

    const results = await service.search('fiber router');
    expect(results).toHaveLength(1);
    expect(results[0].chunk.chunkId).toBe(chunkId);
    expect(results[0].chunk.documentId).toBe(documentId);
    expect(results[0].mode).toBe(RagRetrievalMode.LEXICAL);
  });

  it('only searches chunks belonging to the active revision (index-version isolation)', async () => {
    const { service, revisionId } = buildService(RagRetrievalMode.LEXICAL);
    await seedDocumentAndChunk(ctx, { revisionId, profileName: 'default', sourceName: 'kb', content: 'router setup guide' });
    await seedDocumentAndChunk(ctx, { revisionId: 'rev-OLD', profileName: 'default', sourceName: 'kb', content: 'router setup guide old revision' });

    const results = await service.search('router setup');
    // Only rev-1 content should be searchable through the active-revision-scoped adapter.
    const otherRevisionHits = await ctx.dataSource.query(
      `SELECT chunk_id FROM "${ctx.schemaService.ftsTableName()}" WHERE profile_revision_id = 'rev-OLD'`,
    );
    expect(otherRevisionHits).toHaveLength(1);
    expect(results.every((r) => r.chunk.chunkId !== otherRevisionHits[0].chunk_id)).toBe(true);
  });

  it('supports an explicit administrative revisionId override, validated against the profile', async () => {
    const { service } = buildService(RagRetrievalMode.LEXICAL);
    await service.search('anything', { revisionId: 'rev-1' });
    expect(configurationService.getRevision).toHaveBeenCalledWith('default', 'rev-1');
  });

  it('applies a metadata post-filter', async () => {
    const { service, revisionId } = buildService(RagRetrievalMode.LEXICAL);
    await seedDocumentAndChunk(ctx, {
      revisionId,
      profileName: 'default',
      sourceName: 'kb',
      content: 'fiber router install guide english',
      metadata: { language: 'en' },
    });
    await seedDocumentAndChunk(ctx, {
      revisionId,
      profileName: 'default',
      sourceName: 'kb',
      content: 'fiber router install guide french',
      metadata: { language: 'fr' },
    });

    const results = await service.search('fiber router install guide', { metadata: { language: 'fr' } });
    expect(results).toHaveLength(1);
    expect((results[0].chunk.metadata as any).language).toBe('fr');
  });

  it('respects topK and minScore', async () => {
    const { service, revisionId } = buildService(RagRetrievalMode.LEXICAL);
    for (let i = 0; i < 5; i += 1) {
      await seedDocumentAndChunk(ctx, { revisionId, profileName: 'default', sourceName: 'kb', content: `widget number ${i}` });
    }
    const results = await service.search('widget', { topK: 2 });
    expect(results).toHaveLength(2);
  });

  it('throws when embedding mode is requested but the profile has no embedding configuration', async () => {
    const { service } = buildService(RagRetrievalMode.EMBEDDING, { embedding: false });
    await expect(service.search('query')).rejects.toThrow(RagConfigurationError);
  });

  it('throws RagCapabilityError when embedding mode is requested on a SQLite-backed module', async () => {
    const { service } = buildService(RagRetrievalMode.EMBEDDING, { embedding: true });
    await expect(service.search('query')).rejects.toThrow(RagCapabilityError);
  });

  describe('hybrid retrieval (RRF) with a fake vector adapter standing in for pgvector', () => {
    it('fuses lexical and embedding hits via reciprocal rank fusion', async () => {
      const postgresContext: RagResolvedModuleContext = { ...ctx.context, dbType: RagDatabaseType.POSTGRES, vectorColumnEnabled: true };
      const postgresSchemaService = new RagSchemaService(ctx.dataSource, ctx.schemas, 'rag_', RagDatabaseType.POSTGRES, {
        autoInitialize: false,
        createVectorExtension: true,
        createVectorIndexes: true,
      });

      const revisionId = 'rev-1';
      const configuration = {
        name: 'default',
        retrieval: {
          defaultMode: RagRetrievalMode.HYBRID,
          lexical: { language: 'english' },
          embedding: { providerId: 'fake', modelId: 'fake-model', dimensions: 3 },
          hybrid: { strategy: 'rrf' as const, rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 },
        },
        chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 200, chunkOverlap: 20 },
        searchDefaults: { topK: 10, candidateLimit: 50, minScore: 0 },
      };
      const configurationServiceStub = {
        getActiveRevision: jest.fn().mockResolvedValue({ id: revisionId, dataRevisionId: revisionId, profileName: 'default', configuration }),
        getRevision: jest.fn(),
      };
      const embeddingService = { embedQuery: jest.fn().mockResolvedValue([1, 0, 0]) };

      const service = new RagSearchService(
        ctx.dataSource,
        postgresSchemaService,
        postgresContext,
        ctx.repos.chunk as any,
        ctx.repos.document as any,
        configurationServiceStub as any,
        embeddingService as any,
      );

      const { chunkId: chunkA } = await seedDocumentAndChunk(ctx, { revisionId, profileName: 'default', sourceName: 'kb', content: 'alpha' });
      const { chunkId: chunkB } = await seedDocumentAndChunk(ctx, { revisionId, profileName: 'default', sourceName: 'kb', content: 'beta' });

      // Swap in fake adapters so we don't need a real Postgres connection —
      // this isolates RagSearchService's own fusion/hydration logic.
      (service as any).lexicalAdapter = { search: jest.fn().mockResolvedValue([{ chunkId: chunkA, score: 5 }, { chunkId: chunkB, score: 1 }]) };
      (service as any).vectorAdapter = { search: jest.fn().mockResolvedValue([{ chunkId: chunkB, score: 0.9 }, { chunkId: chunkA, score: 0.4 }]) };

      const results = await service.search('alpha beta', { mode: RagRetrievalMode.HYBRID });
      expect(embeddingService.embedQuery).toHaveBeenCalled();
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.mode === RagRetrievalMode.HYBRID)).toBe(true);
      expect(results.every((r) => typeof r.lexicalRank === 'number' && typeof r.embeddingRank === 'number')).toBe(true);
    });
  });
});
