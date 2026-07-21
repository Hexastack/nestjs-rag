import { Inject, Injectable } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import type { DataSource } from 'typeorm';
import {
  RAG_CHUNK_REPOSITORY,
  RAG_DATA_SOURCE,
  RAG_DOCUMENT_REPOSITORY,
  RAG_RESOLVED_OPTIONS,
  RAG_SCHEMA_SERVICE,
} from '../constants';
import { RagCapabilityError, RagConfigurationError } from '../errors';
import { RagChunkRow, RagDocumentRow } from '../entities/rows';
import { RagSchemaService } from '../entities/rag-schema.service';
import { RagRetrievalMode } from '../enums';
import { RAG_DEFAULT_HYBRID_OPTIONS, RAG_DEFAULT_SEARCH_DEFAULTS } from '../interfaces/profile.interface';
import { RagSearchOptions, RagSearchResult } from '../interfaces/search.interface';
import { RagResolvedModuleContext } from '../module-context';
import { RagConfigurationService } from '../config/rag-configuration.service';
import { RagEmbeddingService } from '../providers/embedding.service';
import { PostgresFtsLexicalAdapter } from './lexical/postgres-fts.adapter';
import { SqliteFtsLexicalAdapter } from './lexical/sqlite-fts.adapter';
import { PgvectorSearchAdapter } from './vector/pgvector.adapter';
import { reciprocalRankFusion } from './hybrid/reciprocal-rank-fusion';
import { RagLexicalSearchAdapter, RagSearchHit, RagVectorSearchAdapter } from './search.types';

interface FusedHit {
  chunkId: string;
  score: number;
  lexicalScore?: number;
  embeddingScore?: number;
  lexicalRank?: number;
  embeddingRank?: number;
}

/**
 * Public search entry point behind `RagService.search`. Resolves the
 * requested (or active) profile revision, dispatches to the lexical and/or
 * vector adapter appropriate for the host database, fuses results with RRF
 * for hybrid mode, and hydrates chunk/document rows for the response —
 * always scoped to one profile revision, so results never mix chunks or
 * embeddings produced under a different configuration (index-version
 * isolation, design doc section 10).
 */
@Injectable()
export class RagSearchService {
  private readonly lexicalAdapter: RagLexicalSearchAdapter;
  private readonly vectorAdapter?: RagVectorSearchAdapter;

