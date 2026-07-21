import type { DataSource } from 'typeorm';
import { RagSourceFilter, RagSourceMapping, RagSourceProvider, RagSourceRecord } from '../../interfaces/source.interface';
import { mapRecordToSourceRecord } from '../mapping.util';
import { assertSafeIdentifier } from '../../utils/identifier.util';
import { DEFAULT_SOURCE_BATCH_SIZE } from '../../constants';

/** `batchSize` is interpolated into `LIMIT` (placeholders aren't reliable there across drivers) — force it to a safe positive integer. */
function sanitizeBatchSize(value: number | undefined): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SOURCE_BATCH_SIZE;
}

/**
 * `RagSourceProvider` backed by an explicit database table + column mapping
 * (no TypeORM entity required). Every table/column identifier is validated
 * against a strict allow-list (`assertSafeIdentifier`) before being
 * interpolated into SQL — these identifiers come from `RagModule.forRoot()`
 * (developer-controlled configuration), never from a search-time caller.
 * All *values* (filter values, cursors, ids) are always parameterized.
 */
export class TableSourceProvider implements RagSourceProvider {
  private readonly safeTable: string;
  private readonly safeIdColumn: string;

  constructor(
    public readonly name: string,
    private readonly dataSource: DataSource,
    private readonly table: string,
    private readonly mapping: RagSourceMapping,
    private readonly filter?: RagSourceFilter,
  ) {
    this.safeTable = assertSafeIdentifier(table, 'table name');
    this.safeIdColumn = assertSafeIdentifier(mapping.id, 'id column');
    for (const field of mapping.content) {
      assertSafeIdentifier(typeof field === 'string' ? field : field.column, 'content column');
    }
    for (const column of mapping.metadata ?? []) {
      assertSafeIdentifier(column, 'metadata column');
    }
    if (mapping.updatedAt) assertSafeIdentifier(mapping.updatedAt, 'updatedAt column');
    if (mapping.deletedAt) assertSafeIdentifier(mapping.deletedAt, 'deletedAt column');
    if (mapping.namespace) {
      assertSafeIdentifier(typeof mapping.namespace === 'string' ? mapping.namespace : mapping.namespace.column, 'namespace column');
    }
    if (filter?.where) {
      for (const key of Object.keys(filter.where)) {
        assertSafeIdentifier(key, 'filter column');
      }
    }
  }

  async fetchRecords(options: {
    since?: Date;
    cursor?: string | null;
    batchSize: number;
  }): Promise<{ records: RagSourceRecord[]; nextCursor: string | null }> {
    const batchSize = sanitizeBatchSize(options.batchSize || this.filter?.batchSize);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;
    const placeholder = () => (this.dataSource.options.type === 'postgres' ? `$${paramIndex++}` : '?');

    if (options.cursor) {
      conditions.push(`"${this.safeIdColumn}" > ${placeholder()}`);
      params.push(options.cursor);
    }
    if (options.since && this.mapping.updatedAt) {
      // `>=`, not `>`: rows sharing the boundary timestamp (common with
      // second-precision columns) must not be skipped forever. Re-processing
      // them is cheap — unchanged content is skipped by its indexing hash.
      conditions.push(`"${this.mapping.updatedAt}" >= ${placeholder()}`);
      params.push(options.since);
    }
    if (this.filter?.where) {
      for (const [key, value] of Object.entries(this.filter.where)) {
        conditions.push(`"${key}" = ${placeholder()}`);
        params.push(value);
      }
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM "${this.safeTable}" ${whereClause} ORDER BY "${this.safeIdColumn}" ASC LIMIT ${batchSize}`;

    const rows: Record<string, unknown>[] = await this.dataSource.query(sql, params);
    const records = rows.map((row) => mapRecordToSourceRecord(row, this.mapping, this.name));
    const nextCursor = rows.length === batchSize ? String(rows[rows.length - 1][this.safeIdColumn]) : null;
    return { records, nextCursor };
  }

  async fetchRecord(externalId: string): Promise<RagSourceRecord | null> {
    const placeholder = this.dataSource.options.type === 'postgres' ? '$1' : '?';
    const sql = `SELECT * FROM "${this.safeTable}" WHERE "${this.safeIdColumn}" = ${placeholder} LIMIT 1`;
    const rows: Record<string, unknown>[] = await this.dataSource.query(sql, [externalId]);
    if (rows.length === 0) return null;
    return mapRecordToSourceRecord(rows[0], this.mapping, this.name);
  }

  /** Verifies the table and every mapped column actually exist, via TypeORM's schema introspection. */
  async validateSchema(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const table = await queryRunner.getTable(this.safeTable);
      if (!table) {
        throw new Error(`Table "${this.safeTable}" does not exist.`);
      }
      const columnNames = new Set(table.columns.map((c) => c.name));
      const required = [
        this.safeIdColumn,
        ...this.mapping.content.map((f) => (typeof f === 'string' ? f : f.column)),
        ...(this.mapping.metadata ?? []),
      ];
      const missing = required.filter((c) => !columnNames.has(c));
      if (missing.length > 0) {
        throw new Error(`Table "${this.safeTable}" is missing column(s): ${missing.join(', ')}`);
      }
    } finally {
      await queryRunner.release();
    }
  }
}
