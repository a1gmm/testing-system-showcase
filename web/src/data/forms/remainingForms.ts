import type { Schema } from '../schemas'

const num = (value: any): number | null => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}
const r3 = (value: number) => Math.round(value * 1000) / 1000

const commonMeta = (extra: any[] = []) => [
  { label: '测量项目', key: 'analyte', fixed: true },
  { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
  ...extra,
  { label: '仪器型号', key: 'instrument' },
  { label: '仪器编号', key: 'instrumentNo' },
  { label: '方法依据', key: 'basis', fixed: true },
  { label: '检出限', key: 'detectionLimit', fixed: true },
]

// 0030：土壤冷原子吸收测汞。该方法的专用测汞仪不要求操作者填写波长。
const mercurySoil: Schema = {
  id: 'mercurySoil', title: () => '土壤（沉积物）冷原子吸收（荧光）测汞原始记录表',
  result: { key: 'result', unit: 'mg/kg' },
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row, ctx) {
    const a = num(row.a), a0 = num(row.a0), w = num(row.w), moisture = num(row.moisture) ?? 0
    const k = num(row.k) ?? 1, slope = num(ctx.reg?.b), intercept = num(ctx.reg?.a) ?? 0
    if (a == null || a0 == null || w == null || w === 0 || slope == null || slope === 0 || moisture >= 100)
      return { net: a == null || a0 == null ? null : r3(a - a0), result: null }
    const net = a - a0
    return { net: r3(net), result: r3(((net - intercept) / slope) * k / (w * (1 - moisture / 100))) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'w', label: '取样量W', unit: 'g', kind: 'input', w: 75 },
      { key: 'v', label: '定容体积V', unit: 'mL', kind: 'input', w: 80 },
      { key: 'k', label: '稀释倍数K', kind: 'input', w: 70 },
      { key: 'a0', label: '空白值', kind: 'input', group: '吸光度（荧光强度）', w: 70 },
      { key: 'a', label: '测量值', kind: 'input', group: '吸光度（荧光强度）', w: 70 },
      { key: 'net', label: '测量值－空白值', kind: 'auto', group: '吸光度（荧光强度）', w: 90 },
      { key: 'moisture', label: '含水率f', unit: '%', kind: 'input', w: 70 },
      { key: 'result', label: '样品含量', unit: 'mg/kg', kind: 'auto', w: 85 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([
      { label: '回归方程', key: 'regression' },
      { label: '计算公式', key: 'formula', fixed: true, colspan: 2, value: 'c=(A−A₀−a)×V×K/[b×W×(1−f)]' },
    ]) },
  ],
}

// 0256：原件报告的是浸出液汞浓度（μg/L），不是土壤干基含量。
const mercurySolidWaste: Schema = {
  id: 'mercurySolidWaste', title: () => '固体废物冷原子吸收分光光度法测汞原始记录表',
  result: { key: 'result', unit: 'μg/L' }, columns: [], meta: [],
  signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row) {
    const c1 = num(row.c1), v = num(row.v), v0 = num(row.v0), k = num(row.k) ?? 1
    return { net: num(row.a) == null || num(row.a0) == null ? null : r3(num(row.a)! - num(row.a0)!),
      result: c1 == null || v == null || v0 == null || v0 === 0 ? null : r3(c1 * v / v0 * k) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '质控编号', kind: 'id', w: 100 },
      { key: 'v0', label: '取样量V₀', unit: 'mL', kind: 'input' },
      { key: 'v', label: '定容体积V', unit: 'mL', kind: 'input' },
      { key: 'k', label: '稀释倍数K', kind: 'input' },
      { key: 'a0', label: '空白值', kind: 'input', group: '吸光度（荧光强度）' },
      { key: 'a', label: '测量值', kind: 'input', group: '吸光度（荧光强度）' },
      { key: 'net', label: '测量值－空白值', kind: 'auto', group: '吸光度（荧光强度）' },
      { key: 'c1', label: '查曲线浓度C₁', unit: 'μg/L', kind: 'input' },
      { key: 'result', label: '样品含量', unit: 'μg/L', kind: 'auto' },
      { key: 'note', label: '备注', kind: 'input' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([
      { label: '回归方程', key: 'regression' },
      { label: '计算公式', key: 'formula', fixed: true, colspan: 2, value: 'c(Hg)=C₁×V/V₀×K' },
    ]) },
  ],
}

