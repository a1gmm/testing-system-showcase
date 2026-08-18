import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createSample, addHandover, saveRecord, reviewRecord, createContract, createScheme, reviewScheme, listRounds,
  addAttachment, listAttachments, getAttachment, deleteAttachment,
  listAudit, canManageAttachment,
} from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }
const actor = { name: '赵采样', username: 'demo_sampler' }

// 建一条实验室分析记录，返回 id
function makeRecord(db: any) {
  const s = createSample(db, { matrix: '废水', client: '甲厂' }, 2026)
  const r = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: { rows: [] }, who: '陈检测' })
  return { sample: s, record: r }
}

test('附件：上传后按时间列出，记文件名+上传人', () => {
  const db = freshDb()
  const { record } = makeRecord(db)
  addAttachment(db, { entityType: 'record', entityId: record.id, origName: '小票.jpg', storedName: 'a1.jpg', mime: 'image/jpeg', size: 1234 }, actor)
  addAttachment(db, { entityType: 'record', entityId: record.id, origName: '现场.png', storedName: 'a2.png', mime: 'image/png', size: 999 }, actor)
  const list = listAttachments(db, 'record', record.id)
  assert.equal(list.length, 2)
  assert.equal(list[0].orig_name, '小票.jpg')
  assert.equal(list[0].stored_name, 'a1.jpg')
  assert.equal(list[0].who, '赵采样')
  assert.equal(list[0].username, 'demo_sampler')
})

test('附件：不支持的记录类型 / 文件名必填 / 目标记录不存在 都报错', () => {
  const db = freshDb()
  const { record } = makeRecord(db)
  assert.throws(() => addAttachment(db, { entityType: 'nope' as any, entityId: record.id, origName: 'x.jpg', storedName: 's.jpg' }, actor), /不支持|类型/)
  assert.throws(() => addAttachment(db, { entityType: 'record', entityId: record.id, origName: '', storedName: 's.jpg' }, actor), /文件名/)
  assert.throws(() => addAttachment(db, { entityType: 'record', entityId: 'MISSING', origName: 'x.jpg', storedName: 's.jpg' }, actor), /不存在/)
})

test('附件：软删后不再列出，但文件记录仍在库（只标记），并写留痕', () => {
  const db = freshDb()
  const { record } = makeRecord(db)
  const a = addAttachment(db, { entityType: 'record', entityId: record.id, origName: '小票.jpg', storedName: 'a1.jpg' }, actor)
  // 归属校验：别人（非 supervisor）删不了我传的
  assert.throws(() => deleteAttachment(db, a.id, { name: '孙审核', username: 'wang' }), /只能本人|技术负责人/)
  // supervisor（tech/admin）可以删任何人的
  deleteAttachment(db, a.id, { name: '孙审核', username: 'wang' }, true)
  assert.equal(listAttachments(db, 'record', record.id).length, 0)
  // 软删：getAttachment 默认取不到（已删），但底层行还在
  assert.equal(getAttachment(db, a.id), null)
  // 留痕：上传 + 删除各一条
  const audit = listAudit(db, record.id)
  const actions = audit.map(x => x.action)
  assert.ok(actions.includes('attach_add'), '应有上传留痕')
  assert.ok(actions.includes('attach_delete'), '应有删除留痕')
})

test('附件冻结：记录定稿(approved)后不能再增/删附件', () => {
  const db = freshDb()
  const { record } = makeRecord(db)
  // 先传一张（草稿态可传）
  const a = addAttachment(db, { entityType: 'record', entityId: record.id, origName: 'x.jpg', storedName: 's.jpg' }, actor)
  // 走完三级审核 → approved
  saveRecord(db, { sampleId: record.sample_id, code: 'HJ-TC-001', data: { rows: [] }, who: '陈检测', submit: true })
  reviewRecord(db, record.id, 'review_pass', '王复核')
  reviewRecord(db, record.id, 'approve', '陈审核')
  // 定稿后：加/删都拒绝
  assert.throws(() => addAttachment(db, { entityType: 'record', entityId: record.id, origName: 'y.jpg', storedName: 's2.jpg' }, actor), /定稿|冻结/)
  assert.throws(() => deleteAttachment(db, a.id, actor), /定稿|冻结/)
})

