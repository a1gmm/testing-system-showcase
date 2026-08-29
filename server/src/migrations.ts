import type { DatabaseSync } from 'node:sqlite'

export type Migration = {
  id: string
  name: string
  up: (db: DatabaseSync) => void
}

export type MigrationResult = {
  applied: string[]
  current: string | null
}

const CREATE_LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`

function validateDefinitions(migrations: readonly Migration[]) {
  const seen = new Set<string>()
  for (const migration of migrations) {
    if (!migration.id.trim()) throw new Error('[迁移] migration id must not be empty')
    if (!migration.name.trim()) throw new Error(`[迁移] migration ${migration.id} name must not be empty`)
    if (seen.has(migration.id)) throw new Error(`[迁移] duplicate migration id: ${migration.id}`)
    seen.add(migration.id)
  }
}

export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  now: () => string = () => new Date().toISOString(),
): MigrationResult {
  validateDefinitions(migrations)
  db.exec(CREATE_LEDGER)

  const known = new Set(migrations.map(migration => migration.id))
  const appliedRows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[]
  const unknown = appliedRows.map(row => row.id).filter(id => !known.has(id))
  if (unknown.length) {
    throw new Error(`[迁移] unknown database migration(s): ${unknown.join(', ')}; refuse to run older application code`)
  }

  const alreadyApplied = new Set(appliedRows.map(row => row.id))
  const applied: string[] = []
  for (const migration of migrations) {
    if (alreadyApplied.has(migration.id)) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations(id,name,applied_at) VALUES(?,?,?)')
        .run(migration.id, migration.name, now())
      db.exec('COMMIT')
      applied.push(migration.id)
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* retain the migration failure as the primary cause */ }
      throw new Error(
        `[迁移] migration ${migration.id} (${migration.name}) failed: ${String((error as any)?.message || error)}`,
        { cause: error },
      )
    }
  }

  return { applied, current: migrations.at(-1)?.id ?? null }
}
