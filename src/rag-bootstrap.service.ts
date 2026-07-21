import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { RAG_RESOLVED_OPTIONS, RAG_SCHEMA_SERVICE } from './constants';
import { RagChunkingStrategy, RagRetrievalMode } from './enums';
import { RagSchemaService } from './entities/rag-schema.service';
import { RagProfileNotFoundError } from './errors';
import { RagResolvedModuleContext } from './module-context';
import { RagConfigurationService } from './config/rag-configuration.service';
import { RagSourceConfigurationService } from './source/rag-source-configuration.service';

/**
 * Sequences everything `RagModule` needs to do once, at application
 * bootstrap, in a well-defined order: (1) optional schema auto-init, (2)
 * optional default-profile creation, (3) seeding source bindings for any
 * source declared in `RagModule.forRoot({ sources })`. Consolidated into one
 * service instead of multiple independent `OnApplicationBootstrap` hooks so
 * ordering is explicit rather than relying on Nest's provider instantiation
 * order.
 */
@Injectable()
export class RagBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RagBootstrapService.name);

  constructor(
    @Inject(RAG_SCHEMA_SERVICE) private readonly schemaService: RagSchemaService,
    @Inject(RAG_RESOLVED_OPTIONS) private readonly context: RagResolvedModuleContext,
    private readonly configurationService: RagConfigurationService,
    private readonly sourceConfigurationService: RagSourceConfigurationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.schemaService.autoInitialize();

    if (this.context.createDefaultProfile) {
      await this.ensureDefaultProfile();
    }

    await this.sourceConfigurationService.seedBindings();
  }

  private async ensureDefaultProfile(): Promise<void> {
    const name = this.context.defaultProfileName;
    try {
      await this.configurationService.getProfile(name);
    } catch (error) {
      if (!(error instanceof RagProfileNotFoundError)) throw error;
      this.logger.log(`Creating default RAG profile "${name}" (lexical-only; configure it further via RagConfigurationService).`);
      await this.configurationService.createProfile({
        name,
        configuration: {
          name,
          description: 'Automatically created default profile.',
          retrieval: { defaultMode: RagRetrievalMode.LEXICAL },
          chunking: { strategy: RagChunkingStrategy.TOKEN, chunkSize: 512, chunkOverlap: 64 },
        },
      });
    }
  }
}
