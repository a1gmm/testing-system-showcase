import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations, type Migration } from '../src/migrations.ts'
import { openDb } from '../src/db.ts'

const NOW = '2026-08-25T12:00:00.000Z'

test('applies pending migrations once and records an auditable ledger row', () => {
  const db = new DatabaseSync(':memory:')
  let applications = 0
  const migrations: Migration[] = [{
    id: '2026082501',
    name: 'create widgets',
    up(target) {
      applications += 1
      target.exec('CREATE TABLE widgets(id TEXT PRIMARY KEY)')
    },
  }]

  assert.deepEqual(runMigrations(db, migrations, () => NOW), { applied: ['2026082501'], current: '2026082501' })
  assert.deepEqual(runMigrations(db, migrations, () => NOW), { applied: [], current: '2026082501' })
  assert.equal(applications, 1)
  assert.deepEqual(
    db.prepare('SELECT id,name,applied_at FROM schema_migrations').all().map(row => ({ ...row })),
    [{ id: '2026082501', name: 'create widgets', applied_at: NOW }],
  )
})

test('rolls back migration work and ledger insertion when a migration fails', () => {
  const db = new DatabaseSync(':memory:')
  const migrations: Migration[] = [{
    id: '2026082501',
    name: 'broken migration',
    up(target) {
      target.exec('CREATE TABLE should_not_survive(id TEXT)')
      throw new Error('simulated failure')
    },
  }]

  assert.throws(() => runMigrations(db, migrations, () => NOW), /2026082501.*simulated failure/)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='should_not_survive'").get()!.count,
    0,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()!.count, 0)
})

test('rejects duplicate migration ids before creating the ledger', () => {
  const db = new DatabaseSync(':memory:')
  const duplicate: Migration[] = [
    { id: '2026082501', name: 'first', up() {} },
    { id: '2026082501', name: 'second', up() {} },
  ]

  assert.throws(() => runMigrations(db, duplicate, () => NOW), /duplicate migration id.*2026082501/i)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()!.count,
    0,
  )
})

test('fails closed when the database declares a migration unknown to this binary', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE schema_migrations(id TEXT PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(id,name,applied_at) VALUES('2099010101','future schema','2099-01-01T00:00:00.000Z')`)

  assert.throws(
    () => runMigrations(db, [{ id: '2026082501', name: 'known', up() {} }], () => NOW),
    /unknown database migration.*2099010101/i,
  )
})

test('openDb records the compatibility baseline once across restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lims-migrations-'))
  const path = join(directory, 'data.db')
  try {
    openDb(path).close()
    const reopened = openDb(path)
    assert.deepEqual(
      reopened.prepare('SELECT id,name FROM schema_migrations ORDER BY id').all().map(row => ({ ...row })),
      [
        { id: '2026082501', name: 'record legacy schema compatibility baseline' },
        { id: '2026090101', name: 'add AI durable execution boundary' },
      ],
    )
    reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
