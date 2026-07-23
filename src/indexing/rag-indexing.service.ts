import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import {
  DEFAULT_SOURCE_BATCH_SIZE,
  DIRECT_SOURCE_NAME,
  RAG_CHUNK_EMBEDDING_REPOSITORY,
  RAG_CHUNK_REPOSITORY,
  RAG_DATA_SOURCE,
  RAG_DOCUMENT_REPOSITORY,
  RAG_RESOLVED_OPTIONS,
  RAG_SCHEMA_SERVICE,
  RAG_SOURCE_BINDING_REPOSITORY,
} from '../constants';
import { RagOperationStatus } from '../enums';
import { RagChunkEmbeddingRow, RagChunkRow, RagDocumentRow, RagSourceBindingRow } from '../entities/rows';
import { RagSchemaService } from '../entities/rag-schema.service';
import { RagConfigurationError, RagSourceNotFoundError } from '../errors';
import { RagProfileConfiguration } from '../interfaces/profile.interface';
import { RagDocumentInput, RagIngestOptions, RagIngestResult } from '../interfaces/ingest.interface';
import {
  RagProfileReindexOptions,
  RagProfileReindexResult,
  RagSourceSyncOptions,
  RagSourceSyncResult,
} from '../interfaces/reindex.interface';
import { RagSourceProvider, RagSourceRecord } from '../interfaces/source.interface';
import { RagResolvedModuleContext } from '../module-context';
import { RagConfigurationService } from '../config/rag-configuration.service';
import { resolveEffectiveChunking, resolveEffectiveRetrieval } from '../config/patch-merge.util';
import { RagEmbeddingProviderRegistry } from '../providers/embedding-provider-registry';
import { RagEmbeddingService } from '../providers/embedding.service';
import { ChonkieChunkerFactory } from '../chunking/chonkie-chunker.factory';
import { EntitySourceProvider } from '../source/providers/entity-source.provider';
import { TableSourceProvider } from '../source/providers/table-source.provider';
import { RagResolvedSourceWiring, RagSourceRegistry } from '../source/source-registry';
import { hashContent, hashIndexingInputs } from '../utils/hash.util';
import { newId } from '../utils/id.util';

interface RevisionContext {
  profileName: string;
  revisionId: string;
  /**
   * Revision id that owns the physical index rows (documents, chunks,
   * embeddings, FTS). Differs from `revisionId` when the revision is a
   * query-only (apply-immediately) descendant of the revision that actually
   * indexed — every physical read/write below must use this id.
   */
  dataRevisionId: string;
  configuration: RagProfileConfiguration;
}

/**
 * Implements `RagService`'s indexing surface (design doc sections 17-18):
 * direct ingestion, source synchronization, single-record indexing, and
 * profile/revision re-indexing. Every write is scoped to one profile
 * revision id — see `RagSchemaService`/README "Index-version isolation".
 */
@Injectable()
export class RagIndexingService {
  private readonly providerCache = new Map<string, RagSourceProvider>();
  private readonly ensuredIndexKeys = new Set<string>();

