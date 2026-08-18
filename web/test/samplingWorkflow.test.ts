import { describe, expect, it } from 'vitest'
import templates from '../src/data/templates.json'
import {
  buildRoundSheetSeed,
  gasMatrixBase,
  initialSheetCodes,
  samplingSheetsForMatrix,
  waterSamplingDefaults,
} from '../src/utils/samplingWorkflow'

describe('采样派工现场表单工作流', () => {
  const all = templates as any[]

  it('有组织与无组织废气分别只显示适用的采样表', () => {
    expect(gasMatrixBase('有组织废气')).toBe('废气')
    expect(gasMatrixBase('无组织废气')).toBe('废气')
    const organized = samplingSheetsForMatrix(all, '有组织废气').map(t => t.code)
    const fugitive = samplingSheetsForMatrix(all, '无组织废气').map(t => t.code)
    expect(organized).toContain('HJ-TC-143')
    expect(organized).not.toContain('HJ-TC-279')
    expect(fugitive).toContain('HJ-TC-279')
    expect(fugitive).toContain('HJ-TC-389')
    expect(fugitive).not.toContain('HJ-TC-143')
  })

  it('同一介质可保留多张已选采样单，并兼容旧版单选字段', () => {
    expect(initialSheetCodes({ sheetCodes: { 废水: ['HJ-TC-136', 'HJ-TC-146'] } } as any, '废水', 'HJ-TC-136'))
      .toEqual(['HJ-TC-136', 'HJ-TC-146'])
    expect(initialSheetCodes({ sheets: { 废水: { code: 'HJ-TC-136', name: '旧数据' } } } as any, '废水', 'HJ-TC-146'))
      .toEqual(['HJ-TC-136'])
  })

  it('新采样单带入计划日期、单位、点位、项目及水样保存建议', () => {
    const seed = buildRoundSheetSeed({
      plannedDate: '2026-08-01', organization: '甲厂', projectNo: 'WT2026-0005',
      planItems: [{ matrix: '废水', point: '排污口', items: ['化学需氧量'], qty: 1 }], matrix: '废水',
    })
    expect(seed.meta.date).toBe('2026-08-01')
    expect(seed.meta.samplingDate).toBe('2026-08-01')
    expect(seed.meta.org).toBe('甲厂')
    expect(seed.meta.projectNo).toBe('WT2026-0005')
    expect(seed.rows[0]).toMatchObject({ point: '排污口', item: '化学需氧量', volume: '500', preserve: 'G3' })
  })

  it('废水常见项目按当前采样表规则给出可修改的采样量与保存方法', () => {
    expect(waterSamplingDefaults('化学需氧量')).toEqual({ volume: '500', preserve: 'G3' })
    expect(waterSamplingDefaults('pH')).toEqual({ volume: '', preserve: 'P13' })
    expect(waterSamplingDefaults('未知项目')).toEqual({ volume: '', preserve: '' })
    expect(waterSamplingDefaults('石油类')).toEqual({ volume: '500', preserve: 'G7' })
    expect(waterSamplingDefaults('总氰化物')).toEqual({ volume: '500', preserve: 'G4' })
  })

  it('按计划数量展开多行，非水基质不误套水样保存规则', () => {
    const water = buildRoundSheetSeed({
      plannedDate: '2026-08-01', organization: '甲厂', projectNo: 'WT2026-0005',
      planItems: [{ matrix: '废水', point: '排污口', items: ['化学需氧量'], qty: 3 }], matrix: '废水',
    })
    expect(water.rows).toHaveLength(3)
    expect(water.rows.every(r => r.point === '排污口' && r.preserve === 'G3')).toBe(true)
    const gas = buildRoundSheetSeed({
      plannedDate: '2026-08-01', organization: '甲厂', projectNo: 'WT2026-0005',
      planItems: [{ matrix: '有组织废气', point: '排气筒', items: ['化学需氧量'], qty: 1 }], matrix: '有组织废气',
    })
    expect(gas.rows[0]).toMatchObject({ point: '排气筒', volume: '', preserve: '' })
  })

  it('混合水样项目按项目拆行，不用首个保存规则覆盖其他项目', () => {
    const seed = buildRoundSheetSeed({
      plannedDate: '2026-08-01', organization: '甲厂', projectNo: 'WT2026-0005',
      planItems: [{ matrix: '废水', point: '排污口', items: ['化学需氧量', '石油类'], qty: 1 }], matrix: '废水',
    })
    expect(seed.rows).toEqual([
      { point: '排污口', item: '化学需氧量', volume: '500', preserve: 'G3' },
      { point: '排污口', item: '石油类', volume: '500', preserve: 'G7' },
    ])
  })
})
