import { DataSource, EntitySchema } from 'typeorm';
import { EntitySourceProvider } from '../../../src/source/providers/entity-source.provider';
import { TableSourceProvider } from '../../../src/source/providers/table-source.provider';
import { mapRecordToSourceRecord } from '../../../src/source/mapping.util';

interface ArticleRow {
  id: number;
  title: string;
  body: string;
  category: string;
  language: string;
  isPublished: boolean;
}

const ArticleSchema = new EntitySchema<ArticleRow>({
  name: 'Article',
  tableName: 'articles',
  columns: {
    id: { type: 'int', primary: true, generated: true },
    title: { type: 'varchar' },
    body: { type: 'text' },
    category: { type: 'varchar' },
    language: { type: 'varchar' },
    isPublished: { type: 'boolean', name: 'is_published' },
  },
});

describe('mapRecordToSourceRecord', () => {
  it('joins labeled content fields and collects metadata columns', () => {
    const record = mapRecordToSourceRecord(
      { id: 1, title: 'Install guide', summary: 'Quick steps', category: 'networking', language: 'en' },
      {
        id: 'id',
        content: [{ column: 'title', label: 'Title' }, { column: 'summary', label: 'Summary' }],
        metadata: ['category', 'language'],
      },
      'kb',
    );
    expect(record.externalId).toBe('1');
    expect(record.content).toBe('Title: Install guide\n\nSummary: Quick steps');
    expect(record.metadata).toEqual({ category: 'networking', language: 'en' });
  });

  it('applies a namespace prefix', () => {
    const record = mapRecordToSourceRecord(
      { id: 1, title: 'x', language: 'en' },
      { id: 'id', content: ['title'], namespace: { column: 'language', prefix: 'kb-' } },
      'kb',
    );
    expect(record.namespace).toBe('kb-en');
  });

  it('throws when the id column is missing', () => {
    expect(() => mapRecordToSourceRecord({ title: 'x' }, { id: 'id', content: ['title'] }, 'kb')).toThrow();
  });
});

describe('EntitySourceProvider', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [ArticleSchema], synchronize: true });
    await dataSource.initialize();
    const repo = dataSource.getRepository(ArticleSchema);
    await repo.save([
      { title: 'Router setup', body: 'How to set up your router', category: 'networking', language: 'en', isPublished: true },
      { title: 'Billing FAQ', body: 'Answers about billing', category: 'billing', language: 'en', isPublished: true },
    ]);
  });

  afterEach(() => dataSource.destroy());

  it('paginates records and maps them via the mapping', async () => {
    const provider = new EntitySourceProvider('articles', dataSource, ArticleSchema, {
      id: 'id',
      content: [{ column: 'title' }, { column: 'body' }],
      metadata: ['category', 'language'],
    });
    const page = await provider.fetchRecords({ cursor: null, batchSize: 10 });
    expect(page.records).toHaveLength(2);
    expect(page.records[0].content).toContain('Router setup');
    expect(page.nextCursor).toBeNull();
  });

  it('applies a filter.where clause', async () => {
    const provider = new EntitySourceProvider(
      'articles',
      dataSource,
      ArticleSchema,
      { id: 'id', content: [{ column: 'title' }], metadata: ['category'] },
      { where: { category: 'billing' } },
    );
    const page = await provider.fetchRecords({ cursor: null, batchSize: 10 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0].metadata?.category).toBe('billing');
  });

  it('fetchRecord retrieves a single record by id', async () => {
    const provider = new EntitySourceProvider('articles', dataSource, ArticleSchema, { id: 'id', content: [{ column: 'title' }] });
    const record = await provider.fetchRecord('1');
    expect(record?.externalId).toBe('1');
  });
});

