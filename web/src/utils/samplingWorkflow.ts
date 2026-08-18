import { templatePhase } from '../data/phase'
import type { FieldInfo } from '../api'

type SamplingTemplate = {
  code: string; name: string; matrix: string; sheetType: string
  analyte?: string; raw?: string; phase?: string; stage?: string
}

type PlanItem = { matrix: string; point?: string; items: string[]; qty: number }

export function gasMatrixBase(matrix: string) {
  return matrix === '有组织废气' || matrix === '无组织废气' ? '废气' : matrix
}

export function samplingSheetsForMatrix<T extends SamplingTemplate>(templates: T[], matrix: string): T[] {
  const base = gasMatrixBase(matrix)
  const candidates = templates.filter(t => templatePhase(t) === '现场' && t.matrix === base)
  if (matrix === '有组织废气') return candidates.filter(t => !/无组织/.test(`${t.name} ${t.raw || ''}`))
  if (matrix === '无组织废气') return candidates.filter(t => /无组织/.test(`${t.name} ${t.raw || ''}`))
  return candidates
}

export function initialSheetCodes(field: FieldInfo, matrix: string, fallback = ''): string[] {
  const selected = field.sheetCodes?.[matrix]?.filter(Boolean) || []
  if (selected.length) return [...new Set(selected)]
  const legacy = field.sheets?.[matrix]?.code
  return legacy ? [legacy] : (fallback ? [fallback] : [])
}

export function waterSamplingDefaults(item: string): { volume: string; preserve: string } {
  const value = String(item || '').trim()
  if (/化学需氧量|COD(?!Mn)|总有机碳|TOC|总氮|TN|总磷|TP|氨氮/.test(value)) return { volume: '500', preserve: 'G3' }
  if (/pH|色度|浊度|透明度|电导率|溶解性总固体|悬浮物|氯化物|硫酸盐|硝酸盐氮|亚硝酸盐氮/.test(value)) return { volume: '', preserve: 'P13' }
  if (/石油类|动植物油/.test(value)) return { volume: '500', preserve: 'G7' }
  if (/总氰|氰化物/.test(value)) return { volume: '500', preserve: 'G4' }
  return { volume: '', preserve: '' }
}

export function buildRoundSheetSeed(input: {
  plannedDate: string; organization: string; projectNo: string; planItems: PlanItem[]; matrix: string
}) {
  const rows: Record<string, string>[] = []
  for (const plan of input.planItems.filter(p => p.matrix === input.matrix)) {
    for (let i = 0; i < Math.max(1, Number(plan.qty) || 1); i++) {
      for (const item of plan.items?.length ? plan.items : ['']) {
        const defaults = gasMatrixBase(input.matrix).includes('水') ? waterSamplingDefaults(item) : { volume: '', preserve: '' }
        rows.push({ point: plan.point || '', item, volume: defaults.volume, preserve: defaults.preserve })
      }
    }
  }
  return {
    meta: {
      date: input.plannedDate, samplingDate: input.plannedDate, sampleDate: input.plannedDate,
      measureDate: input.plannedDate, monitorDate: input.plannedDate,
      org: input.organization, unit: input.organization, projectNo: input.projectNo, projNo: input.projectNo,
    },
    rows,
  }
}
