export type CellMap = Record<string, any>
export function cellKey(sectionId: string, rowKey: string, colKey: string) {
  return `${sectionId}.${rowKey}.${colKey}`
}
export function getCell(m: CellMap, s: string, r: string, c: string) {
  const v = m[cellKey(s, r, c)]
  return v == null ? '' : v
}
export function setCell(m: CellMap, s: string, r: string, c: string, v: any) {
  m[cellKey(s, r, c)] = v
}