const waterPhotometric: Schema = {
  id: 'waterPhotometric', title: () => '水质分光光度法原始记录表',
  result: { key: 'rho', unit: 'mg/L' }, columns: [], meta: [], regression: true,
  signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row, ctx) {
    const a = num(row.a), a0 = num(row.a0), sample = num(row.sample)
    const k = num(row.k) ?? 1, slope = num(ctx.reg?.b), intercept = num(ctx.reg?.a) ?? 0
    if (a == null || a0 == null) return { net: null, amount: null, rho: null }
    const net = a - a0
    const amount = slope == null || slope === 0 ? null : (net - intercept) / slope
    return { net: r3(net), amount: amount == null ? null : r3(amount),
      rho: amount == null || sample == null || sample === 0 ? null : r3(amount / sample * k) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'sample', label: '取样量V', unit: 'mL', kind: 'input' },
      { key: 'vdef', label: '定容体积', unit: 'mL', kind: 'input' },
      { key: 'k', label: '稀释倍数K', kind: 'input' },
      { key: 'a0', label: '空白A₀', kind: 'input', group: '吸光值' },
      { key: 'a', label: '样品A', kind: 'input', group: '吸光值' },
      { key: 'net', label: 'A－A₀', kind: 'auto', group: '吸光值' },
      { key: 'amount', label: '绝对量', unit: 'μg', kind: 'auto' },
      { key: 'rho', label: '样品浓度ρ', unit: 'mg/L', kind: 'auto' },
      { key: 'note', label: '备注', kind: 'input' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([
      { label: '测定波长', key: 'wavelength', fixed: true },
      { label: '光程', key: 'pathLength' },
      { label: '参比溶液', key: 'reference' },
      { label: '回归方程', key: 'regression' },
    ]) },
  ],
}

const permanganateIndex: Schema = {
  id: 'permanganateIndex', title: () => '高锰酸盐指数测量原始记录表',
  result: { key: 'rho', unit: 'mg/L' }, columns: [], meta: [],
  signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row, ctx) {
    const v = num(row.v), v0 = num(row.v0), v1 = num(row.v1), v2 = num(ctx.meta?.v2)
    const c = num(ctx.meta?.c), f = num(row.f) ?? 0
    if ([v, v0, v1, v2, c].some(value => value == null) || v === 0 || v2 === 0) return { rho: null }
    const sample = (10 + v1!) * 10 / v2! - 10
    const blank = ((10 + v0!) * 10 / v2! - 10) * f
    return { rho: r3((sample - blank) * c! * 8000 / v!) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'v', label: '取样量V', unit: 'mL', kind: 'input' },
      { key: 'f', label: '稀释水比例f', kind: 'input' },
      { key: 'v0', label: '空白V₀', unit: 'mL', kind: 'input', group: '高锰酸钾溶液消耗量' },
      { key: 'v1', label: '样品V₁', unit: 'mL', kind: 'input', group: '高锰酸钾溶液消耗量' },
      { key: 'chloride', label: '氯化物浓度', unit: 'mg/L', kind: 'input' },
      { key: 'rho', label: '高锰酸盐指数ρ', unit: 'mg/L', kind: 'auto' },
      { key: 'note', label: '备注', kind: 'input' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([
      { label: '草酸钠标准溶液浓度C', key: 'c' },
      { label: '标定消耗高锰酸钾体积V₂', key: 'v2' },
    ]) },
  ],
}

