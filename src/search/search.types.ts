export interface RagLexicalSearchParams {
  profileRevisionId: string;
  query: string;
  /** Postgres only: the `regconfig` text-search language for this revision. */
  language?: string;
  namespaces?: string[];
  sources?: string[];
  candidateLimit: number;
}

export interface RagVectorSearchParams {
  profileRevisionId: string;
  queryVector: number[];
  dimensions: number;
  namespaces?: string[];
  sources?: string[];
  candidateLimit: number;
}

export interface RagSearchHit {
  chunkId: string;
  /** Higher is better for both lexical and vector hits. */
  score: number;
}

export interface RagLexicalSearchAdapter {
  search(params: RagLexicalSearchParams): Promise<RagSearchHit[]>;
}

export interface RagVectorSearchAdapter {
  search(params: RagVectorSearchParams): Promise<RagSearchHit[]>;
}
