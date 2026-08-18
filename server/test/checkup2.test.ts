// 2026-07-30 全自动体检修复·第二批（10条）：读权限收口/留痕绕权/附件按实体收口/标复检收口/
// URL token 白名单/迁移不吞错/会话加固/裸 JSON.parse/人员名单脱敏/过期仪器拦领用
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/db.ts'
import {
  createUser, login, sessionUser, SESSION_ABS_MS,
  canSeeCommercial, contractForUser, canSeeRecordAudit, urlTokenAllowed, maskUserList,
  canManageAttachment, attachRoleErrorText,
  createContract, createSample, saveRecord, flagRecheck, listAudit,
  createInstrument, checkoutInstrument, listCheckouts,
  getRoundSheet, listRoundSheets,
  type User,
} from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }
// 造个登录态用户对象（角色判断只看 roles/status）
function u(roles: string[], username = 'u1', name = '某人'): User {
  return { username, name, roles, status: 'active', created_at: '', must_change_pw: false }
}

// ============ 【8a】合同商务字段脱敏 ============

test('修8a 脱敏：采样员/检测员/质控看合同剥掉 quote/review_info，干活字段保留', () => {
  const db = freshDb()
  const c = createContract(db, {
    client: '甲厂', project: '年度监测',
    quote: { rows: [{ category: '废水', point: '总排口', items: ['COD'], price: 999, points: 1, perDay: 1, perYear: 1 }], invoice: '开票税号123' },
    review: { demand: '能做', risk: '无' },
  } as any, 2026)
  assert.ok(c.quote, '登记员视角本来有报价')
  for (const roles of [['sampler'], ['tester'], ['qc'], ['reviewer'], ['approver']]) {
    const seen: any = contractForUser(u(roles), c)
    assert.equal(seen.quote, undefined, `${roles} 不该看到报价`)
    assert.equal(seen.review_info, undefined, `${roles} 不该看到合同评审`)
    // 干活必需字段还在
    assert.equal(seen.id, c.id)
    assert.equal(seen.client, '甲厂')
    assert.equal(seen.project, '年度监测')
    assert.ok(Array.isArray(seen.plan))
  }
  // 登记员/tech/签字人/admin 看全量
  for (const roles of [['registrar'], ['tech'], ['signer'], ['admin']]) {
    const seen: any = contractForUser(u(roles), c)
    assert.ok(seen.quote, `${roles} 应看到报价`)
    assert.ok(canSeeCommercial(u(roles)))
  }
  assert.equal(contractForUser(u(['sampler']), null), null)   // 空值透传不炸
})

// ============ 【9】记录留痕：编制人本人或 audit_view ============

test('修9 留痕可见性：编制人本人（登录名优先/姓名回退）和复核审核链能看，路人检测员不能', () => {
  const rec = { author: '陈检测', author_username: 'demo_tester' }
  assert.ok(canSeeRecordAudit(u(['tester'], 'demo_tester', '陈检测改名'), rec), '本人改过姓名也认登录名')
  assert.ok(!canSeeRecordAudit(u(['tester'], 'imposter', '陈检测'), rec), '重名冒充不放行')
  assert.ok(canSeeRecordAudit(u(['reviewer'], 'demo_reviewer', '郑复核'), rec), 'audit_view 角色放行')
  assert.ok(canSeeRecordAudit(u(['approver'], 'demo_approver', '孙审核'), rec))
  assert.ok(canSeeRecordAudit(u(['tech'], 'demo_tech', '许技术'), rec))
  assert.ok(canSeeRecordAudit(u(['admin'], 'root', '管理员'), rec))
  assert.ok(!canSeeRecordAudit(u(['sampler'], 'demo_sampler', '赵采样'), rec), '无关角色拦')
  // 历史数据只有姓名 → 回退姓名比对
  const old = { author: '老王', author_username: null }
  assert.ok(canSeeRecordAudit(u(['tester'], 'laowang', '老王'), old))
  assert.ok(!canSeeRecordAudit(u(['tester'], 'x', '小李'), old))
})

// ============ 【17】附件按实体收口 ============

