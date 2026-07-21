const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Used before interpolating an id into raw DDL, where placeholders aren't reliably supported. */
export function assertUuid(value: string, kind = 'id'): string {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid ${kind} "${value}": expected a UUID.`);
  }
  return value;
}
