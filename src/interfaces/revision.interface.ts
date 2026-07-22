import { RagChangeImpact, RagRevisionStatus } from '../enums';
import { RagProfileConfiguration } from './profile.interface';

export interface RagSerializedError {
  name: string;
  message: string;
  stack?: string;
  details?: Record<string, unknown>;
}

/** A named, top-level container that groups a family of configuration revisions. */
export interface RagProfile {
  id: string;
  name: string;
  description?: string;
  activeRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An immutable, versioned snapshot of a profile's operational configuration. */
export interface RagProfileRevision {
  id: string;
  profileName: string;
  revisionNumber: number;
  status: RagRevisionStatus;
  configuration: RagProfileConfiguration;
  configurationHash: string;
  changeImpact: RagChangeImpact;
  createdAt: Date;
  activatedAt?: Date;
  failedAt?: Date;
  previousRevisionId?: string;
  /**
   * Id of the revision whose physical index rows (documents, chunks,
   * embeddings) this revision serves. Equal to `id` for revisions that were
   * indexed themselves; for query-only (apply-immediately) revisions it
   * points to the ancestor that last re-indexed, since query-only changes
   * share that ancestor's row set instead of copying or moving it.
   */
  dataRevisionId: string;
  error?: RagSerializedError;
}
