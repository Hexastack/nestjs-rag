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
   * Id of the revision whose immutable physical index snapshot (documents,
   * chunks, embeddings) this revision serves. New revisions own their
   * snapshot, so rolling back restores both configuration and corpus.
   */
  dataRevisionId: string;
  error?: RagSerializedError;
}
