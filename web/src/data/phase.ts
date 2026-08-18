import { fieldSurveyForms } from './forms/fieldSurveys'

// 作业环节：把每张表归到"谁在哪个环节填"的三档。
// 与 sheetType（表本身的性质）是两根不同的轴——sheetType 说这是什么表，phase 说这表在哪个环节用。
//
// 归类规则（2026-07 定，边界"现场直读"项目本轮暂全归实验室、以后单独翻）：
//   样品交接                    → 交接
//   采样记录 + fieldSurveys 现场表 → 现场
//   其余（原始记录/校准曲线/前处理…） → 实验室
//
// 想给个别表改档，在 templates.json 里给它加一个 phase 字段（'现场'|'交接'|'实验室'）即可，人工覆盖优先级最高。
export type Phase = '现场' | '交接' | '实验室'

// 挂在 fieldSurveys.ts 里的现场表：有几张被标成"原始记录"，但实际是拿到现场填的，单独拎出来判现场。
// 直接读 fieldSurveyForms 的键，避免和那份清单对不上。
const FIELD_FORM_CODES = new Set(Object.keys(fieldSurveyForms))

type PhaseInput = { code: string; sheetType: string; phase?: string }

export function templatePhase(t: PhaseInput): Phase {
  // 人工覆盖优先（只认三个合法值，瞎写的忽略）
  if (t.phase === '现场' || t.phase === '交接' || t.phase === '实验室') return t.phase
  if (t.sheetType === '样品交接') return '交接'
  if (t.sheetType === '采样记录') return '现场'
  if (FIELD_FORM_CODES.has(t.code)) return '现场'
  return '实验室'
}

export const PHASE_ORDER: Phase[] = ['现场', '交接', '实验室']
