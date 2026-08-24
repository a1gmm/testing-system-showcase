import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createUser } from '../src/handlers.ts'
import { isSingleActorAcceptance, recordAcceptanceOverride } from '../src/acceptanceMode.ts'

test('single-actor acceptance fails closed for every invalid identity or time boundary', () => {
  const previousUsername = process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
  const previousUntil = process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
  try {
    const db = openDb(':memory:')
    createUser(db, { username: 'admin', name: '管理员', roles: ['admin'], password: 'secret1' })
    createUser(db, { username: 'ordinary', name: '普通人员', roles: [], password: 'secret1' })
    createUser(db, { username: 'inactive', name: '停用管理员', roles: ['admin'], password: 'secret1' })
    db.prepare(`UPDATE users SET status='inactive' WHERE username='inactive'`).run()

    const cases = [
      { configured: '', until: '2099-12-31T23:59:59.999Z', actor: 'admin' },
      { configured: 'admin', until: 'invalid', actor: 'admin' },
      { configured: 'admin', until: '2000-01-01T00:00:00.000Z', actor: 'admin' },
      { configured: 'admin', until: '2099-12-31T23:59:59.999Z', actor: 'ordinary' },
      { configured: 'ordinary', until: '2099-12-31T23:59:59.999Z', actor: 'ordinary' },
      { configured: 'inactive', until: '2099-12-31T23:59:59.999Z', actor: 'inactive' },
    ]
    for (const item of cases) {
      process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = item.configured
      process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = item.until
      assert.equal(isSingleActorAcceptance(db, { username: item.actor }), false, JSON.stringify(item))
      assert.equal(recordAcceptanceOverride(db, { username: item.actor }, 'test', 'record', 'normal rule'), false)
    }
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'acceptance_override_%'`).get() as any).n, 0)
  } finally {
    if (previousUsername === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
    else process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = previousUsername
    if (previousUntil === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
    else process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = previousUntil
  }
})
