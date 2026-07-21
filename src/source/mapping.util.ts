import { RagSourceMapping } from '../interfaces/source.interface';
import { RagSourceRecord } from '../interfaces/source.interface';
import { RagSourceConfigurationError } from '../errors';

function toDate(value: unknown): Date | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value;
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Applies a declarative `RagSourceMapping` to one raw record (a TypeORM
 * entity instance, or a plain row object for table sources) and produces the
 * normalized shape the indexing pipeline consumes.
 */
export function mapRecordToSourceRecord(
  record: Record<string, unknown>,
  mapping: RagSourceMapping,
  sourceName: string,
): RagSourceRecord {
  const idValue = record[mapping.id];
  if (idValue === undefined || idValue === null) {
    throw new RagSourceConfigurationError(
      `Source "${sourceName}": record is missing its id column "${mapping.id}".`,
    );
  }

  const contentParts: string[] = [];
  for (const field of mapping.content) {
    const column = typeof field === 'string' ? field : field.column;
    const label = typeof field === 'string' ? undefined : field.label;
    const separator = typeof field === 'string' ? undefined : field.separator;
    const value = record[column];
    if (value === undefined || value === null || value === '') continue;
    const text = String(value);
    contentParts.push(label ? `${label}${separator ?? ': '}${text}` : text);
  }

  const metadata: Record<string, unknown> = {};
  for (const column of mapping.metadata ?? []) {
    if (record[column] !== undefined) {
      metadata[column] = record[column];
    }
  }

  let namespace: string | undefined;
  if (mapping.namespace) {
    if (typeof mapping.namespace === 'string') {
      const value = record[mapping.namespace];
      namespace = value === undefined || value === null ? undefined : String(value);
    } else {
      const value = record[mapping.namespace.column];
      const raw = value === undefined || value === null ? undefined : String(value);
      namespace = raw !== undefined ? `${mapping.namespace.prefix ?? ''}${raw}` : undefined;
    }
  }

  return {
    externalId: String(idValue),
    content: contentParts.join('\n\n'),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    namespace,
    updatedAt: mapping.updatedAt ? toDate(record[mapping.updatedAt]) : undefined,
    deletedAt: mapping.deletedAt ? (toDate(record[mapping.deletedAt]) ?? null) : null,
  };
}
