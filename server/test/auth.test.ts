import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createUser, updateUser, resetPassword, changeOwnPassword, listUsers, login, sessionUser, logout, hasRole, seedUsers, listSamplers } from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

test('建用户→登录→会话→登出 全链路', () => {
  const db = freshDb()
  createUser(db, { username: 'demo_tester', name: '陈检测', roles: ['tester'], password: 'abc123' })
  // 密码错 / 账号不存在：错误文案统一，避免被拿来枚举用户名
  assert.throws(() => login(db, 'demo_tester', 'wrong'), /用户名或密码不正确/)
  assert.throws(() => login(db, 'nobody', 'x'), /用户名或密码不正确/)
  // 登录成功拿 token
  const { token, user } = login(db, 'demo_tester', 'abc123')
  assert.equal(user.name, '陈检测')
  assert.deepEqual(user.roles, ['tester'])
  // token 换回用户
  assert.equal(sessionUser(db, token)?.name, '陈检测')
  // 登出后 token 失效
  logout(db, token)
  assert.equal(sessionUser(db, token), null)
})

test('角色判断：admin 万能，其余按命中', () => {
  const db = freshDb()
  const admin = createUser(db, { username: 'a', name: '管', roles: ['admin'], password: 'x' })
  const rev = createUser(db, { username: 'r', name: '复', roles: ['reviewer'], password: 'x' })
  assert.ok(hasRole(admin, 'signer'))            // admin 干啥都行
  assert.ok(hasRole(rev, 'reviewer'))
  assert.ok(!hasRole(rev, 'approver'))           // 复核员不能终审
  assert.ok(!hasRole(null, 'reviewer'))          // 没登录啥也不行
})

test('建重名用户被拒绝，不静默覆盖', () => {
  const db = freshDb()
  createUser(db, { username: 'lisi', name: '李四', roles: ['tester'], password: 'abc123' })
  assert.throws(() => createUser(db, { username: 'lisi', name: '冒名', roles: ['admin'], password: 'x' }), /已存在/)
  // 原账号未被改
  assert.deepEqual(login(db, 'lisi', 'abc123').user.roles, ['tester'])
})

test('编辑人员：改姓名/岗位/停用', () => {
  const db = freshDb()
  createUser(db, { username: 'lisi', name: '李四', roles: ['tester'], password: 'abc123' })
  const u = updateUser(db, 'lisi', { name: '李小四', roles: ['tester', 'reviewer'], status: 'disabled' })
  assert.equal(u.name, '李小四')
  assert.deepEqual(u.roles, ['tester', 'reviewer'])
  assert.equal(u.status, 'disabled')
  // 停用后不能登录
  assert.throws(() => login(db, 'lisi', 'abc123'), /用户名或密码不正确/)
  assert.throws(() => updateUser(db, 'nobody', { name: 'x' }), /不存在/)
})

test('改密码：本人验原密码，管理员可重置；短密码被拒', () => {
  const db = freshDb()
  createUser(db, { username: 'lisi', name: '李四', roles: ['tester'], password: 'abc123' })
  // 本人改密码：原密码错→拒
  assert.throws(() => changeOwnPassword(db, 'lisi', 'wrong', 'newpass1'), /原密码/)
  // 太短→拒
  assert.throws(() => changeOwnPassword(db, 'lisi', 'abc123', '123'), /6 位/)
  // 正常改
  changeOwnPassword(db, 'lisi', 'abc123', 'newpass1')
  assert.ok(login(db, 'lisi', 'newpass1').token)
  // 管理员重置
  resetPassword(db, 'lisi', 'reset123')
  assert.ok(login(db, 'lisi', 'reset123').token)
})

test('种子用户：8 个岗位齐（含质控员）、密码 123456 可登录、幂等', () => {
  const db = freshDb()
  seedUsers(db)
  assert.equal(listUsers(db).length, 8)
  const { user } = login(db, 'demo_admin', '123456')
  assert.ok(user.roles.includes('signer'))
  const qc = listUsers(db).find(u => u.roles.includes('qc'))
  assert.ok(qc, '种子里应有质控员账号')
  seedUsers(db)   // 再跑不重复
  assert.equal(listUsers(db).length, 8)
})

test('listSamplers：只列在职的采样员/技术负责人（派工下拉用）', () => {
  const db = openDb(':memory:')
  createUser(db, { username: 'wang', name: '王采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'li', name: '李检测', roles: ['tester'], password: 'x12345' })
  createUser(db, { username: 'zhao', name: '赵多岗', roles: ['sampler', 'tester'], password: 'x12345' })
  createUser(db, { username: 'sun', name: '孙技术', roles: ['tech'], password: 'x12345' })
  createUser(db, { username: 'chen', name: '陈离职', roles: ['sampler'], password: 'x12345' })
  updateUser(db, 'chen', { status: 'disabled' })
  const names = listSamplers(db).map(u => u.name).sort()
  assert.deepEqual(names, ['孙技术', '王采样', '赵多岗'])
  // 只暴露必要字段，不带密码哈希等
  assert.deepEqual(Object.keys(listSamplers(db)[0]).sort(), ['name', 'username'])
})
