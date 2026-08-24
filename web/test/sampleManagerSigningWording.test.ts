import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { expect, test } from 'vitest'

function assignsReceiptToQualityOfficer(copy: string) {
  const qualityBeforeReceipt = /(?:质控员|质控(?!员))(?!(?:从|在).{0,10}(?:已)?签收(?:后|的|交接单)).{0,8}(?:负责|进行|办理|确认)?\s*签收/
  const receiptBeforeQuality = /签收\s*(?:责任|人员|人|方)?\s*[:：为由是，,、-]\s*质控员/
  const qualityBeforeHandoverConfirmation = /(?:qc\b|质控员|质控(?!员))(?!(?:从|在).{0,10}(?:已)?签收(?:后|的|交接单)).{0,8}(?:负责|进行|办理|执行|核心职责)?\s*(?:确认|签收)(?:样品)?交接(?:单)?/i
  const handoverConfirmationBeforeQuality = /交接(?:单)?(?:确认|签收)(?:\s*[（(]\s*(?:qc\b|质控员?)(?:\s*核心职责)?\s*[）)]|.{0,8}(?:由|责任(?:人|方)?(?:为|是)?|归属于|核心职责.{0,2}(?:是|为)?).{0,4}(?:qc\b|质控员?))/i
  return qualityBeforeReceipt.test(copy) || receiptBeforeQuality.test(copy)
    || qualityBeforeHandoverConfirmation.test(copy) || handoverConfirmationBeforeQuality.test(copy)
}

function governedFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return governedFiles(path)
    return ['.md', '.ts', '.vue', '.mjs'].includes(extname(path)) ? [path] : []
  })
}

test('样品交接的按钮与下一步指引只把签收职责交给样品管理员', () => {
  const samples = readFileSync(join(process.cwd(), 'src/pages/Samples.vue'), 'utf8')
  expect(samples).toContain('发样品管理员签收')
  for (const retiredVariant of [
    '签收：质控员确认整单', '由质控员签收', '质控员负责签收', '质控还没签收',
    '交接确认（qc 核心职责）', '交接确认由质控员负责', '交接确认责任人：qc', 'qc 负责确认交接', '质控员确认交接单',
  ]) {
    expect(assignsReceiptToQualityOfficer(retiredVariant), retiredVariant).toBe(true)
  }
  for (const validSequence of [
    '质控员从已签收交接单生成通知', '质控员在样品管理员签收后派工',
    '样品管理员确认交接，qc 随后派工', '样品管理员签收后，由质控员派工', '样品管理员签收交接；质控员派工',
  ]) {
    expect(assignsReceiptToQualityOfficer(validSequence), validSequence).toBe(false)
  }

  const roots = ['../docs', '../ops', '../server/src', 'src'].map(path => join(process.cwd(), path))
  const violations = roots.flatMap(governedFiles).filter(path => assignsReceiptToQualityOfficer(readFileSync(path, 'utf8')))
  expect(violations).toEqual([])
})
