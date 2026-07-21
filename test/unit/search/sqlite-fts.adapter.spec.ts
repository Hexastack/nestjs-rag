import { SqliteFtsLexicalAdapter } from '../../../src/search/lexical/sqlite-fts.adapter';
import { createSqliteTestContext, SqliteTestContext } from '../test-utils/sqlite-test-context';

describe('SqliteFtsLexicalAdapter (real FTS5 virtual table)', () => {
  let ctx: SqliteTestContext;
  let adapter: SqliteFtsLexicalAdapter;

  beforeEach(async () => {
    ctx = await createSqliteTestContext();
    adapter = new SqliteFtsLexicalAdapter(ctx.dataSource, ctx.schemaService.ftsTableName());
    const table = ctx.schemaService.ftsTableName();
    await ctx.dataSource.query(
      `INSERT INTO "${table}" (content, chunk_id, profile_revision_id, document_id, source_name, namespace) VALUES (?, ?, ?, ?, ?, ?)`,
      ['How do I install the fiber router', 'chunk-1', 'rev-1', 'doc-1', 'kb', 'en'],
    );
    await ctx.dataSource.query(
      `INSERT INTO "${table}" (content, chunk_id, profile_revision_id, document_id, source_name, namespace) VALUES (?, ?, ?, ?, ?, ?)`,
      ['Billing and invoices FAQ', 'chunk-2', 'rev-1', 'doc-2', 'kb', 'fr'],
    );
    await ctx.dataSource.query(
      `INSERT INTO "${table}" (content, chunk_id, profile_revision_id, document_id, source_name, namespace) VALUES (?, ?, ?, ?, ?, ?)`,
      ['Router installation instructions for fiber', 'chunk-3', 'rev-2', 'doc-3', 'kb', 'en'],
    );
  });

  afterEach(() => ctx.close());

  it('matches on query terms and scopes to the given profile revision', async () => {
    const hits = await adapter.search({ profileRevisionId: 'rev-1', query: 'fiber router', candidateLimit: 10 });
    expect(hits.map((h) => h.chunkId)).toEqual(['chunk-1']);
  });

  it('does not return chunks from a different revision', async () => {
    const hits = await adapter.search({ profileRevisionId: 'rev-1', query: 'fiber installation', candidateLimit: 10 });
    expect(hits.some((h) => h.chunkId === 'chunk-3')).toBe(false);
  });

  it('filters by namespace', async () => {
    const hits = await adapter.search({ profileRevisionId: 'rev-1', query: 'FAQ', namespaces: ['fr'], candidateLimit: 10 });
    expect(hits.map((h) => h.chunkId)).toEqual(['chunk-2']);
  });

  it('filters by source', async () => {
    const hits = await adapter.search({ profileRevisionId: 'rev-1', query: 'router', sources: ['other-source'], candidateLimit: 10 });
    expect(hits).toEqual([]);
  });

  it('returns an empty array when the query has no usable terms', async () => {
    expect(await adapter.search({ profileRevisionId: 'rev-1', query: '   ***  ', candidateLimit: 10 })).toEqual([]);
  });

  it('strips FTS5 special characters so a query string can never be interpreted as query syntax', async () => {
    // A raw `"unterminated OR (` would throw a syntax error from FTS5 if not sanitized.
    await expect(
      adapter.search({ profileRevisionId: 'rev-1', query: '"unterminated OR (', candidateLimit: 10 }),
    ).resolves.toBeDefined();
  });

  it('ranks a closer textual match higher (bm25 ascending, negated to "higher is better")', async () => {
    const hits = await adapter.search({ profileRevisionId: 'rev-1', query: 'router', candidateLimit: 10 });
    expect(hits[0].chunkId).toBe('chunk-1');
    expect(hits[0].score).toBeGreaterThan(-Infinity);
  });
});