test('附件：采样交接等事件类记录也能挂附件（无定稿概念，可增删）', () => {
  const db = freshDb()
  const s = createSample(db, { matrix: '废水' }, 2026)
  const h = addHandover(db, s.id, { action: '采样交接', condition: '完好' }, actor)
  const a = addAttachment(db, { entityType: 'handover', entityId: String(h.id), origName: '交接单.jpg', storedName: 'h1.jpg' }, actor)
  assert.equal(listAttachments(db, 'handover', String(h.id)).length, 1)
  deleteAttachment(db, a.id, actor)
  assert.equal(listAttachments(db, 'handover', String(h.id)).length, 0)
})

test('现场采样单附件按期次和表号分别归档', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-08-01', periodEnd: '2026-08-01' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const round = listRounds(db, c.id)[0]
  const first = `${round.id}::HJ-TC-136`
  const second = `${round.id}::HJ-TC-146`
  addAttachment(db, { entityType: 'round_sheet', entityId: first, origName: '第一张.jpg', storedName: 'one.jpg' }, actor)
  addAttachment(db, { entityType: 'round_sheet', entityId: second, origName: '第二张.jpg', storedName: 'two.jpg' }, actor)
  assert.equal(listAttachments(db, 'round_sheet', first)[0].orig_name, '第一张.jpg')
  assert.equal(listAttachments(db, 'round_sheet', second)[0].orig_name, '第二张.jpg')
  assert.throws(() => addAttachment(db, { entityType: 'round_sheet', entityId: 'MISSING::HJ-TC-136', origName: 'x.jpg', storedName: 'x.jpg' }, actor), /不存在/)
  assert.throws(() => addAttachment(db, { entityType: 'round_sheet', entityId: round.id, origName: 'x.jpg', storedName: 'x.jpg' }, actor), /格式错误/)
  assert.throws(() => addAttachment(db, { entityType: 'round_sheet', entityId: `${round.id}::`, origName: 'x.jpg', storedName: 'x.jpg' }, actor), /格式错误/)
})

test('采样单附件只允许采样员、技术负责人和管理员管理', () => {
  assert.equal(canManageAttachment({ name: '赵采样', roles: ['sampler'] } as any, 'round_sheet'), true)
  assert.equal(canManageAttachment({ name: '许技术', roles: ['tech'] } as any, 'round_sheet'), true)
  assert.equal(canManageAttachment({ name: '管理员', roles: ['admin'] } as any, 'round_sheet'), true)
  assert.equal(canManageAttachment({ name: '周登记', roles: ['registrar'] } as any, 'round_sheet'), false)
  assert.equal(canManageAttachment({ name: '吴质控', roles: ['qc'] } as any, 'round_sheet'), false)
})

test('现场采样单附件在报告签发后冻结新增和删除', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-08-01', periodEnd: '2026-08-01' }, 2026)
  reviewScheme(db, c.id, 'approve', '许技术')
  const round = listRounds(db, c.id)[0]
  const target = `${round.id}::HJ-TC-136`
  const attachment = addAttachment(db, { entityType: 'round_sheet', entityId: target, origName: '现场.jpg', storedName: 'field.jpg' }, actor)
  db.prepare(`INSERT INTO reports (id, round_id, contract_id, client, title, conclusion, data, status, created_at)
    VALUES ('BG2026-9999', ?, ?, '甲厂', '报告', '', '{}', 'issued', '2026-08-02T00:00:00Z')`).run(round.id, c.id)
  assert.throws(() => addAttachment(db, { entityType: 'round_sheet', entityId: target, origName: '补传.jpg', storedName: 'late.jpg' }, actor), /冻结/)
  assert.throws(() => deleteAttachment(db, attachment.id, actor), /冻结/)
})