  constructor(
    @Inject(RAG_DOCUMENT_REPOSITORY) private readonly documentRepo: Repository<RagDocumentRow>,
    @Inject(RAG_CHUNK_REPOSITORY) private readonly chunkRepo: Repository<RagChunkRow>,
    @Inject(RAG_CHUNK_EMBEDDING_REPOSITORY) private readonly chunkEmbeddingRepo: Repository<RagChunkEmbeddingRow>,
    @Inject(RAG_SOURCE_BINDING_REPOSITORY) private readonly sourceBindingRepo: Repository<RagSourceBindingRow>,
    @Inject(RAG_DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(RAG_SCHEMA_SERVICE) private readonly schemaService: RagSchemaService,
    @Inject(RAG_RESOLVED_OPTIONS) private readonly context: RagResolvedModuleContext,
    // See the matching note in RagConfigurationService: this pair is a
    // genuine circular provider dependency and needs forwardRef on both sides.
    @Inject(forwardRef(() => RagConfigurationService))
    private readonly configurationService: RagConfigurationService,
    private readonly sourceRegistry: RagSourceRegistry,
    private readonly chunkerFactory: ChonkieChunkerFactory,
    private readonly embeddingService: RagEmbeddingService,
    private readonly embeddingRegistry: RagEmbeddingProviderRegistry,
  ) {}

  // ---------------------------------------------------------------------
  // Direct ingestion
  // ---------------------------------------------------------------------

  async ingest(document: RagDocumentInput, options: RagIngestOptions = {}): Promise<RagIngestResult> {
    const profileName = options.profileName ?? this.context.defaultProfileName;
    const revision = await this.resolveRevisionContext(profileName, options.revisionId);
    const sourceName = document.sourceName ?? DIRECT_SOURCE_NAME;

    const record: RagSourceRecord = {
      externalId: document.externalId,
      content: document.content,
      metadata: document.metadata,
      namespace: document.namespace ?? options.namespace,
      updatedAt: document.updatedAt,
      deletedAt: null,
    };

    const result = await this.indexRecord(revision, sourceName, document.externalId, record, {
      chunkingOverrides: options.chunkingOverrides,
      replaceExisting: options.replaceExisting ?? true,
    });
    await this.ensureIndexesForRevision(revision);
    return result;
  }

  async ingestMany(documents: RagDocumentInput[], options: RagIngestOptions = {}): Promise<RagIngestResult[]> {
    const results: RagIngestResult[] = [];
    for (const document of documents) {
      results.push(await this.ingest(document, options));
    }
    return results;
  }

  // ---------------------------------------------------------------------
  // Source synchronization
  // ---------------------------------------------------------------------

  async syncSource(sourceName: string, options: RagSourceSyncOptions = {}): Promise<RagSourceSyncResult> {
    const binding = await this.getBindingOrThrow(sourceName);
    const profileName = options.profileName ?? binding.profileName;
    const revision = await this.resolveRevisionContext(profileName, options.revisionId);
    return this.syncSourceUnderRevision(sourceName, revision, options);
  }

  async syncAllSources(options: RagSourceSyncOptions = {}): Promise<RagSourceSyncResult[]> {
    const bindings = await this.sourceBindingRepo.find();
    const results: RagSourceSyncResult[] = [];
    for (const binding of bindings) {
      results.push(await this.syncSource(binding.sourceName, options));
    }
    return results;
  }

  async indexSourceRecord(sourceName: string, sourceId: string | number): Promise<RagIngestResult> {
    const binding = await this.getBindingOrThrow(sourceName);
    const wiring = this.sourceRegistry.get(sourceName);
    const provider = this.resolveProvider(wiring);
    if (!provider.fetchRecord) {
      throw new RagConfigurationError(`Source "${sourceName}" does not support fetching a single record by id.`);
    }
    const record = await provider.fetchRecord(String(sourceId));
    if (!record) {
      throw new RagConfigurationError(`Source "${sourceName}" has no record with id "${sourceId}".`);
    }
    const revision = await this.resolveRevisionContext(binding.profileName);
    if (record.deletedAt) {
      await this.deleteDocument(revision.dataRevisionId, sourceName, record.externalId);
      return {
        documentId: '',
        sourceName,
        externalId: record.externalId,
        profileName: revision.profileName,
        revisionId: revision.revisionId,
        chunksCreated: 0,
        embeddingsCreated: 0,
        indexingHash: '',
        skipped: true,
        skipReason: 'deleted',
      };
    }
    const overrides = await this.getEffectiveSourceOverrides(sourceName, wiring);
    const result = await this.indexRecord(revision, sourceName, record.externalId, record, {
      chunkingOverrides: overrides.chunking,
      retrievalOverrides: overrides.retrieval,
      replaceExisting: true,
    });
    await this.ensureIndexesForRevision(revision);
    return result;
  }

  async removeSourceRecord(sourceName: string, sourceId: string | number): Promise<void> {
    const binding = await this.getBindingOrThrow(sourceName);
    const revision = await this.resolveRevisionContext(binding.profileName);
    await this.deleteDocument(revision.dataRevisionId, sourceName, String(sourceId));
  }

  /**
   * Removes every document a source contributed to a profile's *active*
   * revision (used when a source is reassigned to a different profile, so the
   * old profile stops serving its content). Row sets built by other
   * re-indexes are left untouched — like all deletes, this is scoped to the
   * active revision's data revision.
   */
  async removeSourceDocuments(profileName: string, sourceName: string): Promise<{ documentsRemoved: number }> {
    let revision: RevisionContext;
    try {
      revision = await this.resolveRevisionContext(profileName);
    } catch {
      // No active revision — nothing can be serving this source's content.
      return { documentsRemoved: 0 };
    }
    const documents = await this.documentRepo.find({
      where: { profileRevisionId: revision.dataRevisionId, sourceName },
    });
    for (const document of documents) {
      await this.deleteDocument(revision.dataRevisionId, sourceName, document.externalId);
    }
    return { documentsRemoved: documents.length };
  }

  // ---------------------------------------------------------------------
  // Profile / revision re-indexing
  // ---------------------------------------------------------------------

  /**
   * The raw physical re-index: syncs every bound source (and carries forward
   * unbound/direct documents) into the revision's row set. It deliberately
   * performs no revision status transitions — that lifecycle
   * (`pending → indexing → ready`/`failed`) is owned by
   * `RagConfigurationService.reindexStagedRevision`, which wraps this method
   * and is what `RagService.reindexProfile`/`reindexRevision` call. Invoking
   * this directly leaves a staged revision `pending`, and `activateRevision`
   * will refuse it.
   */
  async reindexRevision(
    profileName: string,
    revisionId: string,
    options: RagProfileReindexOptions = {},
  ): Promise<RagProfileReindexResult> {
    const revision = await this.configurationService.getRevision(profileName, revisionId);
    const configuration = revision.configuration;

    if (configuration.retrieval.embedding) {
      await this.embeddingRegistry.validateConfiguration(configuration.retrieval.embedding);
    }

    const context: RevisionContext = { profileName, revisionId, dataRevisionId: revision.dataRevisionId, configuration };

    const allBindings = await this.sourceBindingRepo.find({ where: { profileName } });
    const targetBindings = options.sources
      ? allBindings.filter((b) => options.sources!.includes(b.sourceName))
      : allBindings;

    const sourceResults: RagSourceSyncResult[] = [];
    let aborted = false;
    for (const binding of targetBindings) {
      const result = await this.syncSourceUnderRevision(binding.sourceName, context, {
        batchSize: options.batchSize,
        continueOnError: options.continueOnError,
        full: true,
      });
      sourceResults.push(result);
      if (result.status === RagOperationStatus.FAILED && !options.continueOnError) {
        aborted = true;
        break;
      }
    }

    // Documents that don't come from a registered source (direct ingestion
    // via `ragService.ingest`, source name "direct" or any ad-hoc name) have
    // no provider to re-fetch them from — but their full content is stored in
    // rag_documents, so they are re-chunked/re-embedded from the currently
    // active revision's stored copy. Without this, activating the new
    // revision would silently drop everything that was directly ingested.
    if (!aborted) {
      const boundNames = new Set(allBindings.map((b) => b.sourceName));
      sourceResults.push(...(await this.reindexUnboundDocuments(context, boundNames, options)));
    }

    const documentsIndexed = sourceResults.reduce((sum, r) => sum + r.documentsIndexed, 0);
    const chunksCreated = sourceResults.reduce((sum, r) => sum + r.chunksCreated, 0);
    const embeddingsCreated = sourceResults.reduce((sum, r) => sum + r.embeddingsCreated, 0);
    const failures = sourceResults.reduce((sum, r) => sum + r.failures, 0);
    const allAttempted = !aborted;

    let status: RagOperationStatus;
    if (failures === 0 && allAttempted) {
      status = RagOperationStatus.COMPLETED;
    } else if (documentsIndexed > 0) {
      status = RagOperationStatus.COMPLETED_WITH_ERRORS;
    } else {
      status = RagOperationStatus.FAILED;
    }

    const readyForActivation =
      status === RagOperationStatus.COMPLETED || (status === RagOperationStatus.COMPLETED_WITH_ERRORS && !!options.continueOnError);

    if (readyForActivation) {
      await this.ensureIndexesForRevision(context);
    }

    return {
      profileName,
      revisionId,
      status,
      sources: sourceResults,
      documentsIndexed,
      chunksCreated,
      embeddingsCreated,
      failures,
      readyForActivation,
    };
  }

  // ---------------------------------------------------------------------
  // Internal: source synchronization loop
  // ---------------------------------------------------------------------

  private async syncSourceUnderRevision(
    sourceName: string,
    revision: RevisionContext,
    options: RagSourceSyncOptions,
  ): Promise<RagSourceSyncResult> {
    const wiring = this.sourceRegistry.get(sourceName);
    const provider = this.resolveProvider(wiring);
    const batchSize = options.batchSize ?? wiring.filter?.batchSize ?? DEFAULT_SOURCE_BATCH_SIZE;
    const overrides = await this.getEffectiveSourceOverrides(sourceName, wiring);

    let since: Date | undefined;
    if (!options.full && wiring.synchronization?.incremental) {
      since = await this.lastSyncedAt(revision.dataRevisionId, sourceName);
    }

    const results: RagIngestResult[] = [];
    const errors: Array<{ externalId: string; message: string }> = [];
    let documentsRemoved = 0;
    let cursor: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await provider.fetchRecords({ since, cursor, batchSize });
      for (const record of page.records) {
        try {
          if (record.deletedAt) {
            await this.deleteDocument(revision.dataRevisionId, sourceName, record.externalId);
            documentsRemoved += 1;
            continue;
          }
          const result = await this.indexRecord(revision, sourceName, record.externalId, record, {
            chunkingOverrides: overrides.chunking,
            retrievalOverrides: overrides.retrieval,
            replaceExisting: false,
          });
          results.push(result);
        } catch (error) {
          errors.push({ externalId: record.externalId, message: (error as Error).message });
          if (!options.continueOnError) {
            return this.buildSyncResult(sourceName, results, errors, documentsRemoved);
          }
        }
      }
      if (!page.nextCursor || page.records.length === 0) break;
      cursor = page.nextCursor;
    }

    return this.buildSyncResult(sourceName, results, errors, documentsRemoved);
  }

