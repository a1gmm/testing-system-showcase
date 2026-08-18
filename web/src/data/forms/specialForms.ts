import type { Schema } from '../schemas'

function n(v: any): number | null { const x = parseFloat(v); return isFinite(x) ? x : null }
const r3 = (x: number) => Math.round(x * 1000) / 1000
const r4 = (x: number) => Math.round(x * 10000) / 10000

// ── 双波长紫外法 样品（总氮HJ636 / 硝酸盐氮HJ/T346）──
// 校正吸光度 Ar=(A220样−2A275样)−(A220空−2A275空)；ρ=(Ar−a)/b×(定容/取样)×K
const dualWaveSample: Schema = {
  id: 'dualWaveSample',
  title: () => '双波长紫外分光光度法 原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 90 },
    { key: 'V', label: '取样量', unit: 'ml', kind: 'input', w: 70 },
    { key: 'K', label: '稀释倍数K', kind: 'input', w: 70 },
    { key: 'b220', label: '空白A₂₂₀', kind: 'input', group: '吸光度', w: 78 },
    { key: 'b275', label: '空白A₂₇₅', kind: 'input', group: '吸光度', w: 78 },
    { key: 's220', label: '样品A₂₂₀', kind: 'input', group: '吸光度', w: 78 },
    { key: 's275', label: '样品A₂₇₅', kind: 'input', group: '吸光度', w: 78 },
    { key: 'ar', label: '校正吸光度Ar', kind: 'auto', w: 96 },
    { key: 'rho', label: '样品浓度', unit: 'mg/L', kind: 'auto', w: 84 },
    { key: 'note', label: '备注', kind: 'input', w: 70 },
  ],
  compute: (row, ctx: any) => {
    const b220 = n(row.b220), b275 = n(row.b275), s220 = n(row.s220), s275 = n(row.s275)
    if (s220 == null || s275 == null) return { ar: null, rho: null }
    const arB = (b220 != null && b275 != null) ? (b220 - 2 * b275) : 0
    const ar = r4((s220 - 2 * s275) - arB)
    const b = ctx?.reg?.b, aa = ctx?.reg?.a
    const vdef = n(ctx?.meta?.vdef) ?? 50
    const V = n(row.V) ?? vdef, K = n(row.K) ?? 1
    let rho: number | null = (b && V) ? (ar - aa) / b * (vdef / V) * K : null
    if (rho != null) { if (rho < 0) rho = 0; rho = r3(rho) }
    return { ar, rho }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true, fixed: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '测定波长', key: 'wavelength', fixed: true, value: '220nm、275nm' },
    { label: '定容体积(ml)', key: 'vdef' },
    { label: '方法依据', key: 'basis', fixed: true },
    { label: '检出限', key: 'detectionLimit', fixed: true },
  ],
  regression: true,
  latex: 'A_r=(A_{220}-2A_{275})_{样}-(A_{220}-2A_{275})_{空}\\;;\\; \\rho=\\dfrac{A_r-a}{b}\\times\\dfrac{V_0}{V}\\times K',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [{ id: '', V: 10, K: 1, b220: '', b275: '', s220: '', s275: '', note: '' }],
}

// ── 双波长紫外法 校准曲线（总氮/硝酸盐）──
const dualWaveCalib: Schema = {
  id: 'dualWaveCalib',
  title: () => '双波长紫外分光光度法 校准曲线原始记录表',
  columns: [
    { key: 'no', label: '序号', kind: 'id', w: 50 },
    { key: 'vol', label: '标准溶液加入体积', unit: 'ml', kind: 'input', w: 110 },
    { key: 'amount', label: '标准物质含量', unit: 'µg', kind: 'input', w: 100 },
    { key: 'a220', label: 'A₂₂₀', kind: 'input', group: '吸光度', w: 78 },
    { key: 'a275', label: 'A₂₇₅', kind: 'input', group: '吸光度', w: 78 },
    { key: 'ar', label: '校正吸光度(A₂₂₀−2A₂₇₅)', kind: 'auto', w: 150 },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute: (row) => {
    const a220 = n(row.a220), a275 = n(row.a275)
    return { ar: (a220 != null && a275 != null) ? r4(a220 - 2 * a275) : null }
  },
  fit: (rows, ctx: any) => {
    const vdef = n(ctx?.meta?.vdef) ?? 50
    const pts = rows.map((r: any) => {
      const amt = n(r.amount), a220 = n(r.a220), a275 = n(r.a275)
      if (amt == null || a220 == null || a275 == null) return null
      return [amt / vdef, a220 - 2 * a275]
    }).filter(Boolean) as number[][]
    // 简单线性拟合
    const nP = pts.length; if (nP < 2) return { a: 0, b: 0, r: 0 }
    const sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0)
    const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0)
    const b = (nP * sxy - sx * sy) / (nP * sxx - sx * sx)
    const a = (sy - b * sx) / nP
    const syy = pts.reduce((s, p) => s + p[1] * p[1], 0)
    const r = (nP * sxy - sx * sy) / Math.sqrt((nP * sxx - sx * sx) * (nP * syy - sy * sy))
    return { a: r4(a), b: r4(b), r: Math.round(r * 100000) / 100000 }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true, fixed: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '测定波长', key: 'wavelength', fixed: true, value: '220nm、275nm' },
    { label: '定容体积(ml)', key: 'vdef' },
    { label: '方法依据', key: 'basis', fixed: true },
    { label: '检出限', key: 'detectionLimit', fixed: true },
  ],
  regression: true, curveCheck: true,
  latex: 'A_r=A_{220}-2A_{275}',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [1, 2, 3, 4, 5, 6].map((k, i) => ({ no: k, vol: [0, 1, 2, 3, 5, 7][i], amount: [0, 10, 20, 30, 50, 70][i], a220: '', a275: '', note: '' })),
}

