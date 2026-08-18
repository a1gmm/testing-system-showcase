import type { Schema } from '../schemas'

function n(v: any): number | null { const x = parseFloat(v); return isFinite(x) ? x : null }
const r2 = (x: number) => Math.round(x * 100) / 100

const metaBasic = (extra: any[] = []) => [
  { label: '测量项目', key: 'analyte', fixed: true },
  { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
  { label: '仪器型号', key: 'instrument' },
  { label: '仪器编号', key: 'instrumentNo' },
  ...extra,
  { label: '方法依据', key: 'basis', fixed: true },
  { label: '检出限', key: 'detectionLimit', fixed: true },
]

// ── pH 电极法（HJ1147-2020）直读，无换算 ──
const phMeter: Schema = {
  id: 'phMeter', title: () => '水质 pH值的测定 电极法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute: () => ({}),
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 110 },
      { key: 'temp', label: '测定温度', unit: '℃', kind: 'input', w: 90 },
      { key: 'ph', label: 'pH测定值', kind: 'input', w: 100 },
      { key: 'note', label: '备注', kind: 'input', w: 100 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: metaBasic([{ label: '校准缓冲液', key: 'buffer' }, { label: '电极斜率', key: 'slope' }]) },
  ],
}

// ── 溶解氧 电化学探头法（HJ506-2009）直读 mg/L ──
const doMeter: Schema = {
  id: 'doMeter', title: () => '水质 溶解氧的测定 电化学探头法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute: () => ({}),
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 110 },
      { key: 'temp', label: '测定温度', unit: '℃', kind: 'input', w: 90 },
      { key: 'do', label: '溶解氧', unit: 'mg/L', kind: 'input', w: 100 },
      { key: 'note', label: '备注', kind: 'input', w: 100 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: metaBasic([{ label: '大气压', key: 'pressure' }]) },
  ],
}

// ── BOD₅ 稀释与接种法（HJ505-2009）──
const bod5: Schema = {
  id: 'bod5', title: () => '五日生化需氧量(BOD₅) 稀释与接种法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row: Record<string, any>) {
    const c1 = n(row.c1), c2 = n(row.c2), f = n(row.f) ?? 1, bcorr = n(row.bcorr) ?? 0
    if (c1 == null || c2 == null) return { bod: null }
    // BOD5 = [(c1−c2) − 空白校正] × 稀释倍数f
    return { bod: r2(((c1 - c2) - bcorr) * f) }
  },
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 90 },
      { key: 'f', label: '稀释倍数f', kind: 'input', w: 80 },
      { key: 'c1', label: '培养前DO c₁', unit: 'mg/L', kind: 'input', group: '溶解氧', w: 100 },
      { key: 'c2', label: '培养5天后DO c₂', unit: 'mg/L', kind: 'input', group: '溶解氧', w: 110 },
      { key: 'bcorr', label: '空白校正', unit: 'mg/L', kind: 'input', w: 90 },
      { key: 'bod', label: 'BOD₅', unit: 'mg/L', kind: 'auto', w: 90 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: metaBasic([{ label: '培养温度', key: 'incTemp', fixed: true, value: '(20±1)℃，5d' }]) },
  ],
}

// ── 电导率 电极法（HJ802-2016 土壤 等）直读 ──
const conductivity: Schema = {
  id: 'conductivity', title: () => '电导率 电极法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute: () => ({}),
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 110 },
      { key: 'ratio', label: '水土比', kind: 'input', w: 80 },
      { key: 'temp', label: '测定温度', unit: '℃', kind: 'input', w: 90 },
      { key: 'ec', label: '电导率', unit: 'μS/cm', kind: 'input', w: 100 },
      { key: 'note', label: '备注', kind: 'input', w: 100 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: metaBasic([{ label: '电极常数', key: 'cellConst' }, { label: '校准标液', key: 'calSolution' }]) },
  ],
}

// ── 色度 稀释倍数法（HJ1182-2021）──
const chroma: Schema = {
  id: 'chroma', title: () => '色度 稀释倍数法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row: Record<string, any>) {
    const d = n(row.dilution)
    return { result: d == null ? null : d }
  },
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 110 },
      { key: 'dilution', label: '稀释倍数(刚好无色)', kind: 'input', w: 140 },
      { key: 'result', label: '色度', unit: '倍', kind: 'auto', w: 90 },
      { key: 'note', label: '备注', kind: 'input', w: 110 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: metaBasic([{ label: '稀释用水', key: 'dilWater', fixed: true, value: '去离子水或纯水' }]) },
  ],
}

export const directForms: Record<string, Schema> = {
  'HJ-TC-550': phMeter, // pH·废水
  'HJ-TC-627': phMeter, // pH
  'HJ-TC-206': phMeter, // pH·土壤 HJ962
  'HJ-TC-638': doMeter, // 溶解氧
  'HJ-TC-071': bod5,    // BOD5
  'HJ-TC-112': chroma,  // 色度
  'HJ-TC-0418': conductivity, // 电导率·土壤 HJ802
}
