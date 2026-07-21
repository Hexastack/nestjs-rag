import type { DataSource } from 'typeorm';
import { qualifyTable } from '../../utils/qualify-table.util';
import { RagSearchHit, RagVectorSearchAdapter, RagVectorSearchParams } from '../search.types';

/**
 * Vector search over the native pgvector `embedding` column. Uses cosine
 * distance (`<=>`) — see the README's "Vector dimension strategy" section
 * for why the column itself is unbounded and how per-dimension ANN indexes
 * are created. Both sides of the distance operator are cast to
 * `vector(dimensions)` so the query text matches the partial expression
 * index `RagSchemaService.ensureVectorIndexForRevision` creates, letting
 * Postgres use it for the `ORDER BY ... LIMIT` scan when present.
 *
 * `dimensions` and `profileRevisionId` are always filtered *before* the
 * distance is computed, which is what makes it safe for one column to hold
 * multiple embedding dimensions: two vectors of different lengths are never
 * compared.
 */
export class PgvectorSearchAdapter implements RagVectorSearchAdapter {
  private readonly chunkEmbeddingsTable: string;
  private readonly documentsTable: string;
  private readonly chunksTable: string;

  constructor(
    private readonly dataSource: DataSource,
    chunkEmbeddingsTable: string,
    documentsTable: string,
    chunksTable: string,
  ) {
    this.chunkEmbeddingsTable = qualifyTable(dataSource, chunkEmbeddingsTable);
    this.documentsTable = qualifyTable(dataSource, documentsTable);
    this.chunksTable = qualifyTable(dataSource, chunksTable);
  }

  async search(params: RagVectorSearchParams): Promise<RagSearchHit[]> {
    if (!Number.isInteger(params.dimensions) || params.dimensions <= 0) {
      throw new Error(`Invalid vector search dimensions: ${params.dimensions}`);
    }
    const dims = params.dimensions;
    const literal = toPgvectorLiteral(params.queryVector);

    const values: unknown[] = [literal, params.profileRevisionId];
    const conditions: string[] = [`ce.profile_revision_id = $2`, `ce.dimensions = ${dims}`];
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

    const distanceExpr = `(ce.embedding::vector(${dims})) <=> ($1::vector(${dims}))`;
    const sql = `
      SELECT ce.chunk_id as "chunkId", 1 - (${distanceExpr}) as "score"
      FROM ${this.chunkEmbeddingsTable} ce
      ${needsJoin ? `JOIN ${this.chunksTable} c ON c.id = ce.chunk_id JOIN ${this.documentsTable} d ON d.id = c.document_id` : ''}
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${distanceExpr} ASC
      LIMIT ${limitParam}
    `;
    const rows: Array<{ chunkId: string; score: number }> = await this.dataSource.query(sql, values);
    return rows.map((row) => ({ chunkId: row.chunkId, score: Number(row.score) }));
  }
}

function toPgvectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
