import { RagApplyStrategy, RagChangeImpact } from '../enums';
import { RagChunkingOptions, RagProfileConfiguration, RagRetrievalOptions, RagSearchDefaults } from './profile.interface';
import { RagProfileReindexOptions, RagProfileReindexResult } from './reindex.interface';
import { RagProfileRevision } from './revision.interface';

export interface CreateRagProfileInput {
  name: string;
  configuration: RagProfileConfiguration;
}

/** A deep partial patch applied on top of the active revision's configuration. */
export interface UpdateRagProfileInput {
  description?: string;
  retrieval?: {
    defaultMode?: RagRetrievalOptions['defaultMode'];
    lexical?: RagRetrievalOptions['lexical'];
    /** Pass `null` to remove the embedding configuration entirely (e.g. converting a profile back to lexical-only). */
    embedding?: Partial<NonNullable<RagRetrievalOptions['embedding']>> | null;
    hybrid?: RagRetrievalOptions['hybrid'];
  };
  chunking?: Partial<RagChunkingOptions>;
  searchDefaults?: RagSearchDefaults;
}

export interface UpdateRagProfileOptions {
  applyStrategy: RagApplyStrategy | `${RagApplyStrategy}`;
  expectedRevisionId?: string;
  reindex?: RagProfileReindexOptions;
}

export interface RagConfigurationChangePreview {
  profileName: string;
  currentRevisionId: string | null;
  proposedConfiguration: RagProfileConfiguration;
  impact: RagChangeImpact;
  changedPaths: string[];
  affectedSources: string[];
  reasons: string[];
  canApplyImmediately: boolean;
}

export interface RagConfigurationUpdateResult {
  profileName: string;
  strategy: RagApplyStrategy | `${RagApplyStrategy}`;
  preview: RagConfigurationChangePreview;
  revision: RagProfileRevision;
  activeRevision: RagProfileRevision;
  reindexResult?: RagProfileReindexResult;
}

export interface RagConfigurationValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