  /**
   * Re-indexes, into `revision`, every document of the profile's currently
   * active revision whose source has no binding (direct ingestion and ad-hoc
   * source names). Content comes from the stored `rag_documents.content`,
   * re-chunked/re-embedded under the new revision's configuration. Results
   * are grouped per source name so they surface in the reindex report like
   * any other source.
   */
  private async reindexUnboundDocuments(
    revision: RevisionContext,
    boundSourceNames: Set<string>,
    options: RagProfileReindexOptions,
  ): Promise<RagSourceSyncResult[]> {
    let activeDataRevisionId: string;
    try {
      const active = await this.configurationService.getActiveRevision(revision.profileName);
      activeDataRevisionId = active.dataRevisionId;
    } catch {
      return []; // no active revision yet — nothing to carry forward
    }
    if (activeDataRevisionId === revision.dataRevisionId) return [];

    const documents = await this.documentRepo.find({ where: { profileRevisionId: activeDataRevisionId } });
    const unbound = documents.filter((d) => !boundSourceNames.has(d.sourceName));
    if (unbound.length === 0) return [];

    const bySource = new Map<string, { results: RagIngestResult[]; errors: Array<{ externalId: string; message: string }> }>();
    for (const document of unbound) {
      const bucket = bySource.get(document.sourceName) ?? { results: [], errors: [] };
      bySource.set(document.sourceName, bucket);
      try {
        const record: RagSourceRecord = {
          externalId: document.externalId,
          content: document.content,
          metadata: (document.metadata as Record<string, unknown> | null) ?? undefined,
          namespace: document.namespace ?? undefined,
          updatedAt: document.sourceUpdatedAt ?? undefined,
          deletedAt: null,
        };
        bucket.results.push(
          await this.indexRecord(revision, document.sourceName, document.sourceId, record, { replaceExisting: true }),
        );
      } catch (error) {
        bucket.errors.push({ externalId: document.externalId, message: (error as Error).message });
        if (!options.continueOnError) break;
      }
    }

    return [...bySource.entries()].map(([sourceName, bucket]) =>
      this.buildSyncResult(sourceName, bucket.results, bucket.errors, 0),
    );
  }

