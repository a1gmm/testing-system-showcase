import { describe, it, expect } from 'vitest'
import { templatePhase, PHASE_ORDER } from '../src/data/phase'
import { fieldSurveyForms } from '../src/data/forms/fieldSurveys'

describe('templatePhase 作业环节归类', () => {
  it('样品交接 → 交接', () => {
    expect(templatePhase({ code: 'HJ-TC-999', sheetType: '样品交接' })).toBe('交接')
  })

  it('采样记录 → 现场', () => {
    expect(templatePhase({ code: 'HJ-TC-710', sheetType: '采样记录' })).toBe('现场')
  })

  it('校准曲线 / 前处理 / 普通原始记录 → 实验室', () => {
    expect(templatePhase({ code: 'HJ-TC-001', sheetType: '原始记录' })).toBe('实验室')
    expect(templatePhase({ code: 'HJ-TC-500', sheetType: '校准曲线' })).toBe('实验室')
    expect(templatePhase({ code: 'HJ-TC-777', sheetType: '前处理' })).toBe('实验室')
  })

  it('挂在 fieldSurveys 里、被标为原始记录的现场表 → 现场', () => {
    // 133 油烟 / 461 烟气CEMS比对 / 564 区域声环境 / 733 铁路边界噪声 都是原始记录但现场填
    expect(templatePhase({ code: 'HJ-TC-133', sheetType: '原始记录' })).toBe('现场')
    expect(templatePhase({ code: 'HJ-TC-461', sheetType: '原始记录' })).toBe('现场')
    expect(templatePhase({ code: 'HJ-TC-564', sheetType: '原始记录' })).toBe('现场')
    expect(templatePhase({ code: 'HJ-TC-733', sheetType: '原始记录' })).toBe('现场')
  })

  it('fieldSurveyForms 里的每张表都判为现场（防清单漂移）', () => {
    for (const code of Object.keys(fieldSurveyForms)) {
      expect(templatePhase({ code, sheetType: '原始记录' })).toBe('现场')
    }
  })

  it('templates.json 的 phase 字段可人工覆盖、优先级最高', () => {
    // 一张本会判成实验室的原始记录，人工标成现场
    expect(templatePhase({ code: 'HJ-TC-047', sheetType: '原始记录', phase: '现场' })).toBe('现场')
    // 一张采样记录人工标回实验室
    expect(templatePhase({ code: 'HJ-TC-710', sheetType: '采样记录', phase: '实验室' })).toBe('实验室')
    // 非法覆盖值忽略，回落到规则
    expect(templatePhase({ code: 'HJ-TC-047', sheetType: '原始记录', phase: '瞎写' })).toBe('实验室')
  })

  it('PHASE_ORDER 固定为 现场 → 交接 → 实验室', () => {
    expect(PHASE_ORDER).toEqual(['现场', '交接', '实验室'])
  })
})
