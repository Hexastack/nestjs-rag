import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  RAG_CHUNK_EMBEDDING_REPOSITORY,
  RAG_CHUNK_REPOSITORY,
  RAG_DATA_SOURCE,
  RAG_DOCUMENT_REPOSITORY,
  RAG_INDEXING_SERVICE,
  RAG_PROFILE_REPOSITORY,
  RAG_PROFILE_REVISION_REPOSITORY,
  RAG_RESOLVED_OPTIONS,
  RAG_SCHEMA_SERVICE,
  RAG_SOURCE_BINDING_REPOSITORY,
} from '../constants';
import { RagChangeImpact, RagDatabaseType, RagOperationStatus, RagRevisionStatus } from '../enums';
import { RagChunkEmbeddingRow, RagChunkRow, RagDocumentRow, RagProfileRevisionRow, RagProfileRow, RagSourceBindingRow } from '../entities/rows';
import { RagSchemaService } from '../entities/rag-schema.service';
import {
  RagConfigurationError,
  RagConcurrencyError,
  RagProfileActivationError,
  RagProfileAlreadyExistsError,
  RagProfileNotFoundError,
  RagProfileRevisionError,
  RagReindexRequiredError,
  RagRevisionNotFoundError,
  RagSchemaChangeRequiredError,
  RagSourceConfigurationError,
  RagValidationError,
} from '../errors';
import { RagEventNames, RagProfileCreatedEvent, RagProfileRevisionEvent, RagProfileRolledBackEvent } from '../events/rag-events';
import {
  CreateRagProfileInput,
  RagConfigurationChangePreview,
  RagConfigurationUpdateResult,
  RagConfigurationValidationResult,
  UpdateRagProfileInput,
  UpdateRagProfileOptions,
} from '../interfaces/config-api.interface';
import { RagProfileConfiguration } from '../interfaces/profile.interface';
import { RagProfile, RagProfileRevision } from '../interfaces/revision.interface';
import { RagResolvedModuleContext } from '../module-context';
import { RagEmbeddingProviderRegistry } from '../providers/embedding-provider-registry';
import { analyzeConfigurationChange, RagChangeImpactResult } from './change-impact.analyzer';
import { rowToProfile, rowToRevision, serializeError } from './mappers';
import { applyProfilePatch, withProfileDefaults } from './patch-merge.util';
import { RagValidationContext, validateProfileConfigurationStructure } from './validate-configuration';
import { hashConfiguration } from '../utils/hash.util';
import { newId } from '../utils/id.util';
import { assertSafeName } from '../utils/identifier.util';
// Type-only import: erased at compile time, so this never creates a runtime
// require() cycle with the indexing module even though RagIndexingService
// itself depends on RagConfigurationService. Actual wiring goes through the
// RAG_INDEXING_SERVICE DI token (bound in RagModule), not a class import.
import type { RagIndexingService } from '../indexing/rag-indexing.service';
import { RagProfileReindexOptions, RagProfileReindexResult } from '../interfaces/reindex.interface';

/**
 * Public runtime configuration API (design doc section 6). Every mutating
 * method here is the *only* way operational RAG settings — embedding
 * provider/model/dimensions, chunking, hybrid weights, etc. — change after
 * the Nest application has booted. `RagModule.forRoot()` never carries any
 * of this; see the README's "Why active models are not configured in
 * forRoot" section.
 */
@Injectable()
export class RagConfigurationService {
  private readonly logger = new Logger(RagConfigurationService.name);