  private buildSyncResult(
    sourceName: string,
    results: RagIngestResult[],
    errors: Array<{ externalId: string; message: string }>,
    documentsRemoved: number,
  ): RagSourceSyncResult {
    const status =
      errors.length === 0 ? RagOperationStatus.COMPLETED : results.length > 0 ? RagOperationStatus.COMPLETED_WITH_ERRORS : RagOperationStatus.FAILED;
    return {
      sourceName,
      status,
      recordsProcessed: results.length + documentsRemoved + errors.length,
      documentsIndexed: results.filter((r) => !r.skipped).length,
      documentsRemoved,
      chunksCreated: results.reduce((sum, r) => sum + r.chunksCreated, 0),
      embeddingsCreated: results.reduce((sum, r) => sum + r.embeddingsCreated, 0),
      failures: errors.length,
      errors,
      results,
    };
  }

  private async lastSyncedAt(profileRevisionId: string, sourceName: string): Promise<Date | undefined> {
    const row = await this.documentRepo
      .createQueryBuilder('d')
      .select('MAX(d.sourceUpdatedAt)', 'max')
      .where('d.profileRevisionId = :profileRevisionId', { profileRevisionId })
      .andWhere('d.sourceName = :sourceName', { sourceName })
      .getRawOne<{ max: string | null }>();
    return row?.max ? new Date(row.max) : undefined;
  }

