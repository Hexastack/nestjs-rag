import { RagDatabaseType } from './enums';

/**
 * Resolved, static infrastructure context derived once from
 * `RagModuleOptions` at bootstrap and injected (via `RAG_RESOLVED_OPTIONS`)
 * into every service that needs it. Never contains operational RAG settings
 * (those live exclusively in profile revisions).
 */
export interface RagResolvedModuleContext {
  dbType: RagDatabaseType;
  dataSourceName?: string;
  tablePrefix: string;
  autoInitialize: boolean;
  createVectorExtension: boolean;
  createVectorIndexes: boolean;
  vectorColumnEnabled: boolean;
  defaultProfileName: string;
  createDefaultProfile: boolean;
}
