import { RagDatabaseType, RagRetrievalMode } from '../enums';
import { RagProfileConfiguration } from '../interfaces/profile.interface';
import { RagEmbeddingProviderRegistry } from '../providers/embedding-provider-registry';

export interface RagValidationContext {
  dbType: RagDatabaseType;
  /** Whether the module was configured to actually store native vectors (see `schema.createVectorExtension`). */
  vectorColumnEnabled: boolean;
  registry?: RagEmbeddingProviderRegistry;
}

export interface RagStructuralValidationResult {
  errors: string[];
  warnings: string[];
}

function isSqlite(dbType: RagDatabaseType): boolean {
  return dbType === RagDatabaseType.SQLITE || dbType === RagDatabaseType.BETTER_SQLITE3;
}

/**
 * Deterministic, synchronous structural validation shared by
 * `RagConfigurationService.validateProfile`, `previewUpdate`, and
 * `updateProfile`. Provider/model existence checks (which require the
 * registry, and optionally an async provider-side `validateConfiguration`
 * call) are layered on top by the caller — kept separate so this function
 * stays a pure, easily unit-testable core.
 */
export function validateProfileConfigurationStructure(
  configuration: RagProfileConfiguration,
  context: RagValidationContext,
): RagStructuralValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!configuration.name || configuration.name.trim().length === 0) {
    errors.push('Profile configuration must have a non-empty "name".');
  }

  const { chunking, retrieval } = configuration;

  if (!chunking) {
    errors.push('Profile configuration must include "chunking".');
  } else {
    if (!Number.isInteger(chunking.chunkSize) || chunking.chunkSize <= 0) {
      errors.push(`chunking.chunkSize must be a positive integer (got ${chunking.chunkSize}).`);
    }
    if (!Number.isInteger(chunking.chunkOverlap) || chunking.chunkOverlap < 0) {
      errors.push(`chunking.chunkOverlap must be a non-negative integer (got ${chunking.chunkOverlap}).`);
    }
    if (
      Number.isInteger(chunking.chunkSize) &&
      Number.isInteger(chunking.chunkOverlap) &&
      chunking.chunkOverlap >= chunking.chunkSize
    ) {
      errors.push(
        `chunking.chunkOverlap (${chunking.chunkOverlap}) must be smaller than chunking.chunkSize (${chunking.chunkSize}).`,
      );
    }
  }

  if (!retrieval) {
    errors.push('Profile configuration must include "retrieval".');
  } else {
    if (!Object.values(RagRetrievalMode).includes(retrieval.defaultMode)) {
      errors.push(`retrieval.defaultMode "${retrieval.defaultMode}" is not a valid RagRetrievalMode.`);
    }

    const needsEmbedding =
      retrieval.defaultMode === RagRetrievalMode.EMBEDDING || retrieval.defaultMode === RagRetrievalMode.HYBRID;

    if (isSqlite(context.dbType)) {
      if (needsEmbedding) {
        errors.push(
          `retrieval.defaultMode "${retrieval.defaultMode}" is not supported on SQLite: SQLite profiles only ` +
            `support lexical retrieval. Use PostgreSQL for embedding or hybrid retrieval.`,
        );
      }
      if (retrieval.embedding) {
        errors.push('retrieval.embedding must not be set for a SQLite-backed profile.');
      }
    } else if (needsEmbedding) {
      if (!retrieval.embedding) {
        errors.push(`retrieval.embedding is required when retrieval.defaultMode is "${retrieval.defaultMode}".`);
      } else if (!context.vectorColumnEnabled) {
        errors.push(
          'retrieval.embedding is set but this RagModule was not configured with ' +
            '`schema.createVectorExtension: true`, so no native vector column is available. ' +
            'Enable it in RagModule.forRoot() (and run the AddPgvectorSupport migration) before activating ' +
            'an embedding-enabled profile.',
        );
      }
    }

    if (retrieval.embedding) {
      const embedding = retrieval.embedding;
      if (!embedding.providerId) {
        errors.push('retrieval.embedding.providerId is required.');
      } else if (context.registry && !context.registry.has(embedding.providerId)) {
        errors.push(`retrieval.embedding.providerId "${embedding.providerId}" is not a registered provider.`);
      }
      if (!embedding.modelId) {
        errors.push('retrieval.embedding.modelId is required.');
      }
      if (!Number.isInteger(embedding.dimensions) || embedding.dimensions <= 0) {
        errors.push(`retrieval.embedding.dimensions must be a positive integer (got ${embedding.dimensions}).`);
      }
      if (embedding.batchSize !== undefined && (!Number.isInteger(embedding.batchSize) || embedding.batchSize <= 0)) {
        errors.push(`retrieval.embedding.batchSize must be a positive integer (got ${embedding.batchSize}).`);
      }
    }

    if (retrieval.defaultMode === RagRetrievalMode.HYBRID) {
      const hybrid = retrieval.hybrid;
      if (hybrid?.rrfK !== undefined && (!Number.isFinite(hybrid.rrfK) || hybrid.rrfK <= 0)) {
        errors.push(`retrieval.hybrid.rrfK must be a positive number (got ${hybrid.rrfK}).`);
      }
      if (hybrid?.lexicalWeight !== undefined && hybrid.lexicalWeight < 0) {
        errors.push(`retrieval.hybrid.lexicalWeight must be non-negative (got ${hybrid.lexicalWeight}).`);
      }
      if (hybrid?.embeddingWeight !== undefined && hybrid.embeddingWeight < 0) {
        errors.push(`retrieval.hybrid.embeddingWeight must be non-negative (got ${hybrid.embeddingWeight}).`);
      }
    }

    if (retrieval.lexical?.language !== undefined && retrieval.lexical.language.trim().length === 0) {
      errors.push('retrieval.lexical.language must not be an empty string when provided.');
    }
  }

  if (configuration.searchDefaults) {
    const { topK, candidateLimit, minScore } = configuration.searchDefaults;
    if (topK !== undefined && (!Number.isInteger(topK) || topK <= 0)) {
      errors.push(`searchDefaults.topK must be a positive integer (got ${topK}).`);
    }
    if (candidateLimit !== undefined && (!Number.isInteger(candidateLimit) || candidateLimit <= 0)) {
      errors.push(`searchDefaults.candidateLimit must be a positive integer (got ${candidateLimit}).`);
    }
    if (topK !== undefined && candidateLimit !== undefined && candidateLimit < topK) {
      warnings.push(
        `searchDefaults.candidateLimit (${candidateLimit}) is smaller than searchDefaults.topK (${topK}); ` +
          `it will be raised to ${topK} at search time.`,
      );
    }
    if (minScore !== undefined && (minScore < 0 || minScore > 1)) {
      warnings.push(`searchDefaults.minScore (${minScore}) is outside the typical [0, 1] range.`);
    }
  }

  return { errors, warnings };
}