  // ---------------------------------------------------------------------
  // Internal: single-record indexing (chunk + embed + persist)
  // ---------------------------------------------------------------------

  private async indexRecord(
    revision: RevisionContext,
    sourceName: string,
    sourceId: string,
    record: RagSourceRecord,
    options: {
      chunkingOverrides?: Partial<RagProfileConfiguration['chunking']>;
      retrievalOverrides?: Partial<RagProfileConfiguration['retrieval']>;
      replaceExisting: boolean;
    },
  ): Promise<RagIngestResult> {
    const contentHash = hashContent(record.content);
    const effectiveChunking = resolveEffectiveChunking(revision.configuration.chunking, options.chunkingOverrides);
    const indexingHash = hashIndexingInputs({
      contentHash,
      profileRevisionId: revision.dataRevisionId,
      chunkingOverrides: effectiveChunking,
    });

    const existing = await this.documentRepo.findOne({
      where: { profileRevisionId: revision.dataRevisionId, sourceName, externalId: record.externalId },
    });
    if (existing && existing.indexingHash === indexingHash && !options.replaceExisting) {
      return {
        documentId: existing.id,
        sourceName,
        externalId: record.externalId,
        profileName: revision.profileName,
        revisionId: revision.revisionId,
        chunksCreated: 0,
        embeddingsCreated: 0,
        indexingHash,
        skipped: true,
        skipReason: 'unchanged',
      };
    }

    const chunker = await this.chunkerFactory.create(effectiveChunking);
    const chunks = await chunker.chunk(record.content);

    const effectiveRetrieval = resolveEffectiveRetrieval(revision.configuration.retrieval, options.retrievalOverrides);
    let vectors: number[][] = [];
    if (effectiveRetrieval.embedding && chunks.length > 0) {
      vectors = await this.embeddingService.embedMany(chunks.map((c) => c.text), effectiveRetrieval.embedding);
    }

    const documentId = existing?.id ?? newId();
    const now = new Date();

    await this.dataSource.transaction(async (manager) => {
      if (existing) {
        // Delete existing chunks/embeddings for this document, then rewrite.
        const oldChunks = await manager.find<RagChunkRow>(this.chunkRepo.target, { where: { documentId } });
        if (oldChunks.length > 0) {
          await manager.delete(
            this.chunkEmbeddingRepo.target,
            oldChunks.map((c) => ({ chunkId: c.id })),
          );
          await manager.delete(this.chunkRepo.target, { documentId });
        }
      }

      await manager.save(this.documentRepo.target, {
        id: documentId,
        profileName: revision.profileName,
        profileRevisionId: revision.dataRevisionId,
        sourceName,
        sourceId,
        externalId: record.externalId,
        namespace: record.namespace ?? null,
        content: record.content,
        contentHash,
        indexingHash,
        sourceUpdatedAt: record.updatedAt ?? null,
        metadata: record.metadata ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });

      const chunkRows: RagChunkRow[] = chunks.map((chunk, index) => ({
        id: newId(),
        profileName: revision.profileName,
        profileRevisionId: revision.dataRevisionId,
        documentId,
        chunkIndex: index,
        content: chunk.text,
        tokenCount: chunk.tokenCount,
        metadata: record.metadata ?? null,
        createdAt: now,
      }));
      if (chunkRows.length > 0) {
        await manager.save(this.chunkRepo.target, chunkRows, { chunk: 100 });
      }

      if (vectors.length > 0 && effectiveRetrieval.embedding) {
        const embedding = effectiveRetrieval.embedding;
        const embeddingRows: RagChunkEmbeddingRow[] = chunkRows.map((chunkRow, i) => ({
          id: newId(),
          profileName: revision.profileName,
          profileRevisionId: revision.dataRevisionId,
          chunkId: chunkRow.id,
          providerId: embedding.providerId,
          modelId: embedding.modelId,
          dimensions: embedding.dimensions,
          embedding: this.schemaService.isPostgres() ? vectors[i] : JSON.stringify(vectors[i]),
          createdAt: now,
        }));
        await manager.save(this.chunkEmbeddingRepo.target, embeddingRows, { chunk: 100 });
      }

      if (this.schemaService.isSqlite()) {
        const ftsTable = this.schemaService.ftsTableName();
        if (existing) {
          await manager.query(`DELETE FROM "${ftsTable}" WHERE document_id = ?`, [documentId]);
        }
        for (const row of chunkRows) {
          await manager.query(
            `INSERT INTO "${ftsTable}" (content, chunk_id, profile_revision_id, document_id, source_name, namespace) VALUES (?, ?, ?, ?, ?, ?)`,
            [row.content, row.id, revision.dataRevisionId, documentId, sourceName, record.namespace ?? null],
          );
        }
      }
    });

    return {
      documentId,
      sourceName,
      externalId: record.externalId,
      profileName: revision.profileName,
      revisionId: revision.revisionId,
      chunksCreated: chunks.length,
      embeddingsCreated: vectors.length,
      indexingHash,
      skipped: false,
    };
  }

