# AGENTS.md

Guidance for AI coding agents working on `@scope/nestjs-rag` — a NestJS + TypeORM module that adds RAG (ingestion, chunking, indexing, lexical/vector/hybrid retrieval) to a host application's existing database connection.

## Commands

```bash
npm test                  # full suite (unit + integration; SQLite in-memory, no external services needed)
npm run test:unit         # unit tests only
npm run test:integration  # integration tests (Postgres tests self-skip unless TEST_DATABASE_URL is set)
npm run lint              # eslint over src/ and test/
npm run build             # tsc -p tsconfig.build.json → dist/
npx tsc -p tsconfig.build.json --noEmit   # typecheck without emitting
```

Run a single test file: `npx jest test/unit/change-impact.analyzer.spec.ts`.

To exercise the Postgres/pgvector integration tests:

```bash
docker run -d --name rag-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rag_test -p 55432:5432 pgvector/pgvector:pg16
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/rag_test npm run test:integration
```

Always run `npm test`, lint, and the typecheck before considering a change done. There is no watch mode configured; tests are fast (~6s).

## Architecture in one paragraph

`RagModule.forRoot()/forRootAsync()` carries **static infrastructure only** (database type/prefix, schema flags, embedding provider *factories*, source wiring). Everything operational — embedding provider/model/dimensions, chunking, hybrid weights, search defaults — lives in **profile revisions**, persisted rows managed at runtime through `RagConfigurationService`. Every document/chunk/embedding row is tagged with a `profileRevisionId`; search only ever reads one revision. Changing indexing-affecting settings creates a new revision that must be re-indexed and activated; query-only changes create a new revision that shares its predecessor's rows via `dataRevisionId` — rows are never moved or copied.

Key services (all in `src/`):

- `rag.module.ts` — DI wiring; repositories are aliased behind `Symbol` tokens from `constants.ts`.
- `config/rag-configuration.service.ts` — profile/revision lifecycle: create, update (4 apply strategies), activate, rollback, cleanup.
- `config/change-impact.analyzer.ts` — pure function classifying config diffs (`none` / `query-only` / `reindex-required` / `schema-change-required`). Unknown changed paths fall back to `reindex-required` defensively.
- `indexing/rag-indexing.service.ts` — ingest, source sync, revision re-indexing. Circular DI with `RagConfigurationService`: wired via the `RAG_INDEXING_SERVICE` token + `forwardRef`, with a *type-only* import to avoid a require cycle. Preserve that pattern.
- `search/rag-search.service.ts` + adapters — SQLite FTS5, Postgres FTS, pgvector; hybrid mode fuses with weighted RRF.
- `source/` — code-supplied source wiring (`RagSourceRegistry`, never persisted) vs. runtime source state (`rag_source_bindings`, owned by `RagSourceConfigurationService`).
- `entities/rag-schema.service.ts` — all raw DDL: SQLite FTS5 virtual table, per-revision partial GIN/HNSW indexes on Postgres.

## Invariants — do not break these

