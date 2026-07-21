import { RagValidationError } from '../errors';

/** Conservative whitelist for anything that ends up interpolated into raw SQL (table/column/index names). */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Whitelist for a postgres regconfig name (lexical search language), e.g. "english", "simple". */
const SAFE_REGCONFIG = /^[a-z][a-z_]{0,63}$/;

export function assertSafeIdentifier(value: string, kind = 'identifier'): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new RagValidationError([`Invalid ${kind} "${value}": must match ${SAFE_IDENTIFIER}`]);
  }
  return value;
}

export function assertSafeTablePrefix(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)) {
    throw new RagValidationError([
      `Invalid table prefix "${value}": must start with a letter/underscore and contain only letters, digits, underscores.`,
    ]);
  }
  return value;
}

export function assertSafeRegconfig(value: string): string {
  const normalized = value.toLowerCase();
  if (!SAFE_REGCONFIG.test(normalized)) {
    throw new RagValidationError([
      `Invalid lexical search language "${value}": must be a simple lowercase word (a Postgres text search configuration name).`,
    ]);
  }
  return normalized;
}

/** Names sourced from downstream application config (source names, profile names). Alphanumeric + dash/underscore only. */
export function assertSafeName(value: string, kind = 'name'): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)) {
    throw new RagValidationError([
      `Invalid ${kind} "${value}": must be alphanumeric and may contain "-"/"_", max 200 chars.`,
    ]);
  }
  return value;
}
