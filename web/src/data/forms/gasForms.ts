import type { Schema } from '../schemas'

function n(v: any): number | null { const x = parseFloat(v); return isFinite(x) ? x : null }
const r3 = (x: number) => Math.round(x * 1000) / 1000

// ── 废气/环境空气 分光光度/原子吸收 通用版式：绝对量m(μg) ÷ 标干体积Vnd(L) = mg/m³ ──
// 适用 汞/砷/铅/镉/镍/铬·废气、SO₂/镉/镍·环境空气 等（各表波长/检出限按meta）
const photometricGas: Schema = {
  id: 'photometricGas',
  title: () => '废气/环境空气 分光光度(原子吸收)法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row: Record<string, any>) {
    const m = n(row.m), vnd = n(row.vnd)
    const rho = (m == null || vnd == null || vnd === 0) ? null : r3(m / vnd) // μg/L = mg/m³
    // 折算浓度（如有过量空气系数/含氧量折算系数f）
    const f = n(row.fconv)
    const rhoStd = (rho == null || f == null) ? null : r3(rho * f)
    return { rho, rhoStd }
  },
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 90 },
      { key: 'vdef', label: '定容体积V', unit: 'mL', kind: 'input', w: 78 },
      { key: 'a0', label: '空白A₀', kind: 'input', group: '吸光度', w: 66 },
      { key: 'a', label: '样品A', kind: 'input', group: '吸光度', w: 66 },
      { key: 'm', label: '绝对量m(查曲线)', unit: 'μg', kind: 'input', w: 110 },
      { key: 'vnd', label: '标干采样体积Vnd', unit: 'L', kind: 'input', w: 110 },
      { key: 'rho', label: '实测浓度ρ', unit: 'mg/m³', kind: 'auto', w: 90 },
      { key: 'fconv', label: '折算系数f', kind: 'input', w: 70 },
      { key: 'rhoStd', label: '折算浓度', unit: 'mg/m³', kind: 'auto', w: 90 },
      { key: 'note', label: '备注', kind: 'input', w: 66 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true },
      { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
      { label: '仪器型号', key: 'instrument' },
      { label: '仪器编号', key: 'instrumentNo' },
      { label: '测定波长', key: 'wavelength', fixed: true },
      { label: '方法依据', key: 'basis', fixed: true },
      { label: '检出限', key: 'detectionLimit', fixed: true },
      { label: '计算公式', key: 'formula', colspan: 2, latex: '\\rho\\,(mg/m^3)=\\dfrac{m}{V_{nd}}\\;;\\quad \\rho_{折}=\\rho\\times f' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'm—由校准曲线查得的样品中目标物绝对量(μg)；Vnd—标准状态(273K,101.325kPa)下干采样体积(L)；f—折算系数(如按含氧量折算)。μg/L=mg/m³。结果表示按各标准有效数字规则。' },
    ] },
  ],
}

// ── 废气 冷原子吸收测汞（HJ543等）：无波长（测汞仪固定253.7nm）──
const mercuryCVGas: Schema = {
  id: 'mercuryCVGas',
  title: () => '固定污染源废气 汞的测定 冷原子吸收法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row: Record<string, any>) {
    const m = n(row.m), vnd = n(row.vnd)
    return { rho: (m == null || vnd == null || vnd === 0) ? null : r3(m / vnd) }
  },
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'vdef', label: '定容体积V', unit: 'mL', kind: 'input', w: 84 },
      { key: 'a0', label: '空白A₀', kind: 'input', group: '吸光值', w: 72 },
      { key: 'a', label: '样品A', kind: 'input', group: '吸光值', w: 72 },
      { key: 'm', label: '绝对量m(查曲线)', unit: 'μg', kind: 'input', w: 110 },
      { key: 'vnd', label: '标干采样体积Vnd', unit: 'L', kind: 'input', w: 116 },
      { key: 'rho', label: '实测浓度ρ', unit: 'mg/m³', kind: 'auto', w: 96 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true },
      { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
      { label: '仪器型号', key: 'instrument' },
      { label: '仪器编号', key: 'instrumentNo' },
      { label: '方法依据', key: 'basis', fixed: true },
      { label: '检出限', key: 'detectionLimit', fixed: true },
      { label: '计算公式', key: 'formula', colspan: 2, latex: '\\rho\\,(mg/m^3)=\\dfrac{m}{V_{nd}}' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'm—由校准曲线查得的样品中汞绝对量(μg)；Vnd—标准状态(273K,101.325kPa)下干采样体积(L)。μg/L=mg/m³。' },
    ] },
  ],
}