function titrationSchema(id: string, title: string, molarMass: number, concentrationScale = 1000): Schema {
  return {
    id, title: () => title, result: { key: 'rho', unit: 'mg/L' }, columns: [], meta: [],
    signRoles: ['检验', '复核', '审核'], seed: () => [],
    compute(row, ctx) {
      const v = num(row.v), v1 = num(row.v1), v0 = num(ctx.meta?.v0) ?? 0
      const c = num(ctx.meta?.c), k = num(row.k) ?? 1
      return { rho: v == null || v === 0 || v1 == null || c == null ? null : r3((v1 - v0) * c * molarMass * concentrationScale / v * k) }
    },
    layout: [
      { type: 'table', id: 'main', seedRows: 4, columns: [
        { key: 'id', label: '样品编号', kind: 'id', w: 100 },
        { key: 'v', label: '取样量V', unit: 'mL', kind: 'input' },
        { key: 'vdef', label: '定容体积', unit: 'mL', kind: 'input' },
        { key: 'k', label: '稀释倍数K', kind: 'input' },
        { key: 'v1', label: '标准溶液消耗量V₁', unit: 'mL', kind: 'input' },
        { key: 'rho', label: '样品浓度ρ', unit: 'mg/L', kind: 'auto' },
        { key: 'note', label: '备注', kind: 'input' },
      ] },
      { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([
        { label: '标准溶液名称', key: 'standardSolution' },
        { label: '标准溶液浓度C', key: 'c' },
        { label: '空白值V₀', key: 'v0' },
      ]) },
    ],
  }
}
const chlorideTitration = titrationSchema('chlorideTitration', '氯化物容量测量原始记录表', 35.45)
const hardnessTitrationMol = titrationSchema('hardnessTitrationMol', '总硬度容量测量原始记录表', 100.09)
const hardnessTitrationMmol = titrationSchema('hardnessTitrationMmol', '总硬度容量测量原始记录表', 100.1, 1)
const iodideTitration = titrationSchema('iodideTitration', '碘化物容量测量原始记录表', 126.9)

const carbonateTitration: Schema = {
  id: 'carbonateTitration', title: () => '碳酸根、碳酸氢根和氢氧根测量原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'v', label: '取样量V', unit: 'mL', kind: 'input' },
      { key: 'k', label: '稀释倍数K', kind: 'input' },
      { key: 'v1', label: '酚酞终点V₁', unit: 'mL', kind: 'input' },
      { key: 'v2', label: '总碱度终点V₂', unit: 'mL', kind: 'input' },
      { key: 'co3', label: 'CO₃²⁻', unit: 'mg/L', kind: 'input' },
      { key: 'hco3', label: 'HCO₃⁻', unit: 'mg/L', kind: 'input' },
      { key: 'oh', label: 'OH⁻', unit: 'mg/L', kind: 'input' },
      { key: 'note', label: '备注', kind: 'input' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([
      { label: '盐酸标准溶液浓度', key: 'c' },
      { label: '判定说明', key: 'rule', fixed: true, colspan: 2, value: '按V₁与V₂的相对关系分别计算OH⁻、CO₃²⁻和HCO₃⁻，保留原表人工复核结果栏。' },
    ]) },
  ],
}

const seaCod: Schema = {
  id: 'seaCod', title: () => '化学需氧量（CODMn）测量原始记录表',
  result: { key: 'rho', unit: 'mg/L' }, columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row, ctx) {
    const v = num(row.v), v1 = num(row.v1), v2 = num(row.v2), c = num(ctx.meta?.c)
    return { diff: v1 == null || v2 == null ? null : r3(v2 - v1),
      rho: v == null || v === 0 || v1 == null || v2 == null || c == null ? null : r3(c * (v2 - v1) * 8 * 1000 / v) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '样品编号', kind: 'id' }, { key: 'v', label: '取样量V', unit: 'mL', kind: 'input' },
      { key: 'v2', label: '空白V₂', unit: 'mL', kind: 'input', group: '硫代硫酸钠消耗量' },
      { key: 'v1', label: '样品V₁', unit: 'mL', kind: 'input', group: '硫代硫酸钠消耗量' },
      { key: 'diff', label: 'V₂－V₁', unit: 'mL', kind: 'auto' },
      { key: 'rho', label: '浓度ρ', unit: 'mg/L', kind: 'auto' }, { key: 'note', label: '备注', kind: 'input' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([{ label: '硫代硫酸钠浓度c', key: 'c' }]) },
  ],
}

