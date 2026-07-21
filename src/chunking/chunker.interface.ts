import { RagChunkingOptions } from '../interfaces/profile.interface';

export interface RagChunk {
  text: string;
  startIndex: number;
  endIndex: number;
  tokenCount: number;
}

export interface RagChunker {
  chunk(text: string): Promise<RagChunk[]>;
}

/**
 * Resolves a `RagChunker` for a given chunking configuration. Implementations
 * must not hard-code chunk size/strategy at construction time — every call
 * receives the configuration to use, resolved from the active (or pending)
 * profile revision for the operation at hand.
 */
export interface RagChunkerFactory {
  create(configuration: RagChunkingOptions): Promise<RagChunker>;
}
