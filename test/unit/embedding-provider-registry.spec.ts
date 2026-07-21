import { RagEmbeddingProviderRegistry } from '../../src/providers/embedding-provider-registry';
import { RagProviderNotFoundError } from '../../src/errors';
import { RagEmbeddingProviderFactory } from '../../src/interfaces/embedding-provider.interface';

function fakeProvider(id: string, overrides: Partial<RagEmbeddingProviderFactory> = {}): RagEmbeddingProviderFactory {
  return {
    id,
    createModel: jest.fn().mockReturnValue({ modelId: `${id}-model` }),
    ...overrides,
  };
}

describe('RagEmbeddingProviderRegistry', () => {
  it('registers and looks up a provider by id', () => {
    const registry = new RagEmbeddingProviderRegistry();
    const provider = fakeProvider('openai');
    registry.register(provider);
    expect(registry.has('openai')).toBe(true);
    expect(registry.get('openai')).toBe(provider);
  });

  it('lists all registered providers', () => {
    const registry = new RagEmbeddingProviderRegistry();
    registry.register(fakeProvider('openai'));
    registry.register(fakeProvider('google'));
    expect(registry.list().map((p) => p.id).sort()).toEqual(['google', 'openai']);
  });

  it('throws RagProviderNotFoundError for an unregistered provider id', () => {
    const registry = new RagEmbeddingProviderRegistry();
    expect(() => registry.get('missing')).toThrow(RagProviderNotFoundError);
  });

  it('unregisters a provider', () => {
    const registry = new RagEmbeddingProviderRegistry();
    registry.register(fakeProvider('openai'));
    registry.unregister('openai');
    expect(registry.has('openai')).toBe(false);
  });

  it('overwrites a provider registered twice under the same id', () => {
    const registry = new RagEmbeddingProviderRegistry();
    const first = fakeProvider('openai');
    const second = fakeProvider('openai');
    registry.register(first);
    registry.register(second);
    expect(registry.get('openai')).toBe(second);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects a provider with no id', () => {
    const registry = new RagEmbeddingProviderRegistry();
    expect(() => registry.register({ createModel: jest.fn() } as any)).toThrow();
  });

  it('accepts providers supplied through the constructor (RagModule.forRoot wiring)', () => {
    const registry = new RagEmbeddingProviderRegistry([fakeProvider('openai'), fakeProvider('google')]);
    expect(registry.list()).toHaveLength(2);
  });

  it('createModel delegates to the provider factory with the given options', () => {
    const registry = new RagEmbeddingProviderRegistry();
    const provider = fakeProvider('openai');
    registry.register(provider);
    registry.createModel({ providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536 });
    expect(provider.createModel).toHaveBeenCalledWith({
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
      providerOptions: undefined,
    });
  });

  it('validateConfiguration delegates to the provider when implemented', async () => {
    const registry = new RagEmbeddingProviderRegistry();
    const validate = jest.fn().mockResolvedValue(undefined);
    registry.register(fakeProvider('openai', { validateConfiguration: validate }));
    await registry.validateConfiguration({ providerId: 'openai', modelId: 'm', dimensions: 10 });
    expect(validate).toHaveBeenCalled();
  });

  it('validateConfiguration is a no-op when the provider does not implement it', async () => {
    const registry = new RagEmbeddingProviderRegistry();
    registry.register(fakeProvider('openai'));
    await expect(registry.validateConfiguration({ providerId: 'openai', modelId: 'm', dimensions: 10 })).resolves.toBeUndefined();
  });

  it('validateConfiguration rejects when the provider itself rejects (e.g. missing credentials)', async () => {
    const registry = new RagEmbeddingProviderRegistry();
    registry.register(
      fakeProvider('openai', { validateConfiguration: jest.fn().mockRejectedValue(new Error('missing OPENAI_API_KEY')) }),
    );
    await expect(registry.validateConfiguration({ providerId: 'openai', modelId: 'm', dimensions: 10 })).rejects.toThrow(
      'missing OPENAI_API_KEY',
    );
  });

  it('notifies onChange listeners on register/unregister', () => {
    const registry = new RagEmbeddingProviderRegistry();
    const events: string[] = [];
    registry.onChange((e) => events.push(`${e.type}:${e.providerId}`));
    registry.register(fakeProvider('openai'));
    registry.unregister('openai');
    expect(events).toEqual(['registered:openai', 'unregistered:openai']);
  });

  it('listModels/getModelDescriptor return empty/null when unimplemented', async () => {
    const registry = new RagEmbeddingProviderRegistry();
    registry.register(fakeProvider('openai'));
    await expect(registry.listModels('openai')).resolves.toEqual([]);
    await expect(registry.getModelDescriptor('openai', 'm')).resolves.toBeNull();
  });
});
