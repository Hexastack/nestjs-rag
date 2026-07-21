import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { RagConfigurationService, RagRetrievalMode, RagService } from '@scope/nestjs-rag';
import type { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { KnowledgeArticle } from './knowledge-article.entity';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  // Seed a couple of application-owned rows the entity source will pick up.
  const dataSource = app.get<DataSource>(getDataSourceToken());
  const articles = dataSource.getRepository(KnowledgeArticle);
  if ((await articles.count()) === 0) {
    await articles.save([
      {
        title: 'Resetting your router',
        content: 'Hold the reset button on the back of the router for ten seconds until the lights blink.',
        category: 'networking',
        language: 'en',
      },
      {
        title: 'Understanding your invoice',
        content: 'Your monthly invoice breaks down usage charges, taxes, and any applicable discounts.',
        category: 'billing',
        language: 'en',
      },
    ]);
  }

  const ragService = app.get(RagService);
  const configurationService = app.get(RagConfigurationService);

  // Pull the seeded rows into the RAG index (design doc section 17: syncSource).
  console.log('Syncing "knowledge-articles" source...');
  const syncResult = await ragService.syncSource('knowledge-articles');
  console.log(`  indexed ${syncResult.documentsIndexed} document(s), ${syncResult.chunksCreated} chunk(s).`);

  // Direct ingestion works independently of any registered source.
  await ragService.ingest({
    externalId: 'faq-1',
    content: 'Fiber installation appointments are available Monday through Saturday.',
    metadata: { category: 'scheduling' },
  });

  console.log('\nSearching "router reset"...');
  const results = await ragService.search('router reset', { mode: RagRetrievalMode.LEXICAL, topK: 3 });
  for (const result of results) {
    console.log(`  [${result.score.toFixed(3)}] (${result.chunk.sourceName}) ${result.chunk.content.slice(0, 80)}...`);
  }

  // Runtime configuration: change chunking without touching forRoot() or restarting.
  console.log('\nStaging a chunk-size change and re-indexing...');
  const updateResult = await configurationService.updateProfile(
    'default',
    { chunking: { chunkSize: 120, chunkOverlap: 15 } },
    { applyStrategy: 'reindex-and-activate' },
  );
  console.log(`  new active revision: ${updateResult.revision.id} (status: ${updateResult.revision.status})`);

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
