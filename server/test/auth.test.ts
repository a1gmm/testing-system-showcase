import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { bootstrapUsers, createUser, updateUser, resetPassword, changeOwnPassword, listUsers, login, sessionUser, logout, hasRole, listSamplers } from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

test('建用户→登录→会话→登出 全链路', () => {
  const db = freshDb()
  createUser(db, { username: 'demo_tester', name: '陈检测', roles: ['analyst'], password: 'abc123' })
  // 密码错 / 账号不存在：错误文案统一，避免被拿来枚举用户名
  assert.throws(() => login(db, 'demo_tester', 'wrong'), /用户名或密码不正确/)
  assert.throws(() => login(db, 'nobody', 'x'), /用户名或密码不正确/)
  // 登录成功拿 token
  const { token, user } = login(db, 'demo_tester', 'abc123')
  assert.equal(user.name, '陈检测')
  assert.deepEqual(user.roles, ['analyst'])
  // token 换回用户
  assert.equal(sessionUser(db, token)?.name, '陈检测')
  // 登出后 token 失效
  logout(db, token)
  assert.equal(sessionUser(db, token), null)
})

test('角色判断：admin 万能，其余按命中', () => {
  const db = freshDb()
  const admin = createUser(db, { username: 'a', name: '管', roles: ['admin'], password: 'x' })
  const rev = createUser(db, { username: 'r', name: '报', roles: ['report_editor'], password: 'x' })
  assert.ok(hasRole(admin, 'signer'))            // admin 干啥都行
  assert.ok(hasRole(rev, 'report_editor'))
  assert.ok(!hasRole(rev, 'signer'))
  assert.ok(!hasRole(null, 'report_editor'))
})

test('建重名用户被拒绝，不静默覆盖', () => {
  const db = freshDb()
  createUser(db, { username: 'lisi', name: '李四', roles: ['analyst'], password: 'abc123' })
  assert.throws(() => createUser(db, { username: 'lisi', name: '冒名', roles: ['admin'], password: 'x' }), /已存在/)
  // 原账号未被改
  assert.deepEqual(login(db, 'lisi', 'abc123').user.roles, ['analyst'])
})

test('编辑人员：改姓名/岗位/停用', () => {
  const db = freshDb()
  createUser(db, { username: 'lisi', name: '李四', roles: ['analyst'], password: 'abc123' })
  const u = updateUser(db, 'lisi', { name: '李小四', roles: ['analyst', 'report_editor'], status: 'disabled' })
  assert.equal(u.name, '李小四')
  assert.deepEqual(u.roles, ['analyst', 'report_editor'])
  assert.equal(u.status, 'disabled')
  // 停用后不能登录
  assert.throws(() => login(db, 'lisi', 'abc123'), /用户名或密码不正确/)
  assert.throws(() => updateUser(db, 'nobody', { name: 'x' }), /不存在/)
})

test('改密码：本人验原密码，管理员可重置；短密码被拒', () => {
  const db = freshDb()
  createUser(db, { username: 'lisi', name: '李四', roles: ['analyst'], password: 'abc123' })
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

test('演示模式：显式创建 8 个岗位账号（含质控员）、密码 123456 可登录、幂等', () => {
  const db = freshDb()
  bootstrapUsers(db, { mode: 'demo' })
  assert.equal(listUsers(db).length, 8)
  const { user } = login(db, 'demo_admin', '123456')
  assert.ok(user.roles.includes('signer'))
  const qc = listUsers(db).find(u => u.roles.includes('qc'))
  assert.ok(qc, '种子里应有质控员账号')
  bootstrapUsers(db, {})   // 已有账号时不要求重复提供启动配置
  assert.equal(listUsers(db).length, 8)
})

test('空库：没有显式启动模式时拒绝创建通用账号', () => {
  const db = freshDb()
  assert.throws(() => bootstrapUsers(db, {}), /LIMS_BOOTSTRAP_MODE/)
  assert.equal(listUsers(db).length, 0)
})

test('生产启动：缺少、默认、短或低多样性密码均拒绝且不回显密码', () => {
  for (const password of [undefined, '123456', 'short-secret', '                ', 'aaaaaaaaaaaaaaaa']) {
    const db = freshDb()
    let message = ''
    try {
      bootstrapUsers(db, {
        mode: 'production',
        adminUsername: 'initial-admin',
        adminName: '首位管理员',
        adminPassword: password,
      })
      assert.fail('弱生产启动配置不应成功')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert.match(message, /BOOTSTRAP_ADMIN_PASSWORD/)
    if (password) assert.ok(!message.includes(password), '错误信息不得回显启动密码')
    assert.equal(listUsers(db).length, 0)
  }
})

test('生产启动：强一次性密码只创建一个必须改密的管理员', () => {
  const db = freshDb()
  const result = bootstrapUsers(db, {
    mode: 'production',
    adminUsername: 'initial-admin',
    adminName: '首位管理员',
    adminPassword: 'Correct-Horse-2026!',
  })
  assert.equal(result, 'production')
  assert.equal(listUsers(db).length, 1)
  const { user } = login(db, 'initial-admin', 'Correct-Horse-2026!')
  assert.deepEqual(user.roles, ['admin'])
  assert.equal(user.must_change_pw, true)
})

test('已有账号：不需要启动变量，也不增删改账号', () => {
  const db = freshDb()
  createUser(db, { username: 'owner', name: '现有管理员', roles: ['admin'], password: 'existing-secret' })
  const before = listUsers(db)
  assert.equal(bootstrapUsers(db, {}), 'existing')
  assert.deepEqual(listUsers(db), before)
  assert.ok(login(db, 'owner', 'existing-secret').token)
})

test('创建账号：必须显式提供非空初始密码', () => {
  const db = freshDb()
  assert.throws(
    () => createUser(db, { username: 'blank-password', name: '空密码', roles: ['analyst'], password: '' }),
    /初始密码必填/,
  )
  assert.equal(listUsers(db).length, 0)
})

test('listSamplers：只列在职的采样员/技术负责人（派工下拉用）', () => {
  const db = openDb(':memory:')
  createUser(db, { username: 'wang', name: '王采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'li', name: '李检测', roles: ['analyst'], password: 'x12345' })
  createUser(db, { username: 'zhao', name: '赵多岗', roles: ['sampler', 'analyst'], password: 'x12345' })
  createUser(db, { username: 'sun', name: '孙技术', roles: ['tech'], password: 'x12345' })
  createUser(db, { username: 'chen', name: '陈离职', roles: ['sampler'], password: 'x12345' })
  updateUser(db, 'chen', { status: 'disabled' })
  const names = listSamplers(db).map(u => u.name).sort()
  assert.deepEqual(names, ['孙技术', '王采样', '赵多岗'])
  // 只暴露必要字段，不带密码哈希等
  assert.deepEqual(Object.keys(listSamplers(db)[0]).sort(), ['name', 'username'])
})
