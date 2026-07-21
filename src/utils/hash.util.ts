import { createHash } from 'node:crypto';

/**
 * Deterministically stringifies a value: object keys are sorted recursively
 * so two configurations that differ only in key order still hash equal.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Hash used as `RagProfileRevision.configurationHash`. */
export function hashConfiguration(configuration: unknown): string {
  return sha256Hex(canonicalStringify(configuration));
}

/** Hash used to detect unchanged source content between syncs. */
export function hashContent(content: string): string {
  return sha256Hex(content);
}

/**
 * Hash that uniquely identifies "this exact content, chunked and embedded
 * this exact way". Any change to content, chunking, or embedding
 * configuration (including per-operation overrides) changes this hash,
 * which is how the package detects when a direct-ingestion document needs
 * explicit re-indexing after a profile change.
 */
export function hashIndexingInputs(parts: {
  contentHash: string;
  profileRevisionId: string;
  chunkingOverrides?: unknown;
}): string {
  return sha256Hex(
    canonicalStringify({
      contentHash: parts.contentHash,
      profileRevisionId: parts.profileRevisionId,
      chunkingOverrides: parts.chunkingOverrides ?? null,
    }),
  );
}
