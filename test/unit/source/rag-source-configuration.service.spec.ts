import { RagSourceConfigurationService } from '../../../src/source/rag-source-configuration.service';
import { RagSourceRegistry } from '../../../src/source/source-registry';
import { RagChunkingStrategy, RagDatabaseType, RagOperationStatus, RagRetrievalMode } from '../../../src/enums';
import { RagReindexRequiredError, RagSourceConfigurationError, RagSourceNotFoundError } from '../../../src/errors';
import { validateProfileConfigurationStructure } from '../../../src/config/validate-configuration';
import { RagProfileConfiguration } from '../../../src/interfaces/profile.interface';
import { createSqliteTestContext, SqliteTestContext } from '../test-utils/sqlite-test-context';

class FakeEventEmitter {
  events: Array<{ name: string; payload: unknown }> = [];
  emit(name: string, payload: unknown) {
    this.events.push({ name, payload });
    return true;
  }
}

function fakeActiveRevision(profileName: string) {
  return {
    id: `${profileName}-rev-1`,
    profileName,
    revisionNumber: 1,
    status: 'active',
    configuration: {
      name: profileName,
      retrieval: {
        defaultMode: RagRetrievalMode.LEXICAL,
        embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536 },
      },
      chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 200, chunkOverlap: 20 },
    },
    configurationHash: 'hash',
    changeImpact: 'none',
    createdAt: new Date(),
  };
}

