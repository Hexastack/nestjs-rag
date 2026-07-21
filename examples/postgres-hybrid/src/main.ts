import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  RagChunkingStrategy,
  RagConfigurationService,
  RagRetrievalMode,
  RagService,
  RagSourceConfigurationService,
} from '@scope/nestjs-rag';
import type { DataSource } from 'typeorm';
import { AppModule } from './app.module';

async function seedSupportFaqTable(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS support_faq (
      faq_id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      category VARCHAR(100),
      product_code VARCHAR(100),
      is_active BOOLEAN DEFAULT true,
      updated_at TIMESTAMP DEFAULT now()
    )
  `);
  const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int as count FROM support_faq`);
  if (count === 0) {
    await dataSource.query(`
      INSERT INTO support_faq (question, answer, category, product_code, is_active) VALUES
      ('How do I install the fiber router?', 'Connect the ONT to the router WAN port and power both on.', 'networking', 'router-1', true),
      ('What is your refund policy?', 'Refunds are issued within 30 days of purchase.', 'billing', 'general', true)
    `);
  }
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const dataSource = app.get<DataSource>(getDataSourceToken());
  await seedSupportFaqTable(dataSource);

  const configurationService = app.get(RagConfigurationService);
  const sourceConfigurationService = app.get(RagSourceConfigurationService);
  const ragService = app.get(RagService);

  // Create a second, independent profile (design doc section 3: multiple profiles).
  console.log('Creating "customer-support" profile (hybrid retrieval)...');
  await configurationService.createProfile({
    name: 'customer-support',
    configuration: {
      name: 'customer-support',
      retrieval: {
        defaultMode: RagRetrievalMode.HYBRID,
        lexical: { language: 'english' },
        embedding: { providerId: 'openai', modelId: 'text-embedding-3-small', dimensions: 1536, batchSize: 100 },
        hybrid: { strategy: 'rrf', rrfK: 60, lexicalWeight: 1, embeddingWeight: 1 },
      },
      chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 512, chunkOverlap: 64 },
      searchDefaults: { topK: 10, candidateLimit: 50 },
    },
  });

  // Move the support-faq source from "default" onto "customer-support" and
  // index it in the same call (design doc section 13).
  console.log('Assigning "support-faq" to the "customer-support" profile...');
  await sourceConfigurationService.assignProfile('support-faq', 'customer-support', {
    applyStrategy: 'reindex-and-activate',
  });

  console.log('\nSearching (hybrid) "install fiber router"...');
  const results = await ragService.search('install fiber router', {
    profileName: 'customer-support',
    sources: ['support-faq'],
    topK: 5,
  });
  for (const result of results) {
    console.log(
      `  [${result.score.toFixed(4)}] lex#${result.lexicalRank ?? '-'} emb#${result.embeddingRank ?? '-'} ${result.chunk.content.slice(0, 70)}`,
    );
  }

  // Preview before committing to a change (design doc section 6).
  const preview = await configurationService.previewUpdate('customer-support', {
    retrieval: { embedding: { modelId: 'text-embedding-3-large', dimensions: 3072 } },
  });
  console.log(`\nPreview: changing to text-embedding-3-large/3072 => impact "${preview.impact}"`);

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
