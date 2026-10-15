export const BACKUP_TABLES = ['gems', 'products', 'product_images', 'tasks', 'reference_remix_tasks', 'reference_remix_assets', 'reference_remix_settings', 'script_pipeline_tasks', 'tiktok_accounts', 'approval_counts', 'provider_configs', 'provider_runtime', 'workspace_migrations', 'schedules'] as const;
type Row = Record<string, string | number | null>;
type Statement = { bind(...values: unknown[]): Statement; all(): Promise<{ results: Row[] }> };
type Database = { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<Array<{ results: Row[] }>> };

export async function exportTables(db: Database) {
  // D1 batch executes in one transaction; all tables share the same snapshot.
  const result = await db.batch(BACKUP_TABLES.map(name => db.prepare(`SELECT * FROM "${name}"`)));
  return Object.fromEntries(BACKUP_TABLES.map((name, index) => [name, result[index].results]));
}

export async function restoreTables(db: Database, tables: Record<string, Row[]>) {
  if (!tables || Object.keys(tables).sort().join() !== [...BACKUP_TABLES].sort().join()) throw new Error('备份业务表不完整或包含未知表');
  const schemas = await db.batch(BACKUP_TABLES.map(name => db.prepare(`PRAGMA table_info("${name}")`)));
  const statements: Statement[] = BACKUP_TABLES.map(name => db.prepare(`DELETE FROM "${name}"`));
  for (const [index, name] of BACKUP_TABLES.entries()) {
    const allowed = new Set(schemas[index].results.map(row => String(row.name)));
    if (!Array.isArray(tables[name])) throw new Error(`表 ${name} 格式错误`);
    for (const row of tables[name]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`表 ${name} 行格式错误`);
      const columns = Object.keys(row);
      if (!columns.length || columns.some(column => !allowed.has(column))) throw new Error(`表 ${name} 含不兼容字段`);
      const values = columns.map(column => row[column]);
      if (values.some(value => value !== null && !['string', 'number'].includes(typeof value))) throw new Error(`表 ${name} 含无效字段值`);
      statements.push(db.prepare(`INSERT INTO "${name}" (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...values));
    }
  }
  // Validation finishes before any delete, and batch rolls back on any error.
  await db.batch(statements);
  return Object.fromEntries(BACKUP_TABLES.map(name => [name, tables[name].length]));
}
