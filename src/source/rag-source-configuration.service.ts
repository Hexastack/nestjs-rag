import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { RAG_INDEXING_SERVICE, RAG_SOURCE_BINDING_REPOSITORY } from '../constants';
import { RagChangeImpact, RagOperationStatus } from '../enums';
import { RagSourceBindingRow } from '../entities/rows';
import { RagReindexRequiredError, RagSourceConfigurationError, RagSourceNotFoundError } from '../errors';
import { RagEventNames, RagSourceProfileChangedEvent } from '../events/rag-events';
import { RagChunkingOptions, RagProfileConfiguration, RagRetrievalOptions } from '../interfaces/profile.interface';
import {
  RagSourceProfileUpdateOptions,
  RagSourceProfileUpdateResult,
  RagSourceUpdateOptions,
  RagSourceUpdateResult,
  UpdateRagSourceConfigurationInput,
} from '../interfaces/source-config-api.interface';
import { RagSourceDescriptor } from '../interfaces/source.interface';
import { RagConfigurationChangePreview } from '../interfaces/config-api.interface';
import { RagConfigurationService } from '../config/rag-configuration.service';
import { resolveEffectiveChunking, resolveEffectiveRetrieval } from '../config/patch-merge.util';
import { newId } from '../utils/id.util';
import { assertAllowedSourceRetrievalOverrides, RagSourceRegistry } from './source-registry';
// Type-only import: see the note in RagConfigurationService for why this
// never creates a runtime import cycle with the indexing module.
import type { RagIndexingService } from '../indexing/rag-indexing.service';
import { RagProfileReindexResult } from '../interfaces/reindex.interface';

interface StoredSourceConfiguration {
  chunkingOverrides?: Partial<RagChunkingOptions>;
  retrievalOverrides?: Partial<RagRetrievalOptions>;
}

/**
 * Public runtime source-management API (design doc section 16). Owns the
 * *mutable* half of a source's configuration — its profile assignment and
 * chunking/retrieval overrides, persisted in `rag_source_bindings` — while
 * `RagSourceRegistry` owns the immutable, code-supplied half (which entity,
 * table, or provider it reads from).
 */
@Injectable()
export class RagSourceConfigurationService {
  private readonly logger = new Logger(RagSourceConfigurationService.name);

