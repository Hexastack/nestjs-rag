import { Injectable, Logger } from '@nestjs/common';
import { RecursiveChunker, SentenceChunker, TokenChunker } from '@chonkiejs/core';
import { RagChunkingStrategy } from '../enums';
import { RagChunkingOptions } from '../interfaces/profile.interface';
import { RagValidationError } from '../errors';
import { hashConfiguration } from '../utils/hash.util';
import { RagChunk, RagChunker, RagChunkerFactory } from './chunker.interface';

/**
 * Wraps `@chonkiejs/core`'s token/sentence/recursive chunkers behind the
 * package's own `RagChunker` contract, resolving a (possibly cached)
 * chunker instance from a `RagChunkingOptions` value on every call — never
 * a single chunker instantiated once at module startup.
 *
 * Chonkie's default character-based tokenizer is used throughout (no custom
 * tokenizer is implemented), matching the "do not implement a custom
 * tokenizer" requirement.
 */
@Injectable()
export class ChonkieChunkerFactory implements RagChunkerFactory {
  private readonly logger = new Logger(ChonkieChunkerFactory.name);
  private readonly cache = new Map<string, Promise<RagChunker>>();

  async create(configuration: RagChunkingOptions): Promise<RagChunker> {
    this.validate(configuration);
    const cacheKey = hashConfiguration(configuration);
    let cached = this.cache.get(cacheKey);
    if (!cached) {
      cached = this.build(configuration);
      this.cache.set(cacheKey, cached);
    }
    return cached;
  }

  private validate(configuration: RagChunkingOptions): void {
    const errors: string[] = [];
    if (!Number.isInteger(configuration.chunkSize) || configuration.chunkSize <= 0) {
      errors.push(`chunkSize must be a positive integer (got ${configuration.chunkSize}).`);
    }
    if (!Number.isInteger(configuration.chunkOverlap) || configuration.chunkOverlap < 0) {
      errors.push(`chunkOverlap must be a non-negative integer (got ${configuration.chunkOverlap}).`);
    }
    if (
      Number.isInteger(configuration.chunkSize) &&
      Number.isInteger(configuration.chunkOverlap) &&
      configuration.chunkOverlap >= configuration.chunkSize
    ) {
      errors.push(
        `chunkOverlap (${configuration.chunkOverlap}) must be smaller than chunkSize (${configuration.chunkSize}).`,
      );
    }
    if (!Object.values(RagChunkingStrategy).includes(configuration.strategy)) {
      errors.push(`Unknown chunking strategy "${configuration.strategy}".`);
    }
    if (errors.length > 0) {
      throw new RagValidationError(errors);
    }
  }

  private async build(configuration: RagChunkingOptions): Promise<RagChunker> {
    switch (configuration.strategy) {
      case RagChunkingStrategy.TOKEN: {
        const chunker = await TokenChunker.create({
          chunkSize: configuration.chunkSize,
          chunkOverlap: configuration.chunkOverlap,
        });
        return wrap(chunker);
      }
      case RagChunkingStrategy.SENTENCE: {
        const chunker = await SentenceChunker.create({
          chunkSize: configuration.chunkSize,
          chunkOverlap: configuration.chunkOverlap,
        });
        return wrap(chunker);
      }
      case RagChunkingStrategy.RECURSIVE: {
        if (configuration.chunkOverlap > 0) {
          this.logger.warn(
            `chunkOverlap (${configuration.chunkOverlap}) is ignored for the "recursive" chunking strategy — ` +
              `@chonkiejs/core's RecursiveChunker does not support overlap.`,
          );
        }
        const chunker = await RecursiveChunker.create({
          chunkSize: configuration.chunkSize,
        });
        return wrap(chunker);
      }
      default:
        throw new RagValidationError([`Unknown chunking strategy "${configuration.strategy}".`]);
    }
  }
}

function wrap(chonkieChunker: { chunk(text: string): Promise<Array<{
  text: string;
  startIndex: number;
  endIndex: number;
  tokenCount: number;
}>> }): RagChunker {
  return {
    async chunk(text: string): Promise<RagChunk[]> {
      if (text.length === 0) return [];
      const chunks = await chonkieChunker.chunk(text);
      return chunks.map((c) => ({
        text: c.text,
        startIndex: c.startIndex,
        endIndex: c.endIndex,
        tokenCount: c.tokenCount,
      }));
    },
  };
}
