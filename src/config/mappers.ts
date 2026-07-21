import { RagChangeImpact, RagRevisionStatus } from '../enums';
import { RagProfileRevisionRow, RagProfileRow } from '../entities/rows';
import { RagProfileConfiguration } from '../interfaces/profile.interface';
import { RagProfile, RagProfileRevision, RagSerializedError } from '../interfaces/revision.interface';

export function rowToProfile(row: RagProfileRow): RagProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    activeRevisionId: row.activeRevisionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToRevision(row: RagProfileRevisionRow): RagProfileRevision {
  return {
    id: row.id,
    profileName: row.profileName,
    revisionNumber: row.revisionNumber,
    status: row.status as RagRevisionStatus,
    configuration: row.configuration as RagProfileConfiguration,
    configurationHash: row.configurationHash,
    changeImpact: row.changeImpact as RagChangeImpact,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt ?? undefined,
    failedAt: row.failedAt ?? undefined,
    previousRevisionId: row.previousRevisionId ?? undefined,
    error: (row.error as RagSerializedError | null) ?? undefined,
  };
}

export function serializeError(error: unknown): RagSerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'Error', message: String(error) };
}
