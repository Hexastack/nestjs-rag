import type { EmbeddingModel } from 'ai';

export interface RagEmbeddingModelOptions {
  modelId: string;
  dimensions: number;
  providerOptions?: Record<string, unknown>;
}

export interface RagEmbeddingModelDescriptor {
  id: string;
  name?: string;
  supportedDimensions?: number[];
  defaultDimensions?: number;
}

/**
 * Maps a serializable provider id to a Vercel AI SDK embedding model.
 *
 * Implementations are supplied by the downstream application (via
 * `RagModule.forRoot({ providers: { embedding: [...] } })`, ordinary Nest
 * providers, or `RagEmbeddingProviderRegistry.register` during bootstrap) and
 * are responsible for resolving their own credentials. The registry never
 * persists or logs anything returned from `createModel`.
 */
export interface RagEmbeddingProviderFactory {
  readonly id: string;

  createModel(options: RagEmbeddingModelOptions): EmbeddingModel;

  validateConfiguration?(options: RagEmbeddingModelOptions): Promise<void> | void;

  listModels?(): Promise<RagEmbeddingModelDescriptor[]>;

  getModelDescriptor?(
    modelId: string,
  ): Promise<RagEmbeddingModelDescriptor | null> | RagEmbeddingModelDescriptor | null;
}

/** Marker type used by DI tokens for classes implementing the factory contract. */
export type RagEmbeddingProviderFactoryClass = new (...args: any[]) => RagEmbeddingProviderFactory;
