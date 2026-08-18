import type { Schema } from '../schemas'

// 水质金属 原子吸收分光光度法 原始记录表（共用版式）
// 波长/狭缝/检出限/测量项目按各表自己的 meta 显示（各标准表1仪器参考测量条件）
function n(v: any): number | null { const x = parseFloat(v); return isFinite(x) ? x : null }

// ── HJ1453-2026 铜/铅/镉/镍/铬 石墨炉AAS（直接进样，结果 μg/L，ρ=ρ查×D）──
const waterMetalGFAAS: Schema = {
  id: 'waterMetalGFAAS',
  title: () => '水质 金属元素的测定 石墨炉原子吸收分光光度法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'],
  seed: () => [],
  compute(row: Record<string, any>) {
    const rhoii = n(row.rhoii), d = n(row.d) ?? 1
    if (rhoii == null) return { rho: null }
    return { rho: Math.round(rhoii * d * 1000) / 1000 }
  },
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'd', label: '稀释倍数D', kind: 'input', w: 70 },
      { key: 'a0', label: '空白吸光度A₀', kind: 'input', group: '吸光度', w: 90 },
      { key: 'a', label: '样品吸光度A', kind: 'input', group: '吸光度', w: 90 },
      { key: 'rhoii', label: '曲线查得浓度ρ查', unit: 'μg/L', kind: 'input', w: 110 },
      { key: 'rho', label: '结果ρ', unit: 'μg/L', kind: 'auto', w: 90 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true },
      { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
      { label: '仪器型号', key: 'instrument' },
      { label: '仪器编号', key: 'instrumentNo' },
      { label: '测定波长', key: 'wavelength', fixed: true },
      { label: '通带宽度', key: 'slit', fixed: true },
      { label: '灯电流', key: 'lampCurrent' },
      { label: '方法依据', key: 'basis', fixed: true },
      { label: '检出限', key: 'detectionLimit', fixed: true },
      { label: '计算公式', key: 'formula', colspan: 2, latex: '\\rho_i\\,(\\mu g/L)=\\rho_{ii}\\times D' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'ρᵢ—样品中元素的质量浓度(μg/L)；ρᵢᵢ—由校准曲线查得的试样中元素质量浓度(μg/L)；D—试样稀释倍数。结果表示：小数点后位数与检出限一致，最多保留3位有效数字。' },
    ] },
  ],
}

