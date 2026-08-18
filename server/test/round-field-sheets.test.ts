import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createContract, createScheme, reviewScheme, listRounds,
  addAttachment, listAttachments, deleteAttachment, listAudit,
  saveRoundSheet, getRoundSheet, listRoundSheets,
} from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }
const actor = { name: '赵采样', username: 'demo_sampler' }

// 帮手：建合同+方案+审批 → 排出期次，返回第一期
function makeRound(db: any) {
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['锌'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-05-01', periodEnd: '2026-05-01' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  return listRounds(db, c.id)[0]
}

// ============ 期次附件：采样员现场传照片/交接单扫描件 ============

test('期次附件：可传可列，期次不存在报错', () => {
  const db = freshDb()
  const r = makeRound(db)
  addAttachment(db, { entityType: 'round', entityId: r.id, origName: '现场照片.jpg', storedName: 'p1.jpg', mime: 'image/jpeg', size: 100 }, actor)
  const list = listAttachments(db, 'round', r.id)
  assert.equal(list.length, 1)
  assert.equal(list[0].orig_name, '现场照片.jpg')
  assert.equal(list[0].who, '赵采样')
  assert.throws(() => addAttachment(db, { entityType: 'round', entityId: 'MISSING', origName: 'x.jpg', storedName: 's.jpg' }, actor), /不存在/)
})

test('期次附件：事件类无定稿概念，随时可增删', () => {
  const db = freshDb()
  const r = makeRound(db)
  const a = addAttachment(db, { entityType: 'round', entityId: r.id, origName: '交接单.pdf', storedName: 'h.pdf' }, actor)
  // 不像实验室记录有 approved 冻结——期次附件任何时候都能删（软删）
  deleteAttachment(db, a.id, actor)
  assert.equal(listAttachments(db, 'round', r.id).length, 0)
})

// ============ 期次现场表单：采样员现场按精确版式填原始记录 ============

test('期次表单：按(期次,表号)存取，重存覆盖并更新时间与人', () => {
  const db = freshDb()
  const r = makeRound(db)
  saveRoundSheet(db, r.id, 'HJ-TC-710', { cells: { 'kv.point': '1#排口' }, meta: { weather: '晴' } }, actor)
  let s = getRoundSheet(db, r.id, 'HJ-TC-710')
  assert.ok(s)
  assert.equal(s!.data.cells['kv.point'], '1#排口')
  assert.equal(s!.who, '赵采样')
  // 重存同一张表：覆盖不重复建
  saveRoundSheet(db, r.id, 'HJ-TC-710', { cells: { 'kv.point': '2#排口' } }, { name: '许技术' })
  s = getRoundSheet(db, r.id, 'HJ-TC-710')
  assert.equal(s!.data.cells['kv.point'], '2#排口')
  assert.equal(s!.who, '许技术')
  assert.equal(listRoundSheets(db, r.id).length, 1)
})

test('期次表单：一期可存多张表，期次不存在报错', () => {
  const db = freshDb()
  const r = makeRound(db)
  saveRoundSheet(db, r.id, 'HJ-TC-710', { cells: {} }, actor)
  saveRoundSheet(db, r.id, 'HJ-TC-564', { cells: {} }, actor)
  assert.equal(listRoundSheets(db, r.id).length, 2)
  assert.equal(getRoundSheet(db, r.id, 'HJ-TC-999'), null)
  assert.throws(() => saveRoundSheet(db, 'MISSING', 'HJ-TC-710', {}, actor), /不存在/)
})

test('期次表单：保存写留痕(round_sheet)', () => {
  const db = freshDb()
  const r = makeRound(db)
  saveRoundSheet(db, r.id, 'HJ-TC-710', { cells: {} }, actor)
  const audit = listAudit(db, r.id)
  assert.ok(audit.some((a: any) => a.action === 'round_sheet' && a.who === '赵采样'))
})
