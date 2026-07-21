// Module
export * from './rag.module';
export * from './rag.service';

// Enums & constants
export * from './enums';
export { DEFAULT_PROFILE_NAME, DEFAULT_TABLE_PREFIX, DIRECT_SOURCE_NAME } from './constants';

// Errors
export * from './errors';

// Public interfaces
export * from './interfaces/module-options.interface';
export * from './interfaces/profile.interface';
export * from './interfaces/revision.interface';
export * from './interfaces/config-api.interface';
export * from './interfaces/source.interface';
export * from './interfaces/source-config-api.interface';
export * from './interfaces/ingest.interface';
export * from './interfaces/reindex.interface';
export * from './interfaces/search.interface';
export * from './interfaces/embedding-provider.interface';

// Public services
export { RagConfigurationService } from './config/rag-configuration.service';
export { RagSourceConfigurationService } from './source/rag-source-configuration.service';
export { RagEmbeddingProviderRegistry } from './providers/embedding-provider-registry';
export { RagEmbeddingService } from './providers/embedding.service';
export { RagSearchService } from './search/rag-search.service';
export { RagIndexingService } from './indexing/rag-indexing.service';

// Events
export * from './events/rag-events';

// Migrations (for downstream `dataSource.migrations` / TypeORM CLI usage)
export * from './migrations';