// ── 通用水样AAS（分取/定容/稀释，含空白扣减，ρ=(ρ₁-ρ₀)×V₁×f/V）──
// 适用 铊(HJ748)/钒(HJ673)/钼(HJ807)/银(HJ1451)/铬(HJ757) 等单元素水样AAS
function makeWaterMetalAAS(unit: string): Schema {
  return {
    id: `waterMetalAAS_${unit.replace('/', '')}`,
    title: () => '水质 金属元素的测定 原子吸收分光光度法 原始记录表',
    columns: [], meta: [], signRoles: ['检验', '复核', '审核'],
    seed: () => [],
    compute(row: Record<string, any>) {
      const rho1 = n(row.rho1); if (rho1 == null) return { rho: null }
      const rho0 = n(row.rho0) ?? 0, f = n(row.f) ?? 1
      const v = n(row.v), v1 = n(row.v1)
      const ratio = (v && v1 && v !== 0) ? v1 / v : 1
      return { rho: Math.round((rho1 - rho0) * ratio * f * 1000) / 1000 }
    },
    layout: [
      { type: 'table', id: 'tbl', seedRows: 3, columns: [
        { key: 'id', label: '样品编号', kind: 'id', w: 90 },
        { key: 'v', label: '分取体积V', unit: 'mL', kind: 'input', w: 70 },
        { key: 'v1', label: '定容体积V₁', unit: 'mL', kind: 'input', w: 70 },
        { key: 'f', label: '稀释倍数f', kind: 'input', w: 60 },
        { key: 'a0', label: '空白吸光度A₀', kind: 'input', group: '吸光度', w: 88 },
        { key: 'a', label: '样品吸光度A', kind: 'input', group: '吸光度', w: 88 },
        { key: 'rho0', label: '空白查得浓度ρ₀', unit, kind: 'input', w: 100 },
        { key: 'rho1', label: '样品查得浓度ρ₁', unit, kind: 'input', w: 100 },
        { key: 'rho', label: '结果ρ', unit, kind: 'auto', w: 90 },
        { key: 'note', label: '备注', kind: 'input', w: 70 },
      ] },
      { type: 'kv', id: 'meta', cols: 2, rows: [
        { label: '测量项目', key: 'analyte', fixed: true },
        { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
        { label: '仪器型号', key: 'instrument' },
        { label: '仪器编号', key: 'instrumentNo' },
        { label: '测定波长', key: 'wavelength', fixed: true },
        { label: '通带宽度', key: 'slit', fixed: true },
        { label: '灯电流', key: 'lampCurrent' },
        { label: '方法依据', key: 'basis', fixed: true },
        { label: '检出限', key: 'detectionLimit', fixed: true },
        { label: '计算公式', key: 'formula', colspan: 2, latex: `\\rho\\,(${unit === 'mg/L' ? 'mg/L' : '\\mu g/L'})=\\dfrac{(\\rho_1-\\rho_0)\\times V_1\\times f}{V}` },
        { label: '式中', key: 'notation', fixed: true, colspan: 2,
          value: `ρ₁—由校准曲线查得的试样中元素质量浓度(${unit})；ρ₀—空白试样查得浓度(${unit})；V₁—试样定容体积(mL)；V—分取试样体积(mL)；f—稀释倍数。结果表示：小于1${unit}保留小数点后两位，大于等于1${unit}保留三位有效数字。` },
      ] },
    ],
  }
}

const waterMetalAAS_ug = makeWaterMetalAAS('μg/L')
const waterMetalAAS_mg = makeWaterMetalAAS('mg/L')

// ── 冷原子吸收/原子荧光 测汞（HJ597等）：无波长/狭缝（仪器固定253.7nm，测汞仪不设狭缝）──
const mercuryCV: Schema = {
  id: 'mercuryCV',
  title: () => '水质 总汞的测定 冷原子吸收(荧光)法 原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 110 },
    { key: 'V', label: '取样量', unit: 'mL', kind: 'input' },
    { key: 'Vf', label: '定容体积', unit: 'mL', kind: 'input' },
    { key: 'K', label: '稀释倍数K', kind: 'input' },
    { key: 'a0', label: '空白A₀', kind: 'input', group: '吸光值/荧光值' },
    { key: 'a', label: '样品A', kind: 'input', group: '吸光值/荧光值' },
    { key: 'net', label: 'A−A₀', kind: 'auto', group: '吸光值/荧光值' },
    { key: 'rho', label: '样品浓度', unit: 'μg/L', kind: 'auto' },
    { key: 'note', label: '备注', kind: 'input', w: 90 },
  ],
  compute: (row, ctx: any) => {
    const a = n(row.a), a0 = n(row.a0), K = n(row.K) ?? 1
    if (a == null || a0 == null) return { net: null, rho: null }
    const net = Math.round((a - a0) * 10000) / 10000
    const b = ctx?.reg?.b, aa = ctx?.reg?.a
    const vdef = n(row.Vf) ?? n(ctx?.meta?.vdef) ?? 50  // 定容体积
    const V = n(row.V) ?? vdef  // 取样量
    let rho: number | null = (b && V) ? (net - aa) / b * (vdef / V) * K : null
    if (rho != null) { if (rho < 0) rho = 0; rho = Math.round(rho * 1000) / 1000 }
    return { net, rho }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true, fixed: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '方法依据', key: 'basis', fixed: true },
    { label: '检出限', key: 'detectionLimit', fixed: true },
  ],
  regression: true,
  latex: '\\rho\\,(\\mu g/L) = \\dfrac{A - A_0 - a}{b}\\times K',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [
    { id: 'F260114-1', V: 50, K: 1, a0: 0.004, a: 0.061, note: '' },
    { id: 'F260114-0', V: 50, K: 1, a0: 0.004, a: 0.005, note: '空白' },
  ],
}

export const waterMetalForms: Record<string, Schema> = {
  'HJ-TC-725': waterMetalGFAAS, // 铜·废水
  'HJ-TC-726': waterMetalGFAAS, // 铅·废水
  'HJ-TC-727': waterMetalGFAAS, // 镉·废水
  'HJ-TC-728': waterMetalGFAAS, // 镍·废水
  'HJ-TC-729': waterMetalGFAAS, // 铬·废水
  'HJ-TC-466': waterMetalAAS_ug, // 铊·水质 HJ748
  'HJ-TC-572': waterMetalAAS_ug, // 钼·水质 HJ807
  'HJ-TC-571': waterMetalAAS_ug, // 钡·水质 HJ602-2011
  'HJ-TC-730': waterMetalAAS_ug, // 银·废水 HJ1451-2026
  'HJ-TC-569': waterMetalAAS_mg, // 钒·水质 HJ673
  'HJ-TC-731': waterMetalAAS_mg, // 铬·水质 HJ757
  'HJ-TC-467': waterMetalAAS_ug, // 铍·水质 HJ石墨炉 μg/L
  'HJ-TC-732': waterMetalAAS_mg, // 银·废水 火焰 mg/L
  'HJ-TC-017': mercuryCV,        // 汞·废水 冷原子吸收 HJ597
}
