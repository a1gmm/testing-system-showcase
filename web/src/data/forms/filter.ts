import type { Schema } from '../schemas'

// 0220.pdf HJ-TC-365 / 0221.pdf HJ-TC-366：滤筒/滤膜使用原始记录表。
// 版式极简：无抬头 kv、无方法/仪器页脚，仅一周登记表(编号/初重/称量日期/使用日期/使用人/送样日期/称量人/终重/称量日期/备注)。
// 两张原件表头列都逐字写作"滤筒编号"(滤膜表沿用同一措辞，属原件本身用词，非笔误)。
const usageColumns = [
  { key: 'no', label: '滤筒编号', kind: 'id' as const, w: 80 },
  { key: 'w0', label: '初重', unit: 'g', kind: 'input' as const },
  { key: 'wDate0', label: '称量日期', kind: 'input' as const, w: 90 },
  { key: 'useDate', label: '使用日期', kind: 'input' as const, w: 90 },
  { key: 'user', label: '使用人', kind: 'input' as const, w: 80 },
  { key: 'sendDate', label: '送样日期', kind: 'input' as const, w: 90 },
  { key: 'weigher', label: '称量人', kind: 'input' as const, w: 80 },
  { key: 'w1', label: '终重', unit: 'g', kind: 'input' as const },
  { key: 'wDate1', label: '称量日期', kind: 'input' as const, w: 90 },
  { key: 'note', label: '备注', kind: 'input' as const, w: 100 },
]

export const filterCartridgeUsage: Schema = {
  id: 'filterCartridgeUsage',
  title: () => '滤筒使用原始记录表',
  columns: [], meta: [], signRoles: ['称量', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'table', id: 'data', seedRows: 10, columns: usageColumns },
  ],
}

export const filterMembraneUsage: Schema = {
  id: 'filterMembraneUsage',
  title: () => '滤膜使用原始记录表',
  columns: [], meta: [], signRoles: ['称量', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'table', id: 'data', seedRows: 10, columns: usageColumns },
  ],
}

export const filterForms: Record<string, Schema> = {
  'HJ-TC-365': filterCartridgeUsage,
  'HJ-TC-366': filterMembraneUsage,
}
