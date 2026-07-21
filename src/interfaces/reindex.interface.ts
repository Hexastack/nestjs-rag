import { RagOperationStatus } from '../enums';
import { RagIngestResult } from './ingest.interface';

export interface RagSourceSyncOptions {
  profileName?: string;
  batchSize?: number;
  continueOnError?: boolean;
  /** Administrative override: index against a specific pending/ready revision. */
  revisionId?: string;
  /** Force a full re-sync even if a source supports incremental sync. */
  full?: boolean;
}

export interface RagSourceSyncResult {
  sourceName: string;
  status: RagOperationStatus;
  recordsProcessed: number;
  documentsIndexed: number;
  documentsRemoved: number;
  chunksCreated: number;
  embeddingsCreated: number;
  failures: number;
  errors: Array<{ externalId: string; message: string }>;
  results: RagIngestResult[];
}

export interface RagProfileReindexOptions {
  /** Restrict the re-index to these source names (defaults to every source bound to the profile). */
  sources?: string[];
  batchSize?: number;
  continueOnError?: boolean;
}

export interface RagProfileReindexResult {
  profileName: string;
  revisionId: string;
  status: RagOperationStatus;
  sources: RagSourceSyncResult[];
  documentsIndexed: number;
  chunksCreated: number;
  embeddingsCreated: number;
  failures: number;
  readyForActivation: boolean;
}
