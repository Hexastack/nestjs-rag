import { PostgresFtsLexicalAdapter } from '../../../src/search/lexical/postgres-fts.adapter';

describe('PostgresFtsLexicalAdapter', () => {
  it('builds a to_tsvector/plainto_tsquery query scoped to the profile revision', async () => {
    const query = jest.fn().mockResolvedValue([{ chunkId: 'c1', rank: 0.5 }]);
    const dataSource = { query } as any;
    const adapter = new PostgresFtsLexicalAdapter(dataSource, 'rag_chunks', 'rag_documents');

    const results = await adapter.search({
      profileRevisionId: 'rev-1',
      query: 'installation guide',
      language: 'english',
      candidateLimit: 10,
    });

    expect(results).toEqual([{ chunkId: 'c1', score: 0.5 }]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("to_tsvector('english'");
    expect(sql).toContain('rag_chunks');
    expect(sql).not.toContain('JOIN'); // no source/namespace filter -> no join needed
    expect(params[0]).toBe('rev-1');
    expect(params[1]).toBe('installation guide');
  });

  it('joins the documents table and filters by source/namespace when requested', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const dataSource = { query } as any;
    const adapter = new PostgresFtsLexicalAdapter(dataSource, 'rag_chunks', 'rag_documents');

    await adapter.search({
      profileRevisionId: 'rev-1',
      query: 'foo',
      sources: ['articles'],
      namespaces: ['en'],
      candidateLimit: 5,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('JOIN "rag_documents"');
    expect(sql).toContain('d.source_name = ANY(');
    expect(sql).toContain('d.namespace = ANY(');
    expect(params).toEqual(['rev-1', 'foo', ['articles'], ['en'], 5]);
  });

  it('rejects an unsafe language value rather than interpolating it', async () => {
    const dataSource = { query: jest.fn() } as any;
    const adapter = new PostgresFtsLexicalAdapter(dataSource, 'rag_chunks', 'rag_documents');
    await expect(
      adapter.search({ profileRevisionId: 'rev-1', query: 'x', language: "english'; DROP TABLE x; --", candidateLimit: 5 }),
    ).rejects.toThrow();
  });

  it('returns an empty array for a blank query without hitting the database', async () => {
    const query = jest.fn();
    const adapter = new PostgresFtsLexicalAdapter({ query } as any, 'rag_chunks', 'rag_documents');
    expect(await adapter.search({ profileRevisionId: 'rev-1', query: '   ', candidateLimit: 5 })).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
