import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createUser, login, sessionUser, seedUsers, changeOwnPassword, resetPassword,
  needsPasswordChange, corsHeaderValue, SESSION_IDLE_MS,
} from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

// ============ 会话空闲超时 ============
test('会话空闲超时：超过 TTL 的 token 失效并被清理', () => {
  const db = freshDb()
  createUser(db, { username: 'z', name: '张', roles: ['tester'], password: 'abc123' })
  const { token } = login(db, 'z', 'abc123')
  // 刚登录：正常换回用户
  assert.equal(sessionUser(db, token)?.name, '张')
  // 超过 TTL：失效
  const expired = Date.now() + SESSION_IDLE_MS + 60_000
  assert.equal(sessionUser(db, token, expired), null)
  // 已被清理：即便回到当下也查不到
  assert.equal(sessionUser(db, token), null)
})

test('会话滑动续期：TTL 内持续使用不掉线', () => {
  const db = freshDb()
  createUser(db, { username: 'z', name: '张', roles: ['tester'], password: 'abc123' })
  const { token } = login(db, 'z', 'abc123')
  const t0 = Date.now()
  // 在 TTL 快到时访问一次 → 续期
  const near = t0 + SESSION_IDLE_MS - 60_000
  assert.equal(sessionUser(db, token, near)?.name, '张')
  // 从上次访问起再过一段（仍在 TTL 内）→ 仍有效
  const after = near + SESSION_IDLE_MS - 60_000
  assert.equal(sessionUser(db, token, after)?.name, '张')
})

test('会话时间戳损坏 → 失败即失效（fail closed，不放行）', () => {
  const db = freshDb()
  createUser(db, { username: 'z', name: '张', roles: ['tester'], password: 'abc123' })
  const { token } = login(db, 'z', 'abc123')
  // 把时间戳写坏（模拟脏数据/迁移遗留）
  db.prepare(`UPDATE sessions SET last_seen='坏日期', created_at='坏日期' WHERE token=?`).run(token)
  assert.equal(sessionUser(db, token), null)                 // 不可解析 → 当作已过期
  const n = (db.prepare(`SELECT COUNT(*) n FROM sessions WHERE token=?`).get(token) as any).n
  assert.equal(n, 0)                                          // 且清理掉
})

test('会话续期节流：60s 内不重复写 last_seen，超窗才写', () => {
  const db = freshDb()
  createUser(db, { username: 'z', name: '张', roles: ['tester'], password: 'abc123' })
  const { token } = login(db, 'z', 'abc123')
  const first = (db.prepare(`SELECT last_seen FROM sessions WHERE token=?`).get(token) as any).last_seen
  const base = Date.parse(first)
  // 30s 后访问：在节流窗内 → last_seen 不变
  sessionUser(db, token, base + 30_000)
  assert.equal((db.prepare(`SELECT last_seen FROM sessions WHERE token=?`).get(token) as any).last_seen, first)
  // 90s 后访问：超节流窗 → last_seen 更新
  const t90 = base + 90_000
  sessionUser(db, token, t90)
  assert.equal((db.prepare(`SELECT last_seen FROM sessions WHERE token=?`).get(token) as any).last_seen, new Date(t90).toISOString())
})

// ============ 强制改初始密码 ============
test('管理员建的账号、种子账号：标记必须改密', () => {
  const db = freshDb()
  seedUsers(db)
  assert.equal(login(db, 'demo_admin', '123456').user.must_change_pw, true)
  createUser(db, { username: 'z', name: '张', roles: ['tester'], password: 'init123' })
  assert.equal(login(db, 'z', 'init123').user.must_change_pw, true)
})

test('本人改密后清除必须改密标记；管理员重置又置回', () => {
  const db = freshDb()
  createUser(db, { username: 'z', name: '张', roles: ['tester'], password: 'init123' })
  changeOwnPassword(db, 'z', 'init123', 'newpass1')
  assert.equal(login(db, 'z', 'newpass1').user.must_change_pw, false)
  resetPassword(db, 'z', 'reset123')
  assert.equal(login(db, 'z', 'reset123').user.must_change_pw, true)
})

test('未改密时：除白名单接口外一律拦截', () => {
  const stale = { username: 'z', name: '张', roles: ['tester'], status: 'active', created_at: '', must_change_pw: true }
  // 业务接口被拦
  assert.equal(needsPasswordChange(stale, '/api/samples'), true)
  // 白名单放行
  assert.equal(needsPasswordChange(stale, '/api/me'), false)
  assert.equal(needsPasswordChange(stale, '/api/change-password'), false)
  assert.equal(needsPasswordChange(stale, '/api/logout'), false)
  // 已改密的用户畅通
  const ok = { ...stale, must_change_pw: false }
  assert.equal(needsPasswordChange(ok, '/api/samples'), false)
  // 未登录不由这里管
  assert.equal(needsPasswordChange(null, '/api/samples'), false)
})

// ============ CORS 收紧 ============
test('CORS：默认不发 * ；按白名单精确回显；显式 * 才放开', () => {
  // 未配置 → 不发 ACAO 头（同源部署无需跨域）
  assert.equal(corsHeaderValue('', 'http://evil.com'), null)
  // 配了具体来源：命中回显、未命中不发
  assert.equal(corsHeaderValue('https://lims.tc.com', 'https://lims.tc.com'), 'https://lims.tc.com')
  assert.equal(corsHeaderValue('https://lims.tc.com', 'http://evil.com'), null)
  // 多来源逗号分隔
  assert.equal(corsHeaderValue('https://a.com,https://b.com', 'https://b.com'), 'https://b.com')
  // 显式配 * → 放开
  assert.equal(corsHeaderValue('*', 'http://any.com'), '*')
})
