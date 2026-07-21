import type { ModuleMetadata, Type } from '@nestjs/common';
import { RagDatabaseType } from '../enums';
import { RagEmbeddingProviderFactory, RagEmbeddingProviderFactoryClass } from './embedding-provider.interface';
import { RagSourceOptions } from './source.interface';

export interface RagDatabaseOptions {
  /** Database dialect the host DataSource uses. Drives capability checks (e.g. SQLite rejects embedding/hybrid). */
  type: RagDatabaseType;
  /**
   * Name of the TypeORM connection already registered by the host application
   * (e.g. via `TypeOrmModule.forRoot({ name: 'default', ... })`). The package
   * never creates or owns a DataSource — it always binds to this connection.
   */
  dataSourceName?: string;
  /** Prefix applied to every table this package creates. Defaults to `rag_`. */
  tablePrefix?: string;
}

export interface RagSchemaOptions {
  /**
   * When true, the package will create/verify its own tables at startup
   * using TypeORM's synchronize-style metadata sync. Intended for
   * development and tests only — production deployments should use the
   * generated migrations instead. Defaults to `false`.
   */
  autoInitialize?: boolean;
  /**
   * When true and the database type is postgres, the package will attempt
   * `CREATE EXTENSION IF NOT EXISTS vector`. Defaults to `false` — creating
   * extensions typically requires elevated privileges and downstream teams
   * should opt in explicitly.
   */
  createVectorExtension?: boolean;
  /**
   * When true (default), the package manages dimension-specific pgvector
   * indexes automatically as new embedding dimensions are activated.
   */
  createVectorIndexes?: boolean;
}

export interface RagBootstrapOptions {
  /** Name of the profile used by sources/operations that don't specify one. */
  defaultProfileName?: string;
  /** When true (default), a `default` profile is created automatically if missing. */
  createDefaultProfile?: boolean;
}

export interface RagProvidersOptions {
  embedding?: Array<RagEmbeddingProviderFactoryClass | RagEmbeddingProviderFactory>;
}

export interface RagModuleOptions {
  database: RagDatabaseOptions;
  schema?: RagSchemaOptions;
  configuration?: RagBootstrapOptions;
  providers?: RagProvidersOptions;
  sources?: RagSourceOptions[];
}

export interface RagOptionsFactory {
  createRagOptions(): Promise<RagModuleOptions> | RagModuleOptions;
}

/**
 * `database` (and, if you plan to enable vector search, `schema.createVectorExtension`)
 * must be provided synchronously even in `forRootAsync` — NestJS/TypeORM
 * require `TypeOrmModule.forFeature()`'s entity list to be known at module
 * *definition* time, before any async factory runs, and the shape of the
 * `chunk_embeddings.embedding` column (native pgvector vs. JSON text) is
 * decided by those two values. Everything else (`schema`'s remaining flags,
 * `configuration`, `providers`, `sources`) may come from the async factory.
 * This is a real constraint of how Nest's DI graph is built, not an
 * arbitrary limitation — see the README's "Known limitations" section.
 */
export interface RagModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  database: RagDatabaseOptions;
  schema?: Pick<RagSchemaOptions, 'createVectorExtension'>;
  useExisting?: Type<RagOptionsFactory>;
  useClass?: Type<RagOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<Omit<RagModuleOptions, 'database'>> | Omit<RagModuleOptions, 'database'>;
  inject?: any[];
}