const seaBod: Schema = {
  id: 'seaBod', title: () => '五日生化需氧量（BOD₅）测量原始记录表',
  result: { key: 'bod', unit: 'mg/L' }, columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row) {
    const c1 = num(row.c1), c2 = num(row.c2), b1 = num(row.b1), b2 = num(row.b2)
    const f1 = num(row.f1) ?? 0, f2 = num(row.f2) ?? 1
    return { bod: [c1, c2, b1, b2].some(v => v == null) || f2 === 0 ? null : r3((c1! - c2!) - (b1! - b2!) * f1 / f2) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '质控编号', kind: 'id' }, { key: 'f1', label: '稀释水比例f₁', kind: 'input' },
      { key: 'f2', label: '水样比例f₂', kind: 'input' }, { key: 'c1', label: '样品培养前C₁', unit: 'mg/L', kind: 'input' },
      { key: 'c2', label: '样品培养后C₂', unit: 'mg/L', kind: 'input' }, { key: 'b1', label: '稀释水培养前B₁', unit: 'mg/L', kind: 'input' },
      { key: 'b2', label: '稀释水培养后B₂', unit: 'mg/L', kind: 'input' }, { key: 'bod', label: 'BOD₅', unit: 'mg/L', kind: 'auto' },
      { key: 'note', label: '备注', kind: 'input' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([{ label: '培养条件', key: 'incubation', fixed: true, value: '(20±1)℃，5d' }]) },
  ],
}

function directValueSchema(id: string, title: string, key: string, label: string, unit?: string): Schema {
  return {
    id, title: () => title, result: { key, unit }, columns: [], meta: [],
    signRoles: ['检验', '复核', '审核'], seed: () => [],
    layout: [
      { type: 'table', id: 'main', seedRows: 4, columns: [
        { key: 'id', label: '样品编号', kind: 'id', w: 110 },
        { key: 'temp', label: '水温', unit: '℃', kind: 'input' },
        { key, label, unit, kind: 'input' },
        { key: 'avg', label: '平均值', unit, kind: 'input' },
        { key: 'note', label: '备注', kind: 'input' },
      ] },
      { type: 'kv', id: 'meta', cols: 2, rows: commonMeta() },
    ],
  }
}
const turbidity = directValueSchema('turbidity', '浊度分析原始记录表', 'turbidity', '浊度', 'NTU')
const salinity = directValueSchema('salinity', '海水盐度测定值原始记录表', 'salinity', '测定值', '‰')
const density = directValueSchema('density', '密度测量原始记录表', 'density', '密度', '%')
const waterTemperature = directValueSchema('waterTemperature', '水温测定原始记录表', 'temperature', '测定值', '℃')

const chromaPtCo: Schema = {
  id: 'chromaPtCo', title: () => '色度分析原始记录表', result: { key: 'chroma', unit: '度' },
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row) {
    const v = num(row.v), v1 = num(row.v1)
    return { chroma: v == null || v === 0 || v1 == null ? null : r3(v1 * 500 / v) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '样品编号', kind: 'id' }, { key: 'tone', label: '色调', kind: 'input', group: '颜色描述' },
      { key: 'depth', label: '深浅', kind: 'input', group: '颜色描述' }, { key: 'clarity', label: '透明度', kind: 'input', group: '颜色描述' },
      { key: 'v', label: '取样体积V', unit: 'mL', kind: 'input' }, { key: 'v1', label: '铂钴标准溶液V₁', unit: 'mL', kind: 'input' },
      { key: 'chroma', label: '色度', unit: '度', kind: 'auto' }, { key: 'ph', label: 'pH值', kind: 'input' },
      { key: 'note', label: '备注', kind: 'input' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([{ label: '稀释用水', key: 'water', fixed: true, value: '光学纯水' }]) },
  ],
}

