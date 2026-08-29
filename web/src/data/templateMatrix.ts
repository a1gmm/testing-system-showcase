type TemplateMatrixEvidence = {
  matrix?: string
  name?: string
  raw?: string
  analyte?: string
  meta?: {
    methodFull?: string
    detectionLimit?: string
    basis?: string
  }
}

type MatrixFamily = 'water' | 'air' | 'soil' | 'solid' | 'noise'

function explicitMatrix(matrix: string) {
  return matrix === '有组织废气' || matrix === '无组织废气' ? '废气' : matrix
}

function matrixFamily(matrix: string): MatrixFamily | null {
  if (['废水', '地表水', '地下水', '海水', '生活饮用水', '饮用水', '大气降水'].includes(matrix)) return 'water'
  if (['环境空气', '废气', '有组织废气', '无组织废气'].includes(matrix)) return 'air'
  if (['土壤', '沉积物', '海洋沉积物', '底泥', '污泥'].includes(matrix)) return 'soil'
  if (['固废', '固体废物'].includes(matrix)) return 'solid'
  if (matrix === '噪声') return 'noise'
  return null
}

function inferredFamilies(template: TemplateMatrixEvidence) {
  const evidence = [
    template.name, template.raw, template.analyte,
    template.meta?.methodFull, template.meta?.detectionLimit, template.meta?.basis,
  ].filter(Boolean).join(' ')
  const families = new Set<MatrixFamily>()

  if (/水质|水中|废水|污水|地表水|地下水|海水|饮用水|水样|大气降水|色度|(?:mg|μg|ug)\s*\/\s*l\b/i.test(evidence)) families.add('water')
  if (/环境空气|空气质量|废气|有组织|无组织|污染源|烟气|气态污染物|(?:mg|μg|ug)\s*\/\s*m(?:3|³)\b/i.test(evidence)) families.add('air')
  if (/土壤|沉积物|底泥|污泥|(?:mg|μg|ug)\s*\/\s*kg\b/i.test(evidence)) families.add('soil')
  if (/固体废物|固废/.test(evidence)) families.add('solid')
  if (/噪声|声级|分贝|\bdB\b/i.test(evidence)) families.add('noise')

  return families
}

export function templateMatchesSampleMatrix(template: TemplateMatrixEvidence, sampleMatrix: string) {
  if (template.matrix?.trim()) return explicitMatrix(template.matrix.trim()) === explicitMatrix(sampleMatrix.trim())
  const family = matrixFamily(sampleMatrix.trim())
  const inferred = inferredFamilies(template)
  return family !== null && inferred.size === 1 && inferred.has(family)
}
