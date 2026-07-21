import { EntitySchema } from 'typeorm';
import { RagDatabaseType } from '../enums';
import {
  RagChunkEmbeddingRow,
  RagChunkRow,
  RagDocumentRow,
  RagProfileRevisionRow,
  RagProfileRow,
  RagSourceBindingRow,
} from './rows';

/**
 * Every RAG-managed table this package can create/read/write, keyed by a
 * short logical name used throughout the codebase and for DI tokens.
 */
export interface RagEntitySchemas {
  profile: EntitySchema<RagProfileRow>;
  profileRevision: EntitySchema<RagProfileRevisionRow>;
  sourceBinding: EntitySchema<RagSourceBindingRow>;
  document: EntitySchema<RagDocumentRow>;
  chunk: EntitySchema<RagChunkRow>;
  chunkEmbedding: EntitySchema<RagChunkEmbeddingRow>;
}

/**
 * Builds the set of `EntitySchema` instances for one `RagModule.forRoot()`
 * registration. Schemas are parameterized by `tablePrefix` so multiple
 * registrations (e.g. in tests) never collide, and so the resulting table
 * names always match `database.tablePrefix` from the module options.
 *
 * These schemas are registered via `TypeOrmModule.forFeature(...)` against
 * the host's existing connection (see `RagModule`) — the package never
 * creates its own `DataSource`. For the host's `DataSource` to actually
 * build metadata for these tables, the host must either set
 * `autoLoadEntities: true` on its `TypeOrmModule.forRoot()` (recommended),
 * or add these schemas to its own `entities` array manually.
 *
 * `vectorColumnEnabled` controls whether the `chunk_embeddings.embedding`
 * column is declared as a native Postgres `vector` type (TypeORM has
 * first-class pgvector support: array<->literal conversion is automatic,
 * and the column is intentionally left without a fixed length so a single
 * column can hold multiple embedding dimensions side by side — see the
 * README's "Vector dimension strategy" section). This is *only* true when
 * `schema.createVectorExtension` is explicitly enabled in module options,
 * because TypeORM's Postgres driver automatically runs
 * `CREATE EXTENSION IF NOT EXISTS "vector"` on connect whenever *any*
 * vector-typed column is present in the DataSource's metadata — we gate our
 * own contribution of that column type behind an explicit opt-in so the
 * extension is never created silently. When disabled (the default), the
 * embedding column falls back to JSON-encoded text and embedding/hybrid
 * retrieval is rejected at configuration-validation time.
 */
