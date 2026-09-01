import { isTemplateReadyForEntry } from './templateEntry'
import { templateMatchesSampleMatrix } from './templateMatrix'
import { templatePhase } from './phase'

export type LaboratoryTemplate = {
  code: string
  file: string
  analyte?: string
  matrix?: string
  applicableMatrices?: string[]
  applicableAnalytes?: string[]
  sheetType: string
  phase?: string
  stage?: string
  name?: string
  raw?: string
  method?: string
  retired?: boolean
  meta?: {
    methodFull?: string
    detectionLimit?: string
    basis?: string
  }
}

export type LaboratoryTemplateCoverage = {
  item: string
  status: 'ready' | 'pending' | 'field' | 'missing'
  readyTemplates: LaboratoryTemplate[]
  pendingTemplates: LaboratoryTemplate[]
  fieldTemplates: LaboratoryTemplate[]
}

const ANALYTE_ALIASES = [
  ['化学需氧量', 'cod', 'codcr'],
  ['生化需氧量', '五日生化需氧量', 'bod', 'bod5'],
  ['ph', 'ph值'],
] as const

const canonicalAnalyteByAlias = new Map<string, string>()
for (const [canonical, ...aliases] of ANALYTE_ALIASES) {
  canonicalAnalyteByAlias.set(normalizeAnalyte(canonical), normalizeAnalyte(canonical))
  for (const alias of aliases) canonicalAnalyteByAlias.set(normalizeAnalyte(alias), normalizeAnalyte(canonical))
}

function normalizeAnalyte(value: string) {
  return value.normalize('NFKC').trim().toLowerCase().replace(/[\s·（）()\-_]/g, '')
}

function canonicalAnalyte(value: string) {
  const normalized = normalizeAnalyte(value)
  return canonicalAnalyteByAlias.get(normalized) || normalized
}

export function templateMatchesAnalyte(template: LaboratoryTemplate, item: string) {
  const wanted = canonicalAnalyte(item)
  if (!wanted) return false
  const explicit = template.applicableAnalytes?.length ? template.applicableAnalytes : [template.analyte || '']
  return explicit.some(analyte => canonicalAnalyte(analyte) === wanted)
}

export function templateMatchesAnyAnalyte(template: LaboratoryTemplate, items: string[]) {
  return items.some(item => templateMatchesAnalyte(template, item))
}

function isLaboratoryOriginalRecord(template: LaboratoryTemplate) {
  return template.sheetType === '原始记录' && templatePhase(template) === '实验室'
}

function isFieldRecord(template: LaboratoryTemplate) {
  return ['原始记录', '采样记录'].includes(template.sheetType) && templatePhase(template) === '现场'
}

export function laboratoryTemplateCoverage(
  templates: LaboratoryTemplate[], sampleMatrix: string, items: string[],
): LaboratoryTemplateCoverage[] {
  const applicable = templates.filter(template => templateMatchesSampleMatrix(template, sampleMatrix))

  return items.map(item => {
    const matching = applicable.filter(template => templateMatchesAnalyte(template, item))
    const laboratoryRecords = matching.filter(isLaboratoryOriginalRecord)
    const readyTemplates = laboratoryRecords.filter(isTemplateReadyForEntry)
    const pendingTemplates = laboratoryRecords.filter(template => !isTemplateReadyForEntry(template))
    const fieldTemplates = matching.filter(isFieldRecord)
    const status = readyTemplates.length ? 'ready'
      : pendingTemplates.length ? 'pending'
        : fieldTemplates.length ? 'field'
          : 'missing'

    return { item, status, readyTemplates, pendingTemplates, fieldTemplates }
  })
}
