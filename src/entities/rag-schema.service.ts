import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, QueryRunner, Table } from 'typeorm';
import { RagDatabaseType } from '../enums';
import { RagSchemaOptions } from '../interfaces/module-options.interface';
import { assertSafeRegconfig, assertSafeTablePrefix } from '../utils/identifier.util';
import { qualifyTable } from '../utils/qualify-table.util';
import { assertUuid } from '../utils/uuid.util';
import { RagEntitySchemas } from './schemas';

/**
 * Owns every piece of raw DDL this package needs beyond what TypeORM's
 * repository layer covers on its own: the SQLite FTS5 virtual table used for
 * lexical search, per-revision Postgres GIN expression indexes for lexical
 * search, and per-dimension Postgres pgvector ANN indexes.
 *
 * Nothing here ever runs implicitly against a production database unless
 * `schema.autoInitialize` is explicitly enabled — see `RagModule` docs.
 */
export class RagSchemaService {
  private readonly logger = new Logger(RagSchemaService.name);
  private readonly tablePrefix: string;

  constructor(
    private readonly dataSource: DataSource,
    private readonly schemas: RagEntitySchemas,
    tablePrefix: string,
    private readonly dbType: RagDatabaseType,
    private readonly options: Required<RagSchemaOptions>,
  ) {
    this.tablePrefix = assertSafeTablePrefix(tablePrefix);
  }

  isSqlite(): boolean {
    return this.dbType === RagDatabaseType.SQLITE || this.dbType === RagDatabaseType.BETTER_SQLITE3;
  }

  isPostgres(): boolean {
    return this.dbType === RagDatabaseType.POSTGRES;
  }

