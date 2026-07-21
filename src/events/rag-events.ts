import { RagProfile, RagProfileRevision } from '../interfaces/revision.interface';

/**
 * Event name constants. Emitted through `@nestjs/event-emitter`'s
 * `EventEmitter2` (already a transitive Nest ecosystem dependency) — no
 * external broker is required. Payloads are scrubbed of credentials and raw
 * document content is never included.
 */
export const RagEventNames = {
  PROFILE_CREATED: 'rag.profile.created',
  PROFILE_REVISION_CREATED: 'rag.profile.revision.created',
  PROFILE_REVISION_INDEXING: 'rag.profile.revision.indexing',
  PROFILE_REVISION_READY: 'rag.profile.revision.ready',
  PROFILE_REVISION_ACTIVATED: 'rag.profile.revision.activated',
  PROFILE_REVISION_FAILED: 'rag.profile.revision.failed',
  PROFILE_ROLLED_BACK: 'rag.profile.rolled_back',
  SOURCE_PROFILE_CHANGED: 'rag.source.profile.changed',
  PROVIDER_REGISTERED: 'rag.provider.registered',
  PROVIDER_UNREGISTERED: 'rag.provider.unregistered',
} as const;

export interface RagProfileCreatedEvent {
  profile: RagProfile;
}

export interface RagProfileRevisionEvent {
  profileName: string;
  revision: RagProfileRevision;
}

export interface RagProfileRolledBackEvent {
  profileName: string;
  fromRevisionId: string;
  toRevisionId: string;
}

export interface RagSourceProfileChangedEvent {
  sourceName: string;
  previousProfileName: string;
  newProfileName: string;
}

export interface RagProviderEvent {
  providerId: string;
}
