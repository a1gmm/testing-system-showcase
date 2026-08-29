import standardsRaw from './standards.json'
import templateEvidenceRaw from './templateStandardEvidence.json'

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

export type TemplateStandardEvidence = {
  kind: 'standard' | 'managed' | 'controlled'
  basis?: string[]
  source: string
  verifiedOn: string
  note: string
  upcoming?: Array<{
    basis: string
    effectiveOn: string
    note: string
  }>
}

export const templateStandardEvidence = templateEvidenceRaw as Record<string, TemplateStandardEvidence>

/** 归一化标准编号：去空格/破折号/斜杠，大写。HJ 491—2019 -> HJ4912019 */
export function normCode(s: string): string {
  return (s || '').replace(/[\s—–－\-/／]/g, '').toUpperCase()
}

export type StandardStatus =
  | { kind: 'pending'; basis: string[]; info: null; documentAvailable: false }
  | { kind: 'outdated'; basis: string[]; info: StandardInfo; documentAvailable: boolean }
  | { kind: 'verified'; basis: string[]; info: StandardInfo; documentAvailable: boolean }

export type TemplateStandardStatus =
  | StandardStatus
  | {
      kind: 'managed'
      basis: string[]
      info: null
      documentAvailable: false
      evidence: TemplateStandardEvidence
    }
  | {
      kind: 'controlled'
      basis: string[]
      info: null
      documentAvailable: false
      evidence: TemplateStandardEvidence
    }
  | {
      kind: 'outdated'
      basis: string[]
      info: StandardInfo
      infos: StandardInfo[]
      documentAvailable: boolean
      evidence: TemplateStandardEvidence
    }
  | {
      kind: 'verified'
      basis: string[]
      info: StandardInfo | null
      infos: StandardInfo[]
      documentAvailable: boolean
      evidence: TemplateStandardEvidence
    }

/** 由表格的 meta.basis 解析出标准状态 */
export function resolveStandard(basis: string | undefined | null): StandardStatus {
  const value = basis?.trim() || ''
  if (!value) return { kind: 'pending', basis: [], info: null, documentAvailable: false }
  const info = standards[normCode(value)]
  if (!info) return { kind: 'pending', basis: [value], info: null, documentAvailable: false }
  const documentAvailable = Boolean(info.crawled && info.pdf)
  if (!info.current) return { kind: 'outdated', basis: [value], info, documentAvailable }
  return { kind: 'verified', basis: [value], info, documentAvailable }
}

type TemplateIdentity = {
  file: string
  meta?: { basis?: string | null } | null
}

/**
 * 表级标准结论以文件名为唯一身份，避免同一表号的两个不同文件互相覆盖。
 * 没有显式决定时，才回退到模板自身的单一依据字段。
 */
export function resolveTemplateStandard(template: TemplateIdentity): TemplateStandardStatus {
  const evidence = templateStandardEvidence[template.file]
  if (!evidence) return resolveStandard(template.meta?.basis)
  if (evidence.kind === 'managed') {
    return {
      kind: 'managed',
      basis: [],
      info: null,
      documentAvailable: false,
      evidence,
    }
  }
  if (evidence.kind === 'controlled') {
    return {
      kind: 'controlled',
      basis: evidence.basis || [],
      info: null,
      documentAvailable: false,
      evidence,
    }
  }

  const basis = evidence.basis || []
  const infos = basis.map(code => standards[normCode(code)]).filter((info): info is StandardInfo => Boolean(info))
  if (basis.length === 0 || infos.length !== basis.length) {
    return {
      kind: 'pending',
      basis,
      info: null,
      documentAvailable: false,
    }
  }
  const documentAvailable = basis.length > 0
    && infos.every(info => Boolean(info.crawled && info.pdf))
  const outdated = infos.find(info => !info.current)
  if (outdated) {
    return {
      kind: 'outdated',
      basis,
      info: outdated,
      infos,
      documentAvailable,
      evidence,
    }
  }
  return {
    kind: 'verified',
    basis,
    info: infos[0] || null,
    infos,
    documentAvailable,
    evidence,
  }
}

/** 查某个标准码对应的现行版信息（用于"应换成 XXX"提示） */
export function lookupStandard(code: string | undefined | null): StandardInfo | null {
  if (!code) return null
  return standards[normCode(code)] || null
}