  /**
   * Deletes a document (and its chunks/embeddings/FTS rows) from *one*
   * physical row set only — the one owned by `profileRevisionId` (always a
   * *data* revision id). Row sets built by other re-indexes keep their copy
   * until `cleanupArchivedRevisions` purges them, so rollback across a
   * re-index boundary restores exactly what that revision indexed. Query-only
   * revisions that share this data revision see the delete immediately: a
   * query-only lineage is one live corpus, not a chain of snapshots.
   */
  private async deleteDocument(profileRevisionId: string, sourceName: string, externalId: string): Promise<void> {
    const documents = await this.documentRepo.find({ where: { profileRevisionId, sourceName, externalId } });
    for (const document of documents) {
      await this.dataSource.transaction(async (manager) => {
        const chunks = await manager.find<RagChunkRow>(this.chunkRepo.target, { where: { documentId: document.id } });
        if (chunks.length > 0) {
          await manager.delete(
            this.chunkEmbeddingRepo.target,
            chunks.map((c) => ({ chunkId: c.id })),
          );
        }
        await manager.delete(this.chunkRepo.target, { documentId: document.id });
        await manager.delete(this.documentRepo.target, { id: document.id });
        if (this.schemaService.isSqlite()) {
          await manager.query(`DELETE FROM "${this.schemaService.ftsTableName()}" WHERE document_id = ?`, [document.id]);
        }
      });
    }
  }

