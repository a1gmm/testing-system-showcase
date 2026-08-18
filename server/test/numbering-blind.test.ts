// 2026-07-31 拍板：样品编号统一新规——介质码+YYMMDD-序号（如 W260731-1）
// 要点：不含合同段/点位段（真盲不泄底）；质控样与普通样连续不可区分；空白样序号 0（沿纸质习惯）
import { test } from 'node:test'
import assert from 'node:assert'
import { openDb } from '../src/db.ts'
import {
  nextBlindSampleId, createSample, createContract, acceptContract, createScheme, reviewScheme,
  listRounds, assignRound, confirmRoundField, sampleRound, composeFreq, createUser,
} from '../src/handlers.ts'

function ymdToday(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

test('nextBlindSampleId：介质码+YYMMDD-序号，同介质同日递增，不补零', () => {
  const db = openDb(':memory:')
  assert.equal(nextBlindSampleId(db, '废水', '2026-03-15'), 'W260315-1')
  db.prepare(`INSERT INTO samples (id, client, matrix, items, status, note, source, created_at)
    VALUES ('W260315-1','','废水','[]','pending','','self','x')`).run()
  assert.equal(nextBlindSampleId(db, '废水', '2026-03-15'), 'W260315-2')
})

test('nextBlindSampleId：介质、日期各自独立序列', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO samples (id, client, matrix, items, status, note, source, created_at)
    VALUES ('W260315-1','','废水','[]','pending','','self','x')`).run()
  assert.equal(nextBlindSampleId(db, '废气', '2026-03-15'), 'Q260315-1', '废气独立起算')
  assert.equal(nextBlindSampleId(db, '废水', '2026-03-16'), 'W260316-1', '换天独立起算')
})

test('nextBlindSampleId：空白样序号 0，同日多个空白 0/00 递增，且不干扰普通序列', () => {
  const db = openDb(':memory:')
  assert.equal(nextBlindSampleId(db, '废水', '2026-07-31', 'blank'), 'W260731-0')
  db.prepare(`INSERT INTO samples (id, client, matrix, items, status, note, source, created_at)
    VALUES ('W260731-0','','废水','[]','pending','','self','x')`).run()
  assert.equal(nextBlindSampleId(db, '废水', '2026-07-31', 'blank'), 'W260731-00')
  assert.equal(nextBlindSampleId(db, '废水', '2026-07-31'), 'W260731-1', '空白不占普通序号')
})

test('nextBlindSampleId：序号破十不撞号（数值比较，非字符串排序）', () => {
  const db = openDb(':memory:')
  for (let i = 1; i <= 11; i++)
    db.prepare(`INSERT INTO samples (id, client, matrix, items, status, note, source, created_at)
      VALUES ('W260731-${i}','','废水','[]','pending','','self','x')`).run()
  assert.equal(nextBlindSampleId(db, '废水', '2026-07-31'), 'W260731-12')
})

test('createSample：散样/合同样/质控样一律新格式，编号不含合同与点位', () => {
  const db = openDb(':memory:')
  const ymd = ymdToday()
  const s1 = createSample(db, { matrix: '废水' })
  assert.match(s1.id, new RegExp(`^W${ymd}-\\d+$`), `散样 ${s1.id}`)
  const c = createContract(db, { client: '盲样厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  const s2 = createSample(db, { matrix: '废水', contractId: c.id, pointName: '1#总排口', pointCode: `${c.id}-P1` })
  assert.match(s2.id, new RegExp(`^W${ymd}-\\d+$`), `合同样 ${s2.id} 不得含合同/点位段`)
  assert.ok(!s2.id.includes('P1') && !s2.id.includes(c.id), '编号里不能出现点位码或合同号')
  assert.equal(s2.point_name, '1#总排口', '点位仍存在字段里，只是不进编号')
  const s3 = createSample(db, { matrix: '废水', contractId: c.id, qcType: '现场平行', pointCode: `${c.id}-P1` })
  assert.match(s3.id, new RegExp(`^W${ymd}-\\d+$`), `质控样 ${s3.id} 与普通样格式一致`)
  assert.ok(!s3.id.includes('QC'), '质控样编号不可区分，不得含 QC 段')
  const s4 = createSample(db, { matrix: '废水', contractId: c.id, qcType: '全程序空白', pointCode: `${c.id}-P1` })
  assert.match(s4.id, new RegExp(`^W${ymd}-0+$`), `空白样 ${s4.id} 序号应为 0`)
})

test('sampleRound：期次收样整批走新格式且互不重号', () => {
  const db = openDb(':memory:')
  createUser(db, { username: 'demo_sampler', name: '赵采样', roles: ['sampler'], password: 'x12345' })
  createUser(db, { username: 'demo_tech', name: '许技术', roles: ['tech'], password: 'x12345' })
  const c = createContract(db, { client: '期次厂', project: '例行', periodStart: '2026-07-01', periodEnd: '2026-07-01' })
  acceptContract(db, c.id, '周登记')
  createScheme(db, {
    contractId: c.id, cycleMonths: 0, periodStart: '2026-07-01', periodEnd: '2026-07-01',
    points: [
      { element: '废水', point: '1#总排口', items: ['COD'], freq: composeFreq(1, 0), standard: 'GB8978' },
      { element: '废气', point: '2#烟囱', items: ['颗粒物'], freq: composeFreq(1, 0), standard: '' },
    ],
  })
  reviewScheme(db, c.id, 'approve', '许技术')
  const r = listRounds(db, c.id)[0]
  assignRound(db, r.id, ['赵采样', '许技术'])
  confirmRoundField(db, r.id, { name: '赵采样' })
  confirmRoundField(db, r.id, { name: '许技术' })
  const made = sampleRound(db, r.id, { name: '赵采样' })
  const ymd = ymdToday()
  for (const s of made) {
    const kind = s.qc_type?.includes('空白') ? '0+' : '[1-9]\\d*'
    assert.match(s.id, new RegExp(`^[WSDHTGAQYRN]${ymd}-${kind}$`), `${s.qc_type ?? '普通'}样 ${s.id}`)
  }
  assert.equal(new Set(made.map(s => s.id)).size, made.length, '整批不重号')
})
