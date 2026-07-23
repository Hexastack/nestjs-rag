import { RagIndexingService } from '../../../src/indexing/rag-indexing.service';
import { RagSourceRegistry } from '../../../src/source/source-registry';
import { ChonkieChunkerFactory } from '../../../src/chunking/chonkie-chunker.factory';
import { RagEmbeddingProviderRegistry } from '../../../src/providers/embedding-provider-registry';
import { RagChunkingStrategy, RagOperationStatus, RagRetrievalMode, RagRevisionStatus } from '../../../src/enums';
import { RagConcurrencyError, RagProfileRevisionError, RagSourceNotFoundError } from '../../../src/errors';
import { RagSourceProvider, RagSourceRecord } from '../../../src/interfaces/source.interface';
import { createSqliteTestContext, SqliteTestContext } from '../test-utils/sqlite-test-context';

function lexicalRevision(id: string, overrides: Partial<any> = {}) {
  return {
    id,
    dataRevisionId: id,
    profileName: 'default',
    status: RagRevisionStatus.ACTIVE,
    configuration: {
      name: 'default',
      retrieval: { defaultMode: RagRetrievalMode.LEXICAL, lexical: { language: 'english' } },
      chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 50, chunkOverlap: 0 },
      ...overrides,
    },
  };
}

/**
 * Physical revision row matching what `lexicalRevision` mocks at the service
 * layer — the write-time guard (`assertRevisionWritable`) re-reads revision
 * rows inside the write transaction, so they have to actually exist.
 */