1. **Index rows belong to the revision that built them.** Every revision carries a `dataRevisionId` — itself for revisions produced by a re-index, the indexing ancestor for query-only (`apply-immediately`) revisions, which share that ancestor's row set as one *live* corpus. Writes *and deletes* are scoped to one data revision; every physical read/write (indexing, search, consistency validation) must use `dataRevisionId`, never the revision's own id. Activation and rollback are pure pointer flips — no code path may move or copy index rows between revisions. Row sets from other re-indexes keep their data until `cleanupArchivedRevisions` purges them (and cleanup must skip a revision whose rows another retained revision still references), so rollback across a re-index boundary restores exactly what that revision indexed.
2. **Nothing silently invalidates the index.** Any config path not classified in `change-impact.analyzer.ts`'s `PATH_IMPACT` table is treated as `reindex-required`. If you add a configuration field, add it to that table and to its unit test.
3. **No credentials or code references in persisted state.** Profile revisions and source bindings store only serializable identifiers/settings — never model instances, API keys, class names, or module paths. Providers and source wiring come exclusively from `forRoot`/bootstrap code.
4. **SQL safety split:** identifiers (table/column/index names, regconfig, revision ids in DDL) go through the allow-list asserts in `utils/identifier.util.ts` / `utils/uuid.util.ts` before interpolation; *values* are always parameterized. Raw-SQL table references must go through `qualifyTable()`. FTS5 query strings must pass through `sanitizeFtsQuery`.
5. **Per-source retrieval overrides must stay query-compatible.** Queries are always embedded with the profile revision's config, so overrides of `providerId`/`modelId`/`dimensions`/`providerOptions` are rejected (`assertAllowedSourceRetrievalOverrides`). Don't relax this.
6. **The `embedding` column is unbounded** (`vector`, no length) on Postgres; vector queries must always filter `profile_revision_id` and `dimensions` before computing distance, and per-(revision, dimensions) partial indexes must match the query's cast expression exactly.
7. **SQLite supports lexical only.** Embedding/hybrid config is rejected at validation time on SQLite; keep the capability checks in `validate-configuration.ts` in sync with any new retrieval feature.
8. **The SQLite FTS table must stay consistent with `rag_chunks`.** Every code path that inserts or deletes chunks must do the matching FTS write *inside the same transaction*. Postgres per-revision index DDL is best-effort and runs after the row transaction commits.

## Conventions

- Public API surface is `RagService`, `RagConfigurationService`, `RagSourceConfigurationService`, plus the registries — exported from `src/index.ts`. Keep the facade thin; logic lives in the internal services. `RagService` has two indexing styles: **push** (`ingest`/`ingestMany` — caller supplies content, stored under the `"direct"` or a caller-chosen source name) and **pull** (`syncSource`/`indexSourceRecord`/`removeSourceRecord` — content re-fetched from a registered source's provider, profile taken from the source binding). On re-index, pull content is re-fetched from its origin while push content is re-chunked from `rag_documents.content` — see the README's "Indexing & search API" section before changing either path.
- Errors: always throw the typed classes from `src/errors/` (e.g. `RagValidationError` takes a string array), never bare `Error` from public paths.
- Events: emitted via `EventEmitter2` with names from `events/rag-events.ts`; payloads carry ids/statuses/config snapshots — never credentials, raw content, or vectors.
- Tables use `EntitySchema` (no decorators) built in `entities/schemas.ts`, parameterized by `tablePrefix`. Timestamp columns must use the dialect-correct type (`timestamp` on Postgres, `datetime` on SQLite) — see the comment there before touching column types.
- Migrations under `src/migrations/` are hand-written raw SQL with the literal `rag_` prefix, one class per file, exported from `src/index.ts`. Schema changes need: the `EntitySchema`, the SQLite migration, the Postgres migration, and (dev path) `RagSchemaService.ensureCoreTables`.
- Tests: unit tests use real in-memory SQLite via `test/unit/test-utils/sqlite-test-context.ts` (not mocks of TypeORM); embedding calls are always mocked or faked — no test may call a real embedding API. Integration tests boot the real module with `@nestjs/testing`.
- Comments explain *why* (constraints, invariants), not what the next line does. Match the existing JSDoc-heavy style on services and exported functions.

## Gotchas

- `forRootAsync` requires `database` (and `schema.createVectorExtension`) synchronously — the entity list and embedding column type are fixed at module definition time. A conflicting async value throws at bootstrap; don't "fix" that by reading the async value.
- `stage` means different things: a staged *profile* revision never affects the active index; staged *source overrides* are used by the very next write (documented in the README — behavior is intentional).
- Score scales differ per retrieval mode (negated BM25 / `ts_rank_cd` / cosine / RRF). `minScore` is applied to raw per-signal scores before fusion in hybrid mode — never to fused RRF scores.
- Incremental sync filters `updatedAt >= since` (inclusive) on purpose; the indexing hash makes boundary re-processing a no-op. Don't "optimize" it back to `>`.
- `README.md` documents guarantees the code must actually keep (change-impact table, rollback semantics, capability matrix). When behavior changes, update the README in the same change — reviews here treat doc/code mismatches as bugs.
