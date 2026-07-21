import { Injectable } from '@nestjs/common';
import { RagDocumentInput, RagIngestOptions, RagIngestResult } from './interfaces/ingest.interface';
import {
  RagProfileReindexOptions,
  RagProfileReindexResult,
  RagSourceSyncOptions,
  RagSourceSyncResult,
} from './interfaces/reindex.interface';
import { RagSearchOptions, RagSearchResult } from './interfaces/search.interface';
import { RagIndexingService } from './indexing/rag-indexing.service';
import { RagSearchService } from './search/rag-search.service';

/**
 * The package's single public indexing + search facade (design doc section
 * 17). Configuration/profile/source management lives on
 * `RagConfigurationService`/`RagSourceConfigurationService` instead — this
 * class is deliberately limited to the operations a downstream application
 * runs on the hot path (ingest content, sync sources, search).
 */
@Injectable()
export class RagService {
  constructor(
    private readonly indexingService: RagIndexingService,
    private readonly searchService: RagSearchService,
  ) {}

  ingest(document: RagDocumentInput, options?: RagIngestOptions): Promise<RagIngestResult> {
    return this.indexingService.ingest(document, options);
  }

  ingestMany(documents: RagDocumentInput[], options?: RagIngestOptions): Promise<RagIngestResult[]> {
    return this.indexingService.ingestMany(documents, options);
  }

  syncSource(sourceName: string, options?: RagSourceSyncOptions): Promise<RagSourceSyncResult> {
    return this.indexingService.syncSource(sourceName, options);
  }

  syncAllSources(options?: RagSourceSyncOptions): Promise<RagSourceSyncResult[]> {
    return this.indexingService.syncAllSources(options);
  }

  indexSourceRecord(sourceName: string, sourceId: string | number): Promise<RagIngestResult> {
    return this.indexingService.indexSourceRecord(sourceName, sourceId);
  }

  removeSourceRecord(sourceName: string, sourceId: string | number): Promise<void> {
    return this.indexingService.removeSourceRecord(sourceName, sourceId);
  }

  reindexProfile(profileName: string, options?: RagProfileReindexOptions): Promise<RagProfileReindexResult> {
    return this.indexingService.reindexProfile(profileName, options);
  }

  reindexRevision(
    profileName: string,
    revisionId: string,
    options?: RagProfileReindexOptions,
  ): Promise<RagProfileReindexResult> {
    return this.indexingService.reindexRevision(profileName, revisionId, options);
  }

  search(query: string, options?: RagSearchOptions): Promise<RagSearchResult[]> {
    return this.searchService.search(query, options);
  }
}