function revisionRow(id: string, revisionNumber: number, status: string, overrides: Partial<any> = {}) {
  return {
    id,
    profileId: 'profile-1',
    profileName: 'default',
    revisionNumber,
    status,
    configuration: lexicalRevision(id).configuration,
    configurationHash: `hash-${id}`,
    changeImpact: 'none',
    previousRevisionId: null,
    dataRevisionId: id,
    sourceIndexGeneration: null,
    error: null,
    createdAt: new Date(),
    activatedAt: null,
    failedAt: null,
    ...overrides,
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
  let configurationService: {
    getActiveRevision: jest.Mock;
    getRevision: jest.Mock;
    listRevisions: jest.Mock;
    guardRevisionWrite: jest.Mock;
  };
  let sourceRegistry: RagSourceRegistry;
  let service: RagIndexingService;
  let embeddingService: { embedMany: jest.Mock; embedQuery: jest.Mock };

  beforeEach(async () => {
    ctx = await createSqliteTestContext();
    const revision = lexicalRevision('rev-1');
    configurationService = {
      getActiveRevision: jest.fn().mockResolvedValue(revision),
      getRevision: jest.fn().mockImplementation(async (_p: string, id: string) => ({
        ...lexicalRevision(id),
        status: id === 'rev-1' ? RagRevisionStatus.ACTIVE : RagRevisionStatus.PENDING,
      })),
      listRevisions: jest.fn().mockResolvedValue([]),
      guardRevisionWrite: jest.fn(),
    };
    sourceRegistry = new RagSourceRegistry();
    embeddingService = { embedMany: jest.fn().mockResolvedValue([]), embedQuery: jest.fn() };

    await ctx.repos.profile.save({
      id: 'profile-1',
      name: 'default',
      description: null,
      activeRevisionId: 'rev-1',
      indexGeneration: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await ctx.repos.profileRevision.save([
      revisionRow('rev-1', 1, RagRevisionStatus.ACTIVE, { activatedAt: new Date() }),
      revisionRow('rev-2', 2, RagRevisionStatus.PENDING),
    ] as any);
    configurationService.guardRevisionWrite.mockImplementation(async (manager: any, target: any) => {
      const profile = await manager.findOne(ctx.schemas.profile, { where: { name: target.profileName } });
      const row = await manager.findOne(ctx.schemas.profileRevision, { where: { id: target.revisionId } });
      const targetsActive = target.resolution === 'active' || profile?.activeRevisionId === target.revisionId;
      if (targetsActive) {
        if (
          !profile ||
          profile.activeRevisionId !== target.revisionId ||
          row?.status !== RagRevisionStatus.ACTIVE ||
          row.dataRevisionId !== target.dataRevisionId
        ) {
          throw new RagConcurrencyError(target.profileName, target.revisionId, profile?.activeRevisionId ?? 'none');
        }
        await manager.update(
          ctx.schemas.profile,
          { id: profile.id },
          { indexGeneration: profile.indexGeneration + 1 },
        );
        return;
      }
      if (
        !row ||
        row.dataRevisionId !== target.dataRevisionId ||
        row.status === RagRevisionStatus.ARCHIVED ||
        row.status === RagRevisionStatus.FAILED
      ) {
        throw new RagProfileRevisionError(`Revision "${target.revisionId}" is no longer writable.`);
      }
    });

    service = new RagIndexingService(
      ctx.repos.document as any,
      ctx.repos.chunk as any,
      ctx.repos.chunkEmbedding as any,
      ctx.repos.sourceBinding as any,
      ctx.repos.profileRevision as any,
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

    function swapProvider(records: RagSourceRecord[], wiringOverrides: Record<string, unknown> = {}) {
      sourceRegistry = new RagSourceRegistry();
      sourceRegistry.register({
        name: 'kb',
        kind: 'provider',
        provider: new InMemorySourceProvider('kb', records),
        defaultProfileName: 'default',
        ...wiringOverrides,
      } as any);
      (service as any).sourceRegistry = sourceRegistry;
      (service as any).providerCache.clear();
    }

    it('refreshes metadata, namespace, and sourceUpdatedAt when content is unchanged', async () => {
      const content = 'stable content that never changes between syncs';
      swapProvider([{ externalId: '1', content, metadata: { tag: 'old' }, namespace: 'ns-old', updatedAt: new Date('2026-01-01') }]);
      await service.syncSource('kb');

      swapProvider([{ externalId: '1', content, metadata: { tag: 'new' }, namespace: 'ns-new', updatedAt: new Date('2026-02-01') }]);
      const result = await service.syncSource('kb');
      expect(result.results[0].skipped).toBe(true);
      expect(result.results[0].skipReason).toBe('attributes-updated');

      const document = await ctx.repos.document.findOneByOrFail({ externalId: '1' });
      expect(document.metadata).toEqual({ tag: 'new' });
      expect(document.namespace).toBe('ns-new');
      expect(new Date(document.sourceUpdatedAt as Date).toISOString()).toBe(new Date('2026-02-01').toISOString());

      const chunks = await ctx.repos.chunk.find({ where: { documentId: document.id } });
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) expect(chunk.metadata).toEqual({ tag: 'new' });

      // SQLite FTS rows denormalize the namespace, so the lexical filter must see the new value too.
      const ftsRows: Array<{ namespace: string }> = await ctx.dataSource.query(
        `SELECT namespace FROM "${ctx.schemaService.ftsTableName()}" WHERE document_id = ?`,
        [document.id],
      );
      expect(ftsRows.length).toBeGreaterThan(0);
      for (const row of ftsRows) expect(row.namespace).toBe('ns-new');
    });

    it('still reports "unchanged" when nothing at all changed', async () => {
      const record: RagSourceRecord = { externalId: '1', content: 'identical', metadata: { tag: 'same' }, updatedAt: new Date('2026-01-01') };
      swapProvider([record]);
      await service.syncSource('kb');
      swapProvider([{ ...record }]);
      const result = await service.syncSource('kb');
      expect(result.results[0].skipReason).toBe('unchanged');
    });

    it('re-indexes unchanged content when the source mappingVersion is bumped', async () => {
      const records: RagSourceRecord[] = [{ externalId: '1', content: 'same content across mapping versions' }];
      swapProvider(records, { mappingVersion: 'v1' });
      const first = await service.syncSource('kb');
      expect(first.documentsIndexed).toBe(1);

      swapProvider(records, { mappingVersion: 'v1' });
      const unchanged = await service.syncSource('kb');
      expect(unchanged.documentsIndexed).toBe(0);

      swapProvider(records, { mappingVersion: 'v2' });
      const bumped = await service.syncSource('kb');
      expect(bumped.documentsIndexed).toBe(1);
      expect(bumped.results[0].indexingHash).not.toEqual(first.results[0].indexingHash);
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

    it('carries forward bound sources excluded by options.sources into the new revision', async () => {
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

      // Populate the active revision (rev-1) with both sources plus a direct document.
      await service.reindexRevision('default', 'rev-1');
      await service.ingest({ externalId: 'manual-1', content: 'directly ingested content' });

      // Partial re-index of a staged revision (fresh row set): only kb1 is re-fetched.
      const result = await service.reindexRevision('default', 'rev-2', { sources: ['kb1'] });

      expect(result.readyForActivation).toBe(true);
      const sourceNames = result.sources.map((s) => s.sourceName).sort();
      expect(sourceNames).toEqual(['direct', 'kb1', 'kb2']);

      // kb2 and the direct document were carried forward, not dropped.
      const rev2Docs = await ctx.repos.document.find({ where: { profileRevisionId: 'rev-2' } });
      const bySource = new Map(rev2Docs.map((d) => [`${d.sourceName}:${d.externalId}`, d]));
      expect(bySource.has('kb1:1')).toBe(true);
      expect(bySource.has('kb2:1')).toBe(true);
      expect(bySource.has('direct:manual-1')).toBe(true);
      expect(bySource.get('kb2:1')!.content).toBe('kb2 content about billing');

      // Carried-forward documents were re-chunked into the new revision's row set.
      const kb2Chunks = await ctx.repos.chunk.count({
        where: { profileRevisionId: 'rev-2', documentId: bySource.get('kb2:1')!.id },
      });
      expect(kb2Chunks).toBeGreaterThan(0);
    });

    it('does not report an empty sources filter as ready with nothing indexed', async () => {
      await ctx.repos.sourceBinding.save([
        { id: 'b1', sourceName: 'kb1', profileName: 'default', sourceConfiguration: {}, createdAt: new Date(), updatedAt: new Date() },
      ] as any);
      sourceRegistry.register({
        name: 'kb1',
        kind: 'provider',
        provider: new InMemorySourceProvider('kb1', [{ externalId: '1', content: 'kb1 content about routers' }]),
        defaultProfileName: 'default',
      } as any);
      await service.reindexRevision('default', 'rev-1');

      const result = await service.reindexRevision('default', 'rev-2', { sources: [] });

      // Everything is carried forward from the active revision, so the new
      // revision is complete rather than empty.
      expect(result.documentsIndexed).toBe(1);
      const rev2Docs = await ctx.repos.document.count({ where: { profileRevisionId: 'rev-2' } });
      expect(rev2Docs).toBe(1);
    });

    it('clears a previous staged candidate before retrying the re-index', async () => {
      await service.ingest(
        { externalId: 'stale', content: 'This record must not survive the retry.' },
        { revisionId: 'rev-2' },
      );
      expect(await ctx.repos.document.count({ where: { profileRevisionId: 'rev-2' } })).toBe(1);

      const result = await service.reindexRevision('default', 'rev-2', { sources: [] });

      expect(result.readyForActivation).toBe(true);
      expect(await ctx.repos.document.count({ where: { profileRevisionId: 'rev-2' } })).toBe(0);
      expect(await ctx.repos.chunk.count({ where: { profileRevisionId: 'rev-2' } })).toBe(0);
      const ftsRows = await ctx.dataSource.query(
        `SELECT COUNT(*) AS "count" FROM "rag_chunks_fts" WHERE profile_revision_id = ?`,
        ['rev-2'],
      );
      expect(Number(ftsRows[0].count)).toBe(0);
    });
  });

  describe('revision write guards', () => {
    it('rejects an ingest whose resolved active revision was replaced by a reindex activation mid-flight', async () => {
      // The mocked configuration service keeps handing out rev-1 (the stale
      // pre-activation resolution); the database now says rev-3, with a
      // different data lineage, is active.
      await ctx.repos.profileRevision.update({ id: 'rev-1' }, { status: RagRevisionStatus.ARCHIVED });
      await ctx.repos.profileRevision.save(
        revisionRow('rev-3', 3, RagRevisionStatus.ACTIVE, { activatedAt: new Date() }) as any,
      );
      await ctx.repos.profile.update({ id: 'profile-1' }, { activeRevisionId: 'rev-3' });

      await expect(service.ingest({ externalId: 'doc-1', content: 'lands nowhere' })).rejects.toThrow(RagConcurrencyError);
      expect(await ctx.repos.document.count()).toBe(0);
    });

    it('rejects an ingest resolved before a query-only snapshot activation', async () => {
      await ctx.repos.profileRevision.update({ id: 'rev-1' }, { status: RagRevisionStatus.ARCHIVED });
      await ctx.repos.profileRevision.save(
        revisionRow('rev-3', 3, RagRevisionStatus.ACTIVE, { activatedAt: new Date() }) as any,
      );
      await ctx.repos.profile.update({ id: 'profile-1' }, { activeRevisionId: 'rev-3' });

      await expect(service.ingest({ externalId: 'doc-1', content: 'must retry against the new snapshot' })).rejects.toThrow(
        RagConcurrencyError,
      );
      expect(await ctx.repos.document.count()).toBe(0);
    });

    it('rejects an explicit revisionId that targets an archived or failed revision', async () => {
      configurationService.getRevision.mockImplementation(async (_p: string, id: string) => ({
        ...lexicalRevision(id),
        status: id === 'rev-archived' ? RagRevisionStatus.ARCHIVED : RagRevisionStatus.FAILED,
      }));

      await expect(service.ingest({ externalId: 'doc-1', content: 'x' }, { revisionId: 'rev-archived' })).rejects.toThrow(
        RagProfileRevisionError,
      );
      await expect(service.ingest({ externalId: 'doc-1', content: 'x' }, { revisionId: 'rev-failed' })).rejects.toThrow(
        RagProfileRevisionError,
      );
      expect(await ctx.repos.document.count()).toBe(0);
    });

    it('rejects a delete against a revision that was archived mid-flight', async () => {
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
        provider: new InMemorySourceProvider('kb', [{ externalId: '1', content: 'indexed before the race' }]),
        defaultProfileName: 'default',
      } as any);
      await service.indexSourceRecord('kb', '1');

      await ctx.repos.profileRevision.update({ id: 'rev-1' }, { status: RagRevisionStatus.ARCHIVED });
      await ctx.repos.profileRevision.save(
        revisionRow('rev-3', 3, RagRevisionStatus.ACTIVE, { activatedAt: new Date() }) as any,
      );
      await ctx.repos.profile.update({ id: 'profile-1' }, { activeRevisionId: 'rev-3' });

      await expect(service.removeSourceRecord('kb', '1')).rejects.toThrow(RagConcurrencyError);
      // The archived snapshot keeps its document.
      expect(await ctx.repos.document.count({ where: { profileRevisionId: 'rev-1' } })).toBe(1);
    });
  });
});
