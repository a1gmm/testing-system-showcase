import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createSample, addHandover, saveRecord, reviewRecord,
  addAttachment, listAttachments, getAttachment, deleteAttachment,
  listAudit,
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
