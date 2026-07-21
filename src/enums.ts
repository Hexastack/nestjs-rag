/**
 * Retrieval strategies supported by the package.
 */
export enum RagRetrievalMode {
  LEXICAL = 'lexical',
  EMBEDDING = 'embedding',
  HYBRID = 'hybrid',
}

/**
 * Database backends the package knows how to target.
 * The value must match the TypeORM `type` used for the host DataSource.
 */
export enum RagDatabaseType {
  SQLITE = 'sqlite',
  BETTER_SQLITE3 = 'better-sqlite3',
  POSTGRES = 'postgres',
}

/**
 * Chunking strategies backed by `@chonkiejs/core`.
 */
export enum RagChunkingStrategy {
  TOKEN = 'token',
  SENTENCE = 'sentence',
  RECURSIVE = 'recursive',
}

/**
 * Lifecycle status of a profile configuration revision.
 */
export enum RagRevisionStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  INDEXING = 'indexing',
  READY = 'ready',
  ACTIVE = 'active',
  FAILED = 'failed',
  ARCHIVED = 'archived',
}

/**
 * Deterministic classification of the impact of a proposed configuration change.
 */
export enum RagChangeImpact {
  NONE = 'none',
  QUERY_ONLY = 'query-only',
  REINDEX_REQUIRED = 'reindex-required',
  SCHEMA_CHANGE_REQUIRED = 'schema-change-required',
}

/**
 * Strategies accepted by `RagConfigurationService.updateProfile`.
 */
export enum RagApplyStrategy {
  VALIDATE_ONLY = 'validate-only',
  APPLY_IMMEDIATELY = 'apply-immediately',
  STAGE = 'stage',
  REINDEX_AND_ACTIVATE = 'reindex-and-activate',
}

/**
 * Result status of a source synchronization or profile re-index operation.
 */
export enum RagOperationStatus {
  COMPLETED = 'completed',
  COMPLETED_WITH_ERRORS = 'completed-with-errors',
  FAILED = 'failed',
}
