import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EmbeddingModel } from 'ai';
import { RagModule } from '../../src/rag.module';
import { RagService } from '../../src/rag.service';
import { RagConfigurationService } from '../../src/config/rag-configuration.service';
import { RagEmbeddingProviderRegistry } from '../../src/providers/embedding-provider-registry';
import { RagDatabaseType, RagChunkingStrategy, RagRetrievalMode, RagRevisionStatus } from '../../src/enums';
import { RagEmbeddingModelOptions, RagEmbeddingProviderFactory } from '../../src/interfaces/embedding-provider.interface';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/rag_test';

/**
 * Deterministic, network-free "embedding" model: hashes each lowercase word
 * into a bucket of a fixed-dimension vector (a minimal hashing-trick bag of
 * words) and L2-normalizes it. Never calls a real API — texts that share
 * vocabulary end up with a meaningfully higher cosine similarity than
 * unrelated texts, which is enough to validate ranking behavior without any
 * network dependency.
 */
function deterministicVector(text: string, dimensions: number): number[] {
  const vector = new Array(dimensions).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    const digest = createHash('sha256').update(word).digest();
    const bucket = digest.readUInt32BE(0) % dimensions;
    vector[bucket] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

class FakeEmbeddingProviderFactory implements RagEmbeddingProviderFactory {
  readonly id = 'fake';

  createModel(options: RagEmbeddingModelOptions): EmbeddingModel {
    const dims = options.dimensions;
    return {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: options.modelId,
      maxEmbeddingsPerCall: 2048,
      supportsParallelCalls: true,
      async doEmbed({ values }: { values: string[] }) {
        return { embeddings: values.map((value) => deterministicVector(value, dims)) };
      },
    } as unknown as EmbeddingModel;
  }
}

async function isDatabaseReachable(): Promise<boolean> {
  const probe = new DataSource({ type: 'postgres', url: DATABASE_URL });
  try {
    await probe.initialize();
    await probe.destroy();
    return true;
  } catch {
    return false;
  }
}

describe('RAG integration (PostgreSQL + pgvector)', () => {
  let available = false;

  beforeAll(async () => {
    available = await isDatabaseReachable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(
        `[postgres-end-to-end.spec] Skipping: no reachable Postgres at ${DATABASE_URL}. ` +
          `Set TEST_DATABASE_URL or run: docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rag_test -p 55432:5432 pgvector/pgvector:pg16`,
      );
    }
  });

  async function buildApp(schemaName: string, sources: NonNullable<Parameters<typeof RagModule.forRoot>[0]['sources']> = []) {
    // `schemaName` is unique per test and doubles as the TypeORM connection
    // name — reusing the default connection name across multiple
    // `Test.createTestingModule()` compilations in one Jest process risks
    // `@nestjs/typeorm` reusing/duplicating its internal DataSource
    // registration for that name, which manifests as spurious
    // "relation already exists" errors from RagSchemaService.autoInitialize()
    // on the second+ app instance.
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        TypeOrmModule.forRoot({
          name: schemaName,
          type: 'postgres',
          url: DATABASE_URL,
          schema: schemaName,
          autoLoadEntities: true,
        }),
        RagModule.forRoot({
          database: { type: RagDatabaseType.POSTGRES, tablePrefix: 'rag_', dataSourceName: schemaName },
          schema: { autoInitialize: true, createVectorExtension: true, createVectorIndexes: true },
          configuration: { defaultProfileName: 'default', createDefaultProfile: false },
          providers: { embedding: [new FakeEmbeddingProviderFactory()] },
          sources,
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  async function prepareSchema(schemaName: string): Promise<void> {
    const ds = new DataSource({ type: 'postgres', url: DATABASE_URL });
    await ds.initialize();
    await ds.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await ds.query(`CREATE SCHEMA "${schemaName}"`);
    await ds.destroy();
  }

  it('creates an embedding-enabled profile, indexes content, and retrieves via embedding search', async () => {
    if (!available) return;
    const schemaName = 'rag_it_embedding';
    await prepareSchema(schemaName);
    const app = await buildApp(schemaName);
    const configurationService = app.get(RagConfigurationService);
    const ragService = app.get(RagService);

    await configurationService.createProfile({
      name: 'kb',
      configuration: {
        name: 'kb',
        retrieval: {
          defaultMode: RagRetrievalMode.EMBEDDING,
          embedding: { providerId: 'fake', modelId: 'fake-small', dimensions: 16 },
        },
        chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 100, chunkOverlap: 0 },
      },
    });

    await ragService.ingest(
      { externalId: 'router', content: 'How to install and configure a fiber router at home' },
      { profileName: 'kb' },
    );
    await ragService.ingest(
      { externalId: 'billing', content: 'Billing cycle and invoice payment questions answered' },
      { profileName: 'kb' },
    );

    const results = await ragService.search('fiber router installation', { profileName: 'kb', mode: RagRetrievalMode.EMBEDDING });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.content).toContain('router');
    expect(results[0].embeddingScore).toBeDefined();

    await app.close();
  }, 60000);

  it('supports hybrid retrieval combining lexical and embedding results via RRF', async () => {
    if (!available) return;
    const schemaName = 'rag_it_hybrid';
    await prepareSchema(schemaName);
    const app = await buildApp(schemaName);
    const configurationService = app.get(RagConfigurationService);
    const ragService = app.get(RagService);

    await configurationService.createProfile({
      name: 'kb',
      configuration: {
        name: 'kb',
        retrieval: {
          defaultMode: RagRetrievalMode.HYBRID,
          lexical: { language: 'english' },
          embedding: { providerId: 'fake', modelId: 'fake-small', dimensions: 16 },
          hybrid: { strategy: 'rrf', rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 },
        },
        chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 100, chunkOverlap: 0 },
      },
    });

    await ragService.ingest({ externalId: 'a', content: 'Fiber router setup instructions for new customers' }, { profileName: 'kb' });
    await ragService.ingest({ externalId: 'b', content: 'Refund policy and billing support information' }, { profileName: 'kb' });

    const results = await ragService.search('router setup', { profileName: 'kb' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].mode).toBe(RagRetrievalMode.HYBRID);
    expect(results[0].lexicalRank !== undefined || results[0].embeddingRank !== undefined).toBe(true);

    await app.close();
  }, 60000);

  it('handles a runtime embedding-dimension change: isolated index, atomic activation, old revision untouched until then', async () => {
    if (!available) return;
    const schemaName = 'rag_it_dims';
    await prepareSchema(schemaName);
    // `reindex-and-activate` re-syncs bound *sources*; a directly-ingested
    // document has no source to re-fetch from, so register one here (see
    // README's "Known limitations" re: direct ingestion + re-indexing).
    const app = await buildApp(schemaName, [
      {
        name: 'devices',
        profileName: 'kb',
        provider: {
          name: 'devices',
          async fetchRecords() {
            return { records: [{ externalId: 'x', content: 'Some content about network devices' }], nextCursor: null };
          },
        },
      },
    ]);
    const configurationService = app.get(RagConfigurationService);
    const ragService = app.get(RagService);

    await configurationService.createProfile({
      name: 'kb',
      configuration: {
        name: 'kb',
        retrieval: {
          defaultMode: RagRetrievalMode.EMBEDDING,
          embedding: { providerId: 'fake', modelId: 'fake-small', dimensions: 16 },
        },
        chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 100, chunkOverlap: 0 },
      },
    });
    await ragService.syncSource('devices');
    const before = await configurationService.getActiveRevision('kb');

    const result = await configurationService.updateProfile(
      'kb',
      { retrieval: { embedding: { dimensions: 32 } } },
      { applyStrategy: 'reindex-and-activate' },
    );

    expect(result.revision.status).toBe(RagRevisionStatus.ACTIVE);
    expect(result.revision.configuration.retrieval.embedding?.dimensions).toBe(32);
    expect(result.revision.id).not.toBe(before.id);

    const results = await ragService.search('network devices', { profileName: 'kb', mode: RagRetrievalMode.EMBEDDING });
    expect(results.length).toBeGreaterThan(0);

    await app.close();
  }, 60000);

  it('leaves the active revision untouched when a re-index fails', async () => {
    if (!available) return;
    const schemaName = 'rag_it_failure';
    await prepareSchema(schemaName);
    // A registered source with real content — `reindexRevision` only
    // re-syncs bound *sources* (it needs somewhere to re-fetch records
    // from), so without one the re-index loop would trivially "succeed"
    // with zero work and never actually reach the (broken) embedding call.
    const app = await buildApp(schemaName, [
      {
        name: 'kb-source',
        profileName: 'kb',
        provider: {
          name: 'kb-source',
          async fetchRecords() {
            return { records: [{ externalId: '1', content: 'Some content about network devices and routers' }], nextCursor: null };
          },
        },
      },
    ]);
    const configurationService = app.get(RagConfigurationService);
    const registry = app.get(RagEmbeddingProviderRegistry);
    const ragService = app.get(RagService);

    await configurationService.createProfile({
      name: 'kb',
      configuration: {
        name: 'kb',
        retrieval: {
          defaultMode: RagRetrievalMode.EMBEDDING,
          embedding: { providerId: 'fake', modelId: 'fake-small', dimensions: 16 },
        },
        chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 100, chunkOverlap: 0 },
      },
    });
    await ragService.syncSource('kb-source');
    const initial = await configurationService.getActiveRevision('kb');

    // Swap in a provider that always fails, to force a genuine re-index failure.
    registry.unregister('fake');
    registry.register({
      id: 'fake',
      createModel: () => {
        throw new Error('simulated provider outage');
      },
    });

    const result = await configurationService.updateProfile(
      'kb',
      { chunking: { chunkSize: 50 } },
      { applyStrategy: 'reindex-and-activate' },
    );

    expect(result.revision.status).toBe(RagRevisionStatus.FAILED);
    expect((await configurationService.getActiveRevision('kb')).id).toBe(initial.id);

    await app.close();
  }, 60000);

  it('isolates search results by source and namespace', async () => {
    if (!available) return;
    const schemaName = 'rag_it_isolation';
    await prepareSchema(schemaName);
    const app = await buildApp(schemaName);
    const configurationService = app.get(RagConfigurationService);
    const ragService = app.get(RagService);

    await configurationService.createProfile({
      name: 'kb',
      configuration: {
        name: 'kb',
        retrieval: { defaultMode: RagRetrievalMode.LEXICAL, lexical: { language: 'english' } },
        chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 100, chunkOverlap: 0 },
      },
    });

    await ragService.ingest(
      { sourceName: 'articles', externalId: '1', namespace: 'en', content: 'shared topic alpha in english' },
      { profileName: 'kb' },
    );
    await ragService.ingest(
      { sourceName: 'faq', externalId: '1', namespace: 'fr', content: 'shared topic alpha en francais' },
      { profileName: 'kb' },
    );

    const results = await ragService.search('shared topic alpha', {
      profileName: 'kb',
      sources: ['articles'],
      namespace: 'en',
    });
    expect(results.every((r) => r.chunk.sourceName === 'articles' && r.chunk.namespace === 'en')).toBe(true);

    await app.close();
  }, 60000);
});
