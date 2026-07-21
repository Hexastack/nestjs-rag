import {
  RAG_DEFAULT_HYBRID_OPTIONS,
  RAG_DEFAULT_SEARCH_DEFAULTS,
  RagChunkingOptions,
  RagProfileConfiguration,
  RagRetrievalOptions,
} from '../interfaces/profile.interface';
import { UpdateRagProfileInput } from '../interfaces/config-api.interface';

/**
 * Applies a deep-partial patch on top of a base profile configuration and
 * returns a brand new object — `base` is never mutated. Used both by
 * `RagConfigurationService.updateProfile`/`previewUpdate` (patch against the
 * active revision) and by tests that want to construct a proposed
 * configuration directly.
 */
export function applyProfilePatch(
  base: RagProfileConfiguration,
  patch: UpdateRagProfileInput,
): RagProfileConfiguration {
  const retrieval: RagRetrievalOptions = {
    defaultMode: patch.retrieval?.defaultMode ?? base.retrieval.defaultMode,
    lexical:
      patch.retrieval?.lexical !== undefined
        ? { ...base.retrieval.lexical, ...patch.retrieval.lexical }
        : base.retrieval.lexical,
    // `null` removes the embedding configuration entirely (spread-merging
    // could otherwise never unset it); `undefined` means "no change".
    embedding:
      patch.retrieval?.embedding === null
        ? undefined
        : patch.retrieval?.embedding !== undefined
          ? { ...base.retrieval.embedding, ...patch.retrieval.embedding } as RagRetrievalOptions['embedding']
          : base.retrieval.embedding,
    hybrid:
      patch.retrieval?.hybrid !== undefined
        ? { ...base.retrieval.hybrid, ...patch.retrieval.hybrid }
        : base.retrieval.hybrid,
  };

  const chunking: RagChunkingOptions = {
    ...base.chunking,
    ...patch.chunking,
  };

  const searchDefaults =
    patch.searchDefaults !== undefined
      ? { ...base.searchDefaults, ...patch.searchDefaults }
      : base.searchDefaults;

  return {
    name: base.name,
    description: patch.description !== undefined ? patch.description : base.description,
    retrieval,
    chunking,
    searchDefaults,
  };
}

/** Fills in library-wide defaults for optional sections a caller omitted when creating a profile. */
export function withProfileDefaults(configuration: RagProfileConfiguration): RagProfileConfiguration {
  return {
    ...configuration,
    retrieval: {
      ...configuration.retrieval,
      hybrid:
        configuration.retrieval.defaultMode === 'hybrid'
          ? { ...RAG_DEFAULT_HYBRID_OPTIONS, ...configuration.retrieval.hybrid }
          : configuration.retrieval.hybrid,
    },
    searchDefaults: { ...RAG_DEFAULT_SEARCH_DEFAULTS, ...configuration.searchDefaults },
  };
}

/**
 * Computes the effective chunking/retrieval configuration for one indexing
 * operation: profile configuration, overlaid with persisted source-level
 * overrides, overlaid with explicit per-operation overrides. Per-operation
 * overrides never mutate anything persisted.
 */
export function resolveEffectiveChunking(
  profileChunking: RagChunkingOptions,
  sourceOverride?: Partial<RagChunkingOptions>,
  operationOverride?: Partial<RagChunkingOptions>,
): RagChunkingOptions {
  return { ...profileChunking, ...sourceOverride, ...operationOverride };
}

export function resolveEffectiveRetrieval(
  profileRetrieval: RagRetrievalOptions,
  sourceOverride?: Partial<RagRetrievalOptions>,
): RagRetrievalOptions {
  if (!sourceOverride) return profileRetrieval;
  return {
    defaultMode: sourceOverride.defaultMode ?? profileRetrieval.defaultMode,
    lexical: sourceOverride.lexical ? { ...profileRetrieval.lexical, ...sourceOverride.lexical } : profileRetrieval.lexical,
    embedding: sourceOverride.embedding
      ? ({ ...profileRetrieval.embedding, ...sourceOverride.embedding } as RagRetrievalOptions['embedding'])
      : profileRetrieval.embedding,
    hybrid: sourceOverride.hybrid ? { ...profileRetrieval.hybrid, ...sourceOverride.hybrid } : profileRetrieval.hybrid,
  };
}
