import type { Col, Schema } from './schemas'
import { roundGB } from '../../../server/src/gbround'

export type ResultSummary = {
  analyte: string
  value: number | string
  unit: string
}

export function schemaColumns(schema: Schema): Col[] {
  if (schema.columns.length) return schema.columns
  const tables = schema.layout?.filter(section => section.type === 'table') ?? []
  if (!tables.length) return []
  if (schema.result) {
    const owner = tables.find(table => table.columns.some(column => column.key === schema.result!.key))
    if (owner) return owner.columns
  }
  return tables[0].columns
}

export function projectResultSummary(
  schema: Schema,
  rows: Record<string, any>[],
  analyte: string,
  computeRow: (row: Record<string, any>) => Record<string, any>,
): ResultSummary | null {
  if (!schema.result) return null
  const { key } = schema.result
  const column = schemaColumns(schema).find(candidate => candidate.key === key)
  if (!column) return null

  const rawValues: Array<number | string> = []
  for (const row of rows) {
    if (String(row.note ?? '').includes('空白')) continue
    const computed = computeRow(row)
    const raw = Object.prototype.hasOwnProperty.call(computed, key) ? computed[key] : row[key]
    if (raw == null || raw === '') continue
    rawValues.push(raw)
  }
  if (!rawValues.length) return null

  const numericValues = rawValues
    .map(value => Number(value))
    .filter(value => Number.isFinite(value))
  let value: number | string
  if (numericValues.length === rawValues.length) {
    value = roundGB(numericValues.reduce((sum, item) => sum + item, 0) / numericValues.length, 4)
  } else if (schema.result.allowText) {
    value = [...new Set(rawValues.map(item => String(item).trim()).filter(Boolean))].join('、')
    if (!value) return null
  } else {
    if (!numericValues.length) return null
    value = roundGB(numericValues.reduce((sum, item) => sum + item, 0) / numericValues.length, 4)
  }

  return {
    analyte,
    value,
    unit: schema.result.unit ?? column.unit ?? '',
  }
}
