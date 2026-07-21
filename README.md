# @scope/nestjs-rag

Configurable document ingestion, source synchronization, chunking, indexing, and retrieval (RAG) for NestJS applications that already use TypeORM.

> **Naming**: `@scope/nestjs-rag` is a placeholder. Replace `@scope` with your npm org (or drop the scope entirely) before publishing — the name appears only in `package.json` and this README; nothing in the source code depends on it.

This package **indexes and retrieves**. It deliberately does not do chat completion, LLM answer generation, agents, or expose any HTTP/GraphQL layer — see [Out of scope](#out-of-scope). It is designed so downstream applications can build their own protected admin API (REST/GraphQL) on top of the public services described below.

## Contents

- [Design principles](#design-principles)
- [Installation](#installation)
- [Static infrastructure configuration](#static-infrastructure-configuration)
- [Why active models are not configured in forRoot](#why-active-models-are-not-configured-in-forroot)
- [Provider registration & credential management](#provider-registration--credential-management)
- [Runtime profile configuration](#runtime-profile-configuration)
- [Update strategies](#update-strategies)
- [Change-impact detection](#change-impact-detection)
- [Sources](#sources)
- [Direct ingestion & search](#direct-ingestion--search)
- [Vector dimension strategy](#vector-dimension-strategy)
- [Capability matrix](#capability-matrix-sqlite-vs-postgresql)
- [Migrations](#migrations)
- [Concurrency control](#concurrency-control)
- [Failure recovery](#failure-recovery)
- [Events](#events)
- [Security considerations](#security-considerations)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [Out of scope](#out-of-scope)

## Design principles

1. **Bring your own connection.** `RagModule` never calls `new DataSource()`. It attaches to a `DataSource` your application already registered with `@nestjs/typeorm` (via `database.dataSourceName`).
2. **Static config vs. runtime config are different things.** `RagModule.forRoot()` carries only infrastructure: which database, whether to auto-create tables, which embedding provider *factories* exist, and initial bootstrap behavior. Which provider/model/dimensions/chunk size are *active* is runtime state, changed through `RagConfigurationService`, persisted as versioned **profile revisions**.
3. **Revisions are immutable and isolated.** Every document, chunk, and embedding row is tagged with a `profileRevisionId`. Search only ever reads one revision. Changing chunking or embeddings never mutates existing data in place — it produces a new revision with its own index.
4. **Nothing silently invalidates your index.** Query-time settings (topK, RRF weights, ...) apply instantly. Indexing-affecting settings (chunk size, embedding model, dimensions, ...) always go through an explicit re-index step you control.

## Installation

```bash
npm install @scope/nestjs-rag
# peer dependencies your app must also have:
npm install @nestjs/common @nestjs/core @nestjs/typeorm @nestjs/event-emitter typeorm reflect-metadata rxjs
# plus a driver for your database:
npm install better-sqlite3      # SQLite
npm install pg                  # PostgreSQL
```

`@nestjs/event-emitter` is required: `RagConfigurationService` publishes lifecycle events (profile created, revision activated, ...) through `EventEmitter2`. Import `EventEmitterModule.forRoot()` once, anywhere in your application (it's a global Nest module) — `RagModule` does not import it for you, so it never risks double-registering a second `EventEmitter2` instance alongside one your app already set up.

## Static infrastructure configuration

```ts
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RagDatabaseType, RagModule } from '@scope/nestjs-rag';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      autoLoadEntities: true, // required — see below
    }),
    RagModule.forRoot({
      database: {
        type: RagDatabaseType.POSTGRES,
        dataSourceName: undefined, // omit for the default connection, or pass a name
        tablePrefix: 'rag_',
      },
      schema: {
        autoInitialize: false,        // dev/test convenience only; use migrations in production
        createVectorExtension: false, // opt-in, see "Vector dimension strategy"
        createVectorIndexes: true,
      },
      configuration: {
        defaultProfileName: 'default',
        createDefaultProfile: true,
      },
      providers: {
        embedding: [/* RagEmbeddingProviderFactory instances/classes */],
      },
      sources: [/* RagSourceOptions[] */],
    }),
  ],
})
export class AppModule {}
```

**`autoLoadEntities: true` is required.** `RagModule` never owns a `DataSource`; it contributes its six tables (`rag_profiles`, `rag_profile_revisions`, `rag_source_bindings`, `rag_documents`, `rag_chunks`, `rag_chunk_embeddings`) as `TypeOrmModule.forFeature(...)` registrations against your existing connection. Nest's `autoLoadEntities` is the supported mechanism for a library to contribute entities to a connection it doesn't own — without it, `RagModule`'s tables are never added to your `DataSource`'s metadata and every query fails at bootstrap.

Nothing under `database`, `schema`, `configuration`, or `providers` (as *factories*, not active selections) ever needs to change to swap embedding models, chunk sizes, or retrieval modes — that all happens at runtime (next section).

### forRootAsync

```ts
RagModule.forRootAsync({
  // database (and schema.createVectorExtension, if you'll use it) must be
  // synchronous — see "Known limitations" for why.
  database: { type: RagDatabaseType.POSTGRES, tablePrefix: 'rag_' },
  schema: { createVectorExtension: true },
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    schema: { autoInitialize: false },
    providers: { embedding: [new OpenAiEmbeddingProviderFactory(config)] },
  }),
});
```

`useClass`/`useExisting` (an `RagOptionsFactory` with `createRagOptions()`) are also supported.

## Why active models are not configured in forRoot

If the embedding model lived in `forRoot()`, changing it would require editing code, redeploying, and restarting — and there would be nowhere to keep the *previous* model's index around for comparison, rollback, or a gradual cutover. Instead:

- `forRoot()` registers **provider factories** — code that knows how to turn a serializable `{ providerId, modelId, dimensions, providerOptions }` into a live Vercel AI SDK `EmbeddingModel`.
- The *active* `{ providerId, modelId, dimensions, providerOptions }` lives inside a profile revision, in the database, changed via `RagConfigurationService.updateProfile()`.
- Nothing about an embedding model instance, or any credential, is ever persisted — only the identifiers needed to reconstruct it through a registered factory.

This is also why the design doc's "must not configure the module like this" example is rejected:

```ts
// NOT supported — do not do this:
RagModule.forRoot({
  retrieval: { embedding: { model: openai.embeddingModel('text-embedding-3-small') } },
});
```

## Provider registration & credential management

An embedding provider factory maps a provider id to a live model:

```ts
import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModel } from 'ai';
import type { RagEmbeddingModelOptions, RagEmbeddingProviderFactory } from '@scope/nestjs-rag';

export class OpenAiEmbeddingProviderFactory implements RagEmbeddingProviderFactory {
  readonly id = 'openai';
  constructor(private readonly configService: ConfigService) {}

  createModel(options: RagEmbeddingModelOptions): EmbeddingModel {
    // `dimensions`/other settings travel as `providerOptions`, forwarded by
    // RagEmbeddingService into every embed()/embedMany() call — this SDK's
    // `embedding()` factory itself takes only a model id.
    const provider = createOpenAI({ apiKey: this.configService.getOrThrow('OPENAI_API_KEY') });
    return provider.embedding(options.modelId);
  }

  async validateConfiguration(options: RagEmbeddingModelOptions) {
    if (!this.configService.get('OPENAI_API_KEY')) throw new Error('OPENAI_API_KEY is not set.');
  }
}
```

Three ways to register one, all ending up in `RagEmbeddingProviderRegistry`:

1. **`RagModule.forRoot({ providers: { embedding: [...] } })`** — pass already-constructed instances, or a no-arg-constructible class.
2. **`RagModule.forRootAsync({ useFactory: (config) => ({ providers: { embedding: [new OpenAiEmbeddingProviderFactory(config)] } }) })`** — the recommended way to give a factory access to `ConfigService` or any other injected dependency, since `forRoot()` itself runs before Nest's injector exists.
3. **Programmatically at bootstrap** — inject `RagEmbeddingProviderRegistry` into any of your own providers and call `.register()` in `onModuleInit`/`onApplicationBootstrap`.

Credentials are **never** persisted: `RagProfileConfiguration.retrieval.embedding` only ever stores `{ providerId, modelId, dimensions, batchSize, providerOptions }`. `providerOptions` is for provider-side *model behavior* (e.g. a Google `taskType`), not secrets — don't put API keys there, since (unlike real credentials) it round-trips through `RagConfigurationService`'s public read APIs.

## Runtime profile configuration

A **profile** bundles all operational settings — retrieval mode, embedding config, chunking, hybrid weights, search defaults — under a name. Sources are assigned to a profile; multiple sources may share one.

```ts
await ragConfigurationService.createProfile({
  name: 'customer-support',
  configuration: {
    name: 'customer-support',
    retrieval: {
      defaultMode: RagRetrievalMode.HYBRID,
      lexical: { language: 'english' },
      embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536, batchSize: 100 },
      hybrid: { strategy: 'rrf', rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 },
    },
    chunking: { strategy: 'token', chunkSize: 512, chunkOverlap: 64 },
    searchDefaults: { topK: 10, candidateLimit: 50 },
  },
});
```

### Previewing a change

```ts
const preview = await ragConfigurationService.previewUpdate('customer-support', {
  chunking: { chunkSize: 800 },
});
console.log(preview.impact); // "reindex-required"
console.log(preview.affectedSources); // ["knowledge-articles", "support-faq"]
```

### Changing the embedding model/provider and re-indexing

```ts
await ragConfigurationService.updateProfile(
  'customer-support',
  { retrieval: { embedding: { providerId: 'google', modelId: 'text-embedding-004', dimensions: 768, batchSize: 64 } } },
  { applyStrategy: 'reindex-and-activate' },
);
```

### Changing only query-time settings

```ts
await ragConfigurationService.updateProfile(
  'customer-support',
  { retrieval: { hybrid: { lexicalWeight: 1.2, embeddingWeight: 0.8 } }, searchDefaults: { topK: 15 } },
  { applyStrategy: 'apply-immediately' },
);
```

### Staging, activating, rolling back

```ts
const staged = await ragConfigurationService.updateProfile('customer-support', { chunking: { chunkSize: 800 } }, { applyStrategy: 'stage' });
// ... later, possibly from an admin action, not necessarily right away:
await ragService.reindexRevision('customer-support', staged.revision.id);
await ragConfigurationService.activateRevision('customer-support', staged.revision.id);
// ... if it turns out to be a bad change:
await ragConfigurationService.rollback('customer-support', previousRevisionId);
```

None of this requires restarting the application.

## Update strategies

| Strategy | Effect |
|---|---|
| `validate-only` | Validates and computes impact. Persists nothing, activates nothing. `revision` in the result is an ephemeral, non-persisted preview object. |
| `apply-immediately` | Only allowed when impact is `none`/`query-only`. Creates a new (immutable) revision and re-points existing chunks/documents/embeddings to it in a single bulk update — no re-chunking or re-embedding, because nothing about the index changed. Throws `RagReindexRequiredError` otherwise. |
| `stage` | Creates a `pending` revision. Does not touch the active revision. Re-index it explicitly later with `ragService.reindexRevision(...)`. |
| `reindex-and-activate` | Stages a revision, re-indexes every affected source against it, validates the result, and atomically activates it — all inside one call, which only resolves after re-indexing finishes (there is no background queue in this version). Documents that were ingested directly (`ragService.ingest`, no registered source) are carried into the new revision too: they are re-chunked/re-embedded from the content stored in `rag_documents`, since there is no provider to re-fetch them from. A failed re-index leaves the previous revision active and marks the new one `failed`; `updateProfile` still *resolves* (not rejects) in that case so you can inspect `result.revision.status` and `result.reindexResult`. |

## Change-impact detection

`analyzeConfigurationChange` (a pure, synchronous function — see `src/config/change-impact.analyzer.ts`) diffs two configurations path-by-path against a fixed classification table:

- **`query-only`** (safe to `apply-immediately`): `retrieval.defaultMode`, `retrieval.hybrid.*`, `retrieval.embedding.batchSize`, `searchDefaults.*`.
- **`reindex-required`**: `chunking.*`, `retrieval.lexical.language`, `retrieval.embedding.providerId`/`modelId`/`providerOptions`.
- **`schema-change-required`**: `retrieval.embedding.dimensions` — see [Vector dimension strategy](#vector-dimension-strategy) for what "schema change" means here (a new per-dimension index, not a destructive column change).
- Anything not in the table is classified `reindex-required` defensively, rather than risking a silent, invalid `apply-immediately`.

The overall impact is the worst-case across every changed path. `RagConfigurationService.previewUpdate()`/`updateProfile()` both run this before doing anything else.

## Sources

Exactly one of `entity`, `table`, or `provider` per source:

```ts
sources: [
  // 1. TypeORM entity
  {
    name: 'knowledge-articles',
    entity: KnowledgeArticle,
    profileName: 'customer-support',
    mapping: {
      id: 'id',
      content: [{ column: 'title', label: 'Title' }, { column: 'content', label: 'Content' }],
      metadata: ['category', 'language'],
      namespace: { column: 'language', prefix: 'kb-' },
      updatedAt: 'updatedAt',
    },
    filter: { where: { status: 'published' }, batchSize: 250 },
    synchronization: { strategy: 'manual', incremental: true },
  },
  // 2. Explicit table + columns (validated against a strict identifier allow-list, never search-time input)
  {
    name: 'support-faq',
    table: 'support_faq',
    mapping: {
      id: 'faq_id',
      content: [{ column: 'question', label: 'Question' }, { column: 'answer', label: 'Answer' }],
      metadata: ['category', 'product_code'],
      updatedAt: 'updated_at',
    },
  },
  // 3. Fully custom
  { name: 'external-cms', provider: new CmsSourceProvider(cmsClient) },
],
```

Incremental synchronization (`synchronization: { incremental: true }`) filters on `updatedAt >= MAX(previously synced updatedAt)` — inclusive on purpose, so rows sharing the boundary timestamp (second-precision columns are common) are never skipped; re-processing them is cheap because unchanged content is skipped by its indexing hash.

A source's own entity/table/provider wiring is **code**, supplied only through `forRoot`/`forRootAsync` — it is never read from persisted configuration (see [Security considerations](#security-considerations)). Its *profile assignment* and *chunking/retrieval overrides*, by contrast, are runtime state in `rag_source_bindings`, managed through `RagSourceConfigurationService`:

```ts
await ragSourceConfigurationService.assignProfile('knowledge-articles', 'customer-support', {
  applyStrategy: 'reindex-and-activate',
});

await ragSourceConfigurationService.updateSourceOverrides(
  'knowledge-articles',
  { chunking: { chunkSize: 300 } },
  { applyStrategy: 'stage' },
);
```

The effective configuration for any indexing operation is `profile configuration → source-level overrides → per-operation overrides`, in that order; per-operation overrides (e.g. `ragService.ingest(doc, { chunkingOverrides })`) never mutate anything persisted.

Three rules to be aware of:

- **Source overrides must never change the embedding identity.** `retrieval.embedding.providerId`/`modelId`/`dimensions`/`providerOptions` cannot be overridden per source (rejected with `RagSourceConfigurationError`): queries are always embedded with the *profile revision's* configuration, so content indexed under a different model could never be searched correctly. Only query-compatible settings (e.g. `embedding.batchSize`) may be overridden. Use a separate profile when a source needs a different model.
- **`stage` for source overrides takes effect on the next write.** Unlike a staged *profile* revision (which never affects the active index), staged source overrides are persisted on the binding and used by the very next ingest/sync — "stage" here means "persist without immediately re-syncing", not "isolate from the active revision". Re-sync the source to apply them to already-indexed content.
- **Reassigning a source removes its documents from the old profile.** `assignProfile` (with `stage` or `reindex-and-activate`) deletes the source's documents from the old profile's *active* revision, so the old profile stops serving that content; with `stage`, the content is unavailable until you sync the source under its new profile. Archived revisions are untouched.

## Direct ingestion & search

```ts
await ragService.ingest({ externalId: 'faq-99', content: 'Fiber installation appointments run Mon–Sat.' });

const results = await ragService.search('installation appointment', {
  profileName: 'customer-support',
  mode: RagRetrievalMode.HYBRID,
  sources: ['knowledge-articles', 'support-faq'],
  topK: 8,
});
```

`search()` always resolves the requested (or default) profile's **active** revision unless an explicit, profile-validated `revisionId` is supplied for administrative testing — results only ever come from chunks/embeddings tagged with that one revision id.

**`minScore` semantics.** Scores live on a different scale per mode: lexical scores are negated BM25 (SQLite) or `ts_rank_cd` (Postgres), embedding scores are cosine similarity, and hybrid result scores are RRF values (bounded by `weight / (rrfK + 1)`, ≈ 0.016 with defaults). `minScore` is therefore applied to the **raw per-signal scores** — in hybrid mode it filters the lexical and embedding candidate lists *before* fusion, never the fused RRF score.

## Vector dimension strategy

Postgres's `vector` column type supports two shapes: `vector` (unbounded — holds any length, but you can't build an ANN index on it directly) and `vector(n)` (fixed length — indexable, but only for exactly `n` dimensions). Since this package must support changing embedding dimensions at runtime *without* a destructive column migration, `rag_chunk_embeddings.embedding` is declared **unbounded** (`vector`, no length), and:

1. Every embedding row also stores its own `dimensions` (and `profile_revision_id`).
2. Every vector search filters `WHERE profile_revision_id = :rev AND dimensions = :dims` **before** computing any distance — two vectors of different lengths are never compared, and pgvector would error if they were.
3. For ANN performance, `RagSchemaService` creates a **partial expression index** per `(revision, dimensions)` pair:
   ```sql
   CREATE INDEX ... ON rag_chunk_embeddings
   USING hnsw ((embedding::vector(N)) vector_cosine_ops)
   WHERE profile_revision_id = '<rev>' AND dimensions = N
   ```
   Because it's a *partial* index, Postgres only ever evaluates the `embedding::vector(N)` cast for rows that already satisfy the predicate — rows with a different `dimensions` value are never cast, so this is safe even though the underlying column is unbounded. Index creation is best-effort (falls back to `ivfflat`, then to a logged warning + sequential scan) so a slow/older pgvector never blocks indexing.
4. TypeORM has first-class pgvector support (array ⇄ literal conversion is automatic), which this package uses **only when you opt in**: `RagModule.forRoot({ schema: { createVectorExtension: true } })`. This is deliberate — TypeORM's Postgres driver automatically runs `CREATE EXTENSION IF NOT EXISTS "vector"` on connect whenever *any* `vector`-typed column exists in the DataSource's metadata, so gating our own contribution of that column type behind an explicit flag is what keeps "never silently create the vector extension" true. When the flag is off, `chunk_embeddings.embedding` is a plain JSON-encoded `text` column and embedding/hybrid retrieval is rejected at profile-validation time.
5. `activateRevision` additionally checks (live, via `pg_extension`) that the `vector` extension actually exists before activating an embedding-enabled revision — a defense-in-depth check independent of how/when the extension got installed.

Changing dimensions is therefore a `schema-change-required` change: it's always safe (no column alteration, no data loss), but it does create a new index and a new revision, so it always goes through the normal re-index/activate flow.

## Capability matrix (SQLite vs. PostgreSQL)

| Capability | SQLite | PostgreSQL |
|---|---|---|
| Lexical retrieval | ✅ (FTS5, standalone virtual table) | ✅ (`to_tsvector`/`ts_rank_cd`, per-revision partial GIN index) |
| Embedding retrieval | ❌ (rejected at validation time) | ✅ (pgvector, opt-in — see above) |
| Hybrid retrieval | ❌ | ✅ |
| Runtime chunking changes | ✅ | ✅ |
| Runtime lexical language changes | ✅ | ✅ |
| Profiles & revisions | ✅ | ✅ |
| Runtime provider/model/dimension changes | N/A (no embedding) | ✅ |

A profile whose `retrieval.defaultMode` is `embedding`/`hybrid`, or that sets `retrieval.embedding`, is rejected outright on a SQLite-backed `RagModule` registration (`validateProfileConfigurationStructure`), whether via `createProfile`, `updateProfile`, or `previewUpdate`.

## Migrations

Generated migrations (default `rag_` prefix) live under `dist/migrations` (source: `src/migrations`):

- `InitRagSqliteSchema1700000000001` — core tables + the FTS5 virtual table.
- `InitRagPostgresSchema1700000000001` — core tables, `embedding` column starts as `text`.
- `AddPgvectorSupport1700000000002` — **opt-in**, run only when/if you enable `schema.createVectorExtension`; creates the extension and converts `embedding` to a native `vector` column.

```ts
import { InitRagPostgresSchema1700000000001, AddPgvectorSupport1700000000002 } from '@scope/nestjs-rag';
// add to your DataSourceOptions.migrations
```

**Custom table prefixes**: TypeORM migrations don't accept runtime parameters, so a non-default `tablePrefix` requires copying the relevant migration file(s) and replacing the `rag_` literal throughout — see the comment at the top of each migration file.

`schema.autoInitialize: true` (via `RagSchemaService`) is a convenient alternative for local development and tests — it creates tables (using the same `EntitySchema` definitions the app queries with, via TypeORM's own `Table.create()`) and the SQLite FTS5 table on `onApplicationBootstrap`. It never runs automatically in a way that could surprise a production deployment; you opt in explicitly.

## Concurrency control

`updateProfile(name, patch, { expectedRevisionId })` implements compare-and-swap: if `expectedRevisionId` doesn't match the profile's current active revision, the call throws `RagConcurrencyError` instead of applying a stale change.

## Failure recovery

- A revision that fails re-indexing is marked `failed` and **never** becomes active; the previously active revision keeps serving searches untouched.
- **Deletes are revision-scoped, like writes.** A record deletion seen during sync (or `removeSourceRecord`) removes the document from the revision being written only; archived revisions keep their copy until `cleanupArchivedRevisions` purges them, so rollback restores exactly what a revision indexed. Content that must disappear from *all* retained revisions (e.g. a compliance erasure) requires explicit cleanup of archived revisions.
- `activateRevision` validates chunk/embedding row-count consistency (and, on Postgres, that the vector extension is actually installed) before flipping the active pointer, inside one transaction — old revision archived and new one activated atomically, or neither happens.
- `rollback(profileName, revisionId)` reactivates an older `ready`/`archived` revision without rebuilding anything, as long as its index data hasn't been purged. A revision archived by an `apply-immediately` update owns no rows of its own (they were bulk re-pointed to its successor); rolling back across a purely query-only lineage re-points the rows back as part of the same activation transaction, so the restored revision serves exactly what it indexed.
- `cleanupArchivedRevisions(profileName, { keep })` (beyond the six-method core API) permanently deletes archived revisions older than the retention count, along with their documents/chunks/embeddings and Postgres indexes. After cleanup, `rollback` to a purged revision fails with a descriptive `RagRevisionNotFoundError`.

## Events

Published through `EventEmitter2` (no external broker):

```
rag.profile.created
rag.profile.revision.created
rag.profile.revision.indexing
rag.profile.revision.ready
rag.profile.revision.activated
rag.profile.revision.failed
rag.profile.rolled_back
rag.source.profile.changed
```

Payloads carry ids, statuses, and full (credential-free) configuration snapshots — never a credential, and never raw document content or embedding vectors.

## Security considerations

- Provider credentials are resolved by your own factory code (env vars, `ConfigService`, a secrets manager) and are never written to any RAG-managed table or returned from any public method.
- Source entity/table/provider wiring is **compile-time code**, supplied only through `RagModule.forRoot()`/`forRootAsync()`. Persisted configuration (`rag_source_bindings.source_configuration`) only ever contains a profile name and plain chunking/retrieval override values — never a class name, module path, or anything that could cause the package to load or execute code it wasn't explicitly given.
- Table/column identifiers for `table`-based sources are validated against a strict allow-list (`assertSafeIdentifier`) before being interpolated into SQL; every *value* (filter values, cursors, search query text) is always parameterized. These identifiers are developer-supplied configuration, never derived from a search-time caller.
- SQLite FTS5 query strings are sanitized to bare `AND`-ed terms so a search string can never be interpreted as FTS5 query syntax.
- Vector/lexical index names embed a UUID hash of the revision id (validated as a UUID before interpolation), not a caller-supplied string.
- Activation and rollback run inside transactions; revision history is retained (not overwritten) until explicit cleanup.
- Searches are always scoped by profile + revision (+ optional source/namespace filters) — there is no code path that reads chunks across profiles or revisions other than the one resolved for the request.

## Testing

```bash
npm test              # everything
npm run test:unit     # unit only (mocked embedding calls; real SQLite for persistence-heavy tests)
npm run test:integration
```

Unit tests never call a real embedding API — `ai`'s `embed`/`embedMany` are mocked (`jest.mock('ai', ...)`) or a small deterministic hashing-trick fake `EmbeddingModel` is used. Integration tests run the real `RagModule` (via `@nestjs/testing`) against a real SQLite file (restart simulation included) and, when `TEST_DATABASE_URL` points at a reachable Postgres+pgvector instance, against real Postgres — including genuine hybrid retrieval, dimension changes, and failure-recovery scenarios. If no Postgres is reachable, those tests no-op individually with a console warning rather than failing the suite (see `test/integration/postgres-end-to-end.spec.ts`).

```bash
docker run -d --name rag-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rag_test -p 55432:5432 pgvector/pgvector:pg16
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/rag_test npm run test:integration
```

## Known limitations

- **`forRootAsync` needs `database` synchronously.** `TypeOrmModule.forFeature()`'s entity list — and whether `chunk_embeddings.embedding` is a native `vector` column — must be known at module *definition* time, before any async factory runs. `database` and `schema.createVectorExtension` are therefore required, synchronous top-level fields on `RagModuleAsyncOptions` even when the rest comes from `useFactory`/`useClass`/`useExisting`. This is a real constraint of how Nest builds its DI graph together with TypeORM, not an arbitrary restriction.
- **Custom table prefixes need a copied migration file.** See [Migrations](#migrations).
- **Entity/table sources read from the same connection as `RagModule` itself.** `database.dataSourceName` is the only connection `EntitySourceProvider`/`TableSourceProvider` know how to query. A source that needs a different connection should use a custom `RagSourceProvider` instead (which can use any connection it wants).
- **No custom vector distance metric.** Vector search always uses cosine distance (pgvector `<=>`). Exposing L2/inner-product as a profile setting is a natural extension but isn't implemented in this version.
- **`ingestMany` is not batched across documents.** It calls `ingest()` once per document (each of which still batches its own chunks through `embedMany` per `batchSize`), rather than embedding chunks from multiple documents in a single request. Simpler and correct; a future version could reduce embedding-API round-trips further.
- **No background queue.** `reindex-and-activate` and `syncSource`/`reindexRevision` run to completion in the calling request/process, as the design doc requires ("do not introduce a background queue"). For very large corpora, call these from your own job runner.

## Out of scope

Chat/answer generation, agents, chat history, HTTP/GraphQL controllers, a configuration UI, background queues/workers, automatic secret storage, arbitrary runtime package installation, OCR, PDF parsing, web crawling, reranking models, and SQLite vector extensions are all intentionally not implemented — see the design doc's section 34 for the full list and rationale. The public services (`RagService`, `RagConfigurationService`, `RagSourceConfigurationService`) are designed to be easy to wrap in your own protected REST/GraphQL admin API.
