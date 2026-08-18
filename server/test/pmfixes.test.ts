import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import {
  createContract, acceptContract, createSample, getSample,
  generateReport, checkReport, issueReport, saveRecord, reviewRecord,
  projectStats,
} from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

// —— 修复①：报告状态一致性（projectStats.reportStatus 反映真实进度）——
test('projectStats.reportStatus：无报告→none，编制中→draft，审核→checked，签发→issued', () => {
  const db = freshDb()
  const c = createContract(db, { client: '甲厂', project: '验收' })
  acceptContract(db, c.id, '周登记')
  const s = createSample(db, { matrix: '废水', items: ['锌'], contractId: c.id }, 2026)
  assert.equal(projectStats(db, c.id).reportStatus, 'none')

  // 录入→提交→复核→审核，让样品可出报告
  let rec = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-003', analyte: '锌', method: '原子吸收', data: { rows: [{ id: 'F-1', a: 0.06 }], resultSummary: { analyte: '锌', value: 1.2, unit: 'mg/L' } }, submit: true })
  rec = reviewRecord(db, rec.id, 'review_pass', '郑复核')
  rec = reviewRecord(db, rec.id, 'approve', '孙审核')

  const rep = generateReport(db, s.id)
  assert.equal(projectStats(db, c.id).reportStatus, 'draft')   // 已生成，编制中
  checkReport(db, rep.id, '孙审核')
  assert.equal(projectStats(db, c.id).reportStatus, 'checked')  // 待签发
  issueReport(db, rep.id, '林工程师')
  assert.equal(projectStats(db, c.id).reportStatus, 'issued')   // 已签发
})

// —— 修复②：样品来源留痕（凭空登记=自送样，走委托/采样=受托采样）——
test('样品来源 source：无委托=self（自送样），有委托/期次=field（受托采样）', () => {
  const db = freshDb()
  const selfSample = createSample(db, { matrix: '地表水', items: ['COD'] }, 2026)   // 检测录入凭空登记
  assert.equal(getSample(db, selfSample.id)!.source, 'self')

  const c = createContract(db, { client: '乙厂' })
  const fieldSample = createSample(db, { matrix: '废水', items: ['锌'], contractId: c.id }, 2026)
  assert.equal(getSample(db, fieldSample.id)!.source, 'field')
})

// —— 2026-07-29 用户实测：业务联系人和电话要分两个字段（打印合同分栏带出）——
test('合同 phone 字段：建单/改单都能存，联系人与电话分列', async () => {
  const { updateContract } = await import('../src/handlers.ts')
  const db = freshDb()
  const c = createContract(db, { client: '乙厂', contact: '张工', phone: '13800000000' })
  assert.equal(c.contact, '张工')
  assert.equal(c.phone, '13800000000')
  const r = updateContract(db, c.id, { phone: '13911111111' }, { name: '周登记' })
  assert.equal(r.contract.phone, '13911111111')
  assert.ok(r.changes.find(ch => ch.col === 'phone'))
})