  constructor(
    @Inject(RAG_PROFILE_REPOSITORY) private readonly profileRepo: Repository<RagProfileRow>,
    @Inject(RAG_PROFILE_REVISION_REPOSITORY) private readonly revisionRepo: Repository<RagProfileRevisionRow>,
    @Inject(RAG_SOURCE_BINDING_REPOSITORY) private readonly sourceBindingRepo: Repository<RagSourceBindingRow>,
    @Inject(RAG_DOCUMENT_REPOSITORY) private readonly documentRepo: Repository<RagDocumentRow>,
    @Inject(RAG_CHUNK_REPOSITORY) private readonly chunkRepo: Repository<RagChunkRow>,
    @Inject(RAG_CHUNK_EMBEDDING_REPOSITORY) private readonly chunkEmbeddingRepo: Repository<RagChunkEmbeddingRow>,
    @Inject(RAG_DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(RAG_SCHEMA_SERVICE) private readonly schemaService: RagSchemaService,
    @Inject(RAG_RESOLVED_OPTIONS) private readonly context: RagResolvedModuleContext,
    private readonly embeddingRegistry: RagEmbeddingProviderRegistry,
    private readonly eventEmitter: EventEmitter2,
    // `RagIndexingService` depends back on `RagConfigurationService` (to
    // resolve active/pending revisions during indexing), so this pair is a
    // genuine circular provider dependency — `forwardRef` on *both* sides is
    // required or Nest's instantiation graph deadlocks instead of throwing
    // a clear error (a plain `@Inject(TOKEN)` without it hides the cycle
    // from Nest's usual circular-dependency detection, since that detector
    // works off constructor parameter *types*, not indirection tokens).
    @Inject(forwardRef(() => RAG_INDEXING_SERVICE))
    private readonly indexingService: RagIndexingService,
  ) {}

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async listProfiles(): Promise<RagProfile[]> {
    const rows = await this.profileRepo.find({ order: { name: 'ASC' } });
    return rows.map(rowToProfile);
  }

  async getProfile(profileName: string): Promise<RagProfile> {
    return rowToProfile(await this.findProfileRowOrThrow(profileName));
  }

  async getActiveRevision(profileName: string): Promise<RagProfileRevision> {
    const { revisionRow } = await this.loadActive(profileName);
    return rowToRevision(revisionRow);
  }

  async getRevision(profileName: string, revisionId: string): Promise<RagProfileRevision> {
    return rowToRevision(await this.findRevisionRowOrThrow(profileName, revisionId));
  }

  async listRevisions(profileName: string): Promise<RagProfileRevision[]> {
    const profileRow = await this.findProfileRowOrThrow(profileName);
    const rows = await this.revisionRepo.find({
      where: { profileId: profileRow.id },
      order: { revisionNumber: 'DESC' },
    });
    return rows.map(rowToRevision);
  }

  // ---------------------------------------------------------------------
  // Profile lifecycle
  // ---------------------------------------------------------------------

  async createProfile(input: CreateRagProfileInput): Promise<RagProfile> {
    assertSafeName(input.name, 'profile name');
    if (input.configuration.name !== input.name) {
      throw new RagValidationError([
        `configuration.name ("${input.configuration.name}") must match the profile name ("${input.name}").`,
      ]);
    }
    const existing = await this.profileRepo.findOne({ where: { name: input.name } });
    if (existing) {
      throw new RagProfileAlreadyExistsError(input.name);
    }

    const configuration = withProfileDefaults(input.configuration);
    const structural = validateProfileConfigurationStructure(configuration, this.validationContext());
    if (structural.errors.length > 0) {
      throw new RagValidationError(structural.errors);
    }
    await this.assertEmbeddingProviderValid(configuration);

    const profileId = newId();
    const revisionId = newId();
    const now = new Date();

    await this.dataSource.transaction(async (manager) => {
      await manager.save(this.profileRepo.target, {
        id: profileId,
        name: input.name,
        description: configuration.description ?? null,
        activeRevisionId: null,
        createdAt: now,
        updatedAt: now,
      });
      await manager.save(this.revisionRepo.target, {
        id: revisionId,
        profileId,
        profileName: input.name,
        revisionNumber: 1,
        status: RagRevisionStatus.ACTIVE,
        configuration,
        configurationHash: hashConfiguration(configuration),
        changeImpact: RagChangeImpact.NONE,
        previousRevisionId: null,
        error: null,
        createdAt: now,
        activatedAt: now,
        failedAt: null,
      });
      await manager.update(this.profileRepo.target, { id: profileId }, { activeRevisionId: revisionId });
    });

    const profile = await this.getProfile(input.name);
    const revision = await this.getRevision(input.name, revisionId);
    this.eventEmitter.emit(RagEventNames.PROFILE_CREATED, { profile } satisfies RagProfileCreatedEvent);
    this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_CREATED, {
      profileName: input.name,
      revision,
    } satisfies RagProfileRevisionEvent);
    this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_ACTIVATED, {
      profileName: input.name,
      revision,
    } satisfies RagProfileRevisionEvent);
    return profile;
  }

  async deleteProfile(profileName: string): Promise<void> {
    const profileRow = await this.findProfileRowOrThrow(profileName);
    const boundSources = await this.sourceBindingRepo.count({ where: { profileName } });
    if (boundSources > 0) {
      throw new RagSourceConfigurationError(
        `Cannot delete profile "${profileName}": ${boundSources} source(s) are still assigned to it. ` +
          `Reassign or remove them first via RagSourceConfigurationService.assignProfile.`,
      );
    }
    const revisions = await this.revisionRepo.find({ where: { profileId: profileRow.id } });
    await this.dataSource.transaction(async (manager) => {
      for (const rev of revisions) {
        await manager.delete(this.chunkEmbeddingRepo.target, { profileRevisionId: rev.id });
        await manager.delete(this.chunkRepo.target, { profileRevisionId: rev.id });
        await manager.delete(this.documentRepo.target, { profileRevisionId: rev.id });
        if (this.schemaService.isSqlite()) {
          await manager.query(
            `DELETE FROM "${this.schemaService.ftsTableName()}" WHERE profile_revision_id = ?`,
            [rev.id],
          );
        }
      }
      await manager.delete(this.revisionRepo.target, { profileId: profileRow.id });
      await manager.delete(this.profileRepo.target, { id: profileRow.id });
    });
    for (const rev of revisions) {
      await this.dropAuxiliaryIndexesFor(rev);
    }
  }

  // ---------------------------------------------------------------------
  // Validation & preview
  // ---------------------------------------------------------------------

  async validateProfile(input: RagProfileConfiguration): Promise<RagConfigurationValidationResult> {
    const structural = validateProfileConfigurationStructure(input, this.validationContext());
    const errors = [...structural.errors];
    const warnings = [...structural.warnings];
    if (input.retrieval?.embedding && this.embeddingRegistry.has(input.retrieval.embedding.providerId)) {
      try {
        await this.embeddingRegistry.validateConfiguration(input.retrieval.embedding);
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  async previewUpdate(profileName: string, patch: UpdateRagProfileInput): Promise<RagConfigurationChangePreview> {
    const { revisionRow } = await this.loadActive(profileName);
    const current = revisionRow.configuration as RagProfileConfiguration;
    const proposed = withProfileDefaults(applyProfilePatch(current, patch));
    const structural = validateProfileConfigurationStructure(proposed, this.validationContext());
    if (structural.errors.length > 0) {
      throw new RagValidationError(structural.errors);
    }
    const diff = analyzeConfigurationChange(current, proposed);
    const affectedSources =
      diff.impact === RagChangeImpact.NONE ? [] : await this.listAffectedSourceNames(profileName);
    return this.toPreview(profileName, revisionRow.id, proposed, diff, affectedSources);
  }

  // ---------------------------------------------------------------------
  // Update strategies
  // ---------------------------------------------------------------------

  async updateProfile(
    profileName: string,
    patch: UpdateRagProfileInput,
    options: UpdateRagProfileOptions,
  ): Promise<RagConfigurationUpdateResult> {
    const { profileRow, revisionRow: activeRow } = await this.loadActive(profileName);
    if (options.expectedRevisionId && options.expectedRevisionId !== profileRow.activeRevisionId) {
      throw new RagConcurrencyError(profileName, options.expectedRevisionId, profileRow.activeRevisionId ?? 'none');
    }

    const current = activeRow.configuration as RagProfileConfiguration;
    const proposed = withProfileDefaults(applyProfilePatch(current, patch));
    const structural = validateProfileConfigurationStructure(proposed, this.validationContext());
    if (structural.errors.length > 0) {
      throw new RagValidationError(structural.errors);
    }
    await this.assertEmbeddingProviderValid(proposed);

    const diff = analyzeConfigurationChange(current, proposed);
    const affectedSources =
      diff.impact === RagChangeImpact.NONE ? [] : await this.listAffectedSourceNames(profileName);
    const preview = this.toPreview(profileName, activeRow.id, proposed, diff, affectedSources);
    const strategy = options.applyStrategy;

    switch (strategy) {
      case 'validate-only': {
        const ephemeral = this.buildEphemeralRevision(profileName, activeRow, proposed, diff);
        return { profileName, strategy, preview, revision: ephemeral, activeRevision: rowToRevision(activeRow) };
      }

      case 'apply-immediately': {
        if (!diff.canApplyImmediately) {
          throw new RagReindexRequiredError(
            diff.reasons.length ? diff.reasons : ['The proposed change requires re-indexing.'],
          );
        }
        const newRevision = await this.applyImmediateRevision(profileRow, activeRow, proposed, diff);
        return { profileName, strategy, preview, revision: newRevision, activeRevision: newRevision };
      }

      case 'stage': {
        const staged = await this.createPendingRevision(profileRow, activeRow, proposed, diff);
        return { profileName, strategy, preview, revision: staged, activeRevision: rowToRevision(activeRow) };
      }

      case 'reindex-and-activate': {
        if (diff.canApplyImmediately) {
          const newRevision = await this.applyImmediateRevision(profileRow, activeRow, proposed, diff);
          return { profileName, strategy, preview, revision: newRevision, activeRevision: newRevision };
        }
        const staged = await this.createPendingRevision(profileRow, activeRow, proposed, diff);
        const reindexResult = await this.runReindexAndActivate(profileName, staged.id, options.reindex);
        const finalRevision = await this.getRevision(profileName, staged.id);
        const finalActive = await this.loadActive(profileName).then(({ revisionRow }) => rowToRevision(revisionRow));
        return { profileName, strategy, preview, revision: finalRevision, activeRevision: finalActive, reindexResult };
      }

      default:
        throw new RagValidationError([`Unknown apply strategy "${strategy}".`]);
    }
  }

  async activateRevision(profileName: string, revisionId: string): Promise<RagProfileRevision> {
    const profileRow = await this.findProfileRowOrThrow(profileName);
    const revisionRow = await this.findRevisionRowOrThrow(profileName, revisionId);

    if (revisionRow.status === RagRevisionStatus.ACTIVE) {
      return rowToRevision(revisionRow);
    }
    if (revisionRow.status !== RagRevisionStatus.READY && revisionRow.status !== RagRevisionStatus.ARCHIVED) {
      throw new RagProfileActivationError(
        `Revision "${revisionId}" cannot be activated from status "${revisionRow.status}". ` +
          `Only a "ready" revision (or a previously active "archived" one, for rollback) can be activated.`,
      );
    }

    // A revision archived by an `apply-immediately` update owns no index rows
    // of its own — they were bulk re-pointed to its successor. Rolling back to
    // it is still safe as long as every revision between it and the currently
    // active one is query-only: the active revision's rows are, by
    // construction, exactly the rows this revision indexed, so they can be
    // re-pointed back as part of activation.
    const repointFromRevisionId = await this.resolveRepointSource(profileRow, revisionRow);

    await this.validateIndexConsistency(revisionRow, repointFromRevisionId ?? revisionRow.id);

    const now = new Date();
    await this.dataSource.transaction(async (manager) => {
      if (repointFromRevisionId) {
        await this.repointIndexRows(manager, repointFromRevisionId, revisionId);
      }
      if (profileRow.activeRevisionId && profileRow.activeRevisionId !== revisionId) {
        await manager.update(
          this.revisionRepo.target,
          { id: profileRow.activeRevisionId },
          { status: RagRevisionStatus.ARCHIVED },
        );
      }
      await manager.update(
        this.revisionRepo.target,
        { id: revisionId },
        { status: RagRevisionStatus.ACTIVE, activatedAt: now },
      );
      await manager.update(this.profileRepo.target, { id: profileRow.id }, { activeRevisionId: revisionId, updatedAt: now });
    });
    if (repointFromRevisionId) {
      await this.repointPostgresIndexes(
        repointFromRevisionId,
        revisionId,
        revisionRow.configuration as RagProfileConfiguration,
      );
    }

    const updated = await this.getRevision(profileName, revisionId);
    this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_ACTIVATED, { profileName, revision: updated } satisfies RagProfileRevisionEvent);
    return updated;
  }

  async rollback(profileName: string, revisionId: string): Promise<RagProfileRevision> {
    const before = await this.profileRepo.findOne({ where: { name: profileName } });
    const target = await this.findRevisionRowOrThrow(profileName, revisionId);
    if (target.status !== RagRevisionStatus.ARCHIVED && target.status !== RagRevisionStatus.READY) {
      throw new RagProfileRevisionError(
        `Revision "${revisionId}" is not eligible for rollback (status: ${target.status}). ` +
          `Only a previously active (archived) or ready revision can be restored.`,
      );
    }
    const activated = await this.activateRevision(profileName, revisionId);
    this.eventEmitter.emit(RagEventNames.PROFILE_ROLLED_BACK, {
      profileName,
      fromRevisionId: before?.activeRevisionId ?? '',
      toRevisionId: revisionId,
    } satisfies RagProfileRolledBackEvent);
    return activated;
  }

  /**
   * Optional cleanup (design doc section 9): permanently deletes archived
   * revisions beyond `keep` (default 3, most-recent-first) along with their
   * documents/chunks/embeddings and any Postgres indexes created for them.
   * A purged revision can no longer be rolled back to — attempting to do so
   * surfaces a descriptive `RagRevisionNotFoundError`.
   */
  async cleanupArchivedRevisions(profileName: string, options: { keep?: number } = {}): Promise<{ deleted: string[] }> {
    const keep = options.keep ?? 3;
    const profileRow = await this.findProfileRowOrThrow(profileName);
    const archived = await this.revisionRepo.find({
      where: { profileId: profileRow.id, status: RagRevisionStatus.ARCHIVED },
      order: { revisionNumber: 'DESC' },
    });
    const toDelete = archived.slice(keep);
    const deleted: string[] = [];
    for (const rev of toDelete) {
      await this.dataSource.transaction(async (manager) => {
        await manager.delete(this.chunkEmbeddingRepo.target, { profileRevisionId: rev.id });
        await manager.delete(this.chunkRepo.target, { profileRevisionId: rev.id });
        await manager.delete(this.documentRepo.target, { profileRevisionId: rev.id });
        if (this.schemaService.isSqlite()) {
          await manager.query(
            `DELETE FROM "${this.schemaService.ftsTableName()}" WHERE profile_revision_id = ?`,
            [rev.id],
          );
        }
        await manager.delete(this.revisionRepo.target, { id: rev.id });
      });
      await this.dropAuxiliaryIndexesFor(rev);
      deleted.push(rev.id);
    }
    return { deleted };
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private toPreview(
    profileName: string,
    currentRevisionId: string | null,
    proposed: RagProfileConfiguration,
    diff: RagChangeImpactResult,
    affectedSources: string[],
  ): RagConfigurationChangePreview {
    return {
      profileName,
      currentRevisionId,
      proposedConfiguration: proposed,
      impact: diff.impact,
      changedPaths: diff.changedPaths,
      affectedSources,
      reasons: diff.reasons,
      canApplyImmediately: diff.canApplyImmediately,
    };
  }

  private buildEphemeralRevision(
    profileName: string,
    activeRow: RagProfileRevisionRow,
    proposed: RagProfileConfiguration,
    diff: RagChangeImpactResult,
  ): RagProfileRevision {
    return {
      id: `ephemeral-${newId()}`,
      profileName,
      revisionNumber: activeRow.revisionNumber + 1,
      status: RagRevisionStatus.DRAFT,
      configuration: proposed,
      configurationHash: hashConfiguration(proposed),
      changeImpact: diff.impact,
      createdAt: new Date(),
      previousRevisionId: activeRow.id,
    };
  }

  private async createPendingRevision(
    profileRow: RagProfileRow,
    previousRow: RagProfileRevisionRow,
    proposed: RagProfileConfiguration,
    diff: RagChangeImpactResult,
  ): Promise<RagProfileRevision> {
    const id = newId();
    const now = new Date();
    const revisionNumber = await this.nextRevisionNumber(profileRow.id);
    await this.revisionRepo.save({
      id,
      profileId: profileRow.id,
      profileName: profileRow.name,
      revisionNumber,
      status: RagRevisionStatus.PENDING,
      configuration: proposed,
      configurationHash: hashConfiguration(proposed),
      changeImpact: diff.impact,
      previousRevisionId: previousRow.id,
      error: null,
      createdAt: now,
      activatedAt: null,
      failedAt: null,
    });
    const revision = await this.getRevision(profileRow.name, id);
    this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_CREATED, {
      profileName: profileRow.name,
      revision,
    } satisfies RagProfileRevisionEvent);
    return revision;
  }

  /**
   * Implements the "apply-immediately" fast path for query-only changes: no
   * chunk or embedding regenerates. A new, immutable revision row is created
   * (preserving the "revisions are immutable" invariant for the *previous*
   * revision's frozen configuration snapshot), and the existing index rows
   * are re-pointed to it in a single bulk UPDATE per table — far cheaper
   * than re-chunking/re-embedding, and correct because, by construction,
   * only query-only paths (topK, RRF weights, retrieval mode, ...) changed.
   */
  private async applyImmediateRevision(
    profileRow: RagProfileRow,
    activeRow: RagProfileRevisionRow,
    proposed: RagProfileConfiguration,
    diff: RagChangeImpactResult,
  ): Promise<RagProfileRevision> {
    const newRevisionId = newId();
    const now = new Date();
    const nextNumber = await this.nextRevisionNumber(profileRow.id);

    await this.dataSource.transaction(async (manager) => {
      await manager.save(this.revisionRepo.target, {
        id: newRevisionId,
        profileId: profileRow.id,
        profileName: profileRow.name,
        revisionNumber: nextNumber,
        status: RagRevisionStatus.ACTIVE,
        configuration: proposed,
        configurationHash: hashConfiguration(proposed),
        changeImpact: diff.impact,
        previousRevisionId: activeRow.id,
        error: null,
        createdAt: now,
        activatedAt: now,
        failedAt: null,
      });
      await this.repointIndexRows(manager, activeRow.id, newRevisionId);
      await manager.update(this.revisionRepo.target, { id: activeRow.id }, { status: RagRevisionStatus.ARCHIVED });
      await manager.update(this.profileRepo.target, { id: profileRow.id }, { activeRevisionId: newRevisionId, updatedAt: now });
    });

    await this.repointPostgresIndexes(activeRow.id, newRevisionId, proposed);

    const revision = await this.getRevision(profileRow.name, newRevisionId);
    this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_CREATED, {
      profileName: profileRow.name,
      revision,
    } satisfies RagProfileRevisionEvent);
    this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_ACTIVATED, {
      profileName: profileRow.name,
      revision,
    } satisfies RagProfileRevisionEvent);
    return revision;
  }

  private async runReindexAndActivate(
    profileName: string,
    revisionId: string,
    reindexOptions?: RagProfileReindexOptions,
  ): Promise<RagProfileReindexResult> {
    await this.setRevisionStatus(revisionId, RagRevisionStatus.INDEXING);
    this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_INDEXING, {
      profileName,
      revision: await this.getRevision(profileName, revisionId),
    } satisfies RagProfileRevisionEvent);

    let result: RagProfileReindexResult;
    try {
      result = await this.indexingService.reindexRevision(profileName, revisionId, reindexOptions);
    } catch (error) {
      await this.markRevisionFailed(revisionId, error);
      return {
        profileName,
        revisionId,
        status: RagOperationStatus.FAILED,
        sources: [],
        documentsIndexed: 0,
        chunksCreated: 0,
        embeddingsCreated: 0,
        failures: 1,
        readyForActivation: false,
      };
    }

    if (result.status === RagOperationStatus.FAILED || !result.readyForActivation) {
      await this.markRevisionFailed(revisionId, new Error('Re-index did not produce a ready index.'));
      return result;
    }

    await this.setRevisionStatus(revisionId, RagRevisionStatus.READY);
    this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_READY, {
      profileName,
      revision: await this.getRevision(profileName, revisionId),
    } satisfies RagProfileRevisionEvent);

    await this.activateRevision(profileName, revisionId);
    return result;
  }

  /**
   * `dataRevisionId` is the revision whose rows will actually serve searches
   * after activation — it differs from `revisionRow.id` only during a
   * rollback that re-points rows back from a query-only successor.
   */
  private async validateIndexConsistency(
    revisionRow: RagProfileRevisionRow,
    dataRevisionId: string = revisionRow.id,
  ): Promise<void> {
    const configuration = revisionRow.configuration as RagProfileConfiguration;
    if (!configuration.retrieval.embedding) return;

    const [chunkCount, embeddingCount] = await Promise.all([
      this.chunkRepo.count({ where: { profileRevisionId: dataRevisionId } }),
      this.chunkEmbeddingRepo.count({ where: { profileRevisionId: dataRevisionId } }),
    ]);
    if (chunkCount !== embeddingCount) {
      throw new RagProfileActivationError(
        `Revision "${revisionRow.id}" has ${chunkCount} chunk(s) but ${embeddingCount} embedding(s); ` +
          `refusing to activate an inconsistent index.`,
      );
    }

    if (this.context.dbType === RagDatabaseType.POSTGRES) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        const hasExtension = await this.schemaService.hasVectorExtension(queryRunner);
        if (!hasExtension) {
          throw new RagSchemaChangeRequiredError([
            'The "vector" Postgres extension is not installed, but this revision enables embedding retrieval. ' +
              'Enable `schema.createVectorExtension: true` in RagModule.forRoot() and run the ' +
              'AddPgvectorSupport migration, or ask a database administrator to run "CREATE EXTENSION vector;".',
          ]);
        }
      } finally {
        await queryRunner.release();
      }
    }
  }

  /**
   * Determines whether activating `targetRow` requires re-pointing index rows
   * back from the currently active revision (rollback across a query-only
   * lineage — the inverse of `applyImmediateRevision`'s bulk re-point).
   * Returns the revision id to re-point from, or `null` when the target owns
   * its rows (or the lineage isn't provably query-only, in which case the
   * normal consistency validation decides).
   */
  private async resolveRepointSource(
    profileRow: RagProfileRow,
    targetRow: RagProfileRevisionRow,
  ): Promise<string | null> {
    const activeId = profileRow.activeRevisionId;
    if (!activeId || activeId === targetRow.id) return null;
    const targetDocuments = await this.documentRepo.count({ where: { profileRevisionId: targetRow.id } });
    if (targetDocuments > 0) return null;
    const activeDocuments = await this.documentRepo.count({ where: { profileRevisionId: activeId } });
    if (activeDocuments === 0) return null;

    // Walk the previous-revision chain from the active revision back to the
    // target. Every revision on the way (including the active one, excluding
    // the target) must be a query-only change, otherwise the active rows were
    // built under a different indexing configuration and cannot serve the
    // target revision.
    let cursor: RagProfileRevisionRow | null = await this.revisionRepo.findOne({ where: { id: activeId } });
    for (let hops = 0; cursor && hops < 1000; hops += 1) {
      const impact = cursor.changeImpact as RagChangeImpact;
      if (impact !== RagChangeImpact.NONE && impact !== RagChangeImpact.QUERY_ONLY) return null;
      if (cursor.previousRevisionId === targetRow.id) return activeId;
      cursor = cursor.previousRevisionId
        ? await this.revisionRepo.findOne({ where: { id: cursor.previousRevisionId } })
        : null;
    }
    return null;
  }

  /**
   * Bulk re-points every index row (documents, chunks, embeddings, and the
   * SQLite FTS rows) from one revision to another, inside the caller's
   * transaction — so a crash can never leave the FTS index pointing at a
   * revision the relational rows have already left.
   */
  private async repointIndexRows(
    manager: EntityManager,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<void> {
    await manager.update(this.documentRepo.target, { profileRevisionId: fromRevisionId }, { profileRevisionId: toRevisionId });
    await manager.update(this.chunkRepo.target, { profileRevisionId: fromRevisionId }, { profileRevisionId: toRevisionId });
    await manager.update(this.chunkEmbeddingRepo.target, { profileRevisionId: fromRevisionId }, { profileRevisionId: toRevisionId });
    if (this.schemaService.isSqlite()) {
      await manager.query(
        `UPDATE "${this.schemaService.ftsTableName()}" SET profile_revision_id = ? WHERE profile_revision_id = ?`,
        [toRevisionId, fromRevisionId],
      );
    }
  }

  /** Postgres-only follow-up to `repointIndexRows`: swap the per-revision partial indexes. Best-effort DDL, so it runs after the row transaction commits. */
  private async repointPostgresIndexes(
    oldRevisionId: string,
    newRevisionId: string,
    configuration: RagProfileConfiguration,
  ): Promise<void> {
    if (!this.schemaService.isPostgres()) return;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const language = configuration.retrieval.lexical?.language ?? 'simple';
      await this.schemaService.ensureLexicalIndexForRevision(queryRunner, newRevisionId, language);
      await this.schemaService.dropIndexIfExists(queryRunner, this.schemaService.lexicalIndexName(oldRevisionId, language));

      if (configuration.retrieval.embedding) {
        const dims = configuration.retrieval.embedding.dimensions;
        await this.schemaService.ensureVectorIndexForRevision(queryRunner, newRevisionId, dims);
        await this.schemaService.dropIndexIfExists(queryRunner, this.schemaService.vectorIndexName(oldRevisionId, dims));
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async dropAuxiliaryIndexesFor(revisionRow: RagProfileRevisionRow): Promise<void> {
    if (!this.schemaService.isPostgres()) return;
    const configuration = revisionRow.configuration as RagProfileConfiguration;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      const language = configuration.retrieval.lexical?.language ?? 'simple';
      await this.schemaService.dropIndexIfExists(queryRunner, this.schemaService.lexicalIndexName(revisionRow.id, language));
      if (configuration.retrieval.embedding) {
        await this.schemaService.dropIndexIfExists(
          queryRunner,
          this.schemaService.vectorIndexName(revisionRow.id, configuration.retrieval.embedding.dimensions),
        );
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async markRevisionFailed(revisionId: string, error: unknown): Promise<void> {
    await this.revisionRepo.update(
      { id: revisionId },
      { status: RagRevisionStatus.FAILED, failedAt: new Date(), error: serializeError(error) },
    );
    const row = await this.revisionRepo.findOne({ where: { id: revisionId } });
    if (row) {
      this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_FAILED, {
        profileName: row.profileName,
        revision: rowToRevision(row),
      } satisfies RagProfileRevisionEvent);
    }
    this.logger.warn(`Revision "${revisionId}" failed: ${(error as Error)?.message ?? error}`);
  }

  private async setRevisionStatus(revisionId: string, status: RagRevisionStatus): Promise<void> {
    await this.revisionRepo.update({ id: revisionId }, { status });
  }

  private async nextRevisionNumber(profileId: string): Promise<number> {
    const raw = await this.revisionRepo
      .createQueryBuilder('r')
      .select('MAX(r.revisionNumber)', 'max')
      .where('r.profileId = :profileId', { profileId })
      .getRawOne<{ max: number | string | null }>();
    const max = raw?.max ? Number(raw.max) : 0;
    return max + 1;
  }

  private async listAffectedSourceNames(profileName: string): Promise<string[]> {
    const rows = await this.sourceBindingRepo.find({ where: { profileName } });
    return rows.map((r) => r.sourceName);
  }

  private async assertEmbeddingProviderValid(configuration: RagProfileConfiguration): Promise<void> {
    if (!configuration.retrieval.embedding) return;
    try {
      await this.embeddingRegistry.validateConfiguration(configuration.retrieval.embedding);
    } catch (error) {
      throw new RagConfigurationError((error as Error).message);
    }
  }

  private validationContext(): RagValidationContext {
    return {
      dbType: this.context.dbType,
      vectorColumnEnabled: this.context.vectorColumnEnabled,
      registry: this.embeddingRegistry,
    };
  }

  private async loadActive(profileName: string): Promise<{ profileRow: RagProfileRow; revisionRow: RagProfileRevisionRow }> {
    const profileRow = await this.findProfileRowOrThrow(profileName);
    if (!profileRow.activeRevisionId) {
      throw new RagProfileRevisionError(`Profile "${profileName}" has no active revision.`);
    }
    const revisionRow = await this.revisionRepo.findOne({ where: { id: profileRow.activeRevisionId } });
    if (!revisionRow) {
      throw new RagRevisionNotFoundError(profileName, profileRow.activeRevisionId);
    }
    return { profileRow, revisionRow };
  }

  private async findProfileRowOrThrow(profileName: string): Promise<RagProfileRow> {
    const row = await this.profileRepo.findOne({ where: { name: profileName } });
    if (!row) {
      throw new RagProfileNotFoundError(profileName);
    }
    return row;
  }

  private async findRevisionRowOrThrow(profileName: string, revisionId: string): Promise<RagProfileRevisionRow> {
    const row = await this.revisionRepo.findOne({ where: { id: revisionId } });
    if (!row || row.profileName !== profileName) {
      throw new RagRevisionNotFoundError(profileName, revisionId);
    }
    return row;
  }
}