  // ---------------------------------------------------------------------
  // Internal: helpers
  // ---------------------------------------------------------------------

  /**
   * Resolves the *current* effective chunking/retrieval overrides for a
   * source: the persisted `rag_source_bindings` row (kept up to date by
   * `RagSourceConfigurationService.updateSourceOverrides`) takes precedence
   * over the code-supplied defaults from `RagModule.forRoot({ sources })`,
   * which only seed the binding the first time a source is seen.
   */
  private async getEffectiveSourceOverrides(
    sourceName: string,
    wiring: RagResolvedSourceWiring,
  ): Promise<{ chunking?: Partial<RagProfileConfiguration['chunking']>; retrieval?: Partial<RagProfileConfiguration['retrieval']> }> {
    const binding = await this.sourceBindingRepo.findOne({ where: { sourceName } });
    const stored = (binding?.sourceConfiguration ?? {}) as {
      chunkingOverrides?: Partial<RagProfileConfiguration['chunking']>;
      retrievalOverrides?: Partial<RagProfileConfiguration['retrieval']>;
    };
    return {
      chunking: stored.chunkingOverrides ?? wiring.defaultChunkingOverrides,
      retrieval: stored.retrievalOverrides ?? wiring.defaultRetrievalOverrides,
    };
  }

  private async ensureIndexesForRevision(revision: RevisionContext): Promise<void> {
    if (!this.schemaService.isPostgres()) return;
    const language = revision.configuration.retrieval.lexical?.language ?? 'simple';
    const dimensions = revision.configuration.retrieval.embedding?.dimensions;
    // `CREATE INDEX IF NOT EXISTS` round-trips on every single ingest add up;
    // once ensured for a (revision, language[, dimensions]) combination in
    // this process, skip the DDL entirely.
    const cacheKey = `${revision.dataRevisionId}:${language}:${dimensions ?? 'none'}`;
    if (this.ensuredIndexKeys.has(cacheKey)) return;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await this.schemaService.ensureLexicalIndexForRevision(queryRunner, revision.dataRevisionId, language);
      if (dimensions !== undefined) {
        await this.schemaService.ensureVectorIndexForRevision(queryRunner, revision.dataRevisionId, dimensions);
      }
      this.ensuredIndexKeys.add(cacheKey);
    } finally {
      await queryRunner.release();
    }
  }

  private async resolveRevisionContext(profileName: string, revisionId?: string): Promise<RevisionContext> {
    const revision = revisionId
      ? await this.configurationService.getRevision(profileName, revisionId)
      : await this.configurationService.getActiveRevision(profileName);
    return {
      profileName,
      revisionId: revision.id,
      dataRevisionId: revision.dataRevisionId,
      configuration: revision.configuration,
    };
  }

  private resolveProvider(wiring: RagResolvedSourceWiring): RagSourceProvider {
    const cached = this.providerCache.get(wiring.name);
    if (cached) return cached;

    let provider: RagSourceProvider;
    if (wiring.kind === 'provider') {
      if (!wiring.provider) {
        throw new RagConfigurationError(`Source "${wiring.name}" is declared as a custom provider but none was resolved.`);
      }
      provider = wiring.provider;
    } else if (wiring.kind === 'entity') {
      provider = new EntitySourceProvider(
        wiring.name,
        this.dataSource,
        wiring.entity!,
        wiring.mapping!,
        wiring.filter,
        wiring.transform,
      );
    } else {
      provider = new TableSourceProvider(wiring.name, this.dataSource, wiring.table!, wiring.mapping!, wiring.filter);
    }
    this.providerCache.set(wiring.name, provider);
    return provider;
  }

  private async getBindingOrThrow(sourceName: string): Promise<RagSourceBindingRow> {
    const binding = await this.sourceBindingRepo.findOne({ where: { sourceName } });
    if (!binding) {
      throw new RagSourceNotFoundError(sourceName);
    }
    return binding;
  }
}
