import { describe, it, expect } from 'vitest'
import { auditText } from '../src/utils/auditText'

// 留痕明细渲染：后端 diffData 产出的 change 形状 → 审核员看的人话
// change 形状约定见 server/src/handlers.ts 的 DataChange：
//   row>=1 行内改动；row:0 表级字段，靠 col 前缀区分 meta: / cell: / reg:；comp 为组分名（多组分表）
const mk = (action: string, detail: any) => ({ id: 1, record_id: 'R1', who: '陈检测', action, detail, at: '2026-07-16T10:00:00' }) as any

describe('auditText', () => {
  it('单组分行内改动：第N行·列', () => {
    expect(auditText(mk('update', { changes: [{ row: 2, col: 'a', from: 0.115, to: 0.118 }] })))
      .toBe('第2行·a：0.115→0.118')
  })

  it('多组分行内改动：组分名在最前，定位到底改的是哪个组分', () => {
    expect(auditText(mk('update', { changes: [{ comp: '苯', row: 2, col: 'a', from: 0.115, to: 0.118 }] })))
      .toBe('苯·第2行·a：0.115→0.118')
  })

  it('meta 改动去掉前缀', () => {
    expect(auditText(mk('update', { changes: [{ row: 0, col: 'meta:instrument', from: 'GC-1', to: 'GC-2' }] })))
      .toBe('instrument：GC-1→GC-2')
  })

  it('曲线核查质控值译成中文标签，并带组分名', () => {
    expect(auditText(mk('update', { changes: [{ comp: '苯', row: 0, col: 'cell:midMeasured', from: 0.5, to: 0.52 }] })))
      .toBe('苯·曲线核查·中间点实测值：0.5→0.52')
  })

  it('校准曲线系数译成中文标签', () => {
    expect(auditText(mk('update', { changes: [{ row: 0, col: 'reg:b', from: 0.045, to: 0.051 }] })))
      .toBe('曲线系数b：0.045→0.051')
  })

  // 零浓度点测定值 0 是真实质控数据（应＜检出限），旧代码 row:0 分支用 `||` 会把它渲染成「空」
  it('表级字段的 0 如实显示，不被当成空', () => {
    expect(auditText(mk('update', { changes: [{ row: 0, col: 'cell:zero', from: 0.003, to: 0 }] })))
      .toBe('曲线核查·零浓度点测定值：0.003→0')
  })

  it('空值显示为「空」', () => {
    expect(auditText(mk('update', { changes: [{ comp: '二甲苯', row: 1, col: 'a', from: '', to: 5 }] })))
      .toBe('二甲苯·第1行·a：空→5')
  })

  it('多条改动用「；」连接', () => {
    expect(auditText(mk('update', {
      changes: [
        { comp: '乙苯', row: 1, col: 'a', from: 0.112, to: 0.9 },
        { row: 0, col: 'meta:instrument', from: 'GC-2010', to: 'GC-9790' },
      ],
    }))).toBe('乙苯·第1行·a：0.112→0.9；instrument：GC-2010→GC-9790')
  })

  it('新建记录报行数', () => {
    expect(auditText(mk('create', { rows: 3 }))).toBe('新建记录（3 行）')
  })

  // Archive.vue 原有分支：复核/审核打回时显示意见。合并后 StructuredSheet 也拿到这个能力。
  it('审核意见原样显示', () => {
    expect(auditText(mk('review_reject', { comment: '浓度算错了，重算' }))).toBe('浓度算错了，重算')
  })

  it('无明细时回退到动作标签', () => {
    expect(auditText(mk('approve', {}))).toBe('审核通过')
    expect(auditText(mk('update', { changes: [] }))).toBe('修改')
  })

  it('未知动作原样显示', () => {
    expect(auditText(mk('某新动作', {}))).toBe('某新动作')
  })
})
