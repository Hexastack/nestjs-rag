import type { Type } from '@nestjs/common';
import type { EntityTarget, ObjectLiteral } from 'typeorm';
import { RagChunkingOptions, RagRetrievalOptions } from './profile.interface';

/** One piece of content extracted from a source record, with an optional label. */
export interface RagContentField {
  column: string;
  label?: string;
  separator?: string;
}

export interface RagNamespaceMapping {
  column: string;
  prefix?: string;
}

/**
 * Declarative mapping from a source record (entity instance or raw row) to
 * the fields the indexer needs: an id, one or more content fields, optional
 * metadata columns, an optional namespace, and optional timestamps used for
 * incremental sync and soft-delete detection.
 */
export interface RagSourceMapping<TEntity extends ObjectLiteral = ObjectLiteral> {
  id: string;
  content: Array<string | RagContentField>;
  metadata?: string[];
  namespace?: string | RagNamespaceMapping;
  updatedAt?: string;
  deletedAt?: string;
  /** Optional discriminator, used when a single record produces multiple documents. */
  _entityHint?: TEntity;
}

export interface RagSourceFilter<TEntity extends ObjectLiteral = ObjectLiteral> {
  where?: Record<string, unknown>;
  batchSize?: number;
  _entityHint?: TEntity;
}

export type RagSourceTransform<TEntity extends ObjectLiteral = ObjectLiteral> = (
  record: TEntity,
) => TEntity | Promise<TEntity>;

export interface RagSourceSynchronizationOptions {
  strategy?: 'manual' | 'on-demand';
  incremental?: boolean;
}

/**
 * A single record surfaced by a `RagSourceProvider`, already normalized to
 * the shape the indexing pipeline understands.
 */
export interface RagSourceRecord {
  externalId: string;
  content: string;
  metadata?: Record<string, unknown>;
  namespace?: string;
  updatedAt?: Date;
  deletedAt?: Date | null;
}

/**
 * Contract for a fully custom source. Implementations are responsible for
 * fetching, normalizing, and (optionally) paginating their own records.
 */
export interface RagSourceProvider {
  readonly name: string;
  fetchRecords(options: {
    since?: Date;
    cursor?: string | null;
    batchSize: number;
  }): Promise<{ records: RagSourceRecord[]; nextCursor: string | null }>;
  fetchRecord?(externalId: string): Promise<RagSourceRecord | null>;
}

export interface RagSourceOptions<TEntity extends ObjectLiteral = ObjectLiteral> {
  name: string;

  entity?: EntityTarget<TEntity>;
  table?: string;
  provider?: Type<RagSourceProvider> | RagSourceProvider;

  dataSourceName?: string;

  profileName?: string;

  mapping?: RagSourceMapping<TEntity>;

  namespace?: string;

  filter?: RagSourceFilter<TEntity>;

  transform?: RagSourceTransform<TEntity>;

  chunkingOverrides?: Partial<RagChunkingOptions>;

  retrievalOverrides?: Partial<RagRetrievalOptions>;

  synchronization?: RagSourceSynchronizationOptions;

  mappingVersion?: string;
}

export interface RagSourceDescriptor {
  name: string;
  kind: 'entity' | 'table' | 'provider';
  profileName: string;
  namespace?: string;
  chunkingOverrides?: Partial<RagChunkingOptions>;
  retrievalOverrides?: Partial<RagRetrievalOptions>;
  mappingVersion?: string;
  synchronization?: RagSourceSynchronizationOptions;
}
