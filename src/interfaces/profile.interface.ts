import { RagChunkingStrategy, RagRetrievalMode } from '../enums';

/**
 * Serializable embedding configuration. Only identifiers and settings are
 * stored — never an instantiated model object and never credentials.
 */
export interface RagEmbeddingConfiguration {
  providerId: string;
  modelId: string;
  dimensions: number;
  batchSize?: number;
  providerOptions?: Record<string, unknown>;
}

export interface RagLexicalOptions {
  language?: string;
}

export interface RagHybridOptions {
  strategy?: 'rrf';
  rrfK?: number;
  lexicalWeight?: number;
  embeddingWeight?: number;
}

export interface RagRetrievalOptions {
  defaultMode: RagRetrievalMode;
  lexical?: RagLexicalOptions;
  embedding?: RagEmbeddingConfiguration;
  hybrid?: RagHybridOptions;
}

export interface RagChunkingOptions {
  strategy: RagChunkingStrategy;
  chunkSize: number;
  chunkOverlap: number;
}

export interface RagSearchDefaults {
  topK?: number;
  candidateLimit?: number;
  minScore?: number;
}

/**
 * The full, versioned configuration of a RAG profile. This object is what
 * gets hashed, persisted inside a profile revision, and resolved at
 * indexing/search time. It never contains an instantiated model or a
 * credential of any kind.
 */
export interface RagProfileConfiguration {
  name: string;
  description?: string;
  retrieval: RagRetrievalOptions;
  chunking: RagChunkingOptions;
  searchDefaults?: RagSearchDefaults;
}

/** Default values applied when a partial configuration is created. */
export const RAG_DEFAULT_SEARCH_DEFAULTS: Required<RagSearchDefaults> = {
  topK: 10,
  candidateLimit: 50,
  minScore: 0,
};

export const RAG_DEFAULT_HYBRID_OPTIONS: Required<Omit<RagHybridOptions, 'strategy'>> & {
  strategy: 'rrf';
} = {
  strategy: 'rrf',
  rrfK: 60,
  lexicalWeight: 1,
  embeddingWeight: 1,
};
