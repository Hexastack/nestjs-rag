import type { DataSource } from 'typeorm';
import { assertSafeRegconfig } from '../../utils/identifier.util';
import { qualifyTable } from '../../utils/qualify-table.util';
import { RagLexicalSearchAdapter, RagLexicalSearchParams, RagSearchHit } from '../search.types';

/**
 * Lexical search using Postgres's built-in full-text search
 * (`to_tsvector`/`plainto_tsquery`/`ts_rank_cd`). Benefits from the
 * per-revision partial GIN index created by
 * `RagSchemaService.ensureLexicalIndexForRevision` when present, and falls
 * back to a sequential scan (still correct, just slower) when it isn't.
 */
export class PostgresFtsLexicalAdapter implements RagLexicalSearchAdapter {
  private readonly chunksTable: string;
  private readonly documentsTable: string;

  constructor(
    private readonly dataSource: DataSource,
    chunksTable: string,
    documentsTable: string,
  ) {
    this.chunksTable = qualifyTable(dataSource, chunksTable);
    this.documentsTable = qualifyTable(dataSource, documentsTable);
  }

  async search(params: RagLexicalSearchParams): Promise<RagSearchHit[]> {
    if (!params.query.trim()) return [];
    const language = assertSafeRegconfig(params.language ?? 'simple');

    const values: unknown[] = [params.profileRevisionId, params.query];
    const conditions: string[] = [
      `c.profile_revision_id = $1`,
      `to_tsvector('${language}', c.content) @@ plainto_tsquery('${language}', $2)`,
    ];
    let needsJoin = false;

    if (params.sources && params.sources.length > 0) {
      needsJoin = true;
      values.push(params.sources);
      conditions.push(`d.source_name = ANY($${values.length})`);
    }
    if (params.namespaces && params.namespaces.length > 0) {
      needsJoin = true;
      values.push(params.namespaces);
      conditions.push(`d.namespace = ANY($${values.length})`);
    }

    values.push(params.candidateLimit);
    const limitParam = `$${values.length}`;

    const sql = `
      SELECT c.id as "chunkId", ts_rank_cd(to_tsvector('${language}', c.content), plainto_tsquery('${language}', $2)) as "rank"
      FROM ${this.chunksTable} c
      ${needsJoin ? `JOIN ${this.documentsTable} d ON d.id = c.document_id` : ''}
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank DESC
      LIMIT ${limitParam}
    `;
    const rows: Array<{ chunkId: string; rank: number }> = await this.dataSource.query(sql, values);
    return rows.map((row) => ({ chunkId: row.chunkId, score: Number(row.rank) }));
  }
}