export function createEntitySchemas(
  tablePrefix: string,
  dbType: RagDatabaseType = RagDatabaseType.POSTGRES,
  vectorColumnEnabled = false,
): RagEntitySchemas {
  const t = (suffix: string) => `${tablePrefix}${suffix}`;
  // Schema "name" must be unique per DataSource; embedding the prefix avoids
  // collisions if RagModule is ever registered more than once.
  const n = (suffix: string) => `Rag_${tablePrefix}_${suffix}`;
  // TypeORM's Postgres driver only special-cases 'datetime' for *value*
  // conversion, not for schema/metadata validation — declaring a column as
  // 'datetime' throws `DataTypeNotSupportedError` at DataSource.initialize()
  // on Postgres (its supportedDataTypes list has 'timestamp', not
  // 'datetime'). SQLite accepts 'datetime' directly. Use the dialect-correct
  // logical type for every timestamp column below.
  const timestampType = dbType === RagDatabaseType.POSTGRES ? 'timestamp' : 'datetime';

  const profile = new EntitySchema<RagProfileRow>({
    name: n('Profile'),
    tableName: t('profiles'),
    columns: {
      id: { type: 'varchar', length: 36, primary: true },
      name: { type: 'varchar', length: 200, unique: true },
      description: { type: 'varchar', length: 2000, nullable: true },
      activeRevisionId: { type: 'varchar', length: 36, nullable: true, name: 'active_revision_id' },
      createdAt: { type: timestampType, name: 'created_at', createDate: true },
      updatedAt: { type: timestampType, name: 'updated_at', updateDate: true },
    },
  });

  const profileRevision = new EntitySchema<RagProfileRevisionRow>({
    name: n('ProfileRevision'),
    tableName: t('profile_revisions'),
    columns: {
      id: { type: 'varchar', length: 36, primary: true },
      profileId: { type: 'varchar', length: 36, name: 'profile_id' },
      profileName: { type: 'varchar', length: 200, name: 'profile_name' },
      revisionNumber: { type: 'int', name: 'revision_number' },
      status: { type: 'varchar', length: 32 },
      configuration: { type: 'simple-json' },
      configurationHash: { type: 'varchar', length: 128, name: 'configuration_hash' },
      changeImpact: { type: 'varchar', length: 32, name: 'change_impact' },
      previousRevisionId: {
        type: 'varchar',
        length: 36,
        nullable: true,
        name: 'previous_revision_id',
      },
      error: { type: 'simple-json', nullable: true },
      createdAt: { type: timestampType, name: 'created_at', createDate: true },
      activatedAt: { type: timestampType, name: 'activated_at', nullable: true },
      failedAt: { type: timestampType, name: 'failed_at', nullable: true },
    },
    indices: [
      { name: t('idx_revisions_profile'), columns: ['profileName'] },
      {
        name: t('idx_revisions_profile_number'),
        columns: ['profileId', 'revisionNumber'],
        unique: true,
      },
    ],
  });

  const sourceBinding = new EntitySchema<RagSourceBindingRow>({
    name: n('SourceBinding'),
    tableName: t('source_bindings'),
    columns: {
      id: { type: 'varchar', length: 36, primary: true },
      sourceName: { type: 'varchar', length: 200, unique: true, name: 'source_name' },
      profileName: { type: 'varchar', length: 200, name: 'profile_name' },
      sourceConfiguration: { type: 'simple-json', name: 'source_configuration' },
      createdAt: { type: timestampType, name: 'created_at', createDate: true },
      updatedAt: { type: timestampType, name: 'updated_at', updateDate: true },
    },
  });

  const document = new EntitySchema<RagDocumentRow>({
    name: n('Document'),
    tableName: t('documents'),
    columns: {
      id: { type: 'varchar', length: 36, primary: true },
      profileName: { type: 'varchar', length: 200, name: 'profile_name' },
      profileRevisionId: { type: 'varchar', length: 36, name: 'profile_revision_id' },
      sourceName: { type: 'varchar', length: 200, name: 'source_name' },
      sourceId: { type: 'varchar', length: 200, name: 'source_id' },
      externalId: { type: 'varchar', length: 200, name: 'external_id' },
      namespace: { type: 'varchar', length: 200, nullable: true },
      content: { type: 'text' },
      contentHash: { type: 'varchar', length: 128, name: 'content_hash' },
      indexingHash: { type: 'varchar', length: 128, name: 'indexing_hash' },
      sourceUpdatedAt: { type: timestampType, nullable: true, name: 'source_updated_at' },
      metadata: { type: 'simple-json', nullable: true },
      createdAt: { type: timestampType, name: 'created_at', createDate: true },
      updatedAt: { type: timestampType, name: 'updated_at', updateDate: true },
    },
    indices: [
      {
        name: t('idx_documents_revision_source_ext'),
        columns: ['profileRevisionId', 'sourceName', 'externalId'],
        unique: true,
      },
      { name: t('idx_documents_profile_namespace'), columns: ['profileName', 'namespace'] },
    ],
  });

  const chunk = new EntitySchema<RagChunkRow>({
    name: n('Chunk'),
    tableName: t('chunks'),
    columns: {
      id: { type: 'varchar', length: 36, primary: true },
      profileName: { type: 'varchar', length: 200, name: 'profile_name' },
      profileRevisionId: { type: 'varchar', length: 36, name: 'profile_revision_id' },
      documentId: { type: 'varchar', length: 36, name: 'document_id' },
      chunkIndex: { type: 'int', name: 'chunk_index' },
      content: { type: 'text' },
      tokenCount: { type: 'int', name: 'token_count' },
      metadata: { type: 'simple-json', nullable: true },
      createdAt: { type: timestampType, name: 'created_at', createDate: true },
    },
    indices: [
      {
        name: t('idx_chunks_document_index'),
        columns: ['documentId', 'chunkIndex'],
        unique: true,
      },
      { name: t('idx_chunks_revision'), columns: ['profileRevisionId'] },
    ],
  });

  const chunkEmbedding = new EntitySchema<RagChunkEmbeddingRow>({
    name: n('ChunkEmbedding'),
    tableName: t('chunk_embeddings'),
    columns: {
      id: { type: 'varchar', length: 36, primary: true },
      profileName: { type: 'varchar', length: 200, name: 'profile_name' },
      profileRevisionId: { type: 'varchar', length: 36, name: 'profile_revision_id' },
      chunkId: { type: 'varchar', length: 36, unique: true, name: 'chunk_id' },
      providerId: { type: 'varchar', length: 100, name: 'provider_id' },
      modelId: { type: 'varchar', length: 200, name: 'model_id' },
      dimensions: { type: 'int' },
      embedding:
        dbType === RagDatabaseType.POSTGRES && vectorColumnEnabled
          ? { type: 'vector', nullable: true }
          : { type: 'text', nullable: true },
      createdAt: { type: timestampType, name: 'created_at', createDate: true },
    },
    indices: [
      { name: t('idx_embeddings_revision_dims'), columns: ['profileRevisionId', 'dimensions'] },
    ],
  });

  return { profile, profileRevision, sourceBinding, document, chunk, chunkEmbedding };
}