describe('RagSourceConfigurationService', () => {
  let ctx: SqliteTestContext;
  let registry: RagSourceRegistry;
  let configurationService: { getProfile: jest.Mock; getActiveRevision: jest.Mock; validateProfile: jest.Mock };
  let indexingService: { syncSource: jest.Mock; removeSourceDocuments: jest.Mock };
  let events: FakeEventEmitter;
  let service: RagSourceConfigurationService;

  beforeEach(async () => {
    ctx = await createSqliteTestContext();
    registry = new RagSourceRegistry();
    registry.register({
      name: 'articles',
      kind: 'entity',
      defaultProfileName: 'default',
    } as any);

    await ctx.repos.sourceBinding.save({
      id: 'binding-1',
      sourceName: 'articles',
      profileName: 'default',
      sourceConfiguration: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    configurationService = {
      getProfile: jest.fn().mockResolvedValue({ name: 'customer-support' }),
      getActiveRevision: jest.fn().mockImplementation(async (name: string) => fakeActiveRevision(name)),
      // Runs the real structural validator so override tests exercise genuine
      // acceptance/rejection instead of a canned answer.
      validateProfile: jest.fn().mockImplementation(async (configuration: RagProfileConfiguration) => {
        const structural = validateProfileConfigurationStructure(configuration, {
          dbType: RagDatabaseType.POSTGRES,
          vectorColumnEnabled: true,
        });
        return { valid: structural.errors.length === 0, errors: structural.errors, warnings: structural.warnings };
      }),
    };
    indexingService = {
      syncSource: jest.fn().mockResolvedValue({
        sourceName: 'articles',
        status: RagOperationStatus.COMPLETED,
        recordsProcessed: 2,
        documentsIndexed: 2,
        documentsRemoved: 0,
        chunksCreated: 4,
        embeddingsCreated: 0,
        failures: 0,
        errors: [],
        results: [],
      }),
      removeSourceDocuments: jest.fn().mockResolvedValue({ documentsRemoved: 0 }),
    };
    events = new FakeEventEmitter();

    service = new RagSourceConfigurationService(
      ctx.repos.sourceBinding as any,
      registry,
      configurationService as any,
      indexingService as any,
      events as any,
    );
  });

  afterEach(() => ctx.close());

  it('lists sources with their current profile assignment', async () => {
    const sources = await service.listSources();
    expect(sources).toEqual([
      expect.objectContaining({ name: 'articles', profileName: 'default' }),
    ]);
  });

  it('throws for an unknown source', async () => {
    await expect(service.getSource('missing')).rejects.toThrow(RagSourceNotFoundError);
  });

  describe('assignProfile', () => {
    it('rejects apply-immediately (profile moves always require indexing)', async () => {
      await expect(
        service.assignProfile('articles', 'customer-support', { applyStrategy: 'apply-immediately' }),
      ).rejects.toThrow(RagReindexRequiredError);
    });

    it('validate-only does not persist the change', async () => {
      await service.assignProfile('articles', 'customer-support', { applyStrategy: 'validate-only' });
      const source = await service.getSource('articles');
      expect(source.profileName).toBe('default');
    });

    it('stage persists the new profile without syncing', async () => {
      const result = await service.assignProfile('articles', 'customer-support', { applyStrategy: 'stage' });
      expect(result.newProfileName).toBe('customer-support');
      expect(indexingService.syncSource).not.toHaveBeenCalled();
      const source = await service.getSource('articles');
      expect(source.profileName).toBe('customer-support');
    });

    it('reindex-and-activate persists the new profile and syncs the source', async () => {
      const result = await service.assignProfile('articles', 'customer-support', { applyStrategy: 'reindex-and-activate' });
      expect(indexingService.syncSource).toHaveBeenCalledWith('articles', { profileName: 'customer-support', full: true });
      expect(result.reindexResult?.documentsIndexed).toBe(2);
    });

    it('emits source.profile.changed', async () => {
      await service.assignProfile('articles', 'customer-support', { applyStrategy: 'stage' });
      expect(events.events.some((e) => e.name === 'rag.source.profile.changed')).toBe(true);
    });

    it('is a no-op when assigning to the same profile', async () => {
      await service.assignProfile('articles', 'default', { applyStrategy: 'apply-immediately' });
      expect(indexingService.syncSource).not.toHaveBeenCalled();
    });

    it('removes the source documents from the previous profile on stage and reindex-and-activate', async () => {
      await service.assignProfile('articles', 'customer-support', { applyStrategy: 'stage' });
      expect(indexingService.removeSourceDocuments).toHaveBeenCalledWith('default', 'articles');

      indexingService.removeSourceDocuments.mockClear();
      await service.assignProfile('articles', 'default', { applyStrategy: 'reindex-and-activate' });
      expect(indexingService.removeSourceDocuments).toHaveBeenCalledWith('customer-support', 'articles');
    });

    it('does not remove documents on validate-only', async () => {
      await service.assignProfile('articles', 'customer-support', { applyStrategy: 'validate-only' });
      expect(indexingService.removeSourceDocuments).not.toHaveBeenCalled();
    });

    it('reindex-and-activate keeps the binding and the old documents when the sync reports FAILED', async () => {
      indexingService.syncSource.mockResolvedValue({
        sourceName: 'articles',
        status: RagOperationStatus.FAILED,
        recordsProcessed: 2,
        documentsIndexed: 0,
        documentsRemoved: 0,
        chunksCreated: 0,
        embeddingsCreated: 0,
        failures: 2,
        errors: [{ externalId: '1', message: 'embedding provider unavailable' }],
        results: [],
      });

      await expect(
        service.assignProfile('articles', 'customer-support', { applyStrategy: 'reindex-and-activate' }),
      ).rejects.toThrow(RagSourceConfigurationError);

      const source = await service.getSource('articles');
      expect(source.profileName).toBe('default');
      expect(indexingService.removeSourceDocuments).toHaveBeenCalledWith('customer-support', 'articles');
      expect(indexingService.removeSourceDocuments).not.toHaveBeenCalledWith('default', 'articles');
      expect(events.events.some((e) => e.name === 'rag.source.profile.changed')).toBe(false);
    });

    it('reindex-and-activate discards a partial target copy and keeps the old serving copy', async () => {
      indexingService.syncSource.mockResolvedValue({
        sourceName: 'articles',
        status: RagOperationStatus.COMPLETED_WITH_ERRORS,
        recordsProcessed: 2,
        documentsIndexed: 1,
        documentsRemoved: 0,
        chunksCreated: 2,
        embeddingsCreated: 0,
        failures: 1,
        errors: [{ externalId: '2', message: 'embedding provider unavailable' }],
        results: [],
      });

      await expect(
        service.assignProfile('articles', 'customer-support', { applyStrategy: 'reindex-and-activate' }),
      ).rejects.toThrow(RagSourceConfigurationError);

      expect((await service.getSource('articles')).profileName).toBe('default');
      expect(indexingService.removeSourceDocuments).toHaveBeenCalledWith('customer-support', 'articles');
      expect(indexingService.removeSourceDocuments).not.toHaveBeenCalledWith('default', 'articles');
    });

    it('reindex-and-activate keeps the binding and the old documents when the sync throws', async () => {
      indexingService.syncSource.mockRejectedValue(new Error('provider connection refused'));

      await expect(
        service.assignProfile('articles', 'customer-support', { applyStrategy: 'reindex-and-activate' }),
      ).rejects.toThrow('provider connection refused');

      const source = await service.getSource('articles');
      expect(source.profileName).toBe('default');
      expect(indexingService.removeSourceDocuments).toHaveBeenCalledWith('customer-support', 'articles');
      expect(indexingService.removeSourceDocuments).not.toHaveBeenCalledWith('default', 'articles');
      expect(events.events.some((e) => e.name === 'rag.source.profile.changed')).toBe(false);
    });
  });

  describe('updateSourceOverrides', () => {
    it('rejects apply-immediately for a chunking override (always requires re-sync)', async () => {
      await expect(
        service.updateSourceOverrides('articles', { chunking: { chunkSize: 999 } }, { applyStrategy: 'apply-immediately' }),
      ).rejects.toThrow(RagReindexRequiredError);
    });

    it('stage persists the override without syncing', async () => {
      await service.updateSourceOverrides('articles', { chunking: { chunkSize: 999 } }, { applyStrategy: 'stage' });
      const source = await service.getSource('articles');
      expect(source.chunkingOverrides).toEqual({ chunkSize: 999 });
      expect(indexingService.syncSource).not.toHaveBeenCalled();
    });

    it('reindex-and-activate persists and re-syncs', async () => {
      const result = await service.updateSourceOverrides(
        'articles',
        { chunking: { chunkSize: 999 } },
        { applyStrategy: 'reindex-and-activate' },
      );
      expect(indexingService.syncSource).toHaveBeenCalled();
      expect(result.reindexResult).toBeDefined();
    });

    it('rejects overrides that change the embedding identity (provider/model/dimensions/providerOptions)', async () => {
      await expect(
        service.updateSourceOverrides(
          'articles',
          { retrieval: { embedding: { modelId: 'other-model' } as any } },
          { applyStrategy: 'stage' },
        ),
      ).rejects.toThrow(/must not override retrieval\.embedding/);
      await expect(
        service.updateSourceOverrides(
          'articles',
          { retrieval: { embedding: { dimensions: 768 } as any } },
          { applyStrategy: 'stage' },
        ),
      ).rejects.toThrow(/must not override retrieval\.embedding/);
    });

    it('still allows a per-source embedding batchSize override', async () => {
      await service.updateSourceOverrides(
        'articles',
        { retrieval: { embedding: { batchSize: 25 } as any } },
        { applyStrategy: 'stage' },
      );
      const source = await service.getSource('articles');
      expect(source.retrievalOverrides).toEqual({ embedding: { batchSize: 25 } });
    });

    it('rejects a structurally invalid chunking override (overlap >= chunk size)', async () => {
      await expect(
        service.updateSourceOverrides('articles', { chunking: { chunkSize: 10 } }, { applyStrategy: 'stage' }),
      ).rejects.toThrow(/invalid effective configuration/);
      const source = await service.getSource('articles');
      expect(source.chunkingOverrides).toBeUndefined();
    });

    it('rejects a non-positive chunk size override', async () => {
      await expect(
        service.updateSourceOverrides('articles', { chunking: { chunkSize: -5 } }, { applyStrategy: 'stage' }),
      ).rejects.toThrow(/invalid effective configuration/);
    });

    it('rejects an unknown retrieval mode override', async () => {
      await expect(
        service.updateSourceOverrides(
          'articles',
          { retrieval: { defaultMode: 'not-a-mode' as any } },
          { applyStrategy: 'stage' },
        ),
      ).rejects.toThrow(/invalid effective configuration/);
    });

    it('rejects a non-positive embedding batch-size override', async () => {
      await expect(
        service.updateSourceOverrides(
          'articles',
          { retrieval: { embedding: { batchSize: 0 } as any } },
          { applyStrategy: 'stage' },
        ),
      ).rejects.toThrow(/invalid effective configuration/);
    });

    it('rejects an empty lexical language override', async () => {
      await expect(
        service.updateSourceOverrides(
          'articles',
          { retrieval: { lexical: { language: '  ' } } },
          { applyStrategy: 'stage' },
        ),
      ).rejects.toThrow(/invalid effective configuration/);
    });

    it('rejects a negative hybrid weight override', async () => {
      await expect(
        service.updateSourceOverrides(
          'articles',
          { retrieval: { defaultMode: RagRetrievalMode.HYBRID, hybrid: { lexicalWeight: -1 } } },
          { applyStrategy: 'stage' },
        ),
      ).rejects.toThrow(/invalid effective configuration/);
    });

    it('merges successive overrides rather than replacing them wholesale', async () => {
      await service.updateSourceOverrides('articles', { chunking: { chunkSize: 999 } }, { applyStrategy: 'stage' });
      await service.updateSourceOverrides('articles', { retrieval: { defaultMode: RagRetrievalMode.LEXICAL } }, { applyStrategy: 'stage' });
      const source = await service.getSource('articles');
      expect(source.chunkingOverrides).toEqual({ chunkSize: 999 });
      expect(source.retrievalOverrides).toEqual({ defaultMode: RagRetrievalMode.LEXICAL });
    });
  });

  describe('clearSourceOverrides', () => {
    it('clears persisted overrides on stage', async () => {
      await service.updateSourceOverrides('articles', { chunking: { chunkSize: 999 } }, { applyStrategy: 'stage' });
      await service.clearSourceOverrides('articles', { applyStrategy: 'stage' });
      const source = await service.getSource('articles');
      expect(source.chunkingOverrides).toBeUndefined();
    });

    it('rejects apply-immediately', async () => {
      await expect(service.clearSourceOverrides('articles', { applyStrategy: 'apply-immediately' })).rejects.toThrow(
        RagReindexRequiredError,
      );
    });
  });

  describe('seedBindings', () => {
    it('seeds a binding for a registered source that has none yet, without touching existing bindings', async () => {
      registry.register({ name: 'faq', kind: 'table', defaultProfileName: 'support' } as any);
      await service.seedBindings();
      const faqBinding = await service.getSource('faq');
      expect(faqBinding.profileName).toBe('support');
      const articlesBinding = await service.getSource('articles');
      expect(articlesBinding.profileName).toBe('default'); // untouched
    });

    it('rejects invalid code-supplied overrides before persisting a binding', async () => {
      registry.register({
        name: 'broken',
        kind: 'table',
        defaultProfileName: 'support',
        defaultChunkingOverrides: { chunkSize: 10 },
      } as any);

      await expect(service.seedBindings()).rejects.toThrow(RagSourceConfigurationError);
      expect(await ctx.repos.sourceBinding.findOne({ where: { sourceName: 'broken' } })).toBeNull();
    });
  });
});
