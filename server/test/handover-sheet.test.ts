// 批次一切片1：交接单（handover_sheets）——收样自动生成草稿、可改、整单签收/拒收
// 依据 2026-07-31 方案：由采样记录自动带出、可人工改、发样品管理员签收；拒收单个样品留痕
import { test } from 'node:test'
import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createScheme, reviewScheme, composeFreq, createUser,
  listRounds, assignRound, confirmRoundField, sampleRound, addHandover, confirmHandover, listHandovers,
  listHandoverSheets, getHandoverSheet, updateHandoverSheet, sendHandoverSheet, confirmHandoverSheet,
  assignTestTasks,
} from '../src/handlers.ts'
import { approveRoundSampling } from './support/approved-sampling.ts'

const qcActor = { name: '吴质控', username: 'qianqc' }
const managerActor = { name: '王收样', username: 'wangsy' }
const samplerActor = { name: '赵采样', username: 'demo_sampler' }

function setup(db: any) {
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'qianqc', name: '吴质控', roles: ['qc'], password: 'x12345' })
  createUser(db, { username: 'wangsy', name: '王收样', roles: ['sample_manager'], password: 'x12345' })
  createUser(db, { username: 'zhaoce', name: '赵分析', roles: ['analyst'], password: 'x12345' })
  const c = createContract(db, { client: '交接厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '1#总排口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB8978' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  approveRoundSampling(db, r.id, samplerActor)
  const made = sampleRound(db, r.id, samplerActor)
  return { c, r, made }
}

function multiSamplerSetup(db: any, duplicateNames = false) {
  const samplerA = { username: 'sampler-a', name: duplicateNames ? '同名采样' : '甲采样' }
  const samplerB = { username: 'sampler-b', name: duplicateNames ? '同名采样' : '乙采样' }
  createUser(db, { ...samplerA, roles: ['sampler', 'sample_manager'], password: 'x12345' })
  createUser(db, { ...samplerB, roles: ['sampler'], password: 'x12345' })
  const c = createContract(db, { client: '多人交接厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [{ element: '废水', point: '1#总排口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB8978' }],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, [samplerA.username, samplerB.username])
  confirmRoundField(db, r.id, samplerA)
  confirmRoundField(db, r.id, samplerB)
  approveRoundSampling(db, r.id, samplerA)
  sampleRound(db, r.id, samplerA)
  return { r, samplerA, samplerB, sheet: listHandoverSheets(db, { roundId: r.id })[0] }
}

test('收样入库自动生成交接单草稿：编号JJ、成员齐、明细带项目、交样人=采样员', () => {
  const db = openDb(':memory:')
  const { r, made } = setup(db)
  const sheets = listHandoverSheets(db, { roundId: r.id })
  assert.equal(sheets.length, 1)
  const sh = sheets[0]
  assert.match(sh.id, /^JJ\d{4}-\d{4}$/, `交接单号 ${sh.id}`)
  assert.equal(sh.status, 'draft')
  assert.equal(sh.from_person, '赵采样')
  assert.deepEqual([...sh.sample_ids].sort(), made.map(s => s.id).sort(), '成员=本期全部样品')
  const row = sh.detail.find((d: any) => d.sampleId === made[0].id)
  assert.ok(row, '明细行按样品生成')
  assert.deepEqual(row.items, made[0].items, '明细行带出检测项目')
})

test('草稿可改保存条件并留痕；签收后不可再改', () => {
  const db = openDb(':memory:')
  const { r } = setup(db)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  const upd = updateHandoverSheet(db, sh.id, { storage: '4℃冷藏，加硫酸至pH≤2' }, samplerActor)
  assert.equal(upd.storage, '4℃冷藏，加硫酸至pH≤2')
  sendHandoverSheet(db, sh.id, samplerActor)
  confirmHandoverSheet(db, sh.id, managerActor)
  assert.throws(() => updateHandoverSheet(db, sh.id, { storage: '改不动' }, samplerActor), /签收|不能/)
})

test('采样审核不是已批准状态时交接单不能发出', () => {
  const db = openDb(':memory:')
  const { r } = setup(db)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  db.prepare(`UPDATE workflow_instances SET status='pending_review' WHERE subject_type='round_sampling' AND subject_id=?`).run(r.id)
  assert.throws(() => sendHandoverSheet(db, sh.id, samplerActor), /采样审核通过/)
  assert.equal(getHandoverSheet(db, sh.id)!.status, 'draft')
})

test('发出→样品管理员整单签收：状态confirmed、收样人落名、成员样品交接全部确认', () => {
  const db = openDb(':memory:')
  const { r, made } = setup(db)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, samplerActor)
  assert.equal(getHandoverSheet(db, sh.id)!.status, 'sent')
  assert.throws(() => confirmHandoverSheet(db, sh.id, qcActor), /样品管理员/)
  const done = confirmHandoverSheet(db, sh.id, managerActor)
  assert.equal(done.status, 'confirmed')
  assert.equal(done.to_person, '王收样')
  assert.ok(done.to_at, '签收时间落库')
  // 整单签收后成员样品的逐条交接都已确认；质量计划审核是下一独立步骤。
  const normal = made.find(s => !s.qc_type)!
  assert.ok(listHandovers(db, normal.id).some(h => h.confirmed_at))
})

test('启动时修复历史整单已签收但样品流水仍显示待签收的数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-confirmation-backfill-'))
  const path = join(dir, 'legacy.sqlite')
  try {
    const db = openDb(path)
    const { r, made } = setup(db)
    const sheet = listHandoverSheets(db, { roundId: r.id })[0]
    sendHandoverSheet(db, sheet.id, samplerActor)
    const confirmed = confirmHandoverSheet(db, sheet.id, managerActor)
    const sample = made.find(item => !item.qc_type)!
    db.prepare(`UPDATE sample_handovers SET confirmed_by=NULL, confirmed_at=NULL WHERE sample_id=?`).run(sample.id)
    const later = addHandover(db, sample.id, { action: '流转领用' }, managerActor)
    db.close()

    const reopened = openDb(path)
    const handovers = listHandovers(reopened, sample.id)
    const repaired = handovers.find(handover => handover.action === '采样交接')
    assert.equal(repaired?.confirmed_by, managerActor.name)
    assert.equal(repaired?.confirmed_at, confirmed.to_at)
    assert.equal(handovers.find(handover => handover.id === later.id)?.confirmed_at, null)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('启动时把同一接收人已逐条签完的历史交接单升级为整单已签收', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-sheet-backfill-'))
  const path = join(dir, 'legacy.sqlite')
  try {
    const db = openDb(path)
    const { r, made } = setup(db)
    const sheet = listHandoverSheets(db, { roundId: r.id })[0]
    for (const sample of made) {
      const handover = listHandovers(db, sample.id)[0]
      db.prepare(`UPDATE sample_handovers SET confirmed_by=?,confirmed_at=? WHERE id=?`)
        .run(managerActor.name, '2026-08-24T08:00:00.000Z', handover.id)
    }
    assert.equal(getHandoverSheet(db, sheet.id)!.status, 'draft')
    db.close()

    const reopened = openDb(path)
    const repaired = getHandoverSheet(reopened, sheet.id)!
    assert.equal(repaired.status, 'confirmed')
    assert.equal(repaired.to_person, managerActor.name)
    assert.ok(repaired.to_at)
    const audit = reopened.prepare(`SELECT action,detail FROM audit_log WHERE record_id=? ORDER BY id DESC LIMIT 1`).get(sheet.id) as any
    assert.equal(audit.action, 'handover_sheet_confirmation_reconciled')
    assert.equal(JSON.parse(audit.detail).receiver, managerActor.name)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('最后一个成员逐条签收后立即把交接单同步为已签收', () => {
  const db = openDb(':memory:')
  const { r, made } = setup(db)
  const sheet = listHandoverSheets(db, { roundId: r.id })[0]
  for (const sample of made) {
    const handover = listHandovers(db, sample.id)[0]
    confirmHandover(db, handover.id, managerActor)
  }
  assert.equal(getHandoverSheet(db, sheet.id)!.status, 'confirmed')
  assert.equal(getHandoverSheet(db, sheet.id)!.to_person, managerActor.name)
})

test('后续流转记录的签字不能冒充采样交接签收', () => {
  const db = openDb(':memory:')
  const { r, made } = setup(db)
  const sheet = listHandoverSheets(db, { roundId: r.id })[0]
  for (const sample of made) {
    const later = addHandover(db, sample.id, { action: '流转领用' }, samplerActor)
    confirmHandover(db, later.id, managerActor)
  }
  assert.equal(getHandoverSheet(db, sheet.id)!.status, 'draft')
})

test('最新的采样交接还未签收时不能沿用旧签字升级整单', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-latest-confirmation-'))
  const path = join(dir, 'legacy.sqlite')
  try {
    const db = openDb(path)
    const { r, made } = setup(db)
    const sheet = listHandoverSheets(db, { roundId: r.id })[0]
    for (const sample of made) {
      const original = listHandovers(db, sample.id).find(handover => handover.action === '采样交接')!
      db.prepare(`UPDATE sample_handovers SET confirmed_by=?,confirmed_at=? WHERE id=?`)
        .run(managerActor.name, '2026-08-24T08:00:00.000Z', original.id)
    }
    addHandover(db, made[0].id, { action: '采样交接', note: '补录的当前交接' }, samplerActor)
    db.close()

    const reopened = openDb(path)
    assert.equal(getHandoverSheet(reopened, sheet.id)!.status, 'draft')
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('多人采样时按实际发单账号双签，不把样品建档人误当发单人', () => {
  const db = openDb(':memory:')
  const { sheet, samplerA, samplerB } = multiSamplerSetup(db)
  sendHandoverSheet(db, sheet.id, samplerB)
  const received = confirmHandoverSheet(db, sheet.id, samplerA)
  assert.equal(received.to_person, samplerA.name)
})

test('显示名相同的两个账号仍可作为不同交接双方', () => {
  const db = openDb(':memory:')
  const { sheet, samplerA, samplerB } = multiSamplerSetup(db, true)
  sendHandoverSheet(db, sheet.id, samplerB)
  assert.equal(confirmHandoverSheet(db, sheet.id, samplerA).status, 'confirmed')
})

test('发单人改名后仍不能用同一账号接收自己的交接单', () => {
  const db = openDb(':memory:')
  const { sheet, samplerB } = multiSamplerSetup(db)
  sendHandoverSheet(db, sheet.id, samplerB)
  db.prepare(`UPDATE users SET name='乙采样改名', roles='["sampler","sample_manager"]' WHERE username=?`).run(samplerB.username)
  assert.throws(
    () => confirmHandoverSheet(db, sheet.id, { username: samplerB.username, name: '乙采样改名' }),
    /自己|交样人/,
  )
})

test('旧库幂等迁移交接单发单账号列', () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-sender-migration-'))
  const path = join(dir, 'legacy.sqlite')
  try {
    const legacy = new DatabaseSync(path)
    legacy.exec(`CREATE TABLE handover_sheets (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, contract_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'field', sample_ids TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '[]',
      from_person TEXT, from_at TEXT, to_person TEXT, to_at TEXT, storage TEXT,
      status TEXT NOT NULL DEFAULT 'draft', note TEXT, created_at TEXT NOT NULL
    )`)
    legacy.close()
    openDb(path).close()
    const reopened = openDb(path)
    const columns = reopened.prepare(`PRAGMA table_info(handover_sheets)`).all() as any[]
    assert.equal(columns.filter(column => column.name === 'from_username').length, 1)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('草稿不能直接签收；交样人不能自签', () => {
  const db = openDb(':memory:')
  const { r } = setup(db)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  assert.throws(() => confirmHandoverSheet(db, sh.id, managerActor), /发出|草稿/)
  sendHandoverSheet(db, sh.id, samplerActor)
  db.prepare(`UPDATE users SET roles='["sampler","sample_manager"]' WHERE username=?`).run(samplerActor.username)
  assert.throws(() => confirmHandoverSheet(db, sh.id, samplerActor), /自己|交样人/)
})

test('显式单人验收模式允许配置的管理员自签交接并留下豁免审计', () => {
  const previousUsername = process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
  const previousUntil = process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
  process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = samplerActor.username
  process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = '2099-12-31T23:59:59.999Z'
  try {
    const db = openDb(':memory:')
    const { r } = setup(db)
    const sh = listHandoverSheets(db, { roundId: r.id })[0]
    db.prepare(`UPDATE users SET roles='["admin","sampler","sample_manager"]' WHERE username=?`).run(samplerActor.username)
    sendHandoverSheet(db, sh.id, samplerActor)

    assert.equal(confirmHandoverSheet(db, sh.id, samplerActor).status, 'confirmed')
    const audit = db.prepare(`SELECT detail FROM audit_log WHERE record_id=? AND action='acceptance_override_handover_confirm'`).get(sh.id) as any
    assert.equal(JSON.parse(audit.detail).normalRule, '交样人与收样人必须不同')
  } finally {
    if (previousUsername === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME
    else process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME = previousUsername
    if (previousUntil === undefined) delete process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL
    else process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL = previousUntil
  }
})

test('逐条交接的签收提示统一指向样品管理员而不是质控员', () => {
  const db = openDb(':memory:')
  const { made } = setup(db)
  const handover = addHandover(db, made[0].id, { action: '采样交接' }, { name: '赵采样', username: 'sampler' })
  assert.throws(
    () => confirmHandover(db, handover.id, { name: '赵采样', username: 'sampler' }),
    error => /样品管理员/.test(String((error as Error).message)) && !/质控员/.test(String((error as Error).message)),
  )
})

test('拒收：整单签收时可拒个别样品——被拒样品不确认交接、派任务被拦、拒收留痕', () => {
  const db = openDb(':memory:')
  const { r, made } = setup(db)
  const sh = listHandoverSheets(db, { roundId: r.id })[0]
  sendHandoverSheet(db, sh.id, samplerActor)
  const normals = made.filter(s => !s.qc_type)
  const bad = normals[0]
  const done = confirmHandoverSheet(db, sh.id, managerActor, { rejects: [{ sampleId: bad.id, reason: '采样瓶破损' }] })
  assert.equal(done.status, 'confirmed')
  const badRow = done.detail.find((d: any) => d.sampleId === bad.id)
  assert.ok(badRow.rejected, '明细行标记拒收')
  assert.equal(badRow.rejectReason, '采样瓶破损')
  // 被拒样品是终态（2026-08-01 起）：派任务被拒收拦截（原来靠交接闸悬着，现在流水已关闭防止永挂待签收）
  assert.throws(() => assignTestTasks(db, bad.id, [{ analyte: 'COD', assignee: '赵检测' }], qcActor), /拒收/)
  // 拒收在样品交接流水里留痕
  const hs = listHandovers(db, bad.id)
  assert.ok(hs.some(h => h.action === '拒收' && (h.note || '').includes('采样瓶破损')), '拒收流水+原因')
})
