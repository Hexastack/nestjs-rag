import { RagConfigurationService } from '../../../src/config/rag-configuration.service';
import { RagEmbeddingProviderRegistry } from '../../../src/providers/embedding-provider-registry';
import { RagChangeImpact, RagChunkingStrategy, RagOperationStatus, RagRetrievalMode, RagRevisionStatus } from '../../../src/enums';
import {
  RagConcurrencyError,
  RagProfileActivationError,
  RagProfileAlreadyExistsError,
  RagProfileNotFoundError,
  RagProfileRevisionError,
  RagReindexRequiredError,
  RagRevisionNotFoundError,
  RagValidationError,
} from '../../../src/errors';
import { RagProfileConfiguration } from '../../../src/interfaces/profile.interface';
import { RagProfileReindexResult } from '../../../src/interfaces/reindex.interface';
import { createSqliteTestContext, SqliteTestContext } from '../test-utils/sqlite-test-context';

class FakeEventEmitter {
  events: Array<{ name: string; payload: unknown }> = [];
  emit(name: string, payload: unknown) {
    this.events.push({ name, payload });
    return true;
  }
}

function lexicalConfig(name = 'default'): RagProfileConfiguration {
  return {
    name,
    retrieval: { defaultMode: RagRetrievalMode.LEXICAL, lexical: { language: 'english' } },
    chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 200, chunkOverlap: 20 },
    searchDefaults: { topK: 5, candidateLimit: 25, minScore: 0 },
  };
}