// ── 热灼减率 重量法（HJ1024-2019）P=(m1−m2)/(m1−m0)×100 ──
const ignitionLoss: Schema = {
  id: 'ignitionLoss',
  title: () => '固体废物 热灼减率 重量法 原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 100 },
    { key: 'm0', label: '坩埚质量m₀', unit: 'g', kind: 'input', group: '称量', w: 96 },
    { key: 'm1', label: '灼烧前(样+埚)m₁', unit: 'g', kind: 'input', group: '称量', w: 120 },
    { key: 'm2', label: '灼烧后(样+埚)m₂', unit: 'g', kind: 'input', group: '称量', w: 120 },
    { key: 'p', label: '热灼减率P', unit: '%', kind: 'auto', w: 90 },
    { key: 'note', label: '备注', kind: 'input', w: 90 },
  ],
  compute: (row) => {
    const m0 = n(row.m0), m1 = n(row.m1), m2 = n(row.m2)
    if (m0 == null || m1 == null || m2 == null || m1 === m0) return { p: null }
    return { p: r3((m1 - m2) / (m1 - m0) * 100) }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true, fixed: true },
    { label: '使用天平', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '灼烧条件', key: 'igniteTemp', fixed: true, value: '(600±25)℃，3h' },
    { label: '方法依据', key: 'basis', fixed: true },
    { label: '检出限', key: 'detectionLimit', fixed: true },
  ],
  latex: 'P\\,(\\%)=\\dfrac{m_1-m_2}{m_1-m_0}\\times 100',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [{ id: '', m0: '', m1: '', m2: '', note: '' }],
}

// ── 土壤 分光光度法（氰化物HJ745等）ω=(A−A₀−a)×V₁/(b·m·w_dm·V₂) mg/kg ──
const soilPhotometric: Schema = {
  id: 'soilPhotometric',
  title: () => '土壤 分光光度法 原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 88 },
    { key: 'm', label: '取样量m', unit: 'g', kind: 'input', w: 70 },
    { key: 'v1', label: '定容体积V₁', unit: 'ml', kind: 'input', w: 80 },
    { key: 'v2', label: '分取体积V₂', unit: 'ml', kind: 'input', w: 80 },
    { key: 'wdm', label: '干物质w_dm', unit: '%', kind: 'input', w: 84 },
    { key: 'a0', label: '空白A₀', kind: 'input', group: '吸光度', w: 66 },
    { key: 'a', label: '样品A', kind: 'input', group: '吸光度', w: 66 },
    { key: 'w', label: '样品含量ω', unit: 'mg/kg', kind: 'auto', w: 90 },
    { key: 'note', label: '备注', kind: 'input', w: 66 },
  ],
  compute: (row, ctx: any) => {
    const a = n(row.a), a0 = n(row.a0), m = n(row.m), v1 = n(row.v1), v2 = n(row.v2), wdm = n(row.wdm)
    const b = ctx?.reg?.b, aa = ctx?.reg?.a
    if (a == null || a0 == null || !b || m == null || m === 0 || v1 == null || v2 == null || v2 === 0 || wdm == null || wdm === 0) return { w: null }
    // (A−A0−a)/b = 氰离子量µg；×V1/V2 定容/分取；÷(m×wdm/100) → mg/kg
    const amt = (a - a0 - aa) / b
    const w = amt * v1 / v2 / (m * (wdm / 100)) / 1000 * 1000 // µg/g = mg/kg
    return { w: w < 0 ? 0 : r3(w) }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true, fixed: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '测定波长', key: 'wavelength', fixed: true },
    { label: '方法依据', key: 'basis', fixed: true },
    { label: '检出限', key: 'detectionLimit', fixed: true },
  ],
  regression: true,
  latex: '\\omega\\,(mg/kg)=\\dfrac{(A-A_0-a)\\times V_1}{b\\times m\\times w_{dm}\\times V_2}',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [{ id: '', m: 10, v1: 100, v2: 10, wdm: '', a0: '', a: '', note: '' }],
}

