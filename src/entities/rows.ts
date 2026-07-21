/**
 * Plain row shapes stored by TypeORM. These intentionally mirror the tables
 * described in the design doc (`rag_profiles`, `rag_profile_revisions`, ...)
 * and are kept separate from the public-facing interfaces in `src/interfaces`
 * so persistence concerns (JSON-serialized columns, denormalized ids) don't
 * leak into the public API surface.
 */

export interface RagProfileRow {
  id: string;
  name: string;
  description: string | null;
  activeRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RagProfileRevisionRow {
  id: string;
  profileId: string;
  profileName: string;
  revisionNumber: number;
  status: string;
  configuration: unknown;
  configurationHash: string;
  changeImpact: string;
  previousRevisionId: string | null;
  error: unknown;
  createdAt: Date;
  activatedAt: Date | null;
  failedAt: Date | null;
}

export interface RagSourceBindingRow {
  id: string;
  sourceName: string;
  profileName: string;
  sourceConfiguration: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface RagDocumentRow {
  id: string;
  profileName: string;
  profileRevisionId: string;
  sourceName: string;
  sourceId: string;
  externalId: string;
  namespace: string | null;
  content: string;
  contentHash: string;
  indexingHash: string;
  sourceUpdatedAt: Date | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface RagChunkRow {
  id: string;
  profileName: string;
  profileRevisionId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  metadata: unknown;
  createdAt: Date;
}

export interface RagChunkEmbeddingRow {
  id: string;
  profileName: string;
  profileRevisionId: string;
  chunkId: string;
  providerId: string;
  modelId: string;
  dimensions: number;
  /**
   * On Postgres this is a native `vector` column (TypeORM's pgvector
   * support handles array<->literal conversion transparently), stored
   * without a fixed length so a single column can hold multiple embedding
   * dimensions side by side (see the "vector dimension strategy" section of
   * the README). On SQLite it is JSON-encoded text, kept only so the schema
   * is uniform; SQLite profiles can never enable embedding retrieval.
   */
  embedding: number[] | string | null;
  createdAt: Date;
}