describe('EntitySourceProvider with a TypeORM soft-delete column', () => {
  interface SoftDeleteArticleRow {
    id: number;
    title: string;
    deletedAt: Date | null;
  }

  const SoftDeleteArticleSchema = new EntitySchema<SoftDeleteArticleRow>({
    name: 'SoftDeleteArticle',
    tableName: 'soft_delete_articles',
    columns: {
      id: { type: 'int', primary: true, generated: true },
      title: { type: 'varchar' },
      deletedAt: { type: 'datetime', deleteDate: true, nullable: true },
    },
  });

  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [SoftDeleteArticleSchema],
      synchronize: true,
    });
    await dataSource.initialize();
    const repo = dataSource.getRepository(SoftDeleteArticleSchema);
    await repo.save([{ title: 'kept' }, { title: 'removed' }]);
    await repo.softDelete(2);
  });

  afterEach(() => dataSource.destroy());

  it('surfaces soft-deleted rows as tombstones when the mapping declares deletedAt', async () => {
    const provider = new EntitySourceProvider('soft-articles', dataSource, SoftDeleteArticleSchema, {
      id: 'id',
      content: [{ column: 'title' }],
      deletedAt: 'deletedAt',
    });
    const page = await provider.fetchRecords({ cursor: null, batchSize: 10 });
    expect(page.records).toHaveLength(2);
    const deleted = page.records.find((r) => r.externalId === '2');
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
    expect(page.records.find((r) => r.externalId === '1')?.deletedAt).toBeNull();
  });

  it('fetchRecord also observes the tombstone of a soft-deleted row', async () => {
    const provider = new EntitySourceProvider('soft-articles', dataSource, SoftDeleteArticleSchema, {
      id: 'id',
      content: [{ column: 'title' }],
      deletedAt: 'deletedAt',
    });
    const record = await provider.fetchRecord('2');
    expect(record).not.toBeNull();
    expect(record?.deletedAt).toBeInstanceOf(Date);
  });

  it('keeps excluding soft-deleted rows when the mapping declares no deletedAt column', async () => {
    const provider = new EntitySourceProvider('soft-articles', dataSource, SoftDeleteArticleSchema, {
      id: 'id',
      content: [{ column: 'title' }],
    });
    const page = await provider.fetchRecords({ cursor: null, batchSize: 10 });
    expect(page.records.map((r) => r.externalId)).toEqual(['1']);
    expect(await provider.fetchRecord('2')).toBeNull();
  });
});

describe('TableSourceProvider', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
    await dataSource.query(
      `CREATE TABLE support_faq (faq_id INTEGER PRIMARY KEY, question TEXT, answer TEXT, product_code TEXT, is_active BOOLEAN)`,
    );
    await dataSource.query(
      `INSERT INTO support_faq (faq_id, question, answer, product_code, is_active) VALUES (1, 'How do I reset?', 'Hold the button', 'router-1', 1), (2, 'Refund policy?', 'Within 30 days', 'billing', 1)`,
    );
  });

  afterEach(() => dataSource.destroy());

  it('reads rows from a raw table via a validated column mapping', async () => {
    const provider = new TableSourceProvider('support-faq', dataSource, 'support_faq', {
      id: 'faq_id',
      content: [{ column: 'question', label: 'Question' }, { column: 'answer', label: 'Answer' }],
      metadata: ['product_code'],
    });
    const page = await provider.fetchRecords({ cursor: null, batchSize: 10 });
    expect(page.records).toHaveLength(2);
    expect(page.records[0].content).toContain('Question: How do I reset?');
  });

  it('rejects an unsafe table name at construction time', () => {
    expect(
      () =>
        new TableSourceProvider('bad', dataSource, 'support_faq; DROP TABLE support_faq;--', {
          id: 'faq_id',
          content: ['question'],
        }),
    ).toThrow();
  });

  it('rejects an unsafe column name at construction time', () => {
    expect(
      () => new TableSourceProvider('bad', dataSource, 'support_faq', { id: 'faq_id', content: ['question; DROP TABLE x'] }),
    ).toThrow();
  });

  it('validateSchema detects a missing table', async () => {
    const provider = new TableSourceProvider('missing', dataSource, 'does_not_exist', { id: 'id', content: ['x'] });
    await expect(provider.validateSchema()).rejects.toThrow();
  });

  it('validateSchema passes for a correctly mapped table', async () => {
    const provider = new TableSourceProvider('support-faq', dataSource, 'support_faq', {
      id: 'faq_id',
      content: ['question', 'answer'],
      metadata: ['product_code'],
    });
    await expect(provider.validateSchema()).resolves.toBeUndefined();
  });
});