const transparency: Schema = {
  id: 'transparency', title: () => '透明度检测原始记录', result: { key: 'avg', unit: 'cm' },
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'], seed: () => [],
  compute(row) {
    const values = [num(row.v1), num(row.v2), num(row.v3)].filter((v): v is number => v != null)
    return { avg: values.length ? r3(values.reduce((sum, v) => sum + v, 0) / values.length) : null }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '样品编号', kind: 'id' }, { key: 'v1', label: '透明度1', unit: 'cm', kind: 'input' },
      { key: 'v2', label: '透明度2', unit: 'cm', kind: 'input' }, { key: 'v3', label: '透明度3', unit: 'cm', kind: 'input' },
      { key: 'avg', label: '平均值', unit: 'cm', kind: 'auto' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta() },
  ],
}

const flowCheck: Schema = {
  id: 'flowCheck', title: () => '仪器设备流量核查记录表', result: { key: 'error', unit: '%' },
  columns: [], meta: [], signRoles: ['核查', '复核', '审核'], seed: () => [],
  compute(row) {
    const set = num(row.setFlow), actual = num(row.actualFlow)
    return { error: set == null || set === 0 || actual == null ? null : r3((actual - set) / set * 100) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 10, columns: [
      { key: 'id', label: '编号', kind: 'id' }, { key: 'instrument', label: '仪器名称', kind: 'input' },
      { key: 'model', label: '型号', kind: 'input' }, { key: 'channel', label: '流路', kind: 'input' },
      { key: 'setFlow', label: '设定核准流量', unit: 'L/min', kind: 'input' },
      { key: 'actualFlow', label: '校准仪显示流量', unit: 'L/min', kind: 'input' },
      { key: 'error', label: '误差', unit: '%', kind: 'auto' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: [
      { label: '核查日期', key: 'date' }, { label: '核查人', key: 'checker' },
      { label: '标准流量校准仪', key: 'standard' }, { label: '标准器编号', key: 'standardNo' },
    ] },
  ],
}

const chlorineDioxide: Schema = {
  id: 'chlorineDioxide', title: () => '二氧化氯测量原始记录表', result: { key: 'rho', unit: 'mg/L' },
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row, ctx) {
    const v = num(row.v), v1 = num(row.v1), v0 = num(row.v0), c = num(ctx.meta?.c), sign = row.blankMode === '加' ? 1 : -1
    return { combined: v1 == null || v0 == null ? null : r3(v1 + sign * v0),
      rho: v == null || v === 0 || v1 == null || v0 == null || c == null ? null : r3((v1 + sign * v0) * c * 13.49 * 1000 / v) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '样品编号', kind: 'id' }, { key: 'v', label: '取样量V', unit: 'mL', kind: 'input' },
      { key: 'f', label: '稀释倍数f', kind: 'input' }, { key: 'v0', label: '空白V₀', unit: 'mL', kind: 'input' },
      { key: 'v1', label: '样品V₁', unit: 'mL', kind: 'input' }, { key: 'blankMode', label: '空白运算（加/减）', kind: 'input' },
      { key: 'combined', label: 'V₁±V₀', unit: 'mL', kind: 'auto' }, { key: 'rho', label: '样品浓度ρ', unit: 'mg/L', kind: 'auto' },
      { key: 'note', label: '备注', kind: 'input' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([{ label: '硫代硫酸钠浓度C', key: 'c' }]) },
  ],
}

const metalGasAAS: Schema = {
  id: 'metalGasAAS', title: () => '固定污染源废气颗粒物中金属原子吸收分光光度法原始记录表',
  result: { key: 'rhoGas', unit: 'μg/m³' }, columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row) {
    const rho = num(row.rhoSolution), vdef = num(row.vdef), k = num(row.k) ?? 1, vnd = num(row.vnd)
    return { rhoGas: rho == null || vdef == null || vnd == null || vnd === 0 ? null : r3(rho * vdef * k / vnd) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '样品编号', kind: 'id' }, { key: 'vnd', label: '标况下采样体积Vnd', unit: 'm³', kind: 'input' },
      { key: 'vdef', label: '定容体积V', unit: 'mL', kind: 'input' }, { key: 'k', label: '稀释倍数K', kind: 'input' },
      { key: 'a0', label: '空白A₀', kind: 'input', group: '吸光值' }, { key: 'a', label: '样品A', kind: 'input', group: '吸光值' },
      { key: 'net', label: 'A－A₀', kind: 'input', group: '吸光值' }, { key: 'rhoSolution', label: '试液中金属浓度ρ', unit: 'mg/L', kind: 'input' },
      { key: 'rhoGas', label: '颗粒物中金属质量浓度', unit: 'μg/m³', kind: 'auto' }, { key: 'note', label: '备注', kind: 'input' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([
      { label: '测定波长', key: 'wavelength', fixed: true }, { label: '狭缝', key: 'slit' },
      { label: '灯电流', key: 'lampCurrent' }, { label: '回归方程', key: 'regression' },
    ]) },
  ],
}

