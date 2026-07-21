import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Opt-in migration that enables native pgvector storage. Run this only when
 * you're ready to use embedding or hybrid retrieval on Postgres, and only if
 * `RagModule.forRoot({ schema: { createVectorExtension: true } })` is set —
 * that flag is what tells the package to actually read/write the column as
 * a vector (see `createEntitySchemas` in `src/entities/schemas.ts`).
 *
 * The `embedding` column is intentionally left without a fixed length
 * (`vector`, not `vector(1536)`): one column holds multiple embedding
 * dimensions side by side, scoped per profile revision. ANN indexes are
 * created per-dimension, per-revision at runtime by `RagSchemaService`
 * (partial expression indexes), not by this migration.
 */
export class AddPgvectorSupport1700000000002 implements MigrationInterface {
  name = 'AddPgvectorSupport1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);
    // Existing JSON-encoded rows, if any, are intentionally left as NULL
    // after the type change — this migration is meant to be run before a
    // profile's first embedding-enabled revision is activated, not as a
    // live data migration for an already-populated text column.
    await queryRunner.query(`
      ALTER TABLE "rag_chunk_embeddings"
      ALTER COLUMN "embedding" TYPE vector USING NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "rag_chunk_embeddings"
      ALTER COLUMN "embedding" TYPE text USING NULL
    `);
  }
}
