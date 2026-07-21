import { PgvectorSearchAdapter } from '../../../src/search/vector/pgvector.adapter';

describe('PgvectorSearchAdapter', () => {
  it('filters by profile revision and dimensions before computing distance, and casts both sides to vector(dims)', async () => {
    const query = jest.fn().mockResolvedValue([{ chunkId: 'c1', score: 0.87 }]);
    const dataSource = { query } as any;
    const adapter = new PgvectorSearchAdapter(dataSource, 'rag_chunk_embeddings', 'rag_documents', 'rag_chunks');

    const results = await adapter.search({
      profileRevisionId: 'rev-1',
      queryVector: [0.1, 0.2, 0.3],
      dimensions: 3,
      candidateLimit: 8,
    });

    expect(results).toEqual([{ chunkId: 'c1', score: 0.87 }]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ce.dimensions = 3');
    expect(sql).toContain('ce.profile_revision_id = $2');
    expect(sql).toContain('vector(3)');
    expect(params[0]).toBe('[0.1,0.2,0.3]');
    expect(params[1]).toBe('rev-1');
  });

  it('joins documents/chunks and filters by source/namespace when requested', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const adapter = new PgvectorSearchAdapter({ query } as any, 'rag_chunk_embeddings', 'rag_documents', 'rag_chunks');

    await adapter.search({
      profileRevisionId: 'rev-1',
      queryVector: [1, 2],
      dimensions: 2,
      sources: ['kb'],
      namespaces: ['en'],
      candidateLimit: 20,
    });

    const [sql] = query.mock.calls[0];
    expect(sql).toContain('JOIN "rag_chunks"');
    expect(sql).toContain('JOIN "rag_documents"');
    expect(sql).toContain('d.source_name = ANY(');
    expect(sql).toContain('d.namespace = ANY(');
  });

  it('rejects a non-positive dimensions value rather than building a query', async () => {
    const query = jest.fn();
    const adapter = new PgvectorSearchAdapter({ query } as any, 'e', 'd', 'c');
    await expect(adapter.search({ profileRevisionId: 'r', queryVector: [1], dimensions: 0, candidateLimit: 5 })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
