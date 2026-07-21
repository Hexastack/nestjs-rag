import { RagChunkingOptions } from './profile.interface';

export interface RagDocumentInput {
  /** Logical source this document belongs to. Defaults to `"direct"`. */
  sourceName?: string;
  /** Stable identifier for the record within its source. */
  externalId: string;
  content: string;
  metadata?: Record<string, unknown>;
  namespace?: string;
  updatedAt?: Date;
}

export interface RagIngestOptions {
  profileName?: string;
  namespace?: string;
  replaceExisting?: boolean;
  chunkingOverrides?: Partial<RagChunkingOptions>;
  /** Administrative override: index against a specific pending/ready revision. */
  revisionId?: string;
}

export interface RagIngestResult {
  documentId: string;
  sourceName: string;
  externalId: string;
  profileName: string;
  revisionId: string;
  chunksCreated: number;
  embeddingsCreated: number;
  indexingHash: string;
  skipped: boolean;
  skipReason?: string;
}
