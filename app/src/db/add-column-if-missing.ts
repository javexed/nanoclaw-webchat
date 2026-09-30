import type Database from 'better-sqlite3';

/**
 * `ALTER TABLE <table> ADD COLUMN <columnDef>`, run only when the column (the
 * first word of columnDef) is absent: ADD COLUMN isn't idempotent, and the
 * guard also keeps an existing column's old default. True when it was added.
 */
export function addColumnIfMissing(db: Database.Database, table: string, columnDef: string): boolean {
  const column = columnDef.split(' ')[0];
  const has = (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).some(
    (c) => c.name === column,
  );
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  return !has;
}