describe('RagConfigurationService (SQLite-backed, real persistence)', () => {
  let ctx: SqliteTestContext;
  let events: FakeEventEmitter;
  let indexingService: { reindexRevision: jest.Mock };
  let service: RagConfigurationService;

  beforeEach(async () => {
    ctx = await createSqliteTestContext();
    events = new FakeEventEmitter();
    indexingService = { reindexRevision: jest.fn() };
    service = new RagConfigurationService(
      ctx.repos.profile as any,
      ctx.repos.profileRevision as any,
      ctx.repos.sourceBinding as any,
      ctx.repos.document as any,
      ctx.repos.chunk as any,
      ctx.repos.chunkEmbedding as any,
      ctx.dataSource,
      ctx.schemaService,
      ctx.context,
      new RagEmbeddingProviderRegistry(),
      events as any,
      indexingService as any,
    );
  });

  afterEach(() => ctx.close());

  describe('createProfile', () => {
    it('creates a profile with an active revision #1', async () => {
      const profile = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      expect(profile.name).toBe('default');
      expect(profile.activeRevisionId).toBeTruthy();

      const revision = await service.getActiveRevision('default');
      expect(revision.revisionNumber).toBe(1);
      expect(revision.status).toBe(RagRevisionStatus.ACTIVE);
      expect(revision.changeImpact).toBe(RagChangeImpact.NONE);
    });

    it('rejects a duplicate profile name', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      await expect(service.createProfile({ name: 'default', configuration: lexicalConfig() })).rejects.toThrow(
        RagProfileAlreadyExistsError,
      );
    });

    it('rejects a structurally invalid configuration', async () => {
      const bad = lexicalConfig();
      bad.chunking.chunkOverlap = bad.chunking.chunkSize; // overlap must be < chunkSize
      await expect(service.createProfile({ name: 'default', configuration: bad })).rejects.toThrow(RagValidationError);
    });

    it('emits profile.created and profile.revision.activated events', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      expect(events.events.map((e) => e.name)).toEqual(
        expect.arrayContaining(['rag.profile.created', 'rag.profile.revision.created', 'rag.profile.revision.activated']),
      );
    });

    it('never persists provider credentials (only serializable ids/settings)', async () => {
      const config: RagProfileConfiguration = {
        ...lexicalConfig(),
        retrieval: { defaultMode: RagRetrievalMode.LEXICAL },
      };
      await service.createProfile({ name: 'default', configuration: config });
      const revision = await service.getActiveRevision('default');
      expect(JSON.stringify(revision.configuration)).not.toMatch(/apiKey|api_key|secret|password/i);
    });
  });

  describe('reads', () => {
    it('throws RagProfileNotFoundError for an unknown profile', async () => {
      await expect(service.getProfile('nope')).rejects.toThrow(RagProfileNotFoundError);
    });

    it('lists profiles', async () => {
      await service.createProfile({ name: 'a', configuration: lexicalConfig('a') });
      await service.createProfile({ name: 'b', configuration: lexicalConfig('b') });
      const profiles = await service.listProfiles();
      expect(profiles.map((p) => p.name).sort()).toEqual(['a', 'b']);
    });
  });

  describe('previewUpdate', () => {
    beforeEach(() => service.createProfile({ name: 'default', configuration: lexicalConfig() }));

    it('classifies a query-only patch and allows immediate application', async () => {
      const preview = await service.previewUpdate('default', { searchDefaults: { topK: 15 } });
      expect(preview.impact).toBe(RagChangeImpact.QUERY_ONLY);
      expect(preview.canApplyImmediately).toBe(true);
    });

    it('classifies a chunk-size patch as reindex-required', async () => {
      const preview = await service.previewUpdate('default', { chunking: { chunkSize: 400 } });
      expect(preview.impact).toBe(RagChangeImpact.REINDEX_REQUIRED);
      expect(preview.canApplyImmediately).toBe(false);
    });

    it('does not persist or activate anything', async () => {
      await service.previewUpdate('default', { chunking: { chunkSize: 400 } });
      const revisions = await service.listRevisions('default');
      expect(revisions).toHaveLength(1);
    });
  });

  describe('updateProfile: validate-only', () => {
    it('never creates a persisted revision', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const result = await service.updateProfile(
        'default',
        { chunking: { chunkSize: 400 } },
        { applyStrategy: 'validate-only' },
      );
      expect(result.revision.status).toBe(RagRevisionStatus.DRAFT);
      expect(await service.listRevisions('default')).toHaveLength(1);
    });
  });

  describe('updateProfile: apply-immediately', () => {
    it('applies a query-only change without creating a pending revision, and it becomes active immediately', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const result = await service.updateProfile(
        'default',
        { searchDefaults: { topK: 25 } },
        { applyStrategy: 'apply-immediately' },
      );
      expect(result.revision.status).toBe(RagRevisionStatus.ACTIVE);
      expect(result.revision.configuration.searchDefaults?.topK).toBe(25);
      expect((await service.getActiveRevision('default')).id).toBe(result.revision.id);
    });

    it('shares the existing index rows via dataRevisionId instead of moving or re-indexing them', async () => {
      const profile = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const originalRevisionId = profile.activeRevisionId!;
      await ctx.repos.document.save({
        id: 'doc-1',
        profileName: 'default',
        profileRevisionId: originalRevisionId,
        sourceName: 'direct',
        sourceId: 'x',
        externalId: 'x',
        namespace: null,
        content: 'hello',
        contentHash: 'h',
        indexingHash: 'h',
        sourceUpdatedAt: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.updateProfile(
        'default',
        { searchDefaults: { topK: 30 } },
        { applyStrategy: 'apply-immediately' },
      );

      // Rows stay with the revision that built them; the new revision serves
      // them by reference.
      expect(result.revision.dataRevisionId).toBe(originalRevisionId);
      expect(await ctx.repos.document.count({ where: { profileRevisionId: originalRevisionId } })).toBe(1);
      expect(await ctx.repos.document.count({ where: { profileRevisionId: result.revision.id } })).toBe(0);
    });

    it('chained query-only revisions all reference the original indexing revision', async () => {
      const profile = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const originalRevisionId = profile.activeRevisionId!;
      const first = await service.updateProfile('default', { searchDefaults: { topK: 10 } }, { applyStrategy: 'apply-immediately' });
      const second = await service.updateProfile('default', { searchDefaults: { topK: 20 } }, { applyStrategy: 'apply-immediately' });
      expect(first.revision.dataRevisionId).toBe(originalRevisionId);
      expect(second.revision.dataRevisionId).toBe(originalRevisionId);
    });

    it('rejects a change that requires re-indexing', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      await expect(
        service.updateProfile('default', { chunking: { chunkSize: 500 } }, { applyStrategy: 'apply-immediately' }),
      ).rejects.toThrow(RagReindexRequiredError);
    });

    it('archives the previous revision', async () => {
      const profile = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      await service.updateProfile('default', { searchDefaults: { topK: 30 } }, { applyStrategy: 'apply-immediately' });
      const revisions = await service.listRevisions('default');
      const previous = revisions.find((r) => r.id === profile.activeRevisionId);
      expect(previous?.status).toBe(RagRevisionStatus.ARCHIVED);
    });
  });

  describe('updateProfile: stage', () => {
    it('creates a pending revision without touching the active one', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const before = await service.getActiveRevision('default');
      const result = await service.updateProfile('default', { chunking: { chunkSize: 400 } }, { applyStrategy: 'stage' });
      expect(result.revision.status).toBe(RagRevisionStatus.PENDING);
      expect((await service.getActiveRevision('default')).id).toBe(before.id);
      expect(indexingService.reindexRevision).not.toHaveBeenCalled();
    });
  });

  describe('updateProfile: reindex-and-activate', () => {
    it('stages, reindexes, and atomically activates on success', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      indexingService.reindexRevision.mockImplementation(
        async (_profileName: string, revisionId: string): Promise<RagProfileReindexResult> => ({
          profileName: 'default',
          revisionId,
          status: RagOperationStatus.COMPLETED,
          sources: [],
          documentsIndexed: 3,
          chunksCreated: 9,
          embeddingsCreated: 0,
          failures: 0,
          readyForActivation: true,
        }),
      );

      const result = await service.updateProfile(
        'default',
        { chunking: { chunkSize: 400 } },
        { applyStrategy: 'reindex-and-activate' },
      );

      expect(result.revision.status).toBe(RagRevisionStatus.ACTIVE);
      expect(result.reindexResult?.status).toBe(RagOperationStatus.COMPLETED);
      expect((await service.getActiveRevision('default')).id).toBe(result.revision.id);
    });

    it('leaves the previous revision active when re-indexing fails, and marks the new one failed', async () => {
      const initial = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      indexingService.reindexRevision.mockResolvedValue({
        profileName: 'default',
        revisionId: 'whatever',
        status: RagOperationStatus.FAILED,
        sources: [],
        documentsIndexed: 0,
        chunksCreated: 0,
        embeddingsCreated: 0,
        failures: 5,
        readyForActivation: false,
      } satisfies RagProfileReindexResult);

      const result = await service.updateProfile(
        'default',
        { chunking: { chunkSize: 400 } },
        { applyStrategy: 'reindex-and-activate' },
      );

      expect(result.revision.status).toBe(RagRevisionStatus.FAILED);
      expect((await service.getActiveRevision('default')).id).toBe(initial.activeRevisionId);
    });

    it('marks the revision failed when the indexing service throws', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      indexingService.reindexRevision.mockRejectedValue(new Error('embedding provider unreachable'));

      const result = await service.updateProfile(
        'default',
        { chunking: { chunkSize: 400 } },
        { applyStrategy: 'reindex-and-activate' },
      );
      expect(result.revision.status).toBe(RagRevisionStatus.FAILED);
      expect(result.revision.error?.message).toContain('unreachable');
    });
  });

  describe('reindexStagedRevision (manual staged workflow)', () => {
    const readyResult = (revisionId: string): RagProfileReindexResult => ({
      profileName: 'default',
      revisionId,
      status: RagOperationStatus.COMPLETED,
      sources: [],
      documentsIndexed: 2,
      chunksCreated: 4,
      embeddingsCreated: 0,
      failures: 0,
      readyForActivation: true,
    });

    it('supports the documented stage → reindex → activate sequence', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      indexingService.reindexRevision.mockImplementation(
        async (_profileName: string, revisionId: string) => readyResult(revisionId),
      );

      const staged = await service.updateProfile('default', { chunking: { chunkSize: 400 } }, { applyStrategy: 'stage' });
      const result = await service.reindexStagedRevision('default', staged.revision.id);
      expect(result.readyForActivation).toBe(true);
      expect((await service.getRevision('default', staged.revision.id)).status).toBe(RagRevisionStatus.READY);
      expect(events.events.map((e) => e.name)).toEqual(
        expect.arrayContaining(['rag.profile.revision.indexing', 'rag.profile.revision.ready']),
      );

      const activated = await service.activateRevision('default', staged.revision.id);
      expect(activated.status).toBe(RagRevisionStatus.ACTIVE);
      expect((await service.getActiveRevision('default')).id).toBe(staged.revision.id);
    });

    it('marks the revision failed when the re-index does not produce a ready index', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      indexingService.reindexRevision.mockResolvedValue({
        ...readyResult('x'),
        status: RagOperationStatus.FAILED,
        failures: 3,
        readyForActivation: false,
      } satisfies RagProfileReindexResult);

      const staged = await service.updateProfile('default', { chunking: { chunkSize: 400 } }, { applyStrategy: 'stage' });
      await service.reindexStagedRevision('default', staged.revision.id);
      expect((await service.getRevision('default', staged.revision.id)).status).toBe(RagRevisionStatus.FAILED);
    });

    it('marks the revision failed and rethrows when the indexing service throws', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      indexingService.reindexRevision.mockRejectedValue(new Error('embedding provider unreachable'));

      const staged = await service.updateProfile('default', { chunking: { chunkSize: 400 } }, { applyStrategy: 'stage' });
      await expect(service.reindexStagedRevision('default', staged.revision.id)).rejects.toThrow('unreachable');
      const revision = await service.getRevision('default', staged.revision.id);
      expect(revision.status).toBe(RagRevisionStatus.FAILED);
      expect(revision.error?.message).toContain('unreachable');
    });

    it('allows retrying a previously failed staged revision', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const staged = await service.updateProfile('default', { chunking: { chunkSize: 400 } }, { applyStrategy: 'stage' });

      indexingService.reindexRevision.mockRejectedValueOnce(new Error('transient outage'));
      await expect(service.reindexStagedRevision('default', staged.revision.id)).rejects.toThrow('transient outage');

      indexingService.reindexRevision.mockImplementation(
        async (_profileName: string, revisionId: string) => readyResult(revisionId),
      );
      await service.reindexStagedRevision('default', staged.revision.id);
      expect((await service.getRevision('default', staged.revision.id)).status).toBe(RagRevisionStatus.READY);
    });

    it('re-indexes the active revision in place without corrupting its status', async () => {
      const profile = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      indexingService.reindexRevision.mockImplementation(
        async (_profileName: string, revisionId: string) => readyResult(revisionId),
      );

      await service.reindexStagedRevision('default', profile.activeRevisionId!);
      expect((await service.getActiveRevision('default')).status).toBe(RagRevisionStatus.ACTIVE);
    });

    it('reindexStagedProfile finds the pending revision, and throws when there is none', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      await expect(service.reindexStagedProfile('default')).rejects.toThrow(RagValidationError);

      indexingService.reindexRevision.mockImplementation(
        async (_profileName: string, revisionId: string) => readyResult(revisionId),
      );
      const staged = await service.updateProfile('default', { chunking: { chunkSize: 400 } }, { applyStrategy: 'stage' });
      const result = await service.reindexStagedProfile('default');
      expect(result.revisionId).toBe(staged.revision.id);
      expect((await service.getRevision('default', staged.revision.id)).status).toBe(RagRevisionStatus.READY);
    });
  });

  describe('activateRevision', () => {
    it('is atomic: rejects activating a revision that is not ready/archived', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const staged = await service.updateProfile('default', { chunking: { chunkSize: 400 } }, { applyStrategy: 'stage' });
      await expect(service.activateRevision('default', staged.revision.id)).rejects.toThrow(RagProfileActivationError);
    });

    it('throws for a revision id that does not belong to the profile', async () => {
      await service.createProfile({ name: 'a', configuration: lexicalConfig('a') });
      await service.createProfile({ name: 'b', configuration: lexicalConfig('b') });
      const bRevision = await service.getActiveRevision('b');
      await expect(service.activateRevision('a', bRevision.id)).rejects.toThrow(RagRevisionNotFoundError);
    });
  });

  describe('rollback', () => {
    it('restores a previously active (archived) revision', async () => {
      const initial = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const afterUpdate = await service.updateProfile(
        'default',
        { searchDefaults: { topK: 99 } },
        { applyStrategy: 'apply-immediately' },
      );
      expect((await service.getActiveRevision('default')).id).toBe(afterUpdate.revision.id);

      const rolledBack = await service.rollback('default', initial.activeRevisionId!);
      expect(rolledBack.id).toBe(initial.activeRevisionId);
      expect((await service.getActiveRevision('default')).id).toBe(initial.activeRevisionId);
    });

    it('emits a profile.rolled_back event', async () => {
      const initial = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      await service.updateProfile('default', { searchDefaults: { topK: 99 } }, { applyStrategy: 'apply-immediately' });
      events.events = [];
      await service.rollback('default', initial.activeRevisionId!);
      expect(events.events.some((e) => e.name === 'rag.profile.rolled_back')).toBe(true);
    });

    it('rejects rolling back to a pending (never-activated) revision', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const staged = await service.updateProfile('default', { chunking: { chunkSize: 400 } }, { applyStrategy: 'stage' });
      await expect(service.rollback('default', staged.revision.id)).rejects.toThrow(RagProfileRevisionError);
    });

    it('serves the shared row set when rolling back to an intermediate query-only revision after an earlier rollback', async () => {
      // Regression: A (indexed) -> B (query-only) -> C (query-only), rollback
      // to A, then rollback to B. Under the old row re-pointing scheme the
      // lineage resolver only walked backward from the active revision, so B
      // activated with an empty index. Now B references A's rows directly.
      const profile = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const revisionA = profile.activeRevisionId!;
      await ctx.repos.document.save({
        id: 'doc-1',
        profileName: 'default',
        profileRevisionId: revisionA,
        sourceName: 'direct',
        sourceId: 'x',
        externalId: 'x',
        namespace: null,
        content: 'hello',
        contentHash: 'h',
        indexingHash: 'h',
        sourceUpdatedAt: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const revisionB = (await service.updateProfile('default', { searchDefaults: { topK: 4 } }, { applyStrategy: 'apply-immediately' })).revision;
      await service.updateProfile('default', { searchDefaults: { topK: 6 } }, { applyStrategy: 'apply-immediately' });

      await service.rollback('default', revisionA);
      const restored = await service.rollback('default', revisionB.id);

      expect(restored.dataRevisionId).toBe(revisionA);
      expect(await ctx.repos.document.count({ where: { profileRevisionId: revisionA } })).toBe(1);
    });
  });

  describe('concurrency control', () => {
    it('rejects an update whose expectedRevisionId is stale', async () => {
      const initial = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      await service.updateProfile('default', { searchDefaults: { topK: 12 } }, { applyStrategy: 'apply-immediately' });

      await expect(
        service.updateProfile(
          'default',
          { searchDefaults: { topK: 99 } },
          { applyStrategy: 'apply-immediately', expectedRevisionId: initial.activeRevisionId! },
        ),
      ).rejects.toThrow(RagConcurrencyError);
    });

    it('accepts an update whose expectedRevisionId matches the current active revision', async () => {
      const initial = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      await expect(
        service.updateProfile(
          'default',
          { searchDefaults: { topK: 12 } },
          { applyStrategy: 'apply-immediately', expectedRevisionId: initial.activeRevisionId! },
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('revision immutability', () => {
    it('never mutates a previously returned revision object when the profile is updated again', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const first = await service.getActiveRevision('default');
      const firstConfigSnapshot = JSON.parse(JSON.stringify(first.configuration));
      await service.updateProfile('default', { searchDefaults: { topK: 42 } }, { applyStrategy: 'apply-immediately' });
      expect(first.configuration).toEqual(firstConfigSnapshot);
    });

    it('keeps distinct configuration hashes for distinct revisions', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const before = await service.getActiveRevision('default');
      const result = await service.updateProfile(
        'default',
        { chunking: { chunkSize: 250 } },
        { applyStrategy: 'stage' },
      );
      expect(result.revision.configurationHash).not.toEqual(before.configurationHash);
    });
  });

  describe('deleteProfile', () => {
    it('deletes a profile with no bound sources', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      await service.deleteProfile('default');
      await expect(service.getProfile('default')).rejects.toThrow(RagProfileNotFoundError);
    });

    it('refuses to delete a profile that still has bound sources', async () => {
      await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      await ctx.repos.sourceBinding.save({
        id: 'binding-1',
        sourceName: 'articles',
        profileName: 'default',
        sourceConfiguration: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await expect(service.deleteProfile('default')).rejects.toThrow();
    });
  });

  describe('cleanupArchivedRevisions', () => {
    const readyReindexResult = (revisionId: string): RagProfileReindexResult => ({
      profileName: 'default',
      revisionId,
      status: RagOperationStatus.COMPLETED,
      sources: [],
      documentsIndexed: 1,
      chunksCreated: 1,
      embeddingsCreated: 0,
      failures: 0,
      readyForActivation: true,
    });

    it('purges archived revisions beyond the retention count and rollback then fails descriptively', async () => {
      const initial = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      indexingService.reindexRevision.mockImplementation(
        async (_profileName: string, revisionId: string) => readyReindexResult(revisionId),
      );
      // Two re-index boundaries: each revision owns its own row set, so the
      // archived ones are not referenced by anything and can be purged.
      await service.updateProfile('default', { chunking: { chunkSize: 300 } }, { applyStrategy: 'reindex-and-activate' });
      await service.updateProfile('default', { chunking: { chunkSize: 350 } }, { applyStrategy: 'reindex-and-activate' });

      const { deleted } = await service.cleanupArchivedRevisions('default', { keep: 0 });
      expect(deleted).toContain(initial.activeRevisionId);
      await expect(service.rollback('default', initial.activeRevisionId!)).rejects.toThrow(RagRevisionNotFoundError);
    });

    it('never purges a revision whose row set another retained revision still references', async () => {
      const initial = await service.createProfile({ name: 'default', configuration: lexicalConfig() });
      const originalRevisionId = initial.activeRevisionId!;
      // Query-only updates: the active revision serves the original
      // revision's rows via dataRevisionId, so the original must survive
      // cleanup even with keep: 0. The intermediate query-only revision owns
      // nothing and is purged.
      const intermediate = await service.updateProfile('default', { searchDefaults: { topK: 1 } }, { applyStrategy: 'apply-immediately' });
      await service.updateProfile('default', { searchDefaults: { topK: 2 } }, { applyStrategy: 'apply-immediately' });

      const { deleted } = await service.cleanupArchivedRevisions('default', { keep: 0 });
      expect(deleted).toContain(intermediate.revision.id);
      expect(deleted).not.toContain(originalRevisionId);

      // The original revision's rows are intact, so rolling back to it works.
      const rolledBack = await service.rollback('default', originalRevisionId);
      expect(rolledBack.status).toBe(RagRevisionStatus.ACTIVE);
    });
  });

  describe('validateProfile', () => {
    it('returns a non-throwing validation result', async () => {
      const result = await service.validateProfile(lexicalConfig());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('reports errors without throwing for an invalid configuration', async () => {
      const bad = lexicalConfig();
      bad.chunking.chunkSize = -1;
      const result = await service.validateProfile(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
