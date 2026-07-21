export const RAG_MODULE_OPTIONS = Symbol('RAG_MODULE_OPTIONS');
export const RAG_RESOLVED_OPTIONS = Symbol('RAG_RESOLVED_OPTIONS');
export const RAG_ENTITY_SCHEMAS = Symbol('RAG_ENTITY_SCHEMAS');

/**
 * Fixed (non-prefix-scoped) repository injection tokens. Each
 * `RagModule.forRoot()`/`forRootAsync()` call returns its own `DynamicModule`
 * with its own provider bindings for these tokens (built from that
 * registration's own `EntitySchema` instances) — because Nest's DI is
 * hierarchical and `RagModule` is not `@Global()`, multiple independent
 * registrations in the same application never collide even though the
 * tokens themselves are the same symbols.
 */
export const RAG_PROFILE_REPOSITORY = Symbol('RAG_PROFILE_REPOSITORY');
export const RAG_PROFILE_REVISION_REPOSITORY = Symbol('RAG_PROFILE_REVISION_REPOSITORY');
export const RAG_SOURCE_BINDING_REPOSITORY = Symbol('RAG_SOURCE_BINDING_REPOSITORY');
export const RAG_DOCUMENT_REPOSITORY = Symbol('RAG_DOCUMENT_REPOSITORY');
export const RAG_CHUNK_REPOSITORY = Symbol('RAG_CHUNK_REPOSITORY');
export const RAG_CHUNK_EMBEDDING_REPOSITORY = Symbol('RAG_CHUNK_EMBEDDING_REPOSITORY');
export const RAG_SCHEMA_SERVICE = Symbol('RAG_SCHEMA_SERVICE');
export const RAG_DATA_SOURCE = Symbol('RAG_DATA_SOURCE');
export const RAG_SOURCE_REGISTRY = Symbol('RAG_SOURCE_REGISTRY');
/** DI token alias for `RagIndexingService`, used so `RagConfigurationService` never needs a runtime import of it (breaks the DI cycle; only a type-only import remains). */
export const RAG_INDEXING_SERVICE = Symbol('RAG_INDEXING_SERVICE');

export const DEFAULT_TABLE_PREFIX = 'rag_';
export const DEFAULT_PROFILE_NAME = 'default';
export const DIRECT_SOURCE_NAME = 'direct';
