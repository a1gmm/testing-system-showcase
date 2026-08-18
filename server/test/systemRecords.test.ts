import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { addSystemRecord, listSystemRecords, updateSystemRecord, SYSREC_CATEGORIES } from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

test('体系记录：追加内审/管评/培训，按分类过滤，倒序列出', () => {
  const db = freshDb()
  const actor = { name: '李质量', username: 'liqa' }
  addSystemRecord(db, { category: '内部审核', title: '2026年度内部审核', recDate: '2026-03-10', owner: '质量负责人', status: '已完成', result: '发现2项不符合，已整改' }, actor)
  addSystemRecord(db, { category: '管理评审', title: '2026年度管理评审', recDate: '2026-04-15', owner: '技术负责人', status: '进行中' }, actor)
  addSystemRecord(db, { category: '人员培训', title: '新版采样标准培训', recDate: '2026-05-01', owner: '培训组', status: '已完成', content: '参训8人，考核合格8人' }, actor)

  const all = listSystemRecords(db)
  assert.equal(all.length, 3)
  // 倒序：最后加的在最前
  assert.equal(all[0].category, '人员培训')

  const audit = listSystemRecords(db, { category: '内部审核' })
  assert.equal(audit.length, 1)
  assert.equal(audit[0].title, '2026年度内部审核')
  assert.equal(audit[0].result, '发现2项不符合，已整改')
  assert.equal(audit[0].who, '李质量')
  assert.equal(audit[0].username, 'liqa')
})

test('体系记录：分类与标题必填，非法分类报错', () => {
  const db = freshDb()
  const actor = { name: 'x' }
  assert.throws(() => addSystemRecord(db, { category: '', title: 'a', status: '进行中' }, actor), /分类/)
  assert.throws(() => addSystemRecord(db, { category: '内部审核', title: '', status: '进行中' }, actor), /标题/)
  assert.throws(() => addSystemRecord(db, { category: '乱写的', title: 'a', status: '进行中' }, actor), /分类/)
  assert.ok(SYSREC_CATEGORIES.includes('内部审核'))
})

test('体系记录：可更新状态与结论（活台账，如计划中→已完成）', () => {
  const db = freshDb()
  const actor = { name: '李质量', username: 'liqa' }
  const r = addSystemRecord(db, { category: '管理评审', title: '2026年度管理评审', status: '计划中' }, actor)
  const upd = updateSystemRecord(db, r.id, { status: '已完成', result: '体系运行有效，制定5项改进措施' }, actor)
  assert.equal(upd.status, '已完成')
  assert.equal(upd.result, '体系运行有效，制定5项改进措施')
  // 未传的字段保持不变
  assert.equal(upd.title, '2026年度管理评审')
})