// ── 废气 重量法（沥青烟/颗粒物）：增重ΔW(mg) ÷ 标干体积Vnd(m³) = mg/m³ ──
const gravimetricGas: Schema = {
  id: 'gravimetricGas',
  title: () => '固定污染源废气 重量法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row: Record<string, any>) {
    const w1 = n(row.w1), w2 = n(row.w2), vnd = n(row.vnd)
    const dw = (w1 == null || w2 == null) ? null : r3(w2 - w1)
    const rho = (dw == null || vnd == null || vnd === 0) ? null : r3(dw / vnd)
    return { dw, rho }
  },
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'w1', label: '采样前重W₁', unit: 'mg', kind: 'input', group: '称重', w: 100 },
      { key: 'w2', label: '采样后重W₂', unit: 'mg', kind: 'input', group: '称重', w: 100 },
      { key: 'dw', label: '增重ΔW', unit: 'mg', kind: 'auto', group: '称重', w: 90 },
      { key: 'vnd', label: '标干体积Vnd', unit: 'm³', kind: 'input', w: 100 },
      { key: 'rho', label: '浓度ρ', unit: 'mg/m³', kind: 'auto', w: 90 },
      { key: 'note', label: '备注', kind: 'input', w: 90 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true },
      { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
      { label: '使用天平', key: 'instrument' },
      { label: '仪器编号', key: 'instrumentNo' },
      { label: '方法依据', key: 'basis', fixed: true },
      { label: '检出限', key: 'detectionLimit', fixed: true },
      { label: '计算公式', key: 'formula', colspan: 2, latex: '\\rho\\,(mg/m^3)=\\dfrac{W_2-W_1}{V_{nd}}' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'W₁—采样前滤筒/滤膜质量(mg)；W₂—采样后质量(mg)；Vnd—标准状态下干采样体积(m³)。' },
    ] },
  ],
}

// ── 化学需氧量(COD) 重铬酸盐法：COD=(V₀−V₁)×c×8000/V ──
const codTitration: Schema = {
  id: 'codTitration',
  title: () => '化学需氧量(COD) 重铬酸盐法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row: Record<string, any>, ctx: any) {
    const v0 = n(row.v0), v1 = n(row.v1), V = n(row.V), f = n(row.f) ?? 1
    const c = n(ctx?.meta?.c) ?? n(row.c)
    if (v0 == null || v1 == null || V == null || V === 0 || c == null) return { cod: null }
    // COD(mg/L)=(V0−V1)×c×8×1000/V ×稀释倍数f
    return { cod: r3((v0 - v1) * c * 8000 / V * f) }
  },
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'V', label: '水样体积V', unit: 'mL', kind: 'input', w: 90 },
      { key: 'f', label: '稀释倍数f', kind: 'input', w: 70 },
      { key: 'v0', label: '空白滴定V₀', unit: 'mL', kind: 'input', group: '硫酸亚铁铵', w: 100 },
      { key: 'v1', label: '样品滴定V₁', unit: 'mL', kind: 'input', group: '硫酸亚铁铵', w: 100 },
      { key: 'cod', label: 'COD', unit: 'mg/L', kind: 'auto', w: 90 },
      { key: 'note', label: '备注', kind: 'input', w: 90 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true },
      { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
      { label: '硫酸亚铁铵浓度c', key: 'c' },
      { label: '仪器编号', key: 'instrumentNo' },
      { label: '方法依据', key: 'basis', fixed: true },
      { label: '检出限', key: 'detectionLimit', fixed: true },
      { label: '计算公式', key: 'formula', colspan: 2, latex: 'COD_{Cr}\\,(mg/L)=\\dfrac{(V_0-V_1)\\times c\\times 8000}{V}\\times f' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'V₀—空白消耗硫酸亚铁铵体积(mL)；V₁—样品消耗体积(mL)；c—硫酸亚铁铵标准溶液浓度(mol/L)；8000—氧(1/2 O)摩尔质量×1000；V—水样体积(mL)；f—稀释倍数。' },
    ] },
  ],
}

