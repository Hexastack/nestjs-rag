import type { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import { RagSourceFilter, RagSourceMapping, RagSourceProvider, RagSourceRecord, RagSourceTransform } from '../../interfaces/source.interface';
import { mapRecordToSourceRecord } from '../mapping.util';
import { assertSafeIdentifier } from '../../utils/identifier.util';
import { DEFAULT_SOURCE_BATCH_SIZE } from '../../constants';

/**
 * `RagSourceProvider` backed by a TypeORM entity. Reads go through the
 * host's `Repository<TEntity>` (via `QueryBuilder`), so entity-level
 * TypeORM features (relations excluded — only mapped columns are read)
 * stay under the host application's own metadata/validation. Property names
 * that end up inside query-builder expressions are validated against the
 * same identifier allow-list `TableSourceProvider` uses — they are
 * developer-supplied configuration, but the two providers should be hardened
 * identically.
 */
export class EntitySourceProvider<TEntity extends ObjectLiteral = ObjectLiteral> implements RagSourceProvider {
  constructor(
    public readonly name: string,
    private readonly dataSource: DataSource,
    private readonly entity: EntityTarget<TEntity>,
    private readonly mapping: RagSourceMapping<TEntity>,
    private readonly filter?: RagSourceFilter<TEntity>,
    private readonly transform?: RagSourceTransform<TEntity>,
  ) {
    assertSafeIdentifier(String(mapping.id), 'id property');
    if (mapping.updatedAt) assertSafeIdentifier(String(mapping.updatedAt), 'updatedAt property');
    for (const key of Object.keys(filter?.where ?? {})) {
      assertSafeIdentifier(key, 'filter property');
    }
  }

  async fetchRecords(options: {
    since?: Date;
    cursor?: string | null;
    batchSize: number;
  }): Promise<{ records: RagSourceRecord[]; nextCursor: string | null }> {
    const repo = this.dataSource.getRepository(this.entity);
    const batchSize = options.batchSize || this.filter?.batchSize || DEFAULT_SOURCE_BATCH_SIZE;
    const idProp = this.mapping.id as string;

    const qb = repo.createQueryBuilder('e').orderBy(`e.${idProp}`, 'ASC').limit(batchSize);

    // When the mapped `deletedAt` is the entity's TypeORM @DeleteDateColumn,
    // the query builder's implicit soft-delete filter would exclude deleted
    // rows before the mapper could observe their tombstones — and their
    // indexed documents could then never be removed by a sync. Reads must
    // include deleted rows so the indexer sees `deletedAt` and deletes the
    // document. Only done when a tombstone column is actually mapped:
    // without one, a deleted row would otherwise be indexed as live content.
    if (this.mapping.deletedAt) {
      qb.withDeleted();
    }

    if (options.cursor) {
      qb.andWhere(`e.${idProp} > :cursor`, { cursor: options.cursor });
    }
    if (options.since && this.mapping.updatedAt) {
      // `>=`, not `>`: rows sharing the boundary timestamp (common with
      // second-precision columns) must not be skipped forever. Re-processing
      // them is cheap — unchanged content is skipped by its indexing hash.
      qb.andWhere(`e.${String(this.mapping.updatedAt)} >= :since`, { since: options.since });
    }
    if (this.filter?.where) {
      for (const [key, value] of Object.entries(this.filter.where)) {
        qb.andWhere(`e.${key} = :${key}`, { [key]: value });
      }
    }

    const rows = await qb.getMany();
    let nextCursor: string | null = null;
    const records: RagSourceRecord[] = [];
    for (const row of rows) {
      const transformed = this.transform ? await this.transform(row) : row;
      records.push(mapRecordToSourceRecord(transformed as unknown as Record<string, unknown>, this.mapping, this.name));
      nextCursor = String((transformed as Record<string, unknown>)[idProp]);
    }
    return { records, nextCursor: rows.length === batchSize ? nextCursor : null };
  }

  async fetchRecord(externalId: string): Promise<RagSourceRecord | null> {
    const repo = this.dataSource.getRepository(this.entity);
    const idProp = this.mapping.id as string;
    const qb = repo.createQueryBuilder('e').where(`e.${idProp} = :id`, { id: externalId });
    // See fetchRecords: a mapped tombstone column must be observable even
    // when it is the entity's TypeORM soft-delete column.
    if (this.mapping.deletedAt) {
      qb.withDeleted();
    }
    const row = await qb.getOne();
    if (!row) return null;
    const transformed = this.transform ? await this.transform(row) : row;
    return mapRecordToSourceRecord(transformed as unknown as Record<string, unknown>, this.mapping, this.name);
  }
}
