// PRD 步骤6 跨合同同表：一张表多样品批量录入，按样品编号自动归各自合同
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import { createSample, saveRecordsBatch, getRecord, listRecords } from '../src/handlers.ts'

test('批量录入：多个样品各落一条记录，data 归各自样品；同表同人一次提交', () => {
  const db = openDb(':memory:')
  const s1 = createSample(db, { client: '甲厂', matrix: '废水', items: ['COD'] })
  const s2 = createSample(db, { client: '乙厂', matrix: '废水', items: ['COD'] })
  const recs = saveRecordsBatch(db, {
    code: 'HJ-TC-030', analyte: 'COD', matrix: '废水', method: '重铬酸盐法',
    sharedMeta: { date: '2026-07-29', signer: '陈检测' },
    entries: [
      { sampleId: s1.id, row: { id: s1.id, v: 10 }, resultSummary: { analyte: 'COD', value: 15.2, unit: 'mg/L' } },
      { sampleId: s2.id, row: { id: s2.id, v: 20 }, resultSummary: { analyte: 'COD', value: 30.4, unit: 'mg/L' } },
    ],
    who: '陈检测',
  }, { supervisor: false })
  assert.equal(recs.length, 2)
  const r1 = getRecord(db, s1.id, 'HJ-TC-030')!
  const r2 = getRecord(db, s2.id, 'HJ-TC-030')!
  assert.equal(r1.data.resultSummary.value, 15.2)
  assert.equal(r2.data.resultSummary.value, 30.4)
  assert.equal((r1 as any).author, '陈检测')
  assert.equal(r1.data.meta.signer, '陈检测')
})

test('批量录入：一行失败整批回滚（一个样品占两行直接拒）', () => {
  const db = openDb(':memory:')
  const s1 = createSample(db, { client: '甲厂', matrix: '废水', items: ['COD'] })
  assert.throws(() => saveRecordsBatch(db, {
    code: 'HJ-TC-030',
    entries: [
      { sampleId: s1.id, row: { v: 1 } },
      { sampleId: s1.id, row: { v: 2 } },
    ],
    who: '陈检测',
  }), /一行/)
  // 中途炸整批回滚：第二个样品不存在
  assert.throws(() => saveRecordsBatch(db, {
    code: 'HJ-TC-030', analyte: 'COD',
    entries: [
      { sampleId: s1.id, row: { v: 1 } },
      { sampleId: 'NOPE', row: { v: 2 } },
    ],
    who: '陈检测',
  }, { supervisor: false }), /样品不存在/)
  assert.equal(listRecords(db, { sampleId: s1.id }).length, 0, '整批应回滚，第一条也不落库')
})
