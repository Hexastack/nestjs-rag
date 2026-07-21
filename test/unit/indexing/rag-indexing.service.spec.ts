import { RagIndexingService } from '../../../src/indexing/rag-indexing.service';
import { RagSourceRegistry } from '../../../src/source/source-registry';
import { ChonkieChunkerFactory } from '../../../src/chunking/chonkie-chunker.factory';
import { RagEmbeddingProviderRegistry } from '../../../src/providers/embedding-provider-registry';
import { RagChunkingStrategy, RagOperationStatus, RagRetrievalMode } from '../../../src/enums';
import { RagSourceNotFoundError } from '../../../src/errors';
import { RagSourceProvider, RagSourceRecord } from '../../../src/interfaces/source.interface';
import { createSqliteTestContext, SqliteTestContext } from '../test-utils/sqlite-test-context';

function lexicalRevision(id: string, overrides: Partial<any> = {}) {
  return {
    id,
    profileName: 'default',
    configuration: {
      name: 'default',
      retrieval: { defaultMode: RagRetrievalMode.LEXICAL, lexical: { language: 'english' } },
      chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 50, chunkOverlap: 0 },
      ...overrides,
    },
  };
}

class InMemorySourceProvider implements RagSourceProvider {
  constructor(
    public readonly name: string,
    private records: RagSourceRecord[],
  ) {}

  async fetchRecords(options: { since?: Date; cursor?: string | null; batchSize: number }) {
    const startIndex = options.cursor ? this.records.findIndex((r) => r.externalId === options.cursor) + 1 : 0;
    const page = this.records.slice(startIndex, startIndex + options.batchSize);
    const nextCursor = page.length === options.batchSize ? page[page.length - 1].externalId : null;
    return { records: page, nextCursor };
  }

  async fetchRecord(externalId: string) {
    return this.records.find((r) => r.externalId === externalId) ?? null;
  }
}

