import 'reflect-metadata';
import { unlinkSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RagModule } from '../../src/rag.module';
import { RagService } from '../../src/rag.service';
import { RagConfigurationService } from '../../src/config/rag-configuration.service';
import { RagSourceConfigurationService } from '../../src/source/rag-source-configuration.service';
import { RagDatabaseType, RagChunkingStrategy, RagRetrievalMode, RagRevisionStatus } from '../../src/enums';
import { RagProfileActivationError, RagValidationError } from '../../src/errors';
import { RagProfileConfiguration } from '../../src/interfaces/profile.interface';

/**
 * Full-stack integration tests against a real SQLite database file (not
 * `:memory:`, so we can genuinely simulate an application "restart" by
 * tearing down and rebuilding the Nest application against the same file).
 * These exercise `RagModule.forRoot()` exactly as a downstream application
 * would use it — no internal classes are constructed by hand.
 */
describe('RAG integration (SQLite, lexical-only)', () => {
  const dbFile = `${__dirname}/.tmp-rag-integration.sqlite`;
  let connectionCounter = 0;

  async function buildApp() {
    // Each call gets its own named TypeORM connection — reusing the default
    // connection name across multiple `Test.createTestingModule()`
    // compilations in one Jest process risks reusing/duplicating
    // `@nestjs/typeorm`'s internal DataSource registration for that name,
    // which manifests as "index/relation already exists" errors during
    // RagSchemaService.autoInitialize() on the second+ app instance.
    const connectionName = `sqlite-it-${connectionCounter++}`;
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        TypeOrmModule.forRoot({
          name: connectionName,
          type: 'better-sqlite3',
          database: dbFile,
          autoLoadEntities: true,
        }),
        RagModule.forRoot({
          database: { type: RagDatabaseType.SQLITE, tablePrefix: 'rag_', dataSourceName: connectionName },
          schema: { autoInitialize: true },
          configuration: { defaultProfileName: 'default', createDefaultProfile: true },
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  beforeAll(() => {
    try {
      unlinkSync(dbFile);
    } catch {
      /* file may not exist yet */
    }
  });

  afterAll(() => {
    try {
      unlinkSync(dbFile);
    } catch {
      /* best effort cleanup */
    }
  });

  it('boots and creates the default profile automatically', async () => {
    const app = await buildApp();
    const configurationService = app.get(RagConfigurationService);
    const profile = await configurationService.getProfile('default');
    expect(profile.name).toBe('default');
    const revision = await configurationService.getActiveRevision('default');
    expect(revision.configuration.retrieval.defaultMode).toBe(RagRetrievalMode.LEXICAL);
    await app.close();
  });

  it('rejects creating an embedding-enabled profile on SQLite', async () => {
    const app = await buildApp();
    const configurationService = app.get(RagConfigurationService);
    const config: RagProfileConfiguration = {
      name: 'embedding-attempt',
      retrieval: {
        defaultMode: RagRetrievalMode.EMBEDDING,
        embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536 },
      },
      chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 200, chunkOverlap: 20 },
    };
    await expect(configurationService.createProfile({ name: 'embedding-attempt', configuration: config })).rejects.toThrow(
      RagValidationError,
    );
    await app.close();
  });

  it('ingests a document directly and finds it via lexical search', async () => {
    const app = await buildApp();
    const ragService = app.get(RagService);
    await ragService.ingest({
      externalId: 'doc-router',
      content: 'How do I reset my fiber router? Hold the reset button for ten seconds.',
    });
    const results = await ragService.search('reset fiber router');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.content).toContain('router');
    await app.close();
  });

  it('applies a query-only setting change immediately (no pending revision)', async () => {
    const app = await buildApp();
    const configurationService = app.get(RagConfigurationService);
    const before = await configurationService.getActiveRevision('default');
    const result = await configurationService.updateProfile(
      'default',
      { searchDefaults: { topK: 3 } },
      { applyStrategy: 'apply-immediately' },
    );
    expect(result.revision.status).toBe(RagRevisionStatus.ACTIVE);
    expect(result.revision.id).not.toBe(before.id); // new revision and copied snapshot, without re-indexing
    expect((await configurationService.listRevisions('default')).length).toBe(2);
    await app.close();
  });

  it('creates a pending revision when chunk size changes, and search keeps using the old (active) revision until activated', async () => {
    const app = await buildApp();
    const ragService = app.get(RagService);
    const configurationService = app.get(RagConfigurationService);

    await ragService.ingest({ externalId: 'doc-a', content: 'Alpha content about widgets and gadgets.' });
    const activeBefore = await configurationService.getActiveRevision('default');

    const staged = await configurationService.updateProfile(
      'default',
      { chunking: { chunkSize: 900 } },
      { applyStrategy: 'stage' },
    );
    expect(staged.revision.status).toBe(RagRevisionStatus.PENDING);

    // Search still resolves against the untouched active revision.
    const resultsBeforeActivation = await ragService.search('widgets gadgets');
    expect(resultsBeforeActivation[0]?.chunk).toBeDefined();
    expect((await configurationService.getActiveRevision('default')).id).toBe(activeBefore.id);
    await app.close();
  });

  it('supports the documented manual staged workflow: stage → reindexRevision → activateRevision', async () => {
    const app = await buildApp();
    const ragService = app.get(RagService);
    const configurationService = app.get(RagConfigurationService);

    await ragService.ingest({ externalId: 'doc-staged', content: 'Manual staging notes about lighthouses and harbors.' });

    // The exact sequence from the README's "Staging, activating, rolling
    // back" example: the re-index must move the revision to `ready`, or
    // activateRevision refuses it.
    // Chunk values deliberately differ from every other test in this suite:
    // the profile (shared SQLite file) keeps this configuration afterwards,
    // and a later updateProfile with identical values would classify as a
    // no-op and skip re-indexing.
    const staged = await configurationService.updateProfile(
      'default',
      { chunking: { chunkSize: 80, chunkOverlap: 8 } },
      { applyStrategy: 'stage' },
    );
    expect(staged.revision.status).toBe(RagRevisionStatus.PENDING);

    const reindexResult = await ragService.reindexRevision('default', staged.revision.id);
    expect(reindexResult.readyForActivation).toBe(true);
    expect((await configurationService.getRevision('default', staged.revision.id)).status).toBe(RagRevisionStatus.READY);

    const activated = await configurationService.activateRevision('default', staged.revision.id);
    expect(activated.status).toBe(RagRevisionStatus.ACTIVE);
    expect((await configurationService.getActiveRevision('default')).id).toBe(staged.revision.id);

    const results = await ragService.search('lighthouses');
    expect(results.length).toBeGreaterThan(0);
    await app.close();
  });

  it('refuses a reindex cutover after a successful concurrent active write, then succeeds after retry', async () => {
    const app = await buildApp();
    const ragService = app.get(RagService);
    const configurationService = app.get(RagConfigurationService);

    await ragService.ingest({ externalId: 'cutover-base', content: 'Base notes about observatories.' });
    const staged = await configurationService.updateProfile(
      'default',
      { chunking: { chunkSize: 88, chunkOverlap: 8 } },
      { applyStrategy: 'stage' },
    );
    expect((await ragService.reindexRevision('default', staged.revision.id)).readyForActivation).toBe(true);

    // This write lands after the candidate became ready. Activation must
    // reject that stale candidate rather than hide the successful write.
    await ragService.ingest({ externalId: 'cutover-late', content: 'Late notes about astrolabes.' });
    await expect(
      configurationService.activateRevision('default', staged.revision.id),
    ).rejects.toThrow(RagProfileActivationError);
    expect((await ragService.search('astrolabes')).length).toBeGreaterThan(0);

    // Retrying starts from an empty candidate and records the new corpus
    // generation, so it includes the late write and can activate safely.
    expect((await ragService.reindexRevision('default', staged.revision.id)).readyForActivation).toBe(true);
    await configurationService.activateRevision('default', staged.revision.id);
    expect((await ragService.search('astrolabes')).length).toBeGreaterThan(0);
    await app.close();
  });

  it('re-indexes a pending revision and activates it; search then reflects the new revision', async () => {
    // Registered sources are re-synced from their provider during
    // `reindex-and-activate`; directly ingested documents are carried
    // forward from their stored content instead (covered by a separate
    // test below).
    const records = [{ externalId: 'gizmo-1', content: 'Widgets and gadgets and also gizmos for testing purposes here.' }];
    const connectionName = `sqlite-it-${connectionCounter++}`;
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        TypeOrmModule.forRoot({ name: connectionName, type: 'better-sqlite3', database: ':memory:', autoLoadEntities: true }),
        RagModule.forRoot({
          database: { type: RagDatabaseType.SQLITE, dataSourceName: connectionName },
          schema: { autoInitialize: true },
          sources: [{ name: 'gizmos', provider: { name: 'gizmos', async fetchRecords() { return { records, nextCursor: null }; } } }],
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const ragService = app.get(RagService);
    const configurationService = app.get(RagConfigurationService);

    await ragService.syncSource('gizmos');

    // The default chunker tokenizes by character (per chonkiejs, no custom
    // tokenizer is implemented — see README). A very small chunkSize is
    // realistic to exercise here (it's still a real, meaningfully different
    // chunking config), but the search query below has to fit within a
    // single character-chunk to be findable, hence one common word.
    const result = await configurationService.updateProfile(
      'default',
      { chunking: { chunkSize: 60, chunkOverlap: 10 } },
      { applyStrategy: 'reindex-and-activate' },
    );

    expect(result.revision.status).toBe(RagRevisionStatus.ACTIVE);
    expect(result.reindexResult?.documentsIndexed).toBeGreaterThan(0);

    const active = await configurationService.getActiveRevision('default');
    expect(active.id).toBe(result.revision.id);

    const results = await ragService.search('gizmos');
    expect(results.length).toBeGreaterThan(0);
    await app.close();
  });

  it('rolls back to a previous revision atomically', async () => {
    const app = await buildApp();
    const configurationService = app.get(RagConfigurationService);
    const initial = await configurationService.getActiveRevision('default');

    await configurationService.updateProfile('default', { searchDefaults: { topK: 7 } }, { applyStrategy: 'apply-immediately' });
    expect((await configurationService.getActiveRevision('default')).id).not.toBe(initial.id);

    const rolledBack = await configurationService.rollback('default', initial.id);
    expect(rolledBack.id).toBe(initial.id);
    expect((await configurationService.getActiveRevision('default')).id).toBe(initial.id);
    await app.close();
  });

  it('still serves indexed content after rolling back across an apply-immediately snapshot', async () => {
    const app = await buildApp();
    const ragService = app.get(RagService);
    const configurationService = app.get(RagConfigurationService);

    await ragService.ingest({ externalId: 'doc-rb', content: 'Rollback subject content about telescopes.' });
    const initial = await configurationService.getActiveRevision('default');

    // Query-only changes copy the physical snapshot without calling the
    // chunker or embedding provider again.
    const updated = await configurationService.updateProfile('default', { searchDefaults: { topK: 4 } }, { applyStrategy: 'apply-immediately' });
    expect(updated.revision.dataRevisionId).toBe(updated.revision.id);
    expect(updated.revision.dataRevisionId).not.toBe(initial.dataRevisionId);
    expect((await ragService.search('telescopes')).length).toBeGreaterThan(0);

    // Rolling back switches to the retained immutable snapshot.
    await configurationService.rollback('default', initial.id);
    const results = await ragService.search('telescopes');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.documentId).toBeDefined();
    await app.close();
  });

  it('restores exact query-only corpus snapshots instead of later writes', async () => {
    const app = await buildApp();
    const ragService = app.get(RagService);
    const configurationService = app.get(RagConfigurationService);

    // A (indexed) -> B (query-only snapshot) -> C (query-only snapshot).
    await ragService.ingest({ externalId: 'doc-a', content: 'Original article about volcanoes.' });
    const revisionA = await configurationService.getActiveRevision('default');
    const revisionB = (await configurationService.updateProfile('default', { searchDefaults: { topK: 4 } }, { applyStrategy: 'apply-immediately' })).revision;
    await ragService.ingest({ externalId: 'doc-b', content: 'Revision B notes about mountains.' });
    await configurationService.updateProfile('default', { searchDefaults: { topK: 6 } }, { applyStrategy: 'apply-immediately' });

    // This document belongs only to C's snapshot.
    await ragService.ingest({ externalId: 'doc-late', content: 'Late-breaking notes about glaciers.' });

    await configurationService.rollback('default', revisionA.id);
    expect((await ragService.search('volcanoes')).length).toBeGreaterThan(0);
    expect(await ragService.search('mountains')).toHaveLength(0);
    expect(await ragService.search('glaciers')).toHaveLength(0);

    const restoredB = await configurationService.rollback('default', revisionB.id);
    expect(restoredB.dataRevisionId).toBe(revisionB.id);
    expect((await ragService.search('volcanoes')).length).toBeGreaterThan(0);
    expect((await ragService.search('mountains')).length).toBeGreaterThan(0);
    expect(await ragService.search('glaciers')).toHaveLength(0);
    await app.close();
  });

  it('carries directly-ingested documents into a re-indexed revision from their stored content', async () => {
    const app = await buildApp();
    const ragService = app.get(RagService);
    const configurationService = app.get(RagConfigurationService);

    await ragService.ingest({ externalId: 'doc-direct', content: 'Directly ingested facts about barnacles and ships.' });

    const result = await configurationService.updateProfile(
      'default',
      { chunking: { chunkSize: 60, chunkOverlap: 10 } },
      { applyStrategy: 'reindex-and-activate' },
    );
    expect(result.revision.status).toBe(RagRevisionStatus.ACTIVE);
    expect(result.reindexResult?.documentsIndexed).toBeGreaterThan(0);

    // The new revision serves the direct document, re-chunked from stored content.
    const results = await ragService.search('barnacles');
    expect(results.length).toBeGreaterThan(0);
    await app.close();
  });

  it('preserves profile settings across an application restart', async () => {
    const app1 = await buildApp();
    const configurationService1 = app1.get(RagConfigurationService);
    await configurationService1.createProfile({
      name: 'restart-check',
      configuration: {
        name: 'restart-check',
        retrieval: { defaultMode: RagRetrievalMode.LEXICAL, lexical: { language: 'french' } },
        chunking: { strategy: RagChunkingStrategy.SENTENCE, chunkSize: 333, chunkOverlap: 10 },
      },
    });
    await app1.close();

    const app2 = await buildApp();
    const configurationService2 = app2.get(RagConfigurationService);
    const revision = await configurationService2.getActiveRevision('restart-check');
    expect(revision.configuration.chunking.chunkSize).toBe(333);
    expect(revision.configuration.retrieval.lexical?.language).toBe('french');
    await app2.close();
  });

  it('keeps namespaces and sources isolated at search time', async () => {
    const app = await buildApp();
    const ragService = app.get(RagService);
    await ragService.ingest({ externalId: 'ns-en', content: 'shared keyword alpha', namespace: 'en' }, { profileName: 'default' });
    await ragService.ingest({ externalId: 'ns-fr', content: 'shared keyword beta', namespace: 'fr' }, { profileName: 'default' });

    const enResults = await ragService.search('shared keyword', { namespace: 'en' });
    expect(enResults.every((r) => r.chunk.namespace === 'en')).toBe(true);
    await app.close();
  });

  it('syncs a registered custom source end to end via RagSourceConfigurationService + RagService', async () => {
    const records = [
      { externalId: '1', content: 'First knowledge base article about installation.' },
      { externalId: '2', content: 'Second knowledge base article about billing.' },
    ];
    const connectionName = `sqlite-it-${connectionCounter++}`;
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        TypeOrmModule.forRoot({ name: connectionName, type: 'better-sqlite3', database: ':memory:', autoLoadEntities: true }),
        RagModule.forRoot({
          database: { type: RagDatabaseType.SQLITE, dataSourceName: connectionName },
          schema: { autoInitialize: true },
          sources: [
            {
              name: 'kb',
              provider: {
                name: 'kb',
                async fetchRecords() {
                  return { records, nextCursor: null };
                },
              },
            },
          ],
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const ragService = app.get(RagService);
    const sourceConfigurationService = app.get(RagSourceConfigurationService);

    const sources = await sourceConfigurationService.listSources();
    expect(sources.map((s) => s.name)).toEqual(['kb']);

    const syncResult = await ragService.syncSource('kb');
    expect(syncResult.documentsIndexed).toBe(2);

    const results = await ragService.search('knowledge base installation');
    expect(results.length).toBeGreaterThan(0);
    await app.close();
  });
});