test('修17 附件实体白名单：report 限报告链（签字人能传），system_record 只许 tech，其余维持现状', () => {
  // report：registrar/reviewer/approver/signer/tech/admin 行，sampler/tester/qc 不行
  for (const roles of [['registrar'], ['reviewer'], ['approver'], ['signer'], ['tech'], ['admin']]) {
    assert.ok(canManageAttachment(u(roles), 'report'), `${roles} 应能动报告附件`)
  }
  for (const roles of [['sampler'], ['tester'], ['qc']]) {
    assert.ok(!canManageAttachment(u(roles), 'report'), `${roles} 不该动报告附件`)
  }
  // system_record：只有 tech/admin
  assert.ok(canManageAttachment(u(['tech']), 'system_record'))
  assert.ok(canManageAttachment(u(['admin']), 'system_record'))
  for (const roles of [['registrar'], ['sampler'], ['tester'], ['qc'], ['signer'], ['reviewer']]) {
    assert.ok(!canManageAttachment(u(roles), 'system_record'), `${roles} 不该动体系记录附件`)
  }
  // 其余实体维持 attach_upload 名单：sampler 能动 record/round，signer 不能
  assert.ok(canManageAttachment(u(['sampler']), 'record'))
  assert.ok(canManageAttachment(u(['qc']), 'handover'))
  assert.ok(!canManageAttachment(u(['signer']), 'record'))
  // 错误提示按实体给人话
  assert.match(attachRoleErrorText('report'), /报告附件/)
  assert.match(attachRoleErrorText('system_record'), /技术负责人/)
})

// ============ 【19】标复检收口 ============

test('修19 标复检：受限模式下只有编制人/任务受派人能标，路人检测员 403；不受限照旧', () => {
  const db = freshDb()
  const s = createSample(db, { client: '甲厂', matrix: '废水', items: ['COD'] }, 2026)
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', analyte: 'COD', data: { rows: [] }, who: '陈检测', whoUsername: 'demo_tester', submit: true })
  // 路人检测员（受限）→ 403
  assert.throws(() => flagRecheck(db, rec.id, '看不顺眼', true, '王路人', { username: 'wanglr', restrictToOwn: true }),
    (e: any) => e.httpCode === 403 && /自己名下/.test(e.message))
  // 编制人本人（改过显示名也认登录名）→ 放行
  const r1 = flagRecheck(db, rec.id, '超标复检', true, '陈检测改名', { username: 'demo_tester', restrictToOwn: true })
  assert.equal(r1.recheck, 1)
  flagRecheck(db, rec.id, '', false, '陈检测改名', { username: 'demo_tester', restrictToOwn: true })   // 本人也能取消
  // 任务受派人（不是编制人）→ 放行
  db.prepare(`INSERT INTO test_tasks (sample_id, analyte, assignee, assignee_username, assigned_by, assigned_at)
    VALUES (?,?,?,?,?,?)`).run(s.id, 'COD', '王受派', 'wangsp', '吴质控', new Date().toISOString())
  assert.equal(flagRecheck(db, rec.id, '受派人复检', true, '王受派', { username: 'wangsp', restrictToOwn: true }).recheck, 1)
  // 复核/审核/tech 走不受限模式（路由层判角色）→ 照旧
  assert.equal(flagRecheck(db, rec.id, '', false, '郑复核', { username: 'demo_reviewer', restrictToOwn: false }).recheck, 0)
})

// ============ 【22】URL token 白名单 ============

test('修22 ?token= 只对 GET 下载路径生效，其余接口只认 Authorization 头', () => {
  assert.ok(urlTokenAllowed('GET', '/api/attachments/file/abc-123'))
  assert.ok(urlTokenAllowed('GET', '/api/contracts/WT2026-0001/doc'))
  assert.ok(!urlTokenAllowed('POST', '/api/contracts/WT2026-0001/doc'), '上传不走 URL token')
  assert.ok(!urlTokenAllowed('GET', '/api/reports'))
  assert.ok(!urlTokenAllowed('GET', '/api/contracts'))
  assert.ok(!urlTokenAllowed('POST', '/api/records'))
  assert.ok(!urlTokenAllowed('GET', '/api/attachments/record/xx'), '附件列表也不走 URL token')
})

// ============ 【23】迁移不吞错 + 幂等回填 ============

