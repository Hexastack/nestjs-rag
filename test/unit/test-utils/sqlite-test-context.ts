import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createEntitySchemas, RagEntitySchemas } from '../../../src/entities/schemas';
import { RagSchemaService } from '../../../src/entities/rag-schema.service';
import { RagDatabaseType } from '../../../src/enums';
import { RagResolvedModuleContext } from '../../../src/module-context';

export interface SqliteTestContext {
  dataSource: DataSource;
  schemas: RagEntitySchemas;
  schemaService: RagSchemaService;
  context: RagResolvedModuleContext;
  repos: {
    profile: ReturnType<DataSource['getRepository']>;
    profileRevision: ReturnType<DataSource['getRepository']>;
    sourceBinding: ReturnType<DataSource['getRepository']>;
    document: ReturnType<DataSource['getRepository']>;
    chunk: ReturnType<DataSource['getRepository']>;
    chunkEmbedding: ReturnType<DataSource['getRepository']>;
  };
  close(): Promise<void>;
}

/**
 * Builds a real, throwaway in-memory SQLite `DataSource` wired with the same
 * `EntitySchema`s and `RagSchemaService` bootstrap path RagModule uses in
 * production (`autoInitialize()`), so persistence-heavy unit tests
 * (revision immutability, atomic activation, concurrency) exercise real SQL
 * rather than a mocked repository.
 */
export async function createSqliteTestContext(tablePrefix = 'rag_'): Promise<SqliteTestContext> {
  const schemas = createEntitySchemas(tablePrefix, RagDatabaseType.SQLITE, false);
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: Object.values(schemas),
    synchronize: false,
    dropSchema: false,
  });
  await dataSource.initialize();

  const schemaService = new RagSchemaService(dataSource, schemas, tablePrefix, RagDatabaseType.SQLITE, {
    autoInitialize: true,
    createVectorExtension: false,
    createVectorIndexes: true,
  });
  await schemaService.autoInitialize();

  const context: RagResolvedModuleContext = {
    dbType: RagDatabaseType.SQLITE,
    tablePrefix,
    autoInitialize: true,
    createVectorExtension: false,
    createVectorIndexes: true,
    vectorColumnEnabled: false,
    defaultProfileName: 'default',
    createDefaultProfile: false,
  };

  return {
    dataSource,
    schemas,
    schemaService,
    context,
    repos: {
      profile: dataSource.getRepository(schemas.profile),
      profileRevision: dataSource.getRepository(schemas.profileRevision),
      sourceBinding: dataSource.getRepository(schemas.sourceBinding),
      document: dataSource.getRepository(schemas.document),
      chunk: dataSource.getRepository(schemas.chunk),
      chunkEmbedding: dataSource.getRepository(schemas.chunkEmbedding),
    },
    close: () => dataSource.destroy(),
  };
}
