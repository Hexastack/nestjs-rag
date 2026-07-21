import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModel } from 'ai';
import type { ConfigService } from '@nestjs/config';
import type {
  RagEmbeddingModelDescriptor,
  RagEmbeddingModelOptions,
  RagEmbeddingProviderFactory,
} from '@scope/nestjs-rag';

/**
 * Resolves credentials through NestJS `ConfigService` — never persisted,
 * never returned from any public API. Because it needs `ConfigService`
 * injected, it's constructed inside `RagModule.forRootAsync()`'s
 * `useFactory` (see app.module.ts) rather than passed as a bare class
 * reference to `providers.embedding`.
 */
export class OpenAiEmbeddingProviderFactory implements RagEmbeddingProviderFactory {
  readonly id = 'openai';

  constructor(private readonly configService: ConfigService) {}

  createModel(options: RagEmbeddingModelOptions): EmbeddingModel {
    // `dimensions` and any other provider-side settings are passed as
    // `providerOptions` at call time (RagEmbeddingService forwards
    // `RagEmbeddingConfiguration.providerOptions` into every `embed`/
    // `embedMany` call), not at model-construction time — this SDK's
    // `embedding()` factory takes only a model id.
    const provider = createOpenAI({ apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY') });
    return provider.embedding(options.modelId);
  }

  async validateConfiguration(options: RagEmbeddingModelOptions): Promise<void> {
    if (!this.configService.get('OPENAI_API_KEY')) {
      throw new Error('OPENAI_API_KEY is not set.');
    }
    if (options.dimensions <= 0) {
      throw new Error('dimensions must be positive.');
    }
  }

  async listModels(): Promise<RagEmbeddingModelDescriptor[]> {
    return [
      { id: 'text-embedding-3-small', name: 'text-embedding-3-small', defaultDimensions: 1536, supportedDimensions: [256, 512, 1536] },
      { id: 'text-embedding-3-large', name: 'text-embedding-3-large', defaultDimensions: 3072, supportedDimensions: [256, 1024, 3072] },
    ];
  }
}
