import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the core RAG tables (default `rag_` prefix). The `embedding`
 * column starts as `text` (JSON-encoded) — run
 * `AddPgvectorSupport1700000000002` separately, and only when you're ready,
 * to convert it to a native pgvector column. This keeps "create the vector
 * extension" and "alter the embedding column type" as an explicit, reviewed
 * migration step rather than something that happens implicitly.
 *
 * If your application uses a custom `database.tablePrefix`, copy this file
 * and replace every `rag_` literal with your prefix.
 */
export class InitRagSchema1700000000001 implements MigrationInterface {
  name = 'InitRagSchema1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rag_profiles" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "name" varchar(200) NOT NULL UNIQUE,
        "description" varchar(2000),
        "active_revision_id" varchar(36),
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rag_profile_revisions" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "profile_id" varchar(36) NOT NULL,
        "profile_name" varchar(200) NOT NULL,
        "revision_number" integer NOT NULL,
        "status" varchar(32) NOT NULL,
        "configuration" text NOT NULL,
        "configuration_hash" varchar(128) NOT NULL,
        "change_impact" varchar(32) NOT NULL,
        "previous_revision_id" varchar(36),
        "data_revision_id" varchar(36) NOT NULL,
        "error" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "activated_at" timestamp,
        "failed_at" timestamp
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "rag_idx_revisions_profile" ON "rag_profile_revisions" ("profile_name")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "rag_idx_revisions_profile_number" ON "rag_profile_revisions" ("profile_id", "revision_number")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rag_source_bindings" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "source_name" varchar(200) NOT NULL UNIQUE,
        "profile_name" varchar(200) NOT NULL,
        "source_configuration" text NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rag_documents" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "profile_name" varchar(200) NOT NULL,
        "profile_revision_id" varchar(36) NOT NULL,
        "source_name" varchar(200) NOT NULL,
        "source_id" varchar(200) NOT NULL,
        "external_id" varchar(200) NOT NULL,
        "namespace" varchar(200),
        "content" text NOT NULL,
        "content_hash" varchar(128) NOT NULL,
        "indexing_hash" varchar(128) NOT NULL,
        "source_updated_at" timestamp,
        "metadata" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "rag_idx_documents_revision_source_ext" ON "rag_documents" ("profile_revision_id", "source_name", "external_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "rag_idx_documents_profile_namespace" ON "rag_documents" ("profile_name", "namespace")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rag_chunks" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "profile_name" varchar(200) NOT NULL,
        "profile_revision_id" varchar(36) NOT NULL,
        "document_id" varchar(36) NOT NULL,
        "chunk_index" integer NOT NULL,
        "content" text NOT NULL,
        "token_count" integer NOT NULL,
        "metadata" text,
        "created_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "rag_idx_chunks_document_index" ON "rag_chunks" ("document_id", "chunk_index")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "rag_idx_chunks_revision" ON "rag_chunks" ("profile_revision_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rag_chunk_embeddings" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "profile_name" varchar(200) NOT NULL,
        "profile_revision_id" varchar(36) NOT NULL,
        "chunk_id" varchar(36) NOT NULL UNIQUE,
        "provider_id" varchar(100) NOT NULL,
        "model_id" varchar(200) NOT NULL,
        "dimensions" integer NOT NULL,
        "embedding" text,
        "created_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "rag_idx_embeddings_revision_dims" ON "rag_chunk_embeddings" ("profile_revision_id", "dimensions")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_chunk_embeddings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_chunks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_documents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_source_bindings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_profile_revisions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_profiles"`);
  }
}
