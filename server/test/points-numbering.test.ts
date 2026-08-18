// 批次4：点位实体（决策1）+ 样品编号新规（决策9）+ 合同修改（决策8）
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  createContract, updateContract, acceptContract, createScheme, reviewScheme,
  listPoints, upsertPoint, setPointActual, listAudit,
  listRounds, assignRound, sampleRound, confirmRoundField, composeFreq,
  createUser,
} from '../src/handlers.ts'

const wj = { name: '许技术', username: 'demo_tech' }

function setup(db: any) {
  // 体检39：派工名字必须是在职且带采样岗（tech 兜底）的真实账号
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'demo_tech', name: '许技术', roles: ['tech'], password: 'x12345' })
  const c = createContract(db, { client: '点位厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [
      { element: '废水', point: '1#总排口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB8978' },
      { element: '废气', point: '2#烟囱', items: ['颗粒物'], freq: composeFreq(1, 0), standard: '' },
    ],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  return c
}

test('方案保存自动建点位档案：source=contract、编号 {合同号}-P{n}', () => {
  const db = openDb(':memory:')
  const c = setup(db)
  const pts = listPoints(db, c.id)
  assert.equal(pts.length, 2)
  assert.equal(pts[0].name, '1#总排口')
  assert.equal(pts[0].source, 'contract')
  assert.match(pts[0].code, new RegExp(`^${c.id}-P1$`))
  // 重存方案不重复建
  createScheme(db, { contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01', points: [{ element: '废水', point: '1#总排口', items: ['COD'], freq: composeFreq(1, 0), standard: '' }] })
  assert.equal(listPoints(db, c.id).length, 2)
})

test('现场补点 + 改实际位置留痕（决策1）', () => {
  const db = openDb(':memory:')
  const c = setup(db)
  const p = upsertPoint(db, c.id, { name: '临时加测口', matrix: '废水', source: 'field', actualDesc: '厂区东南角' }, wj)
  assert.equal(p.source, 'field')
  setPointActual(db, listPoints(db, c.id)[0].id, '实际在排口下游3米', wj)
  const audit = listAudit(db, c.id).map(a => a.action)
  assert.ok(audit.includes('point_add_field'), '现场补点应留痕')
  assert.ok(audit.includes('point_actual_change'), '改实际位置应留痕')
})

test('样品编号盲样新规（2026-07-31拍板）：介质码+YYMMDD-序号，不含合同/点位段，质控样不可区分', () => {
  const db = openDb(':memory:')
  const c = setup(db)
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样', '许技术'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  confirmRoundField(db, r.id, { name: '许技术' })
  const made = sampleRound(db, r.id, { name: '赵采样' })
  const normal = made.filter(s => !s.qc_type)
  const qc = made.filter(s => s.qc_type)
  const short = c.id.replace(/^WT/, '')
  // 普通样：介质码+YYMMDD-序号，编号本身不泄露合同与点位（真盲）
  assert.match(normal[0].id, /^[WSDHTGAQYRN]\d{6}-[1-9]\d*$/, `编号 ${normal[0].id} 应符合盲样新规`)
  assert.ok(!normal[0].id.includes(short) && !/P\d/.test(normal[0].id), '编号不得含合同段或点位段')
  assert.equal(normal[0].point_name, '1#总排口', '点位存字段不进编号')
  // 质控样：空白序号 0，平行样与普通样连续不可区分（编号里不得出现 QC）
  assert.ok(qc.length, '应有质控样')
  for (const s of qc) {
    const kind = s.qc_type!.includes('空白') ? '0+' : '[1-9]\\d*'
    assert.match(s.id, new RegExp(`^[WSDHTGAQYRN]\\d{6}-${kind}$`), `质控样 ${s.qc_type} 编号 ${s.id}`)
    assert.ok(!s.id.includes('QC'), '质控样编号不可区分')
  }
  // 整批不重号
  const ids = new Set(made.map(s => s.id))
  assert.equal(ids.size, made.length)
})

test('合同可改：字段级 diff 留痕；改有效期自动重排未派工期次（决策8+§8.4）', () => {
  const db = openDb(':memory:')
  const c = createContract(db, { client: '改单厂', project: '旧项目', periodStart: '2026-01-01', periodEnd: '2026-12-31' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-01-01', periodEnd: '2026-12-31',
    points: [{ element: '废水', point: 'A口', items: ['COD'], freq: composeFreq(1, 6), standard: '' }],  // 每半年 → 2 期
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  assert.equal(listRounds(db, c.id).length, 2)
  const r1 = updateContract(db, c.id, { project: '新项目名', periodEnd: '2026-06-30' }, wj)
  assert.equal(r1.contract.project, '新项目名')
  assert.equal(r1.changes.length, 2)
  assert.ok(r1.reschedule, '改了有效期应触发重排')
  assert.equal(listRounds(db, c.id).length, 1, '缩短有效期后未派工期次应减少')
  // 留痕
  const audit = listAudit(db, c.id)
  const upd = audit.find(a => a.action === 'contract_update')
  assert.ok(upd, '应有 contract_update 留痕')
  assert.equal((upd!.detail as any).changes.length, 2)
  // 没变化不写留痕
  const r2 = updateContract(db, c.id, { project: '新项目名' }, wj)
  assert.equal(r2.changes.length, 0)
})
