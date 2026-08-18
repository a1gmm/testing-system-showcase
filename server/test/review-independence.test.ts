// 三级审核同人校验（合规红线）：编制、复核、审核不能同一人；报告编制、审核、签发不能同一人
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createSample, saveRecord, reviewRecord,
  generateReport, checkReport, issueReport,
} from '../src/handlers.ts'

function makeSubmitted(db: ReturnType<typeof openDb>, who: string) {
  const s = createSample(db, { client: '同人校验厂', matrix: '废水', items: ['COD'] })
  const rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: { rows: [], resultSummary: { analyte: 'COD', value: 12, unit: 'mg/L' } }, who, submit: true })
  return { s, rec }
}

test('记录：复核人不能是编制人本人', () => {
  const db = openDb(':memory:')
  const { rec } = makeSubmitted(db, '张三')
  assert.throws(() => reviewRecord(db, rec.id, 'review_pass', '张三'), /不能.*本人|编制人/)
  // 换人就行
  const ok = reviewRecord(db, rec.id, 'review_pass', '李四')
  assert.equal(ok.status, 'reviewed')
})

test('记录：终审人不能是编制人，也不能与复核人同一人', () => {
  const db = openDb(':memory:')
  const { rec } = makeSubmitted(db, '张三')
  reviewRecord(db, rec.id, 'review_pass', '李四')
  assert.throws(() => reviewRecord(db, rec.id, 'approve', '张三'), /编制人/)
  assert.throws(() => reviewRecord(db, rec.id, 'approve', '李四'), /复核人/)
  const ok = reviewRecord(db, rec.id, 'approve', '王五')
  assert.equal(ok.status, 'approved')
})

test('记录：打回不受同人限制之外的影响（复核人打回照常）', () => {
  const db = openDb(':memory:')
  const { rec } = makeSubmitted(db, '张三')
  const r = reviewRecord(db, rec.id, 'review_reject', '李四', '数据不对')
  assert.equal(r.status, 'rejected')
})

test('记录：编制人自己打回自己也不行（打回属于复核动作）', () => {
  const db = openDb(':memory:')
  const { rec } = makeSubmitted(db, '张三')
  assert.throws(() => reviewRecord(db, rec.id, 'review_reject', '张三'), /编制人/)
})

test('报告：审核人不能是编制人；签发人不能是编制人或审核人', () => {
  const db = openDb(':memory:')
  const { s, rec } = makeSubmitted(db, '张三')
  reviewRecord(db, rec.id, 'review_pass', '李四')
  reviewRecord(db, rec.id, 'approve', '王五')
  const rep = generateReport(db, s.id, 2026, '赵编制')
  assert.equal((rep as any).author, '赵编制')
  assert.throws(() => checkReport(db, rep.id, '赵编制'), /编制人/)
  const checked = checkReport(db, rep.id, '钱审核')
  assert.equal(checked.status, 'checked')
  assert.throws(() => issueReport(db, rep.id, '赵编制'), /编制人/)
  assert.throws(() => issueReport(db, rep.id, '钱审核'), /审核人/)
  const issued = issueReport(db, rep.id, '孙签发')
  assert.equal(issued.status, 'issued')
})

test('老数据兼容：没有 author 的存量记录/报告不受同人校验阻塞', () => {
  const db = openDb(':memory:')
  const { s, rec } = makeSubmitted(db, '张三')
  db.prepare(`UPDATE records SET author=NULL WHERE id=?`).run(rec.id)
  const ok = reviewRecord(db, rec.id, 'review_pass', '张三')   // 老记录查不到编制人，放行（增量收紧）
  assert.equal(ok.status, 'reviewed')
  reviewRecord(db, rec.id, 'approve', '王五')
  const rep = generateReport(db, s.id, 2026)   // 不传编制人（老调用），照常生成
  const checked = checkReport(db, rep.id, '任何人')
  assert.equal(checked.status, 'checked')
})
