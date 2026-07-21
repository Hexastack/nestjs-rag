import type { DataSource } from 'typeorm';

/**
 * Raw SQL issued by `RagSchemaService` and the Postgres search adapters
 * references tables by name directly (not through TypeORM's query builder,
 * which schema-qualifies automatically). When the host sets a non-default
 * `schema` on its `DataSourceOptions` (common for multi-tenant/namespaced
 * deployments), an unqualified `"rag_chunks"` resolves against the
 * connection's `search_path` — not necessarily the configured schema — and
 * raw queries fail with "relation does not exist" even though the table is
 * right there. Every raw-SQL table reference must go through this helper.
 */
export function qualifyTable(dataSource: DataSource, tableName: string): string {
  const schema = (dataSource.options as { schema?: string } | undefined)?.schema;
  return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
}
