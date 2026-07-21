import { RagApplyStrategy } from '../enums';
import { RagConfigurationChangePreview } from './config-api.interface';
import { RagChunkingOptions, RagRetrievalOptions } from './profile.interface';
import { RagProfileReindexOptions, RagProfileReindexResult } from './reindex.interface';

export interface RagSourceProfileUpdateOptions {
  applyStrategy: RagApplyStrategy | `${RagApplyStrategy}`;
  reindex?: RagProfileReindexOptions;
}

export interface RagSourceProfileUpdateResult {
  sourceName: string;
  previousProfileName: string;
  newProfileName: string;
  preview: RagConfigurationChangePreview;
  reindexResult?: RagProfileReindexResult;
}

export interface RagSourceUpdateOptions {
  applyStrategy: RagApplyStrategy | `${RagApplyStrategy}`;
  reindex?: RagProfileReindexOptions;
}

export interface RagSourceUpdateResult {
  sourceName: string;
  preview: RagConfigurationChangePreview;
  reindexResult?: RagProfileReindexResult;
}

export interface UpdateRagSourceConfigurationInput {
  chunking?: Partial<RagChunkingOptions>;
  retrieval?: Partial<RagRetrievalOptions>;
}