  /** Runs once at application bootstrap when `schema.autoInitialize` is true. Intended for dev/test only. */
  async autoInitialize(): Promise<void> {
    if (!this.options.autoInitialize) {
      return;
    }
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await this.ensureCoreTables(queryRunner);
      if (this.isSqlite()) {
        await this.ensureSqliteFts(queryRunner);
      }
      if (this.isPostgres() && this.options.createVectorExtension) {
        await this.ensureVectorExtension(queryRunner);
      }
    } finally {
      await queryRunner.release();
    }
  }

  async ensureCoreTables(queryRunner: QueryRunner): Promise<void> {
    const orderedSchemas = [
      this.schemas.profile,
      this.schemas.profileRevision,
      this.schemas.sourceBinding,
      this.schemas.document,
      this.schemas.chunk,
      this.schemas.chunkEmbedding,
    ];
    for (const schema of orderedSchemas) {
      const metadata = this.dataSource.getMetadata(schema);
      const table = Table.create(metadata, this.dataSource.driver);
      await queryRunner.createTable(table, true, true, true);
    }
  }

  async ensureSqliteFts(queryRunner: QueryRunner): Promise<void> {
    const ftsTable = this.ftsTableName();
    await queryRunner.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "${ftsTable}" USING fts5(` +
        `content, chunk_id UNINDEXED, profile_revision_id UNINDEXED, document_id UNINDEXED, ` +
        `source_name UNINDEXED, namespace UNINDEXED)`,
    );
  }

  ftsTableName(): string {
    return `${this.tablePrefix}chunks_fts`;
  }

  async ensureVectorExtension(queryRunner: QueryRunner): Promise<void> {
    try {
      await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);
    } catch (error) {
      this.logger.warn(
        `Could not create the "vector" extension automatically (this typically requires superuser rights). ` +
          `Ask a database administrator to run "CREATE EXTENSION vector;" manually. Underlying error: ${
            (error as Error).message
          }`,
      );
    }
  }

  async hasVectorExtension(queryRunner: QueryRunner): Promise<boolean> {
    if (!this.isPostgres()) return false;
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') as "exists"`,
    );
    return Boolean(rows[0]?.exists);
  }

  /**
   * Creates (or no-ops if already present) a partial GIN expression index
   * scoped to one profile revision and lexical-search language, so runtime
   * language changes never require altering a shared index.
   */
  async ensureLexicalIndexForRevision(
    queryRunner: QueryRunner,
    revisionId: string,
    language: string,
  ): Promise<void> {
    if (!this.isPostgres()) return;
    assertUuid(revisionId, 'revisionId');
    const safeLanguage = assertSafeRegconfig(language);
    const indexName = this.lexicalIndexName(revisionId, safeLanguage);
    const chunksTable = qualifyTable(this.dataSource, `${this.tablePrefix}chunks`);
    try {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "${indexName}" ON ${chunksTable} ` +
          `USING gin (to_tsvector('${safeLanguage}', content)) ` +
          `WHERE profile_revision_id = '${revisionId}'`,
      );
    } catch (error) {
      this.logger.warn(
        `Could not create lexical GIN index "${indexName}" (search will still work via a sequential scan). ` +
          `Underlying error: ${(error as Error).message}`,
      );
    }
  }

  lexicalIndexName(revisionId: string, language: string): string {
    const digest = createHash('sha1').update(`${revisionId}:${language}`).digest('hex').slice(0, 12);
    return `${this.tablePrefix}idx_lex_${digest}`;
  }

  /**
   * Creates a dimension-specific, revision-scoped ANN index on the unbounded
   * `embedding` vector column. Because the index predicate
   * (`WHERE profile_revision_id = ... AND dimensions = ...`) is evaluated
   * before the indexed expression, rows with a different dimensionality are
   * never cast and never included — this is what lets a single column
   * safely hold multiple embedding dimensions across profiles/revisions.
   * Index creation is a performance optimization: failure (e.g. an older
   * pgvector without HNSW support) is logged, not thrown — vector search
   * still works via a sequential scan.
   */
  async ensureVectorIndexForRevision(
    queryRunner: QueryRunner,
    revisionId: string,
    dimensions: number,
  ): Promise<void> {
    if (!this.isPostgres() || !this.options.createVectorIndexes) return;
    assertUuid(revisionId, 'revisionId');
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error(`Invalid embedding dimensions: ${dimensions}`);
    }
    const indexName = this.vectorIndexName(revisionId, dimensions);
    const table = qualifyTable(this.dataSource, `${this.tablePrefix}chunk_embeddings`);
    const createIndexSql = (method: 'hnsw' | 'ivfflat') =>
      `CREATE INDEX IF NOT EXISTS "${indexName}" ON ${table} ` +
      `USING ${method} ((embedding::vector(${dimensions})) vector_cosine_ops) ` +
      `WHERE profile_revision_id = '${revisionId}' AND dimensions = ${dimensions}`;
    try {
      await queryRunner.query(createIndexSql('hnsw'));
    } catch (hnswError) {
      try {
        await queryRunner.query(createIndexSql('ivfflat'));
      } catch (ivfflatError) {
        this.logger.warn(
          `Could not create a vector index "${indexName}" for ${dimensions} dimensions ` +
            `(vector search will still work via a sequential scan). HNSW error: ${
              (hnswError as Error).message
            }; IVFFlat error: ${(ivfflatError as Error).message}`,
        );
      }
    }
  }

  vectorIndexName(revisionId: string, dimensions: number): string {
    const digest = createHash('sha1').update(`${revisionId}:${dimensions}`).digest('hex').slice(0, 12);
    return `${this.tablePrefix}idx_vec_${digest}`;
  }

  /**
   * Drops the lexical and/or vector index created for a specific revision.
   * Callers (archived-revision cleanup) know the revision's own language and
   * embedding dimensions and can therefore recompute the exact deterministic
   * index name via `lexicalIndexName`/`vectorIndexName` rather than needing
   * to discover it.
   */
  async dropIndexIfExists(queryRunner: QueryRunner, indexName: string): Promise<void> {
    if (!this.isPostgres()) return;
    await queryRunner.query(`DROP INDEX IF EXISTS ${qualifyTable(this.dataSource, indexName)}`);
  }
}
