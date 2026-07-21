import { Injectable, Optional } from '@nestjs/common';
import type { EmbeddingModel } from 'ai';
import { RagProviderNotFoundError } from '../errors';
import { RagEmbeddingConfiguration } from '../interfaces/profile.interface';
import {
  RagEmbeddingModelDescriptor,
  RagEmbeddingProviderFactory,
} from '../interfaces/embedding-provider.interface';

export interface RagEmbeddingProviderChangeListener {
  (event: { type: 'registered' | 'unregistered'; providerId: string }): void;
}

/**
 * Maps a serializable provider id + model id to a live Vercel AI SDK
 * `EmbeddingModel`. Providers are supplied entirely by the downstream
 * application (never resolved from persisted configuration by name/module
 * path), so this registry never loads a package or class it wasn't
 * explicitly given — see the "Security considerations" README section.
 */
@Injectable()
export class RagEmbeddingProviderRegistry {
  private readonly providers = new Map<string, RagEmbeddingProviderFactory>();
  private readonly listeners = new Set<RagEmbeddingProviderChangeListener>();

  constructor(@Optional() initialProviders: RagEmbeddingProviderFactory[] = []) {
    for (const provider of initialProviders ?? []) {
      this.register(provider);
    }
  }

  register(provider: RagEmbeddingProviderFactory): void {
    if (!provider || typeof provider.id !== 'string' || provider.id.length === 0) {
      throw new Error('An embedding provider factory must expose a non-empty string `id`.');
    }
    this.providers.set(provider.id, provider);
    this.emit({ type: 'registered', providerId: provider.id });
  }

  unregister(providerId: string): void {
    if (this.providers.delete(providerId)) {
      this.emit({ type: 'unregistered', providerId });
    }
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  get(providerId: string): RagEmbeddingProviderFactory {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new RagProviderNotFoundError(providerId);
    }
    return provider;
  }

  list(): RagEmbeddingProviderFactory[] {
    return [...this.providers.values()];
  }

  async listModels(providerId: string): Promise<RagEmbeddingModelDescriptor[]> {
    const provider = this.get(providerId);
    return (await provider.listModels?.()) ?? [];
  }

  async getModelDescriptor(
    providerId: string,
    modelId: string,
  ): Promise<RagEmbeddingModelDescriptor | null> {
    const provider = this.get(providerId);
    return (await provider.getModelDescriptor?.(modelId)) ?? null;
  }

  async validateConfiguration(configuration: RagEmbeddingConfiguration): Promise<void> {
    const provider = this.get(configuration.providerId);
    await provider.validateConfiguration?.({
      modelId: configuration.modelId,
      dimensions: configuration.dimensions,
      providerOptions: configuration.providerOptions,
    });
  }

  createModel(configuration: RagEmbeddingConfiguration): EmbeddingModel {
    const provider = this.get(configuration.providerId);
    return provider.createModel({
      modelId: configuration.modelId,
      dimensions: configuration.dimensions,
      providerOptions: configuration.providerOptions,
    });
  }

  /** Used by `RagEmbeddingService` to invalidate its model cache when providers change. */
  onChange(listener: RagEmbeddingProviderChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: { type: 'registered' | 'unregistered'; providerId: string }): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