// ── 叶绿素a 分光光度法（HJ897-2017）四波长 ──
const chlorophyll: Schema = {
  id: 'chlorophyll',
  title: () => '叶绿素a 分光光度法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'], seed: () => [],
  compute(row: Record<string, any>) {
    const a664 = n(row.a664), a647 = n(row.a647), a630 = n(row.a630), a750 = n(row.a750) ?? 0
    const ve = n(row.ve), vs = n(row.vs), d = n(row.d) ?? 1 // ve提取液体积(mL), vs过滤水样体积(L)
    if (a664 == null || a647 == null || a630 == null || ve == null || vs == null || vs === 0) return { chla: null }
    // Jeffrey-Humphrey: Chla(μg/mL提取液)=11.85(E664−E750)−1.54(E647−E750)−0.08(E630−E750)
    const ca = 11.85 * (a664 - a750) - 1.54 * (a647 - a750) - 0.08 * (a630 - a750)
    // 水样叶绿素a(μg/L)=Chla×提取液体积(mL)/(光程d cm×过滤水样体积vs L)
    return { chla: r3(ca * ve / (d * vs)) }
  },
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 88 },
      { key: 'vs', label: '过滤水样V', unit: 'L', kind: 'input', w: 78 },
      { key: 've', label: '提取液体积Ve', unit: 'mL', kind: 'input', w: 92 },
      { key: 'd', label: '光程', unit: 'cm', kind: 'input', w: 60 },
      { key: 'a664', label: 'A664', kind: 'input', group: '吸光度', w: 66 },
      { key: 'a647', label: 'A647', kind: 'input', group: '吸光度', w: 66 },
      { key: 'a630', label: 'A630', kind: 'input', group: '吸光度', w: 66 },
      { key: 'a750', label: 'A750', kind: 'input', group: '吸光度', w: 66 },
      { key: 'chla', label: '叶绿素a', unit: 'μg/L', kind: 'auto', w: 84 },
      { key: 'note', label: '备注', kind: 'input', w: 66 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true },
      { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
      { label: '仪器型号', key: 'instrument' },
      { label: '仪器编号', key: 'instrumentNo' },
      { label: '方法依据', key: 'basis', fixed: true },
      { label: '检出限', key: 'detectionLimit', fixed: true },
      { label: '计算公式', key: 'formula', colspan: 2, latex: 'Chl_a=\\dfrac{[11.85(E_{664}-E_{750})-1.54(E_{647}-E_{750})-0.08(E_{630}-E_{750})]\\times V_e}{d\\times V_s}' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'E—各波长扣浊度(A750)后吸光度；Ve—提取液体积(mL)；Vs—过滤水样体积(L)；d—比色皿光程(cm)。A750用于校正浊度。' },
    ] },
  ],
}

export const gasForms: Record<string, Schema> = {
  'HJ-TC-037': mercuryCVGas, // 汞·废气 冷原子吸收（无波长）
  'HJ-TC-041': photometricGas, // 镍·环境空气
  'HJ-TC-086': photometricGas, // 二氧化硫·环境空气
  'HJ-TC-190': photometricGas, // 环境空气
  'HJ-TC-214': photometricGas, // 铬酸雾·废气
  'HJ-TC-219': photometricGas, // 铅·废气
  'HJ-TC-220': photometricGas, // 镍·废气
  'HJ-TC-222': photometricGas, // 镉·废气
  'HJ-TC-415': photometricGas, // 环境空气
  'HJ-TC-440': photometricGas, // 砷·废气
  'HJ-TC-700': photometricGas, // 镉·环境空气
  'HJ-TC-115': photometricGas, // 氨·环境空气 HJ533
  'HJ-TC-116': photometricGas, // 氨·环境空气 HJ533
  'HJ-TC-121': photometricGas, // 氯化氢·废气 HJ/T27
  'HJ-TC-122': photometricGas, // 氯化氢·废气 HJ/T27
  'HJ-TC-182': photometricGas, // 酚类·废气 HJ/T32
  'HJ-TC-207': photometricGas, // 氰化氢·废气 HJ/T28
  'HJ-TC-574': gravimetricGas, // 沥青烟
  'HJ-TC-103': codTitration,   // COD
  'HJ-TC-601': chlorophyll,    // 叶绿素a
}
