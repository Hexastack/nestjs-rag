import { RagRetrievalMode } from '../enums';

export interface RagSearchOptions {
  profileName?: string;
  mode?: RagRetrievalMode;
  namespace?: string;
  namespaces?: string[];
  sources?: string[];
  topK?: number;
  candidateLimit?: number;
  minScore?: number;
  metadata?: Record<string, string | number | boolean>;
  /** Administrative override: search a specific (non-active) revision. */
  revisionId?: string;
}

export interface RagSearchResultChunk {
  chunkId: string;
  documentId: string;
  sourceName: string;
  sourceId: string;
  namespace?: string;
  chunkIndex: number;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RagSearchResult {
  chunk: RagSearchResultChunk;
  score: number;
  lexicalScore?: number;
  embeddingScore?: number;
  lexicalRank?: number;
  embeddingRank?: number;
  mode: RagRetrievalMode;
}