  constructor(
    @Inject(RAG_DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(RAG_SCHEMA_SERVICE) private readonly schemaService: RagSchemaService,
    @Inject(RAG_RESOLVED_OPTIONS) private readonly context: RagResolvedModuleContext,
    @Inject(RAG_CHUNK_REPOSITORY) private readonly chunkRepo: Repository<RagChunkRow>,
    @Inject(RAG_DOCUMENT_REPOSITORY) private readonly documentRepo: Repository<RagDocumentRow>,
    private readonly configurationService: RagConfigurationService,
    private readonly embeddingService: RagEmbeddingService,
  ) {
    const prefix = context.tablePrefix;
    if (schemaService.isSqlite()) {
      this.lexicalAdapter = new SqliteFtsLexicalAdapter(dataSource, schemaService.ftsTableName());
      this.vectorAdapter = undefined;
    } else {
      this.lexicalAdapter = new PostgresFtsLexicalAdapter(dataSource, `${prefix}chunks`, `${prefix}documents`);
      this.vectorAdapter = new PgvectorSearchAdapter(
        dataSource,
        `${prefix}chunk_embeddings`,
        `${prefix}documents`,
        `${prefix}chunks`,
      );
    }
  }

  async search(query: string, options: RagSearchOptions = {}): Promise<RagSearchResult[]> {
    const profileName = options.profileName ?? this.context.defaultProfileName;
    const revision = options.revisionId
      ? await this.configurationService.getRevision(profileName, options.revisionId)
      : await this.configurationService.getActiveRevision(profileName);
    const configuration = revision.configuration;
    const mode = options.mode ?? configuration.retrieval.defaultMode;

    const topK = options.topK ?? configuration.searchDefaults?.topK ?? RAG_DEFAULT_SEARCH_DEFAULTS.topK;
    const candidateLimit = Math.max(
      options.candidateLimit ?? configuration.searchDefaults?.candidateLimit ?? RAG_DEFAULT_SEARCH_DEFAULTS.candidateLimit,
      topK,
    );
    const minScore = options.minScore ?? configuration.searchDefaults?.minScore ?? RAG_DEFAULT_SEARCH_DEFAULTS.minScore;
    const namespaces = options.namespaces ?? (options.namespace ? [options.namespace] : undefined);

    let lexicalHits: RagSearchHit[] = [];
    let embeddingHits: RagSearchHit[] = [];

    if (mode === RagRetrievalMode.LEXICAL || mode === RagRetrievalMode.HYBRID) {
      lexicalHits = await this.lexicalAdapter.search({
        profileRevisionId: revision.id,
        query,
        language: configuration.retrieval.lexical?.language,
        namespaces,
        sources: options.sources,
        candidateLimit,
      });
    }

    if (mode === RagRetrievalMode.EMBEDDING || mode === RagRetrievalMode.HYBRID) {
      if (!configuration.retrieval.embedding) {
        throw new RagConfigurationError(
          `Profile "${profileName}" revision "${revision.id}" has no embedding configuration; cannot search in mode "${mode}".`,
        );
      }
      if (!this.vectorAdapter) {
        throw new RagCapabilityError(
          'Embedding/hybrid retrieval is not available for this RagModule registration (SQLite backend only supports lexical search).',
        );
      }
      const queryVector = await this.embeddingService.embedQuery(query, configuration.retrieval.embedding);
      embeddingHits = await this.vectorAdapter.search({
        profileRevisionId: revision.id,
        queryVector,
        dimensions: configuration.retrieval.embedding.dimensions,
        namespaces,
        sources: options.sources,
        candidateLimit,
      });
    }

    let fused: FusedHit[];
    if (mode === RagRetrievalMode.HYBRID) {
      // `minScore` is applied per signal *before* fusion: RRF scores live on
      // a completely different scale (max ≈ weight/(rrfK+1) ≈ 0.016 with
      // defaults), so a threshold meant for a raw lexical/cosine score would
      // silently filter out every fused result if applied after fusion.
      if (minScore > 0) {
        lexicalHits = lexicalHits.filter((hit) => hit.score >= minScore);
        embeddingHits = embeddingHits.filter((hit) => hit.score >= minScore);
      }
      const hybrid = configuration.retrieval.hybrid ?? {};
      fused = reciprocalRankFusion(lexicalHits, embeddingHits, {
        rrfK: hybrid.rrfK ?? RAG_DEFAULT_HYBRID_OPTIONS.rrfK,
        lexicalWeight: hybrid.lexicalWeight ?? RAG_DEFAULT_HYBRID_OPTIONS.lexicalWeight,
        embeddingWeight: hybrid.embeddingWeight ?? RAG_DEFAULT_HYBRID_OPTIONS.embeddingWeight,
      });
    } else if (mode === RagRetrievalMode.LEXICAL) {
      fused = lexicalHits.map((hit, index) => ({
        chunkId: hit.chunkId,
        score: hit.score,
        lexicalScore: hit.score,
        lexicalRank: index + 1,
      }));
    } else {
      fused = embeddingHits.map((hit, index) => ({
        chunkId: hit.chunkId,
        score: hit.score,
        embeddingScore: hit.score,
        embeddingRank: index + 1,
      }));
    }

    if (mode !== RagRetrievalMode.HYBRID) {
      fused = fused.filter((hit) => hit.score >= minScore);
    }
    fused = fused.slice(0, topK);
    if (fused.length === 0) return [];

    return this.hydrate(fused, mode, options.metadata);
  }

  private async hydrate(
    fused: FusedHit[],
    mode: RagRetrievalMode,
    metadataFilter?: Record<string, string | number | boolean>,
  ): Promise<RagSearchResult[]> {
    const chunkIds = fused.map((f) => f.chunkId);
    const chunks = await this.chunkRepo.findBy({ id: In(chunkIds) });
    const chunkById = new Map(chunks.map((c) => [c.id, c]));

    const documentIds = [...new Set(chunks.map((c) => c.documentId))];
    const documents = documentIds.length > 0 ? await this.documentRepo.findBy({ id: In(documentIds) }) : [];
    const documentById = new Map(documents.map((d) => [d.id, d]));

    const results: RagSearchResult[] = [];
    for (const hit of fused) {
      const chunk = chunkById.get(hit.chunkId);
      if (!chunk) continue;
      const document = documentById.get(chunk.documentId);
      if (!document) continue;

      if (metadataFilter) {
        const meta = (document.metadata ?? {}) as Record<string, unknown>;
        const matches = Object.entries(metadataFilter).every(([key, value]) => meta[key] === value);
        if (!matches) continue;
      }

      results.push({
        chunk: {
          chunkId: chunk.id,
          documentId: document.id,
          sourceName: document.sourceName,
          sourceId: document.sourceId,
          namespace: document.namespace ?? undefined,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          metadata: chunk.metadata as Record<string, unknown> | undefined,
        },
        score: hit.score,
        lexicalScore: hit.lexicalScore,
        embeddingScore: hit.embeddingScore,
        lexicalRank: hit.lexicalRank,
        embeddingRank: hit.embeddingRank,
        mode,
      });
    }
    return results;
  }
}
