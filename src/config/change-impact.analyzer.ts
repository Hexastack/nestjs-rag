import { RagChangeImpact } from '../enums';
import { RagProfileConfiguration } from '../interfaces/profile.interface';
import { canonicalStringify } from '../utils/hash.util';

export interface RagChangeImpactResult {
  impact: RagChangeImpact;
  changedPaths: string[];
  reasons: string[];
  canApplyImmediately: boolean;
}

const SEVERITY: Record<RagChangeImpact, number> = {
  [RagChangeImpact.NONE]: 0,
  [RagChangeImpact.QUERY_ONLY]: 1,
  [RagChangeImpact.REINDEX_REQUIRED]: 2,
  [RagChangeImpact.SCHEMA_CHANGE_REQUIRED]: 3,
};

/**
 * Every path this analyzer knows how to classify, and the impact a change to
 * it carries. This table is the single source of truth for section 8 of the
 * design doc ("Change-impact detection") — see the README's
 * "Previewing configuration impact" section for the human-readable version.
 *
 * Any path not listed here that nonetheless differs between two
 * configurations is classified `REINDEX_REQUIRED` defensively: we would
 * rather over-flag an unrecognized structural change than silently apply it
 * (see "Do not apply a change silently when it invalidates existing chunks
 * or embeddings" in the design doc).
 */
const PATH_IMPACT: Record<string, RagChangeImpact> = {
  name: RagChangeImpact.NONE,
  description: RagChangeImpact.NONE,
  'retrieval.defaultMode': RagChangeImpact.QUERY_ONLY,
  'retrieval.lexical.language': RagChangeImpact.REINDEX_REQUIRED,
  'retrieval.embedding': RagChangeImpact.REINDEX_REQUIRED,
  'retrieval.embedding.providerId': RagChangeImpact.REINDEX_REQUIRED,
  'retrieval.embedding.modelId': RagChangeImpact.REINDEX_REQUIRED,
  'retrieval.embedding.dimensions': RagChangeImpact.SCHEMA_CHANGE_REQUIRED,
  'retrieval.embedding.batchSize': RagChangeImpact.QUERY_ONLY,
  'retrieval.embedding.providerOptions': RagChangeImpact.REINDEX_REQUIRED,
  'retrieval.hybrid.strategy': RagChangeImpact.QUERY_ONLY,
  'retrieval.hybrid.rrfK': RagChangeImpact.QUERY_ONLY,
  'retrieval.hybrid.lexicalWeight': RagChangeImpact.QUERY_ONLY,
  'retrieval.hybrid.embeddingWeight': RagChangeImpact.QUERY_ONLY,
  'chunking.strategy': RagChangeImpact.REINDEX_REQUIRED,
  'chunking.chunkSize': RagChangeImpact.REINDEX_REQUIRED,
  'chunking.chunkOverlap': RagChangeImpact.REINDEX_REQUIRED,
  'searchDefaults.topK': RagChangeImpact.QUERY_ONLY,
  'searchDefaults.candidateLimit': RagChangeImpact.QUERY_ONLY,
  'searchDefaults.minScore': RagChangeImpact.QUERY_ONLY,
};

/** Paths whose values are never included verbatim in human-readable reasons (may carry provider-specific settings). */
const OPAQUE_VALUE_PATHS = new Set(['retrieval.embedding.providerOptions', 'retrieval.embedding']);

function get(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  return canonicalStringify(a) === canonicalStringify(b);
}

function formatValue(path: string, value: unknown): string {
  if (OPAQUE_VALUE_PATHS.has(path)) {
    return value === undefined ? 'unset' : 'set';
  }
  if (value === undefined) return 'unset';
  if (typeof value === 'object') return canonicalStringify(value);
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Recursively collects every leaf path at which `a` and `b` differ. Used to
 * find changes at paths the classification table doesn't know about, so they
 * can be classified `REINDEX_REQUIRED` defensively instead of silently
 * ignored.
 */
function collectChangedLeafPaths(a: unknown, b: unknown, prefix: string, out: string[]): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      collectChangedLeafPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (!isEqual(a, b)) {
    out.push(prefix);
  }
}

/** True when `path` or one of its ancestors is covered by the classification table. */
function isCoveredByKnownPath(path: string): boolean {
  const segments = path.split('.');
  for (let i = segments.length; i > 0; i -= 1) {
    if (segments.slice(0, i).join('.') in PATH_IMPACT) return true;
  }
  return false;
}

/**
 * Deterministically diffs two profile configurations and classifies the
 * combined impact. Pure and synchronous — no I/O, no knowledge of which
 * sources are affected (the caller, `RagConfigurationService`, fills that
 * in from its own source registry).
 */
export function analyzeConfigurationChange(
  current: RagProfileConfiguration | null,
  proposed: RagProfileConfiguration,
): RagChangeImpactResult {
  if (!current) {
    return { impact: RagChangeImpact.NONE, changedPaths: [], reasons: [], canApplyImmediately: true };
  }

  const changedPaths: string[] = [];
  const reasons: string[] = [];
  let worst = RagChangeImpact.NONE;

  for (const path of Object.keys(PATH_IMPACT)) {
    const segments = path.split('.');
    const before = get(current, segments);
    const after = get(proposed, segments);
    if (!isEqual(before, after)) {
      changedPaths.push(path);
      const impact = PATH_IMPACT[path];
      if (SEVERITY[impact] > SEVERITY[worst]) {
        worst = impact;
      }
      if (impact !== RagChangeImpact.NONE) {
        reasons.push(
          `"${path}" changed from ${formatValue(path, before)} to ${formatValue(path, after)} (${impact}).`,
        );
      }
    }
  }

  // Defensive fallback: any changed path the classification table doesn't
  // cover (directly or via an ancestor, e.g. `retrieval.embedding.*` under
  // `retrieval.embedding`) is classified REINDEX_REQUIRED rather than
  // silently ignored — otherwise a future configuration field added without
  // a table entry could slip through `apply-immediately` and serve index
  // rows built under different settings.
  const allChangedPaths: string[] = [];
  collectChangedLeafPaths(current, proposed, '', allChangedPaths);
  for (const path of allChangedPaths) {
    if (isCoveredByKnownPath(path)) continue;
    changedPaths.push(path);
    if (SEVERITY[RagChangeImpact.REINDEX_REQUIRED] > SEVERITY[worst]) {
      worst = RagChangeImpact.REINDEX_REQUIRED;
    }
    reasons.push(
      `"${path}" changed but is not covered by the change-impact classification table; ` +
        `classified ${RagChangeImpact.REINDEX_REQUIRED} defensively.`,
    );
  }

  return {
    impact: worst,
    changedPaths,
    reasons,
    canApplyImmediately: worst === RagChangeImpact.NONE || worst === RagChangeImpact.QUERY_ONLY,
  };
}