describe('RagIndexingService', () => {
  let ctx: SqliteTestContext;
  let configurationService: { getActiveRevision: jest.Mock; getRevision: jest.Mock; listRevisions: jest.Mock };
  let sourceRegistry: RagSourceRegistry;
  let service: RagIndexingService;
  let embeddingService: { embedMany: jest.Mock; embedQuery: jest.Mock };

  beforeEach(async () => {
    ctx = await createSqliteTestContext();
    const revision = lexicalRevision('rev-1');
    configurationService = {
      getActiveRevision: jest.fn().mockResolvedValue(revision),
      getRevision: jest.fn().mockImplementation(async (_p: string, id: string) => lexicalRevision(id)),
      listRevisions: jest.fn().mockResolvedValue([]),
    };
    sourceRegistry = new RagSourceRegistry();
    embeddingService = { embedMany: jest.fn().mockResolvedValue([]), embedQuery: jest.fn() };

    service = new RagIndexingService(
      ctx.repos.document as any,
      ctx.repos.chunk as any,
      ctx.repos.chunkEmbedding as any,
      ctx.repos.sourceBinding as any,
      ctx.dataSource,
      ctx.schemaService,
      ctx.context,
      configurationService as any,
      sourceRegistry,
      new ChonkieChunkerFactory(),
      embeddingService as any,
      new RagEmbeddingProviderRegistry(),
    );
  });

  afterEach(() => ctx.close());

  describe('ingest (direct ingestion)', () => {
    it('creates a document and chunks it against the active revision', async () => {
      const result = await service.ingest({ externalId: 'doc-1', content: 'Fiber routers are easy to install and configure.' });
      expect(result.skipped).toBe(false);
      expect(result.chunksCreated).toBeGreaterThan(0);
      expect(result.revisionId).toBe('rev-1');

      const chunkCount = await ctx.repos.chunk.count({ where: { profileRevisionId: 'rev-1' } });
      expect(chunkCount).toBe(result.chunksCreated);
    });

    it('skips re-indexing unchanged content on a second call unless replaceExisting is requested', async () => {
      await service.ingest({ externalId: 'doc-1', content: 'Same content every time.' }, { replaceExisting: false });
      const second = await service.ingest({ externalId: 'doc-1', content: 'Same content every time.' }, { replaceExisting: false });
      expect(second.skipped).toBe(true);
      expect(second.skipReason).toBe('unchanged');
    });

    it('replaces chunks when content changes', async () => {
      const first = await service.ingest({ externalId: 'doc-1', content: 'Version one of the document.' });
      const second = await service.ingest({ externalId: 'doc-1', content: 'Completely different version two content here now.' });
      expect(second.indexingHash).not.toEqual(first.indexingHash);
      const documents = await ctx.repos.document.count({ where: { profileRevisionId: 'rev-1' } });
      expect(documents).toBe(1); // same document row, updated in place
    });

    it('contributes per-operation chunking overrides to the indexing hash', async () => {
      const withoutOverride = await service.ingest({ externalId: 'doc-2', content: 'abc def ghi' });
      const withOverride = await service.ingest(
        { externalId: 'doc-3', content: 'abc def ghi' },
        { chunkingOverrides: { chunkSize: 5 } },
      );
      expect(withOverride.indexingHash).not.toEqual(withoutOverride.indexingHash);
    });

    it('ingestMany ingests every document', async () => {
      const results = await service.ingestMany([
        { externalId: 'a', content: 'alpha content here' },
        { externalId: 'b', content: 'beta content here' },
      ]);
      expect(results).toHaveLength(2);
    });
  });

  describe('removeSourceRecord / indexSourceRecord', () => {
    beforeEach(async () => {
      await ctx.repos.sourceBinding.save({
        id: 'binding-1',
        sourceName: 'kb',
        profileName: 'default',
        sourceConfiguration: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      sourceRegistry.register({
        name: 'kb',
        kind: 'provider',
        provider: new InMemorySourceProvider('kb', [
          { externalId: '1', content: 'first record content here for testing' },
          { externalId: '2', content: 'second record content here for testing' },
        ]),
        defaultProfileName: 'default',
      } as any);
    });

    it('indexSourceRecord fetches and indexes a single record by id', async () => {
      const result = await service.indexSourceRecord('kb', '1');
      expect(result.externalId).toBe('1');
      expect(result.chunksCreated).toBeGreaterThan(0);
    });

    it('throws for an unknown source', async () => {
      await expect(service.indexSourceRecord('missing', '1')).rejects.toThrow(RagSourceNotFoundError);
    });

    it('removeSourceRecord deletes the document, its chunks, and its FTS rows', async () => {
      await service.indexSourceRecord('kb', '1');
      const before = await ctx.repos.document.count();
      expect(before).toBe(1);

      await service.removeSourceRecord('kb', '1');
      expect(await ctx.repos.document.count()).toBe(0);
      expect(await ctx.repos.chunk.count()).toBe(0);
    });
  });

  describe('syncSource', () => {
    beforeEach(async () => {
      await ctx.repos.sourceBinding.save({
        id: 'binding-1',
        sourceName: 'kb',
        profileName: 'default',
        sourceConfiguration: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    it('indexes every record a provider returns, across pages', async () => {
      const records: RagSourceRecord[] = Array.from({ length: 5 }, (_, i) => ({
        externalId: `r${i}`,
        content: `record number ${i} with some content to chunk`,
      }));
      sourceRegistry.register({ name: 'kb', kind: 'provider', provider: new InMemorySourceProvider('kb', records), defaultProfileName: 'default' } as any);

      const result = await service.syncSource('kb', { batchSize: 2 });
      expect(result.status).toBe(RagOperationStatus.COMPLETED);
      expect(result.documentsIndexed).toBe(5);
      expect(await ctx.repos.document.count()).toBe(5);
    });

    it('removes documents whose provider record is marked deleted', async () => {
      sourceRegistry.register({
        name: 'kb',
        kind: 'provider',
        provider: new InMemorySourceProvider('kb', [{ externalId: '1', content: 'will be removed shortly after indexing' }]),
        defaultProfileName: 'default',
      } as any);
      await service.syncSource('kb');
      expect(await ctx.repos.document.count()).toBe(1);

      sourceRegistry = new RagSourceRegistry();
      sourceRegistry.register({
        name: 'kb',
        kind: 'provider',
        provider: new InMemorySourceProvider('kb', [{ externalId: '1', content: '', deletedAt: new Date() }]),
        defaultProfileName: 'default',
      } as any);
      (service as any).sourceRegistry = sourceRegistry;
      (service as any).providerCache.clear();

      const result = await service.syncSource('kb');
      expect(result.documentsRemoved).toBe(1);
      expect(await ctx.repos.document.count()).toBe(0);
    });

    it('continues past per-record failures when continueOnError is set', async () => {
      // One well-formed record and one with a malformed content field, to
      // deterministically trigger a runtime failure for the second record.
      const brokenProvider: RagSourceProvider = {
        name: 'kb',
        async fetchRecords() {
          return {
            records: [
              { externalId: 'ok', content: 'fine content here' },
              // Intentionally malformed (content is not a string) to deterministically trigger a runtime failure.
              { externalId: 'bad', content: null as unknown as string },
            ],
            nextCursor: null,
          };
        },
      };
      sourceRegistry.register({ name: 'kb', kind: 'provider', provider: brokenProvider, defaultProfileName: 'default' } as any);

      const result = await service.syncSource('kb', { continueOnError: true });
      expect(result.documentsIndexed).toBe(1);
      expect(result.failures).toBe(1);
      expect(result.status).toBe(RagOperationStatus.COMPLETED_WITH_ERRORS);
    });
  });

  describe('reindexRevision', () => {
    it('aggregates results across all sources bound to the profile', async () => {
      await ctx.repos.sourceBinding.save([
        { id: 'b1', sourceName: 'kb1', profileName: 'default', sourceConfiguration: {}, createdAt: new Date(), updatedAt: new Date() },
        { id: 'b2', sourceName: 'kb2', profileName: 'default', sourceConfiguration: {}, createdAt: new Date(), updatedAt: new Date() },
      ] as any);
      sourceRegistry.register({
        name: 'kb1',
        kind: 'provider',
        provider: new InMemorySourceProvider('kb1', [{ externalId: '1', content: 'kb1 content about routers' }]),
        defaultProfileName: 'default',
      } as any);
      sourceRegistry.register({
        name: 'kb2',
        kind: 'provider',
        provider: new InMemorySourceProvider('kb2', [{ externalId: '1', content: 'kb2 content about billing' }]),
        defaultProfileName: 'default',
      } as any);

      const result = await service.reindexRevision('default', 'rev-1');
      expect(result.documentsIndexed).toBe(2);
      expect(result.readyForActivation).toBe(true);
      expect(result.sources).toHaveLength(2);
    });
  });
});