// ── 褪色法 校准曲线（余氯甲基橙HJ/T586 / 臭氧IDS-HJ504）净信号=A₀−A ──
const decolorCalib: Schema = {
  id: 'decolorCalib',
  title: () => '褪色分光光度法 校准曲线原始记录表',
  columns: [
    { key: 'no', label: '序号', kind: 'id', w: 50 },
    { key: 'vol', label: '标准溶液加入体积', unit: 'ml', kind: 'input', w: 110 },
    { key: 'amount', label: '标准物质含量', unit: 'µg', kind: 'input', w: 100 },
    { key: 'a0', label: '空白(零管)A₀', kind: 'input', group: '吸光度', w: 96 },
    { key: 'a', label: '样管A', kind: 'input', group: '吸光度', w: 70 },
    { key: 'net', label: '净信号(A₀−A)', kind: 'auto', group: '吸光度', w: 100 },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute: (row) => {
    const a = n(row.a), a0 = n(row.a0)
    return { net: (a != null && a0 != null) ? r4(a0 - a) : null }  // 褪色：空白高、样品低，A₀−A 为正
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true, fixed: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '测定波长', key: 'wavelength', fixed: true },
    { label: '方法依据', key: 'basis', fixed: true },
    { label: '检出限', key: 'detectionLimit', fixed: true },
  ],
  regression: true, curveCheck: true,
  latex: '\\text{净信号}=A_0-A\\quad(\\text{褪色法：空白吸光度最高})',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [1, 2, 3, 4, 5].map((k, i) => ({ no: k, vol: [0, 1, 2, 4, 6][i], amount: [0, 5, 10, 20, 30][i], a0: '', a: '', note: '' })),
}

// ── 石油类 红外分光光度法（HJ637-2018）三波数+校正系数 ──
// ρ=[X·A2930+Y·A2960+Z(A3030−A2930/F)]·(V0/Vw)·D − ρ0
const irOil: Schema = {
  id: 'irOil',
  title: () => '水质 石油类/动植物油 红外分光光度法 原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 88 },
    { key: 'vw', label: '水样体积Vw', unit: 'ml', kind: 'input', w: 88 },
    { key: 'v0', label: '萃取定容V₀', unit: 'ml', kind: 'input', w: 88 },
    { key: 'd', label: '稀释倍数D', kind: 'input', w: 66 },
    { key: 'a2930', label: 'A₂₉₃₀', kind: 'input', group: '吸光度', w: 72 },
    { key: 'a2960', label: 'A₂₉₆₀', kind: 'input', group: '吸光度', w: 72 },
    { key: 'a3030', label: 'A₃₀₃₀', kind: 'input', group: '吸光度', w: 72 },
    { key: 'rho0', label: '空白ρ₀', unit: 'mg/L', kind: 'input', w: 74 },
    { key: 'rho', label: '结果ρ', unit: 'mg/L', kind: 'auto', w: 84 },
    { key: 'note', label: '备注', kind: 'input', w: 62 },
  ],
  compute: (row, ctx: any) => {
    const a29 = n(row.a2930), a296 = n(row.a2960), a303 = n(row.a3030)
    const vw = n(row.vw), v0 = n(row.v0), d = n(row.d) ?? 1, rho0 = n(row.rho0) ?? 0
    const X = n(ctx?.meta?.coefX), Y = n(ctx?.meta?.coefY), Z = n(ctx?.meta?.coefZ), F = n(ctx?.meta?.coefF)
    if (a29 == null || a296 == null || a303 == null || vw == null || vw === 0 || v0 == null || X == null || Y == null || Z == null || F == null || F === 0) return { rho: null }
    const conc = X * a29 + Y * a296 + Z * (a303 - a29 / F) // mg/L(萃取液)
    const rho = conc * (v0 / vw) * d - rho0
    return { rho: rho < 0 ? 0 : r3(rho) }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true, fixed: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '校正系数X', key: 'coefX' }, { label: '校正系数Y', key: 'coefY' },
    { label: '校正系数Z', key: 'coefZ' }, { label: '校正系数F', key: 'coefF' },
    { label: '方法依据', key: 'basis', fixed: true },
    { label: '检出限', key: 'detectionLimit', fixed: true },
  ],
  latex: '\\rho=[X A_{2930}+Y A_{2960}+Z(A_{3030}-\\tfrac{A_{2930}}{F})]\\cdot\\tfrac{V_0}{V_w}\\cdot D-\\rho_0',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [{ id: '', vw: 500, v0: 50, d: 1, a2930: '', a2960: '', a3030: '', rho0: '', note: '' }],
}

