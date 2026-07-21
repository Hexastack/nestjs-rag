import type { DataSource } from 'typeorm';
import { RagLexicalSearchAdapter, RagLexicalSearchParams, RagSearchHit } from '../search.types';

/**
 * Lexical search over the standalone `{prefix}chunks_fts` FTS5 virtual
 * table (see `RagSchemaService.ensureSqliteFts`). Ranked with SQLite's
 * built-in `bm25()` (lower is better in FTS5, so we negate it to keep the
 * "higher score is better" convention shared with the vector adapter).
 * `namespace`/`source_name` are stored as UNINDEXED columns on the FTS
 * table itself, so filtering never needs a join back to `rag_documents`.
 */
export class SqliteFtsLexicalAdapter implements RagLexicalSearchAdapter {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ftsTableName: string,
  ) {}

  async search(params: RagLexicalSearchParams): Promise<RagSearchHit[]> {
    const query = sanitizeFtsQuery(params.query);
    if (!query) return [];

    const conditions: string[] = ['profile_revision_id = ?', `${this.ftsTableName} MATCH ?`];
    const values: unknown[] = [params.profileRevisionId, query];

    if (params.sources && params.sources.length > 0) {
      conditions.push(`source_name IN (${params.sources.map(() => '?').join(',')})`);
      values.push(...params.sources);
    }
    if (params.namespaces && params.namespaces.length > 0) {
      conditions.push(`namespace IN (${params.namespaces.map(() => '?').join(',')})`);
      values.push(...params.namespaces);
    }

    const sql = `
      SELECT chunk_id as "chunkId", bm25(${this.ftsTableName}) as "rank"
      FROM ${this.ftsTableName}
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank ASC
      LIMIT ${Number(params.candidateLimit)}
    `;
    const rows: Array<{ chunkId: string; rank: number }> = await this.dataSource.query(sql, values);
    return rows.map((row) => ({ chunkId: row.chunkId, score: -row.rank }));
  }
}

/**
 * FTS5's `MATCH` syntax treats punctuation specially (`-`, `"`, `*`, `:`,
 * parentheses, ...). We only support simple "match all of these terms"
 * queries: strip anything that isn't a word character, then AND the terms
 * together, which keeps user-supplied search strings from ever being
 * interpreted as FTS5 query syntax.
 */
function sanitizeFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((term) => term.length > 0);
  return terms.map((term) => `"${term}"`).join(' AND ');
}
