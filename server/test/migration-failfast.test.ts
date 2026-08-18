import test from 'node:test'
import assert from 'node:assert/strict'
import { addColumn, backfill } from '../src/db.ts'

test('schema migration ignores only duplicate columns and fails closed otherwise', () => {
  const duplicate = { exec: () => { throw new Error('duplicate column name: sampler_ids') } } as any
  assert.doesNotThrow(() => addColumn(duplicate, 'ALTER TABLE rounds ADD COLUMN sampler_ids TEXT'))

  const diskFailure = { exec: () => { throw new Error('database or disk is full') } } as any
  assert.throws(
    () => addColumn(diskFailure, 'ALTER TABLE rounds ADD COLUMN sampler_ids TEXT'),
    /database or disk is full/,
  )
})

test('data backfill failure stops startup instead of serving a partial schema', () => {
  const locked = { exec: () => { throw new Error('database is locked') } } as any
  assert.throws(
    () => backfill(locked, 'UPDATE rounds SET assignment_status=\'migrated\'', 'round assignment state'),
    /database is locked/,
  )
})
