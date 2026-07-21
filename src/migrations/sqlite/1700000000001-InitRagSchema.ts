import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the core RAG tables (default `rag_` prefix) plus the FTS5 virtual
 * table used for SQLite lexical search. If your application uses a custom
 * `database.tablePrefix`, copy this file and replace every `rag_` literal
 * with your prefix — TypeORM migrations do not support runtime parameters,
 * so a generated, prefix-specific file is the supported path for a custom
 * prefix (see the "Migration requirements" section of the README).
 */
export class InitRagSchema1700000000001 implements MigrationInterface {
  name = 'InitRagSchema1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rag_profiles" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "name" varchar(200) NOT NULL,
        "description" varchar(2000),
        "active_revision_id" varchar(36),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "uq_rag_profiles_name" UNIQUE ("name")
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
        "error" text,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "activated_at" datetime,
        "failed_at" datetime
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
        "source_name" varchar(200) NOT NULL,
        "profile_name" varchar(200) NOT NULL,
        "source_configuration" text NOT NULL,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "uq_rag_source_bindings_name" UNIQUE ("source_name")
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
        "source_updated_at" datetime,
        "metadata" text,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
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
        "created_at" datetime NOT NULL DEFAULT (datetime('now'))
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
        "chunk_id" varchar(36) NOT NULL,
        "provider_id" varchar(100) NOT NULL,
        "model_id" varchar(200) NOT NULL,
        "dimensions" integer NOT NULL,
        "embedding" text,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "uq_rag_chunk_embeddings_chunk" UNIQUE ("chunk_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "rag_idx_embeddings_revision_dims" ON "rag_chunk_embeddings" ("profile_revision_id", "dimensions")`,
    );

    // Lexical search: standalone (non-external-content) FTS5 table, kept in
    // sync by application code alongside writes to rag_chunks so we don't
    // depend on SQLite's integer-rowid external-content-table constraints
    // against a text/uuid primary key.
    await queryRunner.query(`
      CREATE VIRTUAL TABLE IF NOT EXISTS "rag_chunks_fts" USING fts5(
        content,
        chunk_id UNINDEXED,
        profile_revision_id UNINDEXED,
        document_id UNINDEXED,
        source_name UNINDEXED,
        namespace UNINDEXED
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_chunks_fts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_chunk_embeddings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_chunks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_documents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_source_bindings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_profile_revisions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rag_profiles"`);
  }
}