  constructor(
    @Inject(RAG_SOURCE_BINDING_REPOSITORY) private readonly bindingRepo: Repository<RagSourceBindingRow>,
    private readonly registry: RagSourceRegistry,
    private readonly configurationService: RagConfigurationService,
    @Inject(RAG_INDEXING_SERVICE) private readonly indexingService: RagIndexingService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Seeds `rag_source_bindings` for any source declared in
   * `RagModule.forRoot({ sources })` that isn't already bound. Called once
   * by `RagBootstrapService` during application bootstrap, after schema
   * initialization — not a lifecycle hook on this class itself, so bootstrap
   * ordering stays explicit in one place.
   */
  async seedBindings(): Promise<void> {
    for (const wiring of this.registry.list()) {
      const existing = await this.bindingRepo.findOne({ where: { sourceName: wiring.name } });
      if (existing) continue;
      await this.bindingRepo.save({
        id: newId(),
        sourceName: wiring.name,
        profileName: wiring.defaultProfileName,
        sourceConfiguration: {
          chunkingOverrides: wiring.defaultChunkingOverrides,
          retrievalOverrides: wiring.defaultRetrievalOverrides,
        } satisfies StoredSourceConfiguration,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      this.logger.log(`Registered RAG source "${wiring.name}" bound to profile "${wiring.defaultProfileName}".`);
    }
  }

  async listSources(): Promise<RagSourceDescriptor[]> {
    const descriptors: RagSourceDescriptor[] = [];
    for (const wiring of this.registry.list()) {
      descriptors.push(await this.getSource(wiring.name));
    }
    return descriptors;
  }

  async getSource(sourceName: string): Promise<RagSourceDescriptor> {
    if (!this.registry.has(sourceName)) {
      throw new RagSourceNotFoundError(sourceName);
    }
    const wiring = this.registry.get(sourceName);
    const binding = await this.getBindingOrThrow(sourceName);
    const stored = (binding.sourceConfiguration ?? {}) as StoredSourceConfiguration;
    return {
      name: sourceName,
      kind: wiring.kind,
      profileName: binding.profileName,
      namespace: wiring.namespace,
      chunkingOverrides: stored.chunkingOverrides,
      retrievalOverrides: stored.retrievalOverrides,
      mappingVersion: wiring.mappingVersion,
      synchronization: wiring.synchronization,
    };
  }

  async previewSourceUpdate(
    sourceName: string,
    patch: UpdateRagSourceConfigurationInput,
  ): Promise<RagConfigurationChangePreview> {
    const binding = await this.getBindingOrThrow(sourceName);
    const changedPaths: string[] = [];
    if (patch.chunking) changedPaths.push('source.chunkingOverrides');
    if (patch.retrieval) changedPaths.push('source.retrievalOverrides');
    const impact = changedPaths.length > 0 ? RagChangeImpact.REINDEX_REQUIRED : RagChangeImpact.NONE;
    const activeRevision = await this.configurationService.getActiveRevision(binding.profileName);
    return {
      profileName: binding.profileName,
      currentRevisionId: activeRevision.id,
      proposedConfiguration: activeRevision.configuration,
      impact,
      changedPaths,
      affectedSources: changedPaths.length > 0 ? [sourceName] : [],
      reasons:
        changedPaths.length > 0
          ? [`Source-level overrides changed for "${sourceName}"; re-sync the source to apply them to already-indexed content.`]
          : [],
      canApplyImmediately: impact === RagChangeImpact.NONE,
    };
  }

  async assignProfile(
    sourceName: string,
    profileName: string,
    options: RagSourceProfileUpdateOptions,
  ): Promise<RagSourceProfileUpdateResult> {
    const binding = await this.getBindingOrThrow(sourceName);
    await this.configurationService.getProfile(profileName); // throws RagProfileNotFoundError if missing
    const previousProfileName = binding.profileName;

    const preview: RagConfigurationChangePreview = {
      profileName,
      currentRevisionId: (await this.configurationService.getActiveRevision(previousProfileName).catch(() => null))?.id ?? null,
      proposedConfiguration: (await this.configurationService.getActiveRevision(profileName)).configuration,
      impact: RagChangeImpact.REINDEX_REQUIRED,
      changedPaths: ['source.profileName'],
      affectedSources: [sourceName],
      reasons: [`Source "${sourceName}" would move from profile "${previousProfileName}" to "${profileName}".`],
      canApplyImmediately: false,
    };

    if (previousProfileName === profileName) {
      return { sourceName, previousProfileName, newProfileName: profileName, preview };
    }

    switch (options.applyStrategy) {
      case 'validate-only':
        return { sourceName, previousProfileName, newProfileName: profileName, preview };
      case 'apply-immediately':
        throw new RagReindexRequiredError([
          `Reassigning source "${sourceName}" to profile "${profileName}" requires indexing its content under the ` +
            `new profile. Use "stage" (and sync later) or "reindex-and-activate".`,
        ]);
      case 'stage':
        await this.bindingRepo.update({ sourceName }, { profileName, updatedAt: new Date() });
        await this.removeFromPreviousProfile(sourceName, previousProfileName);
        this.emitProfileChanged(sourceName, previousProfileName, profileName);
        return { sourceName, previousProfileName, newProfileName: profileName, preview };
      case 'reindex-and-activate': {
        // Index under the new profile first; the binding and the old
        // profile's documents are only touched once the new copy actually
        // exists, so a failed sync leaves the old profile serving intact.
        const reindexResult = await this.syncSourceAsReindexResult(sourceName, profileName);
        if (!reindexResult.readyForActivation) {
          throw new RagSourceConfigurationError(
            `Reassigning source "${sourceName}" to profile "${profileName}" failed during re-indexing ` +
              `(${reindexResult.failures} failure(s)); the source remains bound to "${previousProfileName}".`,
          );
        }
        await this.bindingRepo.update({ sourceName }, { profileName, updatedAt: new Date() });
        this.emitProfileChanged(sourceName, previousProfileName, profileName);
        await this.removeFromPreviousProfile(sourceName, previousProfileName);
        return { sourceName, previousProfileName, newProfileName: profileName, preview, reindexResult };
      }
      default:
        throw new RagReindexRequiredError([`Unknown apply strategy "${options.applyStrategy}".`]);
    }
  }

  async updateSourceOverrides(
    sourceName: string,
    overrides: { chunking?: Partial<RagChunkingOptions>; retrieval?: Partial<RagRetrievalOptions> },
    options: RagSourceUpdateOptions,
  ): Promise<RagSourceUpdateResult> {
    const binding = await this.getBindingOrThrow(sourceName);
    assertAllowedSourceRetrievalOverrides(overrides.retrieval, sourceName);
    const stored = (binding.sourceConfiguration ?? {}) as StoredSourceConfiguration;
    const nextStored: StoredSourceConfiguration = {
      chunkingOverrides: overrides.chunking ? { ...stored.chunkingOverrides, ...overrides.chunking } : stored.chunkingOverrides,
      retrievalOverrides: overrides.retrieval
        ? { ...stored.retrievalOverrides, ...overrides.retrieval }
        : stored.retrievalOverrides,
    };
    await this.assertValidEffectiveConfiguration(sourceName, binding.profileName, nextStored);
    const preview = await this.previewSourceUpdate(sourceName, {
      chunking: overrides.chunking,
      retrieval: overrides.retrieval,
    });

    switch (options.applyStrategy) {
      case 'validate-only':
        return { sourceName, preview };
      case 'apply-immediately':
        if (!preview.canApplyImmediately) {
          throw new RagReindexRequiredError([
            `Source overrides for "${sourceName}" changed chunking/retrieval behavior; re-sync required. ` +
              `Use "stage" or "reindex-and-activate".`,
          ]);
        }
        await this.persistOverrides(sourceName, nextStored);
        return { sourceName, preview };
      case 'stage':
        await this.persistOverrides(sourceName, nextStored);
        return { sourceName, preview };
      case 'reindex-and-activate': {
        await this.persistOverrides(sourceName, nextStored);
        const reindexResult = await this.syncSourceAsReindexResult(sourceName, binding.profileName);
        return { sourceName, preview, reindexResult };
      }
      default:
        throw new RagReindexRequiredError([`Unknown apply strategy "${options.applyStrategy}".`]);
    }
  }

  async clearSourceOverrides(sourceName: string, options: RagSourceUpdateOptions): Promise<RagSourceUpdateResult> {
    const binding = await this.getBindingOrThrow(sourceName);
    const basePreview = await this.previewSourceUpdate(sourceName, {});
    // Clearing is conservatively treated as a change even if overrides were
    // already empty: we can't cheaply tell "no-op" apart from "reverting to
    // profile defaults changes effective behavior" without re-running the
    // full diff, and a false "query-only" here could silently invalidate
    // already-indexed content.
    const preview: RagConfigurationChangePreview = {
      ...basePreview,
      impact: RagChangeImpact.REINDEX_REQUIRED,
      canApplyImmediately: false,
      changedPaths: ['source.chunkingOverrides', 'source.retrievalOverrides'],
      reasons: [`Overrides for "${sourceName}" would be cleared; re-sync required to apply profile defaults to already-indexed content.`],
    };

    switch (options.applyStrategy) {
      case 'validate-only':
        return { sourceName, preview };
      case 'apply-immediately':
        throw new RagReindexRequiredError([
          `Clearing overrides for "${sourceName}" requires re-indexing. Use "stage" or "reindex-and-activate".`,
        ]);
      case 'stage':
        await this.persistOverrides(sourceName, {});
        return { sourceName, preview };
      case 'reindex-and-activate': {
        await this.persistOverrides(sourceName, {});
        const reindexResult = await this.syncSourceAsReindexResult(sourceName, binding.profileName);
        return { sourceName, preview, reindexResult };
      }
      default:
        throw new RagReindexRequiredError([`Unknown apply strategy "${options.applyStrategy}".`]);
    }
  }

  /**
   * Rejects overrides that would produce a structurally invalid *effective*
   * configuration once merged over the profile's active revision — the same
   * merge `RagIndexingService` applies at sync time. Embedding-identity
   * fields are rejected separately by `assertAllowedSourceRetrievalOverrides`;
   * this catches everything else (invalid chunk sizes/overlaps, batch sizes,
   * retrieval modes, hybrid weights, lexical languages, ...) that would
   * otherwise be persisted silently and poison every subsequent sync.
   */
  private async assertValidEffectiveConfiguration(
    sourceName: string,
    profileName: string,
    stored: StoredSourceConfiguration,
  ): Promise<void> {
    const revision = await this.configurationService.getActiveRevision(profileName);
    const configuration = revision.configuration;
    const effective: RagProfileConfiguration = {
      ...configuration,
      chunking: resolveEffectiveChunking(configuration.chunking, stored.chunkingOverrides),
      retrieval: resolveEffectiveRetrieval(configuration.retrieval, stored.retrievalOverrides),
    };
    const result = await this.configurationService.validateProfile(effective);
    if (!result.valid) {
      throw new RagSourceConfigurationError(
        `Source "${sourceName}" overrides produce an invalid effective configuration for profile "${profileName}": ` +
          result.errors.join('; '),
      );
    }
  }

  private async persistOverrides(sourceName: string, stored: StoredSourceConfiguration): Promise<void> {
    await this.bindingRepo.update({ sourceName }, { sourceConfiguration: stored, updatedAt: new Date() });
  }

  /**
   * After a source moves to another profile, the old profile's active
   * revision must stop serving its documents — otherwise it would keep
   * returning that content forever. Best-effort: a failure here (e.g. the old
   * profile was deleted concurrently) must not roll back the reassignment.
   */
  private async removeFromPreviousProfile(sourceName: string, previousProfileName: string): Promise<void> {
    try {
      const { documentsRemoved } = await this.indexingService.removeSourceDocuments(previousProfileName, sourceName);
      if (documentsRemoved > 0) {
        this.logger.log(
          `Removed ${documentsRemoved} document(s) of source "${sourceName}" from profile "${previousProfileName}" after reassignment.`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not remove documents of source "${sourceName}" from previous profile "${previousProfileName}": ` +
          `${(error as Error).message}`,
      );
    }
  }

  private emitProfileChanged(sourceName: string, previousProfileName: string, newProfileName: string): void {
    this.eventEmitter.emit(RagEventNames.SOURCE_PROFILE_CHANGED, {
      sourceName,
      previousProfileName,
      newProfileName,
    } satisfies RagSourceProfileChangedEvent);
  }

  private async syncSourceAsReindexResult(sourceName: string, profileName: string): Promise<RagProfileReindexResult> {
    const syncResult = await this.indexingService.syncSource(sourceName, { profileName, full: true });
    const activeRevision = await this.configurationService.getActiveRevision(profileName);
    return {
      profileName,
      revisionId: activeRevision.id,
      status: syncResult.status,
      sources: [syncResult],
      documentsIndexed: syncResult.documentsIndexed,
      chunksCreated: syncResult.chunksCreated,
      embeddingsCreated: syncResult.embeddingsCreated,
      failures: syncResult.failures,
      readyForActivation: syncResult.status !== RagOperationStatus.FAILED,
    };
  }

  private async getBindingOrThrow(sourceName: string): Promise<RagSourceBindingRow> {
    if (!this.registry.has(sourceName)) {
      throw new RagSourceNotFoundError(sourceName);
    }
    const binding = await this.bindingRepo.findOne({ where: { sourceName } });
    if (!binding) {
      throw new RagSourceNotFoundError(sourceName);
    }
    return binding;
  }
}
