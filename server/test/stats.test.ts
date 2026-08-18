import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createSample, addQc, addSystemRecord, statsOverview } from '../src/handlers.ts'

function freshDb() { return openDb(':memory:') }

test('统计看板：样品/质控/体系记录聚合正确', () => {
  const db = freshDb()
  createSample(db, { matrix: '土壤' }, 2026)
  createSample(db, { matrix: '废水' }, 2026)
  const actor = { name: '陈检测', username: 'demo_tester' }
  // 质控：2合格1不合格 → 合格率 67%
  addQc(db, { qcType: '平行样', v1: 10, v2: 10 }, actor)   // 合格
  addQc(db, { qcType: '平行样', v1: 10, v2: 11 }, actor)   // RD≈4.8% 合格
  addQc(db, { qcType: '平行样', v1: 10, v2: 30 }, actor)   // RD=50% 不合格
  // 体系记录：内审已完成，管评仅计划中
  addSystemRecord(db, { category: '内部审核', title: '2026内审', status: '已完成' }, actor)
  addSystemRecord(db, { category: '管理评审', title: '2026管评', status: '计划中' }, actor)

  const s = statsOverview(db)
  assert.equal(s.samples.total, 2)
  assert.equal(s.samples.pending, 2)          // 新建样品默认 pending
  assert.equal(s.qc.total, 3)
  assert.equal(s.qc.pass, 2)
  assert.equal(s.qc.rate, 67)
  assert.equal(s.system.audit, true)          // 内审已完成
  assert.equal(s.system.review, false)        // 管评未完成
  assert.equal(s.system.train, false)         // 没有培训记录
})

test('统计看板：空库不崩，比率为 null', () => {
  const db = freshDb()
  const s = statsOverview(db)
  assert.equal(s.samples.total, 0)
  assert.equal(s.reports.total, 0)
  assert.equal(s.qc.rate, null)
  assert.equal(s.resource.alerts, 0)
})