test('修23 老库迁移：must_change_pw/source 回填幂等，每次启动都补、不覆盖已有值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lims-mig-'))
  const path = join(dir, 'old.db')
  try {
    // 手搓一个「老库」：users 没有 must_change_pw，samples 没有 source
    const raw = new DatabaseSync(path)
    raw.exec(`CREATE TABLE users (username TEXT PRIMARY KEY, name TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '[]',
      pass_salt TEXT NOT NULL, pass_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`)
    raw.exec(`CREATE TABLE samples (id TEXT PRIMARY KEY, client TEXT, matrix TEXT, items TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL, note TEXT, contract_id TEXT, round_id TEXT, created_at TEXT NOT NULL)`)
    raw.prepare(`INSERT INTO users VALUES ('olduser','老账号','["tester"]','s','h','active','2025-01-01')`).run()
    raw.prepare(`INSERT INTO samples (id, matrix, items, status, contract_id, round_id, created_at)
      VALUES ('W-1','废水','[]','pending',NULL,NULL,'2025-01-01')`).run()
    raw.prepare(`INSERT INTO samples (id, matrix, items, status, contract_id, round_id, created_at)
      VALUES ('W-2','废水','[]','pending','WT2025-0001',NULL,'2025-01-01')`).run()
    raw.close()
    // 第一次开：加列 + 回填
    let db = openDb(path)
    assert.equal((db.prepare(`SELECT must_change_pw FROM users WHERE username='olduser'`).get() as any).must_change_pw, 1, '存量账号强制改密')
    assert.equal((db.prepare(`SELECT source FROM samples WHERE id='W-1'`).get() as any).source, 'self', '无委托无期次 → 自送样')
    assert.equal((db.prepare(`SELECT source FROM samples WHERE id='W-2'`).get() as any).source, 'field', '有委托 → 受托采样')
    // 用户自己改过密（置 0）后再重启：回填只认 NULL，不会把 0 又翻回 1
    db.prepare(`UPDATE users SET must_change_pw=0 WHERE username='olduser'`).run()
    db.close()
    db = openDb(path)
    assert.equal((db.prepare(`SELECT must_change_pw FROM users WHERE username='olduser'`).get() as any).must_change_pw, 0, '幂等：已回填过的不再动')
    assert.equal((db.prepare(`SELECT source FROM samples WHERE id='W-1'`).get() as any).source, 'self')
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('修23 新库不受影响：SCHEMA 自带列，回填条件永不命中', () => {
  const db = freshDb()
  createUser(db, { username: 'n1', name: '新人', roles: ['tester'], password: 'abc123' })
  assert.equal((db.prepare(`SELECT must_change_pw FROM users WHERE username='n1'`).get() as any).must_change_pw, 1, '新账号本来就是 1（初始密码须改）')
  const s = createSample(db, { client: 'x', matrix: '废水', items: [] }, 2026)
  assert.equal((db.prepare(`SELECT source FROM samples WHERE id=?`).get(s.id) as any).source, 'self')
})

// ============ 【24】会话加固：绝对有效期 + 停用即失效 ============

test('修24 绝对有效期：签发起 7 天必过期，再活跃也不续命', () => {
  const db = freshDb()
  createUser(db, { username: 'z', name: '张', roles: ['tester'], password: 'abc123' })
  const { token } = login(db, 'z', 'abc123')
  const born = Date.parse((db.prepare(`SELECT created_at FROM sessions WHERE token=?`).get(token) as any).created_at)
  // 6 天 23 小时：保持活跃（last_seen 刚续过）→ 还有效
  db.prepare(`UPDATE sessions SET last_seen=? WHERE token=?`).run(new Date(born + SESSION_ABS_MS - 3600_000).toISOString(), token)
  assert.equal(sessionUser(db, token, born + SESSION_ABS_MS - 1800_000)?.name, '张')
  // 过了 7 天：哪怕 last_seen 一直新鲜也失效，且会话被清理
  db.prepare(`UPDATE sessions SET last_seen=? WHERE token=?`).run(new Date(born + SESSION_ABS_MS).toISOString(), token)
  assert.equal(sessionUser(db, token, born + SESSION_ABS_MS + 60_000), null)
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM sessions WHERE token=?`).get(token) as any).n, 0)
})

test('修24 停用用户：旧 token 一律失效（直改库绕过踢下线也兜得住）', () => {
  const db = freshDb()
  createUser(db, { username: 'gone', name: '离职', roles: ['tester'], password: 'abc123' })
  const { token } = login(db, 'gone', 'abc123')
  assert.equal(sessionUser(db, token)?.name, '离职')
  // 绕过 updateUser（那里会 revoke），直改状态模拟竞态/脏改库
  db.prepare(`UPDATE users SET status='disabled' WHERE username='gone'`).run()
  assert.equal(sessionUser(db, token), null)
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM sessions WHERE token=?`).get(token) as any).n, 0, '顺手清掉会话')
})

