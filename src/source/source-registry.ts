import { Injectable } from '@nestjs/common';
import type { EntityTarget, ObjectLiteral } from 'typeorm';
import { RagSourceConfigurationError } from '../errors';
import { RagSourceMapping, RagSourceOptions, RagSourceProvider } from '../interfaces/source.interface';
import { RagChunkingOptions, RagRetrievalOptions } from '../interfaces/profile.interface';
import { assertSafeName } from '../utils/identifier.util';

export type RagSourceKind = 'entity' | 'table' | 'provider';

/**
 * Rejects per-source retrieval overrides that change the embedding *identity*
 * (provider/model/dimensions/providerOptions). Indexing could honor them, but
 * search always embeds the query with the profile revision's configuration —
 * so a source indexed under a different model would return meaningless
 * similarity scores (same dimensions) or become invisible entirely (different
 * dimensions). Only behavior that stays query-compatible (e.g. `batchSize`)
 * may be overridden per source.
 */
export function assertAllowedSourceRetrievalOverrides(
  retrieval: Partial<RagRetrievalOptions> | undefined,
  sourceName: string,
): void {
  if (!retrieval?.embedding) return;
  const embedding = retrieval.embedding as unknown as Record<string, unknown>;
  const forbidden = ['providerId', 'modelId', 'dimensions', 'providerOptions'].filter(
    (key) => embedding[key] !== undefined,
  );
  if (forbidden.length > 0) {
    throw new RagSourceConfigurationError(
      `Source "${sourceName}" must not override retrieval.embedding.${forbidden.join('/')}: queries are always ` +
        `embedded with the profile revision's embedding configuration, so a per-source embedding identity can ` +
        `never be searched correctly. Use a separate profile for this source instead.`,
    );
  }
}

/**
 * The code-supplied, non-persisted half of a source's configuration: which
 * entity/table/provider it reads from, its column mapping, filter, and
 * transform. This is deliberately never written to the database — only a
 * profile assignment and serializable overrides are (see
 * `rag_source_bindings`) — because resolving an entity class, table name, or
 * provider instance from persisted state would mean the package could load
 * or execute application code purely from database rows, which section 33's
 * "prevent arbitrary package loading from persisted configuration" rules
 * out. The wiring below always comes from `RagModule.forRoot({ sources })`
 * or a source registered programmatically at bootstrap.
 */
export interface RagResolvedSourceWiring<TEntity extends ObjectLiteral = ObjectLiteral> {
  name: string;
  kind: RagSourceKind;
  entity?: EntityTarget<TEntity>;
  table?: string;
  provider?: RagSourceProvider;
  mapping?: RagSourceMapping<TEntity>;
  namespace?: string;
  filter?: RagSourceOptions<TEntity>['filter'];
  transform?: RagSourceOptions<TEntity>['transform'];
  defaultProfileName: string;
  defaultChunkingOverrides?: Partial<RagChunkingOptions>;
  defaultRetrievalOverrides?: Partial<RagRetrievalOptions>;
  synchronization?: RagSourceOptions<TEntity>['synchronization'];
  mappingVersion?: string;
}

/**
 * In-memory registry of source wiring, populated once at bootstrap from
 * `RagModule.forRoot({ sources })`. Runtime-mutable state (profile
 * assignment, override values) lives in `rag_source_bindings` and is owned
 * by `RagSourceConfigurationService` — this registry never changes after
 * the application starts.
 */
@Injectable()
export class RagSourceRegistry {
  private readonly sources = new Map<string, RagResolvedSourceWiring>();

  register(wiring: RagResolvedSourceWiring): void {
    assertSafeName(wiring.name, 'source name');
    if (this.sources.has(wiring.name)) {
      throw new RagSourceConfigurationError(`A source named "${wiring.name}" is already registered.`);
    }
    this.sources.set(wiring.name, wiring);
  }

  has(name: string): boolean {
    return this.sources.has(name);
  }

  get(name: string): RagResolvedSourceWiring {
    const wiring = this.sources.get(name);
    if (!wiring) {
      throw new RagSourceConfigurationError(`RAG source "${name}" was not registered in RagModule.forRoot({ sources }).`);
    }
    return wiring;
  }

  list(): RagResolvedSourceWiring[] {
    return [...this.sources.values()];
  }
}

/** Validates and normalizes one `RagSourceOptions` entry from module options into registry wiring. */
export function buildSourceWiring<TEntity extends ObjectLiteral>(
  options: RagSourceOptions<TEntity>,
  defaultProfileName: string,
  resolveProviderInstance: (provider: RagSourceOptions<TEntity>['provider']) => RagSourceProvider | undefined,
): RagResolvedSourceWiring<TEntity> {
  assertSafeName(options.name, 'source name');
  const provided = [options.entity, options.table, options.provider].filter((v) => v !== undefined);
  if (provided.length !== 1) {
    throw new RagSourceConfigurationError(
      `Source "${options.name}" must set exactly one of "entity", "table", or "provider" (got ${provided.length}).`,
    );
  }

  let kind: RagSourceKind;
  if (options.entity) kind = 'entity';
  else if (options.table) kind = 'table';
  else kind = 'provider';

  if ((kind === 'entity' || kind === 'table') && !options.mapping) {
    throw new RagSourceConfigurationError(`Source "${options.name}" (${kind}) requires a "mapping".`);
  }

  assertAllowedSourceRetrievalOverrides(options.retrievalOverrides, options.name);

  return {
    name: options.name,
    kind,
    entity: options.entity,
    table: options.table,
    provider: kind === 'provider' ? resolveProviderInstance(options.provider) : undefined,
    mapping: options.mapping,
    namespace: options.namespace,
    filter: options.filter,
    transform: options.transform,
    defaultProfileName: options.profileName ?? defaultProfileName,
    defaultChunkingOverrides: options.chunkingOverrides,
    defaultRetrievalOverrides: options.retrievalOverrides,
    synchronization: options.synchronization,
    mappingVersion: options.mappingVersion,
  };
}
