import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
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

  /**
   * Internal indexing hook: validates a write target while holding the
   * profile row lock and advances the serving corpus generation in the same
   * transaction for active writes. Staged-revision writes remain isolated
   * and do not affect the active generation.
   */
  async guardRevisionWrite(
    manager: EntityManager,
    target: {
      profileName: string;
      revisionId: string;
      dataRevisionId: string;
      resolution: 'active' | 'pinned';
    },
  ): Promise<void> {
    const profileLock = this.schemaService.isPostgres() ? ({ mode: 'pessimistic_write' } as const) : undefined;
    const profile = await manager.findOne<RagProfileRow>(this.profileRepo.target, {
      where: { name: target.profileName },
      ...(profileLock ? { lock: profileLock } : {}),
    });
    const targetsActiveRevision =
      target.resolution === 'active' || (!!profile && profile.activeRevisionId === target.revisionId);

    if (targetsActiveRevision) {
      if (!profile || profile.activeRevisionId !== target.revisionId) {
        throw new RagConcurrencyError(
          target.profileName,
          target.revisionId,
          profile?.activeRevisionId ?? 'none',
        );
      }
      const activeRow = await manager.findOne<RagProfileRevisionRow>(this.revisionRepo.target, {
        where: { id: target.revisionId, status: RagRevisionStatus.ACTIVE },
      });
      if (!activeRow || activeRow.dataRevisionId !== target.dataRevisionId) {
        throw new RagConcurrencyError(
          target.profileName,
          target.revisionId,
          activeRow?.id ?? profile.activeRevisionId ?? 'none',
        );
      }
      const bumped = await manager.update(
        this.profileRepo.target,
        {
          id: profile.id,
          activeRevisionId: target.revisionId,
          indexGeneration: profile.indexGeneration,
        },
        {
          indexGeneration: profile.indexGeneration + 1,
          updatedAt: new Date(),
        },
      );
      if (!bumped.affected) {
        throw new RagConcurrencyError(target.profileName, target.revisionId, 'changed-during-write');
      }
      return;
    }

    const revisionLock = this.schemaService.isPostgres() ? ({ mode: 'pessimistic_read' } as const) : undefined;
    const row = await manager.findOne<RagProfileRevisionRow>(this.revisionRepo.target, {
      where: { id: target.revisionId },
      ...(revisionLock ? { lock: revisionLock } : {}),
    });
    if (
      !row ||
      row.dataRevisionId !== target.dataRevisionId ||
      row.status === RagRevisionStatus.ARCHIVED ||
      row.status === RagRevisionStatus.FAILED
    ) {
      throw new RagProfileRevisionError(
        `Revision "${target.revisionId}" of profile "${target.profileName}" changed concurrently and is no longer a valid write target.`,
        {
          profileName: target.profileName,
          revisionId: target.revisionId,
          status: row?.status ?? null,
        },
      );
    }
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
        indexGeneration: 0,
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
        dataRevisionId: revisionId,
        sourceIndexGeneration: null,
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
        await this.deleteRevisionIndexRows(manager, rev.id);
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
    const { preview } = await this.prepareChange(profileName, patch);
    return preview;
  }

  // ---------------------------------------------------------------------
  // Update strategies
  // ---------------------------------------------------------------------

  /**
   * Applies a deep-partial `patch` to the profile's active configuration
   * under one of four strategies:
   *
   * - `validate-only` — validate and classify the change; persist nothing.
   * - `apply-immediately` — only for query-only changes: creates and
   *   activates a new revision with an independent copy of the current index
   *   snapshot (throws `RagReindexRequiredError` otherwise).
   * - `stage` — persists a `pending` revision to be re-indexed later.
   * - `reindex-and-activate` — stages, re-indexes, and activates in one
   *   call (falling back to the immediate path when no re-index is needed).
   *
   * Pass `options.expectedRevisionId` for optimistic concurrency control:
   * the update fails with `RagConcurrencyError` if another writer activated
   * a different revision in the meantime. The early check below fails fast,
   * but the guarantee comes from the write transactions themselves: every
   * pointer flip is a conditional update (compare-and-swap) on the revision
   * the change was prepared against, so a writer racing past the check
   * still cannot apply against a stale revision.
   */
  async updateProfile(
    profileName: string,
    patch: UpdateRagProfileInput,
    options: UpdateRagProfileOptions,
  ): Promise<RagConfigurationUpdateResult> {
    const { profileRow, activeRow, proposed, diff, preview } = await this.prepareChange(profileName, patch);
    if (options.expectedRevisionId && options.expectedRevisionId !== profileRow.activeRevisionId) {
      throw new RagConcurrencyError(profileName, options.expectedRevisionId, profileRow.activeRevisionId ?? 'none');
    }
    await this.assertEmbeddingProviderValid(proposed);

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

  /**
   * Atomically switches the profile's active revision to `revisionId`
   * (which must be `ready`, or `archived` for a rollback), archiving the
   * previously active one. Refuses to activate an index whose chunk and
   * embedding counts are inconsistent, or one that needs the missing
   * pgvector extension.
   */
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

    await this.validateIndexConsistency(revisionRow);

    const now = new Date();
    const expectedActiveId = profileRow.activeRevisionId;
    const expectedGeneration = profileRow.indexGeneration;
    if (revisionRow.status === RagRevisionStatus.READY && revisionRow.previousRevisionId !== expectedActiveId) {
      throw new RagProfileActivationError(
        `Revision "${revisionId}" was prepared from revision "${revisionRow.previousRevisionId ?? 'none'}", but ` +
          `profile "${profileName}" now serves revision "${expectedActiveId ?? 'none'}". Create a new staged update ` +
          `from the current configuration instead of activating this stale patch.`,
      );
    }
    if (
      revisionRow.status === RagRevisionStatus.READY &&
      (revisionRow.sourceIndexGeneration === null ||
        revisionRow.sourceIndexGeneration !== expectedGeneration)
    ) {
      throw new RagProfileActivationError(
        `Revision "${revisionId}" was indexed at corpus generation ` +
          `"${revisionRow.sourceIndexGeneration ?? 'unknown'}", but profile "${profileName}" is now at generation ` +
          `"${expectedGeneration}". Re-index the staged revision again before activation.`,
      );
    }
    await this.dataSource.transaction(async (manager) => {
      // Compare-and-swap: only flip the pointer if it still is what we
      // loaded above — the status/consistency checks ran against that
      // snapshot, and a concurrent writer may have activated another
      // revision since. `affected` 0 rolls the whole activation back.
      // The profile row mirrors the *active* revision's description (it is
      // what getProfile()/listProfiles() serve), so every pointer flip —
      // activation and rollback alike — must carry it along.
      const flip = await manager.update(
        this.profileRepo.target,
        {
          id: profileRow.id,
          activeRevisionId: expectedActiveId ?? IsNull(),
          indexGeneration: expectedGeneration,
        },
        {
          activeRevisionId: revisionId,
          description: (revisionRow.configuration as RagProfileConfiguration).description ?? null,
          indexGeneration: expectedGeneration + 1,
          updatedAt: now,
        },
      );
      if (!flip.affected) {
        const fresh = await manager.findOne(this.profileRepo.target, { where: { id: profileRow.id } });
        if (fresh?.activeRevisionId === expectedActiveId && fresh.indexGeneration !== expectedGeneration) {
          throw new RagProfileActivationError(
            `Revision "${revisionId}" became stale because profile "${profileName}" changed from corpus generation ` +
              `"${expectedGeneration}" to "${fresh.indexGeneration}" during activation. Re-index it again.`,
          );
        }
        throw new RagConcurrencyError(profileName, expectedActiveId ?? 'none', fresh?.activeRevisionId ?? 'none');
      }
      // Archive before activating so the one-active-per-profile partial
      // unique index is never transiently violated; the ACTIVE predicate
      // makes the archive a no-op if the row already left that status.
      if (expectedActiveId && expectedActiveId !== revisionId) {
        await manager.update(
          this.revisionRepo.target,
          { id: expectedActiveId, status: RagRevisionStatus.ACTIVE },
          { status: RagRevisionStatus.ARCHIVED },
        );
      }
      // Re-assert eligibility at write time: the pre-transaction status
      // check ran on a snapshot, and e.g. a concurrent re-index may have
      // moved the revision back out of `ready` since.
      const activated = await manager.update(
        this.revisionRepo.target,
        { id: revisionId, status: In([RagRevisionStatus.READY, RagRevisionStatus.ARCHIVED]) },
        { status: RagRevisionStatus.ACTIVE, activatedAt: now },
      );
      if (!activated.affected) {
        throw new RagProfileActivationError(
          `Revision "${revisionId}" changed status concurrently and is no longer eligible for activation.`,
        );
      }
    });

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
      // New revisions own their snapshots, but retain this reference guard
      // defensively for databases imported from a pre-release schema.
      const referencedBy = await this.revisionRepo
        .createQueryBuilder('r')
        .where('r.dataRevisionId = :id', { id: rev.id })
        .andWhere('r.id != :id', { id: rev.id })
        .getCount();
      if (referencedBy > 0) {
        continue;
      }
      await this.dataSource.transaction(async (manager) => {
        await this.deleteRevisionIndexRows(manager, rev.id);
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

  /**
   * Shared front half of `previewUpdate` and `updateProfile`: applies the
   * patch to the active revision's configuration, validates the result
   * structurally (throwing `RagValidationError` on failure), and classifies
   * the change's impact. Performs no writes and no provider-side validation.
   */
  private async prepareChange(
    profileName: string,
    patch: UpdateRagProfileInput,
  ): Promise<{
    profileRow: RagProfileRow;
    activeRow: RagProfileRevisionRow;
    proposed: RagProfileConfiguration;
    diff: RagChangeImpactResult;
    preview: RagConfigurationChangePreview;
  }> {
    const { profileRow, revisionRow: activeRow } = await this.loadActive(profileName);
    const current = activeRow.configuration as RagProfileConfiguration;
    const proposed = withProfileDefaults(applyProfilePatch(current, patch));
    const structural = validateProfileConfigurationStructure(proposed, this.validationContext());
    if (structural.errors.length > 0) {
      throw new RagValidationError(structural.errors);
    }
    const diff = analyzeConfigurationChange(current, proposed);
    const affectedSources =
      diff.impact === RagChangeImpact.NONE ? [] : await this.listAffectedSourceNames(profileName);
    const preview = this.toPreview(profileName, activeRow.id, proposed, diff, affectedSources);
    return { profileRow, activeRow, proposed, diff, preview };
  }

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
    const id = `ephemeral-${newId()}`;
    return {
      id,
      profileName,
      revisionNumber: activeRow.revisionNumber + 1,
      status: RagRevisionStatus.DRAFT,
      configuration: proposed,
      configurationHash: hashConfiguration(proposed),
      changeImpact: diff.impact,
      createdAt: new Date(),
      previousRevisionId: activeRow.id,
      dataRevisionId: id,
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
    await this.dataSource.transaction(async (manager) => {
      const lock = this.schemaService.isPostgres() ? ({ mode: 'pessimistic_write' } as const) : undefined;
      const currentProfile = await manager.findOne<RagProfileRow>(this.profileRepo.target, {
        where: { id: profileRow.id },
        ...(lock ? { lock } : {}),
      });
      if (!currentProfile || currentProfile.activeRevisionId !== previousRow.id) {
        throw new RagConcurrencyError(
          profileRow.name,
          previousRow.id,
          currentProfile?.activeRevisionId ?? 'none',
        );
      }
      const revisionNumber = await this.nextRevisionNumber(profileRow.id, manager);
      await manager.save(this.revisionRepo.target, {
        id,
        profileId: profileRow.id,
        profileName: profileRow.name,
        revisionNumber,
        status: RagRevisionStatus.PENDING,
        configuration: proposed,
        configurationHash: hashConfiguration(proposed),
        changeImpact: diff.impact,
        previousRevisionId: previousRow.id,
        dataRevisionId: id,
        sourceIndexGeneration: null,
        error: null,
        createdAt: now,
        activatedAt: null,
        failedAt: null,
      });
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
   * chunking or embedding provider calls are repeated, but the physical rows
   * are cloned under the new revision id. Each archived revision therefore
   * remains an immutable corpus snapshot and rollback restores exactly what
   * that revision served.
   */
  private async applyImmediateRevision(
    profileRow: RagProfileRow,
    activeRow: RagProfileRevisionRow,
    proposed: RagProfileConfiguration,
    diff: RagChangeImpactResult,
  ): Promise<RagProfileRevision> {
    const newRevisionId = newId();
    const now = new Date();

    await this.dataSource.transaction(async (manager) => {
      const nextNumber = await this.nextRevisionNumber(profileRow.id, manager);
      // Compare-and-swap: the pointer flip only succeeds if the active
      // revision is still the one this change was prepared (and, when
      // provided, `expectedRevisionId`-checked) against. A concurrent writer
      // that activated another revision in the meantime makes `affected` 0,
      // rolling everything back instead of applying a patch computed from a
      // stale configuration.
      // Mirror the newly active configuration's description onto the profile
      // row — description-only changes are NONE-impact and land exactly here,
      // and getProfile() serves the row's copy.
      const flip = await manager.update(
        this.profileRepo.target,
        {
          id: profileRow.id,
          activeRevisionId: activeRow.id,
          indexGeneration: profileRow.indexGeneration,
        },
        {
          activeRevisionId: newRevisionId,
          description: proposed.description ?? null,
          indexGeneration: profileRow.indexGeneration + 1,
          updatedAt: now,
        },
      );
      if (!flip.affected) {
        const fresh = await manager.findOne(this.profileRepo.target, { where: { id: profileRow.id } });
        throw new RagConcurrencyError(profileRow.name, activeRow.id, fresh?.activeRevisionId ?? 'none');
      }
      // Archive before inserting the new ACTIVE row so the one-active-per-
      // profile partial unique index is never transiently violated. The
      // status predicate keeps this from stomping a row some other state
      // transition already moved out of ACTIVE.
      await manager.update(
        this.revisionRepo.target,
        { id: activeRow.id, status: RagRevisionStatus.ACTIVE },
        { status: RagRevisionStatus.ARCHIVED },
      );
      await this.cloneRevisionIndexRows(manager, activeRow.dataRevisionId, newRevisionId);
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
        dataRevisionId: newRevisionId,
        sourceIndexGeneration: null,
        error: null,
        createdAt: now,
        activatedAt: now,
        failedAt: null,
      });
    });
    await this.ensureAuxiliaryIndexesFor(newRevisionId, proposed);

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

  /**
   * Re-indexes a staged revision and drives its status lifecycle:
   * `pending → indexing → ready` on success, `→ failed` otherwise — without
   * activating it. This is what makes the manual staged workflow
   * (`stage` → re-index → `activateRevision`) possible: `activateRevision`
   * only accepts a `ready` (or `archived`) revision, and the raw
   * `RagIndexingService.reindexRevision` never touches revision status.
   * `RagService.reindexRevision` delegates here.
   *
   * Revisions in a staged lifecycle state (`pending`, `ready`, `failed`) are
   * transitioned. Retrying a ready/failed revision first clears its candidate
   * rows, so the rebuilt snapshot cannot retain stale records. An active
   * revision is re-indexed as-is and its status is never corrupted.
   *
   * Throws whatever the re-index throws (after marking the revision
   * `failed`); a re-index that completes but does not produce a ready index
   * resolves with the result and marks the revision `failed`.
   */
  async reindexStagedRevision(
    profileName: string,
    revisionId: string,
    options?: RagProfileReindexOptions,
  ): Promise<RagProfileReindexResult> {
    const revisionRow = await this.findRevisionRowOrThrow(profileName, revisionId);
    const staged =
      revisionRow.status === RagRevisionStatus.PENDING ||
      revisionRow.status === RagRevisionStatus.READY ||
      revisionRow.status === RagRevisionStatus.FAILED;

    if (staged) {
      await this.beginStagedReindex(revisionRow);
      this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_INDEXING, {
        profileName,
        revision: await this.getRevision(profileName, revisionId),
      } satisfies RagProfileRevisionEvent);
    }

    let result: RagProfileReindexResult;
    try {
      result = await this.indexingService.reindexRevision(profileName, revisionId, options);
    } catch (error) {
      if (staged) {
        await this.markRevisionFailed(revisionId, error);
      }
      throw error;
    }

    if (!staged) {
      return result;
    }

    if (result.status === RagOperationStatus.FAILED || !result.readyForActivation) {
      await this.markRevisionFailed(revisionId, new Error('Re-index did not produce a ready index.'));
      return result;
    }

    const currentRevision = await this.findRevisionRowOrThrow(profileName, revisionId);
    const markedReady = await this.completeStagedReindex(currentRevision);
    if (!markedReady) {
      const error = new RagProfileActivationError(
        `Revision "${revisionId}" finished indexing after its source corpus changed. Its candidate index was ` +
          `discarded; retry it if the active revision is unchanged, or create a new staged update if the active ` +
          `configuration changed.`,
      );
      await this.markRevisionFailed(revisionId, error);
      return {
        ...result,
        status: RagOperationStatus.FAILED,
        failures: result.failures + 1,
        readyForActivation: false,
      };
    }
    this.eventEmitter.emit(RagEventNames.PROFILE_REVISION_READY, {
      profileName,
      revision: await this.getRevision(profileName, revisionId),
    } satisfies RagProfileRevisionEvent);
    return result;
  }

  /**
   * Convenience over `reindexStagedRevision`: finds the newest staged
   * (`pending`/`ready`/`failed`) revision and re-indexes it.
   * `RagService.reindexProfile` delegates here.
   */
  async reindexStagedProfile(profileName: string, options?: RagProfileReindexOptions): Promise<RagProfileReindexResult> {
    const revisions = await this.listRevisions(profileName);
    const target = revisions.find(
      (r) =>
        r.status === RagRevisionStatus.PENDING ||
        r.status === RagRevisionStatus.READY ||
        r.status === RagRevisionStatus.FAILED,
    );
    if (!target) {
      throw new RagValidationError([
        `Profile "${profileName}" has no staged revision to re-index. Call updateProfile(..., { applyStrategy: 'stage' }) ` +
          `first, or use "reindex-and-activate" which stages and re-indexes in one call.`,
      ]);
    }
    return this.reindexStagedRevision(profileName, target.id, options);
  }

  private async runReindexAndActivate(
    profileName: string,
    revisionId: string,
    reindexOptions?: RagProfileReindexOptions,
  ): Promise<RagProfileReindexResult> {
    let result: RagProfileReindexResult;
    try {
      result = await this.reindexStagedRevision(profileName, revisionId, reindexOptions);
    } catch {
      // reindexStagedRevision already marked the revision failed;
      // `updateProfile` resolves (not rejects) on re-index failure so callers
      // can inspect `result.revision.status` and `result.reindexResult`.
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
      return result;
    }

    await this.activateRevision(profileName, revisionId);
    return result;
  }

  /**
   * Validates the index a revision would serve after activation. Counts run
   * against the revision's *data* revision — the revision whose physical
   * rows it serves, which differs from its own id for query-only revisions.
   */
  private async validateIndexConsistency(revisionRow: RagProfileRevisionRow): Promise<void> {
    const dataRevisionId = revisionRow.dataRevisionId;
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
   * Permanently deletes every index row (documents, chunks, embeddings, and
   * the SQLite FTS rows) one revision owns, inside the caller's transaction.
   * Shared by `deleteProfile` and `cleanupArchivedRevisions`; the caller is
   * responsible for deleting the revision row itself and for dropping any
   * Postgres indexes afterwards (`dropAuxiliaryIndexesFor`).
   */
  private async deleteRevisionIndexRows(manager: EntityManager, revisionId: string): Promise<void> {
    await manager.delete(this.chunkEmbeddingRepo.target, { profileRevisionId: revisionId });
    await manager.delete(this.chunkRepo.target, { profileRevisionId: revisionId });
    await manager.delete(this.documentRepo.target, { profileRevisionId: revisionId });
    if (this.schemaService.isSqlite()) {
      await manager.query(
        `DELETE FROM "${this.schemaService.ftsTableName()}" WHERE profile_revision_id = ?`,
        [revisionId],
      );
    }
  }

  /** Clones one immutable physical index snapshot without re-chunking or re-embedding. */
  private async cloneRevisionIndexRows(
    manager: EntityManager,
    sourceDataRevisionId: string,
    targetDataRevisionId: string,
  ): Promise<void> {
    const documents = await manager.find<RagDocumentRow>(this.documentRepo.target, {
      where: { profileRevisionId: sourceDataRevisionId },
    });
    if (documents.length === 0) return;

    const chunks = await manager.find<RagChunkRow>(this.chunkRepo.target, {
      where: { profileRevisionId: sourceDataRevisionId },
    });
    const embeddings = await manager.find<RagChunkEmbeddingRow>(this.chunkEmbeddingRepo.target, {
      where: { profileRevisionId: sourceDataRevisionId },
    });
    const documentIds = new Map(documents.map((document) => [document.id, newId()]));
    const chunkIds = new Map(chunks.map((chunk) => [chunk.id, newId()]));

    const clonedDocuments: RagDocumentRow[] = documents.map((document) => ({
      ...document,
      id: documentIds.get(document.id)!,
      profileRevisionId: targetDataRevisionId,
    }));
    const clonedChunks: RagChunkRow[] = chunks.map((chunk) => ({
      ...chunk,
      id: chunkIds.get(chunk.id)!,
      profileRevisionId: targetDataRevisionId,
      documentId: documentIds.get(chunk.documentId)!,
    }));
    const clonedEmbeddings: RagChunkEmbeddingRow[] = embeddings.map((embedding) => ({
      ...embedding,
      id: newId(),
      profileRevisionId: targetDataRevisionId,
      chunkId: chunkIds.get(embedding.chunkId)!,
      embedding: Array.isArray(embedding.embedding) ? [...embedding.embedding] : embedding.embedding,
    }));

    await manager.save(this.documentRepo.target, clonedDocuments, { chunk: 100 });
    if (clonedChunks.length > 0) {
      await manager.save(this.chunkRepo.target, clonedChunks, { chunk: 100 });
    }
    if (clonedEmbeddings.length > 0) {
      await manager.save(this.chunkEmbeddingRepo.target, clonedEmbeddings, { chunk: 100 });
    }

    if (this.schemaService.isSqlite()) {
      const documentsById = new Map(clonedDocuments.map((document) => [document.id, document]));
      for (const chunk of clonedChunks) {
        const document = documentsById.get(chunk.documentId)!;
        await manager.query(
          `INSERT INTO "${this.schemaService.ftsTableName()}" ` +
            `(content, chunk_id, profile_revision_id, document_id, source_name, namespace) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            chunk.content,
            chunk.id,
            targetDataRevisionId,
            document.id,
            document.sourceName,
            document.namespace,
          ],
        );
      }
    }
  }

  private async ensureAuxiliaryIndexesFor(
    dataRevisionId: string,
    configuration: RagProfileConfiguration,
  ): Promise<void> {
    if (!this.schemaService.isPostgres()) return;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await this.schemaService.ensureLexicalIndexForRevision(
        queryRunner,
        dataRevisionId,
        configuration.retrieval.lexical?.language ?? 'simple',
      );
      if (configuration.retrieval.embedding) {
        await this.schemaService.ensureVectorIndexForRevision(
          queryRunner,
          dataRevisionId,
          configuration.retrieval.embedding.dimensions,
        );
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

  private async beginStagedReindex(revisionRow: RagProfileRevisionRow): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const lock = this.schemaService.isPostgres() ? ({ mode: 'pessimistic_write' } as const) : undefined;
      const profile = await manager.findOne<RagProfileRow>(this.profileRepo.target, {
        where: { id: revisionRow.profileId },
        ...(lock ? { lock } : {}),
      });
      if (!profile || profile.activeRevisionId !== revisionRow.previousRevisionId) {
        throw new RagConcurrencyError(
          revisionRow.profileName,
          revisionRow.previousRevisionId ?? 'none',
          profile?.activeRevisionId ?? 'none',
        );
      }
      const started = await manager.update(
        this.revisionRepo.target,
        {
          id: revisionRow.id,
          status: In([RagRevisionStatus.PENDING, RagRevisionStatus.READY, RagRevisionStatus.FAILED]),
        },
        {
          status: RagRevisionStatus.INDEXING,
          sourceIndexGeneration: profile.indexGeneration,
          error: () => 'NULL',
          failedAt: () => 'NULL',
        },
      );
      if (!started.affected) {
        throw new RagProfileRevisionError(
          `Revision "${revisionRow.id}" is already being indexed or is no longer staged.`,
          { profileName: revisionRow.profileName, revisionId: revisionRow.id },
        );
      }
    });
  }

  private async completeStagedReindex(revisionRow: RagProfileRevisionRow): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const lock = this.schemaService.isPostgres() ? ({ mode: 'pessimistic_write' } as const) : undefined;
      const profile = await manager.findOne<RagProfileRow>(this.profileRepo.target, {
        where: { id: revisionRow.profileId },
        ...(lock ? { lock } : {}),
      });
      if (
        !profile ||
        profile.activeRevisionId !== revisionRow.previousRevisionId ||
        revisionRow.sourceIndexGeneration === null ||
        profile.indexGeneration !== revisionRow.sourceIndexGeneration
      ) {
        return false;
      }
      const ready = await manager.update(
        this.revisionRepo.target,
        {
          id: revisionRow.id,
          status: RagRevisionStatus.INDEXING,
          sourceIndexGeneration: revisionRow.sourceIndexGeneration,
        },
        { status: RagRevisionStatus.READY, error: () => 'NULL', failedAt: () => 'NULL' },
      );
      return !!ready.affected;
    });
  }

  private async nextRevisionNumber(profileId: string, manager?: EntityManager): Promise<number> {
    const repository = manager ? manager.getRepository(this.revisionRepo.target) : this.revisionRepo;
    const raw = await repository
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
