import standardsRaw from './standards.json'

export type StandardInfo = {
  code: string
  name: string
  detail: string
  isGB: boolean
  current: boolean
  currentCode: string | null
  pdf: string | null
  crawled: boolean
}

const standards = standardsRaw as Record<string, StandardInfo>

/** 归一化标准编号：去空格/破折号/斜杠，大写。HJ 491—2019 -> HJ4912019 */
export function normCode(s: string): string {
  return (s || '').replace(/[\s—–－/]/g, '').toUpperCase()
}

export type StandardStatus =
  | { kind: 'none' }                                  // 无依据/查不到
  | { kind: 'gb'; info: StandardInfo }                // GB 需人工
  | { kind: 'outdated'; info: StandardInfo }          // 用了旧版
  | { kind: 'missing'; info: StandardInfo }           // HJ 现行但未入库
  | { kind: 'ok'; info: StandardInfo }                // 现行且已入库

/** 由表格的 meta.basis 解析出标准状态 */
export function resolveStandard(basis: string | undefined | null): StandardStatus {
  if (!basis || !basis.trim()) return { kind: 'none' }
  const info = standards[normCode(basis)]
  if (!info) return { kind: 'none' }
  if (info.isGB) return { kind: 'gb', info }
  if (!info.current) return { kind: 'outdated', info }
  if (!info.crawled) return { kind: 'missing', info }
  return { kind: 'ok', info }
}

/** 查某个标准码对应的现行版信息（用于"应换成 XXX"提示） */
export function lookupStandard(code: string | undefined | null): StandardInfo | null {
  if (!code) return null
  return standards[normCode(code)] || null
}
