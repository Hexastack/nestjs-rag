export class RagError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RagConfigurationError extends RagError {}

export class RagProviderNotFoundError extends RagConfigurationError {
  constructor(providerId: string) {
    super(`No embedding provider registered with id "${providerId}".`, { providerId });
  }
}

export class RagProfileNotFoundError extends RagConfigurationError {
  constructor(profileName: string) {
    super(`RAG profile "${profileName}" was not found.`, { profileName });
  }
}

export class RagProfileAlreadyExistsError extends RagConfigurationError {
  constructor(profileName: string) {
    super(`RAG profile "${profileName}" already exists.`, { profileName });
  }
}

export class RagProfileRevisionError extends RagConfigurationError {}

export class RagRevisionNotFoundError extends RagProfileRevisionError {
  constructor(profileName: string, revisionId: string) {
    super(`Revision "${revisionId}" was not found for profile "${profileName}".`, {
      profileName,
      revisionId,
    });
  }
}

export class RagConfigurationImpactError extends RagConfigurationError {}

export class RagReindexRequiredError extends RagConfigurationImpactError {
  constructor(reasons: string[]) {
    super(
      `The requested change requires re-indexing and cannot be applied immediately: ${reasons.join('; ')}`,
      { reasons },
    );
  }
}

export class RagSchemaChangeRequiredError extends RagConfigurationImpactError {
  constructor(reasons: string[]) {
    super(`The requested change requires a database schema change: ${reasons.join('; ')}`, {
      reasons,
    });
  }
}

export class RagEmbeddingDimensionError extends RagConfigurationError {}

export class RagProfileActivationError extends RagConfigurationError {}

export class RagConcurrencyError extends RagConfigurationError {
  constructor(profileName: string, expected: string, actual: string) {
    super(
      `Concurrent modification detected for profile "${profileName}": expected revision "${expected}" but active revision is "${actual}".`,
      { profileName, expected, actual },
    );
  }
}

export class RagSourceNotFoundError extends RagConfigurationError {
  constructor(sourceName: string) {
    super(`RAG source "${sourceName}" was not found.`, { sourceName });
  }
}

export class RagSourceConfigurationError extends RagConfigurationError {}

export class RagCapabilityError extends RagConfigurationError {}

export class RagValidationError extends RagConfigurationError {
  constructor(errors: string[]) {
    super(`RAG configuration validation failed: ${errors.join('; ')}`, { errors });
  }
}