// ============ 【25】期次表单坏行降级 ============

test('修25 round_sheets 脏 JSON：坏行降级为空表，不再整个接口 500', () => {
  const db = freshDb()
  db.prepare(`INSERT INTO round_sheets (id, round_id, template_code, data, who, username, updated_at)
    VALUES ('a1','R-1','HJ-TC-136','{"rows":[{"v":1}]}','赵采样','demo_sampler','2026-07-30T00:00:00Z')`).run()
  db.prepare(`INSERT INTO round_sheets (id, round_id, template_code, data, who, username, updated_at)
    VALUES ('a2','R-1','HJ-TC-146','{烂掉的JSON','赵采样','demo_sampler','2026-07-30T00:00:00Z')`).run()
  // 单取坏行：不抛，data 空对象
  assert.deepEqual(getRoundSheet(db, 'R-1', 'HJ-TC-146')!.data, {})
  // 列表：好行照常、坏行降级，两行都在
  const all = listRoundSheets(db, 'R-1')
  assert.equal(all.length, 2)
  assert.deepEqual(all.find(r => r.template_code === 'HJ-TC-136')!.data, { rows: [{ v: 1 }] })
  assert.deepEqual(all.find(r => r.template_code === 'HJ-TC-146')!.data, {})
})

// ============ 【40】人员名单脱敏 ============

test('修40 选人名单：有派工权限给 username+name，其他登录者只给 name', () => {
  const rows = [{ username: 'demo_sampler', name: '赵采样' }, { username: 'demo_tech', name: '许技术' }]
  assert.deepEqual(maskUserList(rows, true), rows)
  const masked = maskUserList(rows, false)
  assert.deepEqual(masked, [{ name: '赵采样' }, { name: '许技术' }])
  assert.ok(!('username' in masked[0]))
})

// ============ 【49】过期仪器拦领用 ============

test('修49 检定过期领用一律 400；效期空的老数据放行但留痕提醒', () => {
  const db = freshDb()
  createInstrument(db, { id: 'TC-100', name: '过期机', certUntil: '2020-01-01' })
  assert.throws(() => checkoutInstrument(db, { instrumentId: 'TC-100', takenBy: '许技术' }, { name: '许技术', username: 'demo_tech' }),
    /检定已过期.*先送检更新台账再领用/, 'tech 也拦——所有角色一视同仁')
  assert.equal(listCheckouts(db, { open: true }).length, 0)
  // 效期为空的老台账：放行 + 警告 + 留痕提醒补录
  createInstrument(db, { id: 'TC-101', name: '无效期机' })
  const co = checkoutInstrument(db, { instrumentId: 'TC-101', takenBy: '赵采样' }, { name: '赵采样', username: 'demo_sampler' })
  assert.equal(co.status, 'out')
  assert.match(co.warning || '', /没登记检定有效期/)
  const audit = listAudit(db, 'TC-101')
  assert.ok(audit.some(a => a.action === 'instrument_cert_missing' && a.username === 'demo_sampler'), '留痕里有补录提醒')
  // 效期内正常领，无警告
  createInstrument(db, { id: 'TC-102', name: '好机', certUntil: '2099-01-01' })
  const ok = checkoutInstrument(db, { instrumentId: 'TC-102', takenBy: '赵采样' }, { name: '赵采样' })
  assert.equal(ok.cert_ok_at_checkout, 1)
  assert.equal((ok as any).warning, undefined)
})
