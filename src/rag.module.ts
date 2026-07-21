import { DynamicModule, Module, Provider } from '@nestjs/common';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import {
  DEFAULT_PROFILE_NAME,
  DEFAULT_TABLE_PREFIX,
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
} from './constants';
import { RagDatabaseType } from './enums';
import { createEntitySchemas } from './entities/schemas';
import { RagSchemaService } from './entities/rag-schema.service';
import {
  RagDatabaseOptions,
  RagModuleAsyncOptions,
  RagModuleOptions,
  RagOptionsFactory,
} from './interfaces/module-options.interface';
import { RagResolvedModuleContext } from './module-context';
import { assertSafeTablePrefix } from './utils/identifier.util';
import { RagConfigurationService } from './config/rag-configuration.service';
import { RagEmbeddingProviderRegistry } from './providers/embedding-provider-registry';
import { RagEmbeddingService } from './providers/embedding.service';
import { ChonkieChunkerFactory } from './chunking/chonkie-chunker.factory';
import { buildSourceWiring, RagSourceRegistry } from './source/source-registry';
import { RagSourceConfigurationService } from './source/rag-source-configuration.service';
import { RagIndexingService } from './indexing/rag-indexing.service';
import { RagSearchService } from './search/rag-search.service';
import { RagService } from './rag.service';
import { RagBootstrapService } from './rag-bootstrap.service';

const RAG_ASYNC_MODULE_OPTIONS = Symbol('RAG_ASYNC_MODULE_OPTIONS');
type RagAsyncResolvedOptions = Omit<RagModuleOptions, 'database'>;

/**
 * Registers RAG indexing/retrieval capabilities against an *existing*
 * TypeORM connection. See the README for the full configuration reference —
 * in short: `RagModule.forRoot()`/`forRootAsync()` only ever carry static
 * infrastructure (database, schema management, provider factories, initial
 * bootstrap flags, source wiring). Everything operational (embedding
 * provider/model/dimensions, chunking, hybrid weights, ...) is managed at
 * runtime through `RagConfigurationService`, persisted as versioned profile
 * revisions — never re-supplied here after the app has booted.
 */
@Module({})
export class RagModule {
  static forRoot(options: RagModuleOptions): DynamicModule {
    const asyncOptionsProvider: Provider = {
      provide: RAG_ASYNC_MODULE_OPTIONS,
      useValue: stripDatabase(options),
    };
    return RagModule.build(options.database, options.schema?.createVectorExtension ?? false, [asyncOptionsProvider], []);
  }

  static forRootAsync(options: RagModuleAsyncOptions): DynamicModule {
    const asyncProviders = RagModule.createAsyncOptionsProviders(options);
    return RagModule.build(
      options.database,
      options.schema?.createVectorExtension ?? false,
      asyncProviders,
      options.imports ?? [],
    );
  }

  private static createAsyncOptionsProviders(options: RagModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: RAG_ASYNC_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const inject = options.useExisting ?? options.useClass;
    if (!inject) {
      throw new Error('RagModule.forRootAsync() requires one of useFactory, useClass, or useExisting.');
    }
    const providers: Provider[] = [
      {
        provide: RAG_ASYNC_MODULE_OPTIONS,
        useFactory: async (factory: RagOptionsFactory) => stripDatabase(await factory.createRagOptions()),
        inject: [inject],
      },
    ];
    if (options.useClass) {
      providers.push({ provide: options.useClass, useClass: options.useClass });
    }
    return providers;
  }