const mercuryAfsGas: Schema = {
  id: 'mercuryAfsGas', title: () => '空气和废气原子荧光分光光度法测汞原始记录表',
  result: { key: 'rhoGas', unit: 'μg/m³' }, columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row) {
    const rho = num(row.rhoSolution), v = num(row.v), vnd = num(row.vnd)
    return { rhoGas: rho == null || v == null || vnd == null || vnd === 0 ? null : r3(rho * v / 1000 / vnd) }
  },
  layout: [
    { type: 'table', id: 'main', seedRows: 4, columns: [
      { key: 'id', label: '质控编号', kind: 'id' }, { key: 'v', label: '取样量V', unit: 'mL', kind: 'input' },
      { key: 'vnd', label: '标况体积Vnd', unit: 'm³', kind: 'input' }, { key: 'area', label: '峰面积A', kind: 'input' },
      { key: 'rhoSolution', label: '样品浓度', unit: 'μg/L', kind: 'input' }, { key: 'rhoGas', label: '汞的浓度', unit: 'μg/m³', kind: 'auto' },
      { key: 'note', label: '备注', kind: 'input' },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: commonMeta([{ label: '回归方程', key: 'regression' }]) },
  ],
}

export const remainingForms: Record<string, Schema> = {
  'HJ-TC-033': mercurySoil,
  'HJ-TC-102': permanganateIndex,
  'HJ-TC-125': chlorideTitration,
  'HJ-TC-138': hardnessTitrationMol,
  'HJ-TC-179': permanganateIndex,
  'HJ-TC-197': waterPhotometric,
  'HJ-TC-199': waterPhotometric,
  'HJ-TC-232': turbidity,
  'HJ-TC-355': seaCod,
  'HJ-TC-394': carbonateTitration,
  'HJ-TC-401': metalGasAAS,
  'HJ-TC-402': metalGasAAS,
  'HJ-TC-403': metalGasAAS,
  'HJ-TC-421': mercurySolidWaste,
  'HJ-TC-423': salinity,
  'HJ-TC-429': density,
  'HJ-TC-431': seaBod,
  'HJ-TC-437': chlorideTitration,
  'HJ-TC-438': hardnessTitrationMmol,
  'HJ-TC-458': waterPhotometric,
  'HJ-TC-575': iodideTitration,
  'HJ-TC-576': waterPhotometric,
  'HJ-TC-588': mercuryAfsGas,
  'HJ-TC-598': waterTemperature,
  'HJ-TC-617': carbonateTitration,
  'HJ-TC-636': turbidity,
  'HJ-TC-637': turbidity,
  'HJ-TC-648': chromaPtCo,
  'HJ-TC-378': flowCheck,
  'HJ-TC-405': chlorineDioxide,
  'HJ-TC-705': permanganateIndex,
  'HJ-TC-718': transparency,
}
