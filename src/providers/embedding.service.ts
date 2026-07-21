import { Injectable, Logger } from '@nestjs/common';
import { embed, embedMany } from 'ai';
import type { EmbeddingModel } from 'ai';
import { RagEmbeddingDimensionError } from '../errors';
import { RagEmbeddingConfiguration } from '../interfaces/profile.interface';
import { hashConfiguration } from '../utils/hash.util';
import { RagEmbeddingProviderRegistry } from './embedding-provider-registry';

export interface RagEmbedManyResult {
  vectors: number[][];
}

/**
 * Thin, testable wrapper around the Vercel AI SDK's `embed`/`embedMany`.
 * Resolves the model at call time from `RagEmbeddingConfiguration` (never at
 * module-init time), validates every returned vector's dimensionality, and
 * caches resolved `EmbeddingModel` instances by a hash of their serializable
 * configuration so repeated calls with the same provider/model/options don't
 * re-instantiate a client on every chunk batch. The cache is invalidated
 * whenever a provider is (re)registered or unregistered.
 */
@Injectable()
export class RagEmbeddingService {
  private readonly logger = new Logger(RagEmbeddingService.name);
  private readonly modelCache = new Map<string, EmbeddingModel>();

  constructor(private readonly registry: RagEmbeddingProviderRegistry) {
    // Both unregistration and re-registration invalidate cached models for
    // that provider id — a re-registration may swap credentials or the
    // implementation behind the same id.
    this.registry.onChange((event) => {
      for (const key of [...this.modelCache.keys()]) {
        if (key.startsWith(`${event.providerId}:`)) {
          this.modelCache.delete(key);
        }
      }
    });
  }

  private resolveModel(configuration: RagEmbeddingConfiguration): EmbeddingModel {
    const cacheKey = `${configuration.providerId}:${hashConfiguration(configuration)}`;
    let model = this.modelCache.get(cacheKey);
    if (!model) {
      model = this.registry.createModel(configuration);
      this.modelCache.set(cacheKey, model);
    }
    return model;
  }

  private validateVector(vector: number[], configuration: RagEmbeddingConfiguration): void {
    if (!Array.isArray(vector) || vector.length !== configuration.dimensions) {
      throw new RagEmbeddingDimensionError(
        `Embedding provider "${configuration.providerId}" model "${configuration.modelId}" returned a vector ` +
          `with ${Array.isArray(vector) ? vector.length : 'unknown'} dimensions, but the profile configuration ` +
          `declares ${configuration.dimensions}. Refusing to index a mismatched vector.`,
        { providerId: configuration.providerId, modelId: configuration.modelId, expected: configuration.dimensions },
      );
    }
    if (vector.some((n) => typeof n !== 'number' || Number.isNaN(n))) {
      throw new RagEmbeddingDimensionError(
        `Embedding provider "${configuration.providerId}" model "${configuration.modelId}" returned a vector ` +
          `containing non-numeric values.`,
      );
    }
  }

  /** Embeds a single query string. Used at search time. */
  async embedQuery(query: string, configuration: RagEmbeddingConfiguration): Promise<number[]> {
    const model = this.resolveModel(configuration);
    const { embedding } = await embed({
      model,
      value: query,
      // `providerOptions` is a free-form, per-provider JSON bag (persisted as
      // part of the profile revision, so it is always JSON-serializable at
      // runtime); the Vercel AI SDK's stricter `SharedV4ProviderOptions`
      // type doesn't line up 1:1 with our storage-agnostic `unknown` values.
      providerOptions: configuration.providerOptions as any,
    });
    this.validateVector(embedding, configuration);
    return embedding;
  }

  /**
   * Embeds many chunk texts, honoring `configuration.batchSize` by issuing
   * sequential `embedMany` calls per batch (keeps memory/network usage
   * bounded for large re-index operations without adding a queue).
   */
  async embedMany(texts: string[], configuration: RagEmbeddingConfiguration): Promise<number[][]> {
    if (texts.length === 0) return [];
    const model = this.resolveModel(configuration);
    const batchSize = configuration.batchSize && configuration.batchSize > 0 ? configuration.batchSize : texts.length;
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const batch = texts.slice(offset, offset + batchSize);
      const { embeddings } = await embedMany({
        model,
        values: batch,
        // See the matching note in `embedQuery` about the `as any` cast.
        providerOptions: configuration.providerOptions as any,
      });
      for (const embedding of embeddings) {
        this.validateVector(embedding, configuration);
        vectors.push(embedding);
      }
    }
    return vectors;
  }
}
