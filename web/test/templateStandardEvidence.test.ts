import { describe, expect, test } from 'vitest'
import templatesRaw from '../src/data/templates.json'
import evidenceRaw from '../src/data/templateStandardEvidence.json'
import {
  resolveTemplateStandard,
  templateStandardEvidence,
  type TemplateStandardEvidence,
} from '../src/data/standardLink'
import { presentTemplateStandard } from '../src/data/templateStandardPresentation'

type Evidence = {
  kind: 'standard' | 'managed'
  basis?: string[]
  source: string
  verifiedOn: string
  note: string
  upcoming?: { basis: string; effectiveOn: string; note: string }[]
}

describe('模板标准证据台账', () => {
  test('以文件名区分重复表号', () => {
    const duplicated = templatesRaw.filter((template) => template.code === 'HJ-TC-194')

    expect(duplicated.map((template) => template.file)).toEqual(['0158.pdf', '0159.pdf'])
    expect(resolveTemplateStandard(duplicated[0]).basis).not.toEqual(resolveTemplateStandard(duplicated[1]).basis)
  })

  test('管理记录必须说明为什么不直接承载检测标准', () => {
    const evidence = evidenceRaw as Record<string, Evidence>
    const managed = Object.values(evidence).filter((entry) => entry.kind === 'managed')

    expect(managed.length).toBeGreaterThan(0)
    for (const entry of managed) {
      expect(entry.note.length).toBeGreaterThanOrEqual(12)
      expect(entry.source).toBeTruthy()
      expect(entry.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  test('显式标准决定必须有规范依据和审计信息', () => {
    const evidence = evidenceRaw as Record<string, Evidence>
    const standard = Object.values(evidence).filter((entry) => entry.kind === 'standard')

    expect(standard.length).toBeGreaterThan(0)
    for (const entry of standard) {
      expect(entry.basis?.length).toBeGreaterThan(0)
      expect(entry.source).toBeTruthy()
      expect(entry.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(entry.note).toBeTruthy()
    }
  })

  test('每张启用表都闭环为已核验或管理记录', () => {
    const active = templatesRaw.filter((template) => !template.retired)
    const files = active.map((template) => template.file)
    const unresolved = active
      .map((template) => ({ file: template.file, status: resolveTemplateStandard(template) }))
      .filter(({ status }) => !['verified', 'managed'].includes(status.kind))

    expect(new Set(files).size).toBe(files.length)
    expect(unresolved).toEqual([])
  })

  test('台账没有指向停用或不存在文件的孤立条目', () => {
    const activeFiles = new Set(templatesRaw.filter((template) => !template.retired).map((template) => template.file))
    const evidenceFiles = Object.keys(evidenceRaw)

    expect(evidenceFiles.filter((file) => !activeFiles.has(file))).toEqual([])
  })

  test('旧臭气方法已按生态环境部现行方法更新', () => {
    const template = templatesRaw.find((entry) => entry.file === '0329.pdf')

    expect(template).toBeTruthy()
    expect(resolveTemplateStandard(template!).basis).toEqual(['HJ 1262-2022'])
  })

  test('尚未实施的标准单列预告，不提前混入现行依据', () => {
    const evidence = (evidenceRaw as Record<string, Evidence>)['0137.pdf']

    expect(evidence.basis).not.toContain('HJ 1405-2024')
    expect(evidence.upcoming).toEqual([
      {
        basis: 'HJ 1405-2024',
        effectiveOn: '2027-01-01',
        note: '实施后，监测点位设置相关条款按该标准执行。',
      },
    ])
  })

  test('所有未来标准都在核验日之后生效，且不与现行依据重复', () => {
    const evidence = evidenceRaw as Record<string, Evidence>

    for (const entry of Object.values(evidence)) {
      for (const upcoming of entry.upcoming || []) {
        expect(upcoming.effectiveOn > entry.verifiedOn).toBe(true)
        expect(entry.basis || []).not.toContain(upcoming.basis)
        expect(upcoming.note).toBeTruthy()
      }
    }
  })

  test('显式台账不能绕过旧版判定', () => {
    const file = '__outdated-review-test__.pdf'
    templateStandardEvidence[file] = {
      kind: 'standard',
      basis: ['GB/T5750.6-2006'],
      source: '测试',
      verifiedOn: '2026-08-28',
      note: '用于验证旧版门禁不可被显式台账绕过。',
    } satisfies TemplateStandardEvidence

    try {
      expect(resolveTemplateStandard({ file }).kind).toBe('outdated')
    } finally {
      delete templateStandardEvidence[file]
    }
  })

  test('复合依据只有部分全文时不得标成全部入库', () => {
    const file = '__partial-document-review-test__.pdf'
    templateStandardEvidence[file] = {
      kind: 'standard',
      basis: ['HJ 479-2009', 'HJ 77.1-2025'],
      source: '测试',
      verifiedOn: '2026-08-28',
      note: '用于验证复合依据的全文入库状态。',
    } satisfies TemplateStandardEvidence

    try {
      const status = resolveTemplateStandard({ file })
      expect(status.kind).toBe('verified')
      expect(status.documentAvailable).toBe(false)
    } finally {
      delete templateStandardEvidence[file]
    }
  })

  test.each([
    ['0130.pdf', 'verified', '已核验', 'good'],
    ['0133.pdf', 'managed', '管理记录', 'accent'],
  ])('文件 %s 的界面状态为 %s', (file, bucket, label, dot) => {
    const template = templatesRaw.find((entry) => entry.file === file)
    const presentation = presentTemplateStandard(resolveTemplateStandard(template!))

    expect(presentation).toEqual({ bucket, label, dot })
  })
})
