import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RagDatabaseType, RagModule } from '@scope/nestjs-rag';
import { OpenAiEmbeddingProviderFactory } from './openai-embedding-provider.factory';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
      }),
    }),

    // `database` (and, if used, `schema.createVectorExtension`) must be
    // synchronous even with forRootAsync — see the README's "Known
    // limitations" section for why. Everything else (providers, sources,
    // bootstrap configuration) comes from the async factory below, which
    // can inject ConfigService/etc. the same way any other Nest provider
    // would.
    RagModule.forRootAsync({
      database: { type: RagDatabaseType.POSTGRES, tablePrefix: 'rag_' },
      schema: { createVectorExtension: true },
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        schema: {
          autoInitialize: false, // production: run the generated migrations instead
          createVectorIndexes: true,
        },
        configuration: {
          defaultProfileName: 'default',
          createDefaultProfile: true,
        },
        providers: {
          // Constructed here (not passed as a bare class) because it needs
          // ConfigService injected — see openai-embedding-provider.factory.ts.
          embedding: [new OpenAiEmbeddingProviderFactory(config)],
        },
        sources: [
          {
            name: 'support-faq',
            table: 'support_faq',
            namespace: 'support-faq',
            mapping: {
              id: 'faq_id',
              content: [
                { column: 'question', label: 'Question' },
                { column: 'answer', label: 'Answer' },
              ],
              metadata: ['category', 'product_code'],
              updatedAt: 'updated_at',
            },
            filter: { where: { is_active: true }, batchSize: 250 },
          },
        ],
      }),
    }),
  ],
})
export class AppModule {}
