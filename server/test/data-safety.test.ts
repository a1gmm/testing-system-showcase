// 批次2 数据安全：乐观锁（records/round_sheets）、sampleRound 事务回滚、受理保留评审
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createSample, saveRecord, saveRoundSheet, getRoundSheet,
  createContract, acceptContract, getContract, createScheme, reviewScheme,
  sampleRound, getRound, confirmRoundField,
} from '../src/handlers.ts'

test('记录乐观锁：带旧 baseUpdatedAt 保存被拒；带最新的能存', () => {
  const db = openDb(':memory:')
  const s = createSample(db, { client: 'x', matrix: '废水', items: ['COD'] })
  const r1 = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: { rows: [1] }, who: '甲' })
  // 乙在甲之后保存（模拟并发：乙拿的是不存在时的基线 ''）
  assert.throws(() => saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: { rows: [2] }, who: '乙', baseUpdatedAt: '' }), /已被|阻止本次保存/)
  // 甲拿最新基线继续存，没问题
  const r2 = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: { rows: [3] }, who: '甲', baseUpdatedAt: r1.updated_at })
  assert.ok(r2.updated_at >= r1.updated_at)
  // 老客户端不带 baseUpdatedAt：不启用锁（向后兼容）
  const r3 = saveRecord(db, { sampleId: s.id, code: 'HJ-TC-001', data: { rows: [4] }, who: '丙' })
  assert.ok(r3.id)
})

function makeRoundedContract(db: any) {
  const c = createContract(db, { client: '事务厂', project: 'x', periodStart: '2026-07-01', periodEnd: '2026-07-01', plan: [{ matrix: '废水', items: ['COD'], qty: 1, cycleMonths: 0 }] })
  acceptContract(db, c.id, '周登记')
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01', points: [{ element: '废水', point: '1#口', items: ['COD'], freq: '每天1次 · 单次', standard: '' }], limits: [] })
  reviewScheme(db, c.id, 'approve', '许技术')
  const round = (db.prepare(`SELECT * FROM rounds WHERE contract_id=?`).all(c.id) as any[])[0]
  db.prepare(`UPDATE rounds SET sampler='赵采样、许技术', sampler_ids='["demo_sampler","demo_tech"]', assignment_status='active' WHERE id=?`).run(round.id)
  // 两人采样双确认（§8.3）：入库前两名采样员都得确认
  confirmRoundField(db, round.id, { name: '赵采样', username: 'demo_sampler' })
  confirmRoundField(db, round.id, { name: '许技术', username: 'demo_tech' })
  return { c, roundId: round.id as string }
}

test('采样单乐观锁：后保存的带旧基线被拒，不会抹掉前一个人的数据', () => {
  const db = openDb(':memory:')
  const { roundId } = makeRoundedContract(db)
  saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [{ v: '老张的12行' }] }, { name: '老张', username: 'zhang' }, '')
  // 小李开表时表还不存在（基线 ''），老张先存了 → 小李保存被拒
  assert.throws(() => saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [{ v: '小李的行' }] }, { name: '小李', username: 'li' }, ''), /已被「老张」保存|阻止本次保存/)
  // 老张的数据还在
  assert.equal(getRoundSheet(db, roundId, 'HJ-TC-136')!.data.rows[0].v, '老张的12行')
  // 小李刷新拿到最新基线后能存
  const cur = getRoundSheet(db, roundId, 'HJ-TC-136')!
  const ok = saveRoundSheet(db, roundId, 'HJ-TC-136', { rows: [{ v: '合并后的' }] }, { name: '小李', username: 'li' }, cur.updated_at)
  assert.ok(ok.updated_at)
})

test('sampleRound 事务：中途失败全回滚，不留半截样品，期次不落 done', () => {
  const db = openDb(':memory:')
  const { roundId } = makeRoundedContract(db)
  // 用触发器在第二个样品入库时引爆，模拟中途失败（断电/约束冲突等）
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON samples WHEN NEW.matrix='炸' BEGIN SELECT RAISE(ABORT,'boom'); END`)
  db.prepare(`UPDATE rounds SET items=? WHERE id=?`)
    .run(JSON.stringify([{ matrix: '废水', items: ['COD'], qty: 1, point: '1#口' }, { matrix: '炸', items: [], qty: 1, point: '1#口' }]), roundId)
  assert.throws(() => sampleRound(db, roundId, { name: '赵采样', username: 'demo_sampler' }))
  // 回滚干净：没有半截样品，期次仍是待采
  const left = db.prepare(`SELECT COUNT(*) n FROM samples WHERE round_id=?`).get(roundId) as any
  assert.equal(left.n, 0)
  assert.equal(getRound(db, roundId)!.status, 'pending')
  // 修好数据后重试能正常入库（假幂等已修：不会把半截当已采）
  db.exec(`DROP TRIGGER boom`)
  db.prepare(`UPDATE rounds SET items=? WHERE id=?`).run(JSON.stringify([{ matrix: '废水', items: ['COD'], qty: 1, point: '1#口' }]), roundId)
  const made = sampleRound(db, roundId, { name: '赵采样', username: 'demo_sampler' })
  assert.ok(made.length >= 1)
  assert.equal(getRound(db, roundId)!.status, 'done')
})

test('确认受理不带评审时，保留建单时填的评审记录', () => {
  const db = openDb(':memory:')
  const c = createContract(db, { client: '评审厂', project: 'x', review: { conclusion: '能做' } })
  assert.ok(getContract(db, c.id)!.review_info)
  acceptContract(db, c.id, '周登记')   // 不带 review
  assert.deepEqual(getContract(db, c.id)!.review_info, { conclusion: '能做' })
})