// ── 环境空气 氮氧化物（HJ479）双吸收瓶 ρNOx=ρNO2+ρNO，mg/m³ ──
const noxAir: Schema = {
  id: 'noxAir',
  title: () => '环境空气 氮氧化物 盐酸萘乙二胺分光光度法 原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 82 },
    { key: 'vabs', label: '吸收液体积V', unit: 'ml', kind: 'input', w: 84 },
    { key: 'v0', label: '标态采样体积V₀', unit: 'L', kind: 'input', w: 106 },
    { key: 'd', label: '稀释倍数D', kind: 'input', w: 64 },
    { key: 'a0', label: '空白A₀', kind: 'input', group: '吸光度', w: 62 },
    { key: 'a1', label: '第一瓶A₁(NO₂)', kind: 'input', group: '吸光度', w: 100 },
    { key: 'a2', label: '第二瓶A₂(NO)', kind: 'input', group: '吸光度', w: 96 },
    { key: 'rho', label: 'ρ(NOx)', unit: 'mg/m³', kind: 'auto', w: 88 },
    { key: 'note', label: '备注', kind: 'input', w: 60 },
  ],
  compute: (row, ctx: any) => {
    const a0 = n(row.a0), a1 = n(row.a1), a2 = n(row.a2)
    const V = n(row.vabs), V0 = n(row.v0), D = n(row.d) ?? 1
    const b = ctx?.reg?.b, aa = ctx?.reg?.a
    const f = n(ctx?.meta?.saltzman) ?? 0.88, K = n(ctx?.meta?.convK) ?? 0.68
    if (a1 == null || a0 == null || !b || V == null || V0 == null || V0 === 0) return { rho: null }
    const rhoNO2 = (a1 - a0 - aa) / b * V * D / (f * V0)
    const rhoNO = (a2 != null) ? (a2 - a0 - aa) / b * V * D / (f * V0 * K) : 0
    const rho = rhoNO2 + rhoNO
    return { rho: rho < 0 ? 0 : r3(rho) }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true, fixed: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '测定波长', key: 'wavelength', fixed: true, value: '540nm' },
    { label: 'Saltzman系数f', key: 'saltzman', fixed: true, value: '0.88' },
    { label: '转换系数K', key: 'convK' },
    { label: '方法依据', key: 'basis', fixed: true },
    { label: '检出限', key: 'detectionLimit', fixed: true },
  ],
  regression: true,
  latex: '\\rho_{NOx}=\\rho_{NO_2}+\\rho_{NO},\\; \\rho_{NO_2}=\\tfrac{(A_1-A_0-a)VD}{b f V_0},\\; \\rho_{NO}=\\tfrac{(A_2-A_0-a)VD}{b f V_0 K}',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [{ id: '', vabs: 10, v0: '', d: 1, a0: '', a1: '', a2: '', note: '' }],
}

export const specialForms: Record<string, Schema> = {
  'HJ-TC-094': irOil,           // 石油类 红外 HJ637
  'HJ-TC-118': noxAir,          // 氮氧化物·环境空气 HJ479
  'HJ-TC-097': dualWaveSample,  // 总氮 HJ636
  'HJ-TC-180': dualWaveSample,  // 硝酸盐氮 HJ/T346
  'HJ-TC-181': dualWaveSample,  // 硝酸盐氮 HJ/T346
  'HJ-TC-098': dualWaveCalib,   // 总氮 校准曲线
  'HJ-TC-471': ignitionLoss,    // 热灼减率 HJ1024
  'HJ-TC-565': soilPhotometric, // 氰化物·土壤 HJ745
  'HJ-TC-191': decolorCalib,    // 余氯·褪色法 校准
  'HJ-TC-416': decolorCalib,    // 臭氧·IDS褪色 校准
}
