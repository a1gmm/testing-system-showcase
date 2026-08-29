import type { TemplateStandardStatus } from './standardLink'

export type StandardDot = 'good' | 'warn' | 'crit' | 'accent' | ''

export type TemplateStandardPresentation = {
  bucket: TemplateStandardStatus['kind']
  label: string
  dot: StandardDot
}

export function presentTemplateStandard(status: TemplateStandardStatus): TemplateStandardPresentation {
  switch (status.kind) {
    case 'verified':
      return { bucket: 'verified', label: '已核验', dot: 'good' }
    case 'managed':
      return { bucket: 'managed', label: '管理记录', dot: 'accent' }
    case 'controlled':
      return { bucket: 'controlled', label: '受控方法', dot: 'accent' }
    case 'outdated':
      return { bucket: 'outdated', label: `旧版·应换 ${status.info.currentCode || ''}`.trim(), dot: 'crit' }
    default:
      return { bucket: 'pending', label: '待核验', dot: 'warn' }
  }
}
