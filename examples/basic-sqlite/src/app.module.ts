import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RagDatabaseType, RagModule } from '@scope/nestjs-rag';
import { KnowledgeArticle } from './knowledge-article.entity';

@Module({
  imports: [
    // RagModule contributes its own tables (rag_profiles, rag_documents, ...)
    // to this connection; `autoLoadEntities: true` is what lets it do that
    // without RagModule ever creating or owning a DataSource itself.
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: 'example.sqlite',
      entities: [KnowledgeArticle],
      autoLoadEntities: true,
      synchronize: true, // dev/demo only — creates `knowledge_articles`; use migrations in production
    }),

    RagModule.forRoot({
      database: {
        type: RagDatabaseType.SQLITE,
        tablePrefix: 'rag_',
      },
      schema: {
        // Dev/demo only — production deployments should run the generated
        // migrations instead (see src/migrations in the package).
        autoInitialize: true,
      },
      configuration: {
        defaultProfileName: 'default',
        createDefaultProfile: true,
      },
      // An entity source: RagModule reads KnowledgeArticle rows through a
      // declarative column mapping. No embedding provider is registered
      // here because SQLite only supports lexical retrieval.
      sources: [
        {
          name: 'knowledge-articles',
          entity: KnowledgeArticle,
          mapping: {
            id: 'id',
            content: [
              { column: 'title', label: 'Title' },
              { column: 'content', label: 'Content' },
            ],
            metadata: ['category', 'language'],
            namespace: { column: 'language' },
            updatedAt: 'updatedAt',
          },
        },
      ],
    }),
  ],
})
export class AppModule {}