  private static build(
    database: RagDatabaseOptions,
    syncCreateVectorExtension: boolean,
    optionsProviders: Provider[],
    extraImports: DynamicModule['imports'] = [],
  ): DynamicModule {
    const tablePrefix = assertSafeTablePrefix(database.tablePrefix ?? DEFAULT_TABLE_PREFIX);
    const vectorColumnEnabled = database.type === RagDatabaseType.POSTGRES && syncCreateVectorExtension;
    const schemas = createEntitySchemas(tablePrefix, database.type, vectorColumnEnabled);
    const dataSourceToken = getDataSourceToken(database.dataSourceName);

    const repositoryAliasProviders: Provider[] = [
      { provide: RAG_PROFILE_REPOSITORY, useExisting: getRepositoryToken(schemas.profile, database.dataSourceName) },
      {
        provide: RAG_PROFILE_REVISION_REPOSITORY,
        useExisting: getRepositoryToken(schemas.profileRevision, database.dataSourceName),
      },
      {
        provide: RAG_SOURCE_BINDING_REPOSITORY,
        useExisting: getRepositoryToken(schemas.sourceBinding, database.dataSourceName),
      },
      { provide: RAG_DOCUMENT_REPOSITORY, useExisting: getRepositoryToken(schemas.document, database.dataSourceName) },
      { provide: RAG_CHUNK_REPOSITORY, useExisting: getRepositoryToken(schemas.chunk, database.dataSourceName) },
      {
        provide: RAG_CHUNK_EMBEDDING_REPOSITORY,
        useExisting: getRepositoryToken(schemas.chunkEmbedding, database.dataSourceName),
      },
    ];

    const resolvedOptionsProvider: Provider = {
      provide: RAG_RESOLVED_OPTIONS,
      useFactory: (rest: RagAsyncResolvedOptions): RagResolvedModuleContext => {
        // `createVectorExtension` decides the embedding column's type at
        // module *definition* time — an async factory returning a different
        // value could never take effect, so fail loudly instead of silently
        // ignoring it.
        const asyncFlag = rest.schema?.createVectorExtension;
        if (asyncFlag !== undefined && asyncFlag !== syncCreateVectorExtension) {
          throw new Error(
            'RagModule: schema.createVectorExtension returned from the async options factory ' +
              `(${asyncFlag}) conflicts with the synchronous top-level value (${syncCreateVectorExtension}). ` +
              'This flag must be passed synchronously (top-level in forRootAsync) because it decides the ' +
              'embedding column type before any async factory runs.',
          );
        }
        return {
          dbType: database.type,
          dataSourceName: database.dataSourceName,
          tablePrefix,
          autoInitialize: rest.schema?.autoInitialize ?? false,
          createVectorExtension: syncCreateVectorExtension,
          createVectorIndexes: rest.schema?.createVectorIndexes ?? true,
          vectorColumnEnabled,
          defaultProfileName: rest.configuration?.defaultProfileName ?? DEFAULT_PROFILE_NAME,
          createDefaultProfile: rest.configuration?.createDefaultProfile ?? true,
        };
      },
      inject: [RAG_ASYNC_MODULE_OPTIONS],
    };

    const dataSourceProvider: Provider = { provide: RAG_DATA_SOURCE, useExisting: dataSourceToken };

    const schemaServiceProvider: Provider = {
      provide: RAG_SCHEMA_SERVICE,
      useFactory: (dataSource: any, context: RagResolvedModuleContext) =>
        new RagSchemaService(dataSource, schemas, tablePrefix, database.type, {
          autoInitialize: context.autoInitialize,
          createVectorExtension: context.createVectorExtension,
          createVectorIndexes: context.createVectorIndexes,
        }),
      inject: [RAG_DATA_SOURCE, RAG_RESOLVED_OPTIONS],
    };

    const embeddingRegistryProvider: Provider = {
      provide: RagEmbeddingProviderRegistry,
      useFactory: (rest: RagAsyncResolvedOptions) => {
        const instances = (rest.providers?.embedding ?? []).map((entry) =>
          typeof entry === 'function' ? new (entry as new () => any)() : entry,
        );
        return new RagEmbeddingProviderRegistry(instances);
      },
      inject: [RAG_ASYNC_MODULE_OPTIONS],
    };

    const sourceRegistryProvider: Provider = {
      provide: RagSourceRegistry,
      useFactory: (rest: RagAsyncResolvedOptions, context: RagResolvedModuleContext) => {
        const registry = new RagSourceRegistry();
        for (const sourceOptions of rest.sources ?? []) {
          const wiring = buildSourceWiring(sourceOptions, context.defaultProfileName, (provider) => {
            if (!provider) return undefined;
            return typeof provider === 'function' ? new (provider as new () => any)() : provider;
          });
          registry.register(wiring);
        }
        return registry;
      },
      inject: [RAG_ASYNC_MODULE_OPTIONS, RAG_RESOLVED_OPTIONS],
    };

    const indexingServiceAlias: Provider = { provide: RAG_INDEXING_SERVICE, useExisting: RagIndexingService };

    return {
      module: RagModule,
      imports: [...extraImports, TypeOrmModule.forFeature(Object.values(schemas), database.dataSourceName)],
      providers: [
        ...optionsProviders,
        resolvedOptionsProvider,
        dataSourceProvider,
        ...repositoryAliasProviders,
        schemaServiceProvider,
        embeddingRegistryProvider,
        sourceRegistryProvider,
        indexingServiceAlias,
        ChonkieChunkerFactory,
        RagEmbeddingService,
        RagConfigurationService,
        RagIndexingService,
        RagSearchService,
        RagSourceConfigurationService,
        RagService,
        RagBootstrapService,
      ],
      exports: [
        RagService,
        RagConfigurationService,
        RagSourceConfigurationService,
        RagEmbeddingProviderRegistry,
        RagSourceRegistry,
      ],
    };
  }
}

function stripDatabase(options: RagModuleOptions | RagAsyncResolvedOptions): RagAsyncResolvedOptions {
  const { schema, configuration, providers, sources } = options as RagModuleOptions;
  return { schema, configuration, providers, sources };
}
