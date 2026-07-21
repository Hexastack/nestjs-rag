const embedMock = jest.fn();
const embedManyMock = jest.fn();

jest.mock('ai', () => ({
  embed: (...args: unknown[]) => embedMock(...args),
  embedMany: (...args: unknown[]) => embedManyMock(...args),
}));

// eslint-disable-next-line import/first
import { RagEmbeddingService } from '../../src/providers/embedding.service';
// eslint-disable-next-line import/first
import { RagEmbeddingProviderRegistry } from '../../src/providers/embedding-provider-registry';
// eslint-disable-next-line import/first
import { RagEmbeddingDimensionError } from '../../src/errors';
// eslint-disable-next-line import/first
import { RagEmbeddingConfiguration } from '../../src/interfaces/profile.interface';

describe('RagEmbeddingService (Vercel AI SDK wrapper, embed/embedMany mocked)', () => {
  const configuration: RagEmbeddingConfiguration = {
    providerId: 'fake',
    modelId: 'fake-model',
    dimensions: 3,
  };

  let registry: RagEmbeddingProviderRegistry;
  let service: RagEmbeddingService;
  let fakeModel: { id: string };

  beforeEach(() => {
    embedMock.mockReset();
    embedManyMock.mockReset();
    fakeModel = { id: 'resolved-model' };
    registry = new RagEmbeddingProviderRegistry([
      { id: 'fake', createModel: jest.fn().mockReturnValue(fakeModel) },
    ]);
    service = new RagEmbeddingService(registry);
  });

  it('embedQuery resolves the model from the registry and returns the vector', async () => {
    embedMock.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
    const result = await service.embedQuery('hello', configuration);
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(embedMock).toHaveBeenCalledWith(expect.objectContaining({ model: fakeModel, value: 'hello' }));
  });

  it('rejects a query embedding whose dimensions do not match the configuration', async () => {
    embedMock.mockResolvedValue({ embedding: [0.1, 0.2] }); // 2 dims, configured for 3
    await expect(service.embedQuery('hello', configuration)).rejects.toThrow(RagEmbeddingDimensionError);
  });

  it('rejects a vector containing non-numeric values', async () => {
    embedMock.mockResolvedValue({ embedding: [0.1, Number.NaN, 0.3] });
    await expect(service.embedQuery('hello', configuration)).rejects.toThrow(RagEmbeddingDimensionError);
  });

  it('embedMany batches according to configuration.batchSize', async () => {
    embedManyMock.mockImplementation(async ({ values }: { values: string[] }) => ({
      embeddings: values.map((_, i) => [i, i, i]),
    }));
    const texts = ['a', 'b', 'c', 'd', 'e'];
    const vectors = await service.embedMany(texts, { ...configuration, batchSize: 2 });
    expect(vectors).toHaveLength(5);
    // 5 items, batch size 2 -> 3 calls (2, 2, 1)
    expect(embedManyMock).toHaveBeenCalledTimes(3);
    expect(embedManyMock.mock.calls[0][0].values).toEqual(['a', 'b']);
    expect(embedManyMock.mock.calls[2][0].values).toEqual(['e']);
  });

  it('embedMany returns an empty array for empty input without calling the SDK', async () => {
    const result = await service.embedMany([], configuration);
    expect(result).toEqual([]);
    expect(embedManyMock).not.toHaveBeenCalled();
  });

  it('embedMany rejects when any returned vector has the wrong dimensionality', async () => {
    embedManyMock.mockResolvedValue({ embeddings: [[1, 2, 3], [1, 2]] });
    await expect(service.embedMany(['a', 'b'], configuration)).rejects.toThrow(RagEmbeddingDimensionError);
  });

  it('caches resolved models by configuration and reuses them across calls', async () => {
    embedMock.mockResolvedValue({ embedding: [1, 2, 3] });
    await service.embedQuery('one', configuration);
    await service.embedQuery('two', configuration);
    const factory = registry.get('fake');
    expect(factory.createModel).toHaveBeenCalledTimes(1);
  });

  it('invalidates the model cache when a provider is unregistered', async () => {
    embedMock.mockResolvedValue({ embedding: [1, 2, 3] });
    await service.embedQuery('one', configuration);
    registry.unregister('fake');
    registry.register({ id: 'fake', createModel: jest.fn().mockReturnValue({ id: 'new-model' }) });
    await service.embedQuery('two', configuration);
    expect(registry.get('fake').createModel).toHaveBeenCalledTimes(1);
  });
});
