// 各记录表原型的「系统样子」模板定义（数据驱动）
// 规则：kind='input' 手填；kind='auto' 系统算(只读)；kind='id' 编号(手填,靠左)
import { FORMS } from './forms'
export type Col = {
  key: string; label: string; unit?: string
  kind: 'id' | 'input' | 'auto'
  group?: string      // 分组表头(如"吸光值")
  w?: number          // 列宽提示
}
// value：表级常量缺省值（如 Saltzman 系数 0.88），templates.json 的 tplMeta 缺这项时兜底显示
export type MetaField = { label: string; key: string; fixed?: boolean; wide?: boolean; value?: string }

// —— 版式分区模型（可选，存在时按 sections 渲染；不存在时走旧表格逻辑）——
export type SecCell = { key?: string; kind?: 'input' | 'auto' | 'const'; value?: string }
export type KvRow = {
  label: string; key?: string; fixed?: boolean; value?: string
  checks?: string[]      // 该行是勾选项（如 □验收 □抽查 □年度检查）
  checksKey?: string     // 勾选值存 meta[checksKey]
  colspan?: number       // 跨列（默认 1，KvBlock 的 cols 见 section.cols）
  latex?: string         // 该行是数学公式，用 KaTeX 渲染（如计算公式）
}
export type Section =
  | { type: 'kv'; id: string; cols?: number; rows: KvRow[] }
  | { type: 'checks'; id: string; label: string; key: string; options: string[]; multi?: boolean }
  | {
      type: 'matrix'; id: string; transpose?: boolean
      // transpose=true：rowHeaders 是左侧固定字段行，colHeaders 是顶部固定列
      rowHeaders: { label: string; key: string; unit?: string; kind?: 'input' | 'auto' | 'const'; value?: string }[]
      colHeaders: { label: string; key: string }[]
      cellKind?: 'input' | 'auto'
      note?: string      // 矩阵下方说明（如 Xi=(lga1+lga2)/2）
    }
  | { type: 'table'; id: string; columns: Col[]; seedRows?: number; footer?: { label: string; key: string; span?: number }[] }
  | { type: 'note'; id: string; label: string; key: string; rows?: number }
  | { type: 'diagram'; id: string; label: string }      // 示意图占位（带边框方框 + 说明）

export type Layout = Section[]

export type Schema = {
  id: string
  title: (method: string) => string
  columns: Col[]
  compute?: (row: Record<string, any>, ctx: Ctx) => Record<string, number | null>
  fit?: (rows: Record<string, any>[], ctx: Ctx) => { a: number; b: number; r: number } | null
  meta: MetaField[]
  regression?: boolean
  curveCheck?: boolean   // 校准曲线核查栏（零点/中间点核查，新标准质控要求）
  latex?: string
  signRoles: string[]
  seed: () => Record<string, any>[]
  layout?: Layout
}
export type Ctx = { reg: { a: number; b: number }; meta: Record<string, any> }

const num = (v: any) => (v === '' || v == null || isNaN(+v) ? null : +v)
// 数值修约按 GB/T 8170「四舍六入五成双」：与服务端判定引擎共用同一份实现（server/src/gbround），
// 记录表计算列、结果汇总、报告均值、限值判定四处口径一致
export { roundGB } from '../../../server/src/gbround'
import { roundGB } from '../../../server/src/gbround'
const r3 = (v: number) => roundGB(v, 3)
const r4 = (v: number) => roundGB(v, 4)

// —— 最小二乘拟合 y=a+bx，返回 a,b,r ——
function linfitPts(pts: number[][]) {
  if (pts.length < 2) return null
  const n = pts.length
  const sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0)
  const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), syy = pts.reduce((s, p) => s + p[1] * p[1], 0)
  const sxy = pts.reduce((s, p) => s + p[0] * p[1], 0)
  const den = n * sxx - sx * sx
  if (Math.abs(den) < 1e-12) return null   // 各点浓度相同：拟合无意义，回落手填系数（不再显示 a=NaN）
  const b = (n * sxy - sx * sy) / den
  const a = (sy - b * sx) / n
  const r = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy))
  return { a: roundGB(a, 4), b: roundGB(b, 4), r: roundGB(r, 4) }
}

// ============ 原型模板 ============
const photometric: Schema = {
  id: 'photometric',
  title: m => `${m}原始记录表`,
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 110 },
    { key: 'V', label: '取样量', unit: 'ml', kind: 'input' },
    { key: 'Vf', label: '定容体积', unit: 'ml', kind: 'input' },
    { key: 'K', label: '稀释倍数K', kind: 'input' },
    { key: 'a0', label: '空白A₀', kind: 'input', group: '吸光值' },
    { key: 'a', label: '样品A', kind: 'input', group: '吸光值' },
    { key: 'net', label: 'A−A₀', kind: 'auto', group: '吸光值' },
    { key: 'rho', label: '样品浓度', unit: 'mg/L', kind: 'auto' },
    { key: 'note', label: '备注', kind: 'input', w: 90 },
  ],
  compute: (row, ctx) => {
    const a = num(row.a), a0 = num(row.a0), K = num(row.K) ?? 1
    if (a == null || a0 == null) return { net: null, rho: null }
    const net = r4(a - a0)
    const b = ctx.reg.b, aa = ctx.reg.a
    // 校准曲线以"浓度=含量/定容体积"拟合，故样品浓度需按 定容体积/取样量 折算回原样，等价于国标 (A−A₀−a)/(bV)×K
    const vdef = num(ctx.meta.vdef) ?? 50
    const V = num(row.V) ?? vdef  // 取样量；缺省按定容体积(比值=1，即与校准同体积)
    let rho: number | null = (b && V) ? (net - aa) / b * (vdef / V) * K : null
    if (rho != null) { if (rho < 0) rho = 0; rho = r3(rho) }
    return { net, rho }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '测定波长', key: 'wavelength' },
    { label: '定容体积(ml)', key: 'vdef' },
    { label: '方法依据', key: 'basis' },
    { label: '检出限', key: 'detectionLimit' },
  ],
  regression: true,
  latex: '\\rho = \\dfrac{A - A_0 - a}{b}\\times\\dfrac{V_0}{V}\\times K\\quad(V_0\\text{定容},V\\text{取样})',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [
    { id: 'F260114-1', V: 50, K: 1, a0: 0.004, a: 0.061, note: '' },
    { id: 'F260114-2', V: 50, K: 1, a0: 0.004, a: 0.060, note: '平行样' },
    { id: 'F260114-0', V: 50, K: 1, a0: 0.004, a: 0.005, note: '空白' },
  ],
}

const calibration: Schema = {
  id: 'calibration',
  title: () => '校准曲线绘制及回归方程原始记录表',
  columns: [
    { key: 'no', label: '序号', kind: 'id', w: 50 },
    { key: 'vol', label: '标准溶液加入体积', unit: 'ml', kind: 'input' },
    { key: 'amount', label: '标准物质含量', unit: 'µg', kind: 'input' },
    { key: 'conc', label: '标准溶液浓度', unit: 'mg/L', kind: 'auto' },
    { key: 'a0', label: '空白A₀', kind: 'input', group: '信号值' },
    { key: 'a', label: '信号值A', kind: 'input', group: '信号值' },
    { key: 'net', label: 'A−A₀', kind: 'auto', group: '信号值' },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute: (row, ctx) => {
    const amount = num(row.amount), a = num(row.a), a0 = num(row.a0)
    const vdef = num(ctx.meta.vdef) ?? 50
    const conc = amount != null ? r3(amount / vdef) : null
    const net = a != null && a0 != null ? r4(a - a0) : null
    return { conc, net }
  },
  fit: (rows, ctx) => {
    const vdef = num(ctx.meta.vdef) ?? 50
    const pts = rows.map(r => {
      const amt = num(r.amount), a = num(r.a), a0 = num(r.a0)
      if (amt == null || a == null || a0 == null) return null
      return [amt / vdef, a - a0]
    }).filter(Boolean) as number[][]
    return linfitPts(pts)
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '定容体积(ml)', key: 'vdef' },
    { label: '测定波长', key: 'wavelength' },
    { label: '方法依据', key: 'basis' },
    { label: '检出限', key: 'detectionLimit' },
  ],
  regression: true,
  curveCheck: true,
  signRoles: ['检验', '复核', '审核'],
  seed: () => [1, 2, 3, 4, 5].map((n, i) => ({
    no: n, vol: [0, 0.5, 1, 2, 5][i], amount: [0, 5, 10, 20, 50][i],
    a0: 0.002, a: [0.002, 0.115, 0.228, 0.454, 1.128][i], note: '',
  })),
}

// 色谱法校准曲线变体：信号是"峰面积"，并记录"保留时间"（定性用）。x=浓度, y=峰面积
const calibrationChromatography: Schema = {
  id: 'calibrationChromatography',
  title: () => '校准曲线绘制及回归方程原始记录表',
  columns: [
    { key: 'no', label: '序号', kind: 'id', w: 50 },
    { key: 'vol', label: '标准使用液加入体积', unit: 'ml', kind: 'input' },
    { key: 'amount', label: '标准物质含量', unit: 'µg', kind: 'input' },
    { key: 'conc', label: '标准溶液浓度', unit: 'mg/L', kind: 'auto' },
    { key: 'rt', label: '保留时间', unit: 'min', kind: 'input' },
    { key: 'area', label: '峰面积', kind: 'input' },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute: (row, ctx) => {
    const amount = num(row.amount), vdef = num(ctx.meta.vdef) ?? 50
    return { conc: amount != null ? r3(amount / vdef) : null }
  },
  fit: (rows, ctx) => {
    const vdef = num(ctx.meta.vdef) ?? 50
    const pts = rows.map(r => {
      const amt = num(r.amount), area = num(r.area)
      if (amt == null || area == null) return null
      return [amt / vdef, area]
    }).filter(Boolean) as number[][]
    return linfitPts(pts)
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '定容体积(ml)', key: 'vdef' },
    { label: '色谱柱', key: 'column' },
    { label: '方法依据', key: 'basis' },
    { label: '检出限', key: 'detectionLimit' },
  ],
  regression: true,
  curveCheck: true,
  signRoles: ['检验', '复核', '审核'],
  seed: () => [1, 2, 3, 4, 5].map((n, i) => ({
    no: n, vol: [0, 0.5, 1, 2, 5][i], amount: [0, 5, 10, 20, 50][i], rt: '', area: '', note: '',
  })),
}

// 电极法校准曲线变体：信号是"电位E(mV)"，标准工作曲线为 E~lg(浓度) 半对数直线
const calibrationElectrode: Schema = {
  id: 'calibrationElectrode',
  title: () => '校准曲线绘制及回归方程原始记录表',
  columns: [
    { key: 'no', label: '序号', kind: 'id', w: 50 },
    { key: 'conc', label: '标准溶液浓度', unit: 'mg/L', kind: 'input' },
    { key: 'lgc', label: 'lg(ρ)', kind: 'auto' },
    { key: 'e', label: '电位E', unit: 'mV', kind: 'input' },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute: (row) => {
    const c = num(row.conc)
    return { lgc: c != null && c > 0 ? r3(Math.log10(c)) : null }
  },
  fit: (rows) => {
    const pts = rows.map(r => {
      const c = num(r.conc), e = num(r.e)
      if (c == null || c <= 0 || e == null) return null
      return [Math.log10(c), e]
    }).filter(Boolean) as number[][]
    return linfitPts(pts)
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '方法依据', key: 'basis' },
    { label: '检出限', key: 'detectionLimit' },
  ],
  regression: true,
  curveCheck: true,
  signRoles: ['检验', '复核', '审核'],
  seed: () => [1, 2, 3, 4, 5].map((n, i) => ({
    no: n, conc: [0.05, 0.5, 1, 5, 10][i], e: '', note: '',
  })),
}

const titration: Schema = {
  id: 'titration',
  title: () => '容量测量原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 100 },
    { key: 'V', label: '取样量', unit: 'ml', kind: 'input' },
    { key: 'v1', label: '滴定初读V₁', unit: 'ml', kind: 'input', group: '滴定管读数' },
    { key: 'v2', label: '滴定终读V₂', unit: 'ml', kind: 'input', group: '滴定管读数' },
    { key: 'used', label: '消耗量', unit: 'ml', kind: 'auto', group: '滴定管读数' },
    { key: 'v0', label: '空白V₀', unit: 'ml', kind: 'input' },
    { key: 'rho', label: '样品浓度', unit: 'mg/L', kind: 'auto' },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute: (row, ctx) => {
    const v1 = num(row.v1), v2 = num(row.v2), v0 = num(row.v0) ?? 0, V = num(row.V)
    const C = num(ctx.meta.C) ?? 0.1, M = num(ctx.meta.M) ?? 8
    if (v1 == null || v2 == null) return { used: null, rho: null }
    const used = r3(v2 - v1)
    let rho: number | null = V ? r3((used - v0) * C * M * 1000 / V) : null
    if (rho != null && rho < 0) rho = 0
    return { used, rho }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true },
    { label: '标准溶液', key: 'stdName' },
    { label: '标液浓度C(mol/L)', key: 'C' },
    { label: '摩尔质量/当量M', key: 'M' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '方法依据', key: 'basis' },
    { label: '检出限', key: 'detectionLimit' },
  ],
  latex: '\\rho = \\dfrac{(V_1 - V_0)\\cdot C\\cdot M\\cdot 1000}{V}',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [
    { id: 'F260114-1', V: 50, v1: 0.0, v2: 12.4, v0: 0.2, note: '' },
    { id: 'F260114-2', V: 50, v1: 0.0, v2: 12.5, v0: 0.2, note: '平行样' },
  ],
}

const gravimetric: Schema = {
  id: 'gravimetric',
  title: () => '重量测量原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 100 },
    { key: 'V', label: '取样量', unit: 'ml', kind: 'input' },
    { key: 'w2', label: '容器空重W₂', unit: 'g', kind: 'input', group: '称重' },
    { key: 'w1', label: '容器+样W₁', unit: 'g', kind: 'input', group: '称重' },
    { key: 'wg', label: '样品重', unit: 'g', kind: 'auto', group: '称重' },
    { key: 'rho', label: '样品浓度', unit: 'mg/L', kind: 'auto' },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute: (row) => {
    const w1 = num(row.w1), w2 = num(row.w2), V = num(row.V)
    if (w1 == null || w2 == null) return { wg: null, rho: null }
    const wg = r4(w1 - w2)
    const rho = V ? r3(wg * 1e6 / V) : null
    return { wg, rho }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true },
    { label: '使用天平', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '方法依据', key: 'basis' },
    { label: '检出限', key: 'detectionLimit' },
  ],
  latex: '\\rho(\\text{mg/L}) = \\dfrac{(W_1 - W_2)\\times 10^6}{V}',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [
    { id: 'F260114-1', V: 500, w2: 45.2010, w1: 45.2380, note: '' },
    { id: 'F260114-2', V: 500, w2: 45.1980, w1: 45.2360, note: '平行样' },
  ],
}

const ic: Schema = {
  id: 'ic',
  title: () => '离子色谱法原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 100 },
    { key: 'V', label: '取样量', unit: 'ml', kind: 'input' },
    { key: 'D', label: '稀释倍数', kind: 'input' },
    { key: 'p0', label: '空白ρ₀', kind: 'input' },
    { key: 'p1', label: '样品ρ₁', kind: 'input' },
    { key: 'net', label: '扣空白', kind: 'auto' },
    { key: 'rho', label: '样品浓度', unit: 'mg/L', kind: 'auto' },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute: (row) => {
    const p1 = num(row.p1), p0 = num(row.p0) ?? 0, D = num(row.D) ?? 1
    if (p1 == null) return { net: null, rho: null }
    const net = r3(p1 - p0)
    return { net, rho: r3(net * D) }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '方法依据', key: 'basis' },
    { label: '检出限', key: 'detectionLimit' },
  ],
  latex: '\\rho = (\\rho_1 - \\rho_0)\\times D',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [
    { id: 'F260114-1', V: 10, D: 1, p0: 0.02, p1: 2.35, note: '' },
    { id: 'F260114-2', V: 10, D: 1, p0: 0.02, p1: 2.31, note: '平行样' },
  ],
}

const chromatographySample: Schema = {
  id: 'chromatographySample',
  title: () => '气相色谱法原始记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 100 },
    { key: 'vinj', label: '进样体积', unit: 'ml', kind: 'input' },
    { key: 'rt', label: '保留时间', unit: 'min', kind: 'input' },
    { key: 'area', label: '峰面积', kind: 'input' },
    { key: 'rho1', label: '曲线查得浓度ρ₁', kind: 'input' },
    { key: 'D', label: '稀释倍数', kind: 'input' },
    { key: 'rho', label: '样品浓度', unit: 'mg/m³', kind: 'auto' },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute: (row) => {
    const rho1 = num(row.rho1), D = num(row.D) ?? 1
    if (rho1 == null) return { rho: null }
    return { rho: r3(rho1 * D) }
  },
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '色谱柱', key: 'column' },
    { label: '柱温/检测器', key: 'detector' },
    { label: '方法依据', key: 'basis' },
    { label: '检出限', key: 'detectionLimit' },
  ],
  latex: '\\rho = \\rho_1 \\times D',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [
    { id: 'F260114-1', vinj: 1.0, rt: '', area: '', rho1: '', D: 1, note: '' },
  ],
}

const micro: Schema = {
  id: 'micro',
  title: () => '微生物检验原始记录表(平皿计数)',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 100 },
    { key: 'dil', label: '稀释倍数', kind: 'input' },
    { key: 'p1', label: '平皿1', unit: '个', kind: 'input', group: '菌落数' },
    { key: 'p2', label: '平皿2', unit: '个', kind: 'input', group: '菌落数' },
    { key: 'p3', label: '平皿3', unit: '个', kind: 'input', group: '菌落数' },
    { key: 'avg', label: '平均', kind: 'auto', group: '菌落数' },
    { key: 'result', label: '菌落总数', unit: 'CFU/mL', kind: 'auto' },
    { key: 'note', label: '备注', kind: 'input', w: 80 },
  ],
  compute: (row) => {
    const ps = ['p1', 'p2', 'p3'].map(k => num(row[k])).filter(v => v != null) as number[]
    if (!ps.length) return { avg: null, result: null }
    const avg = r3(ps.reduce((s, v) => s + v, 0) / ps.length)
    const dil = num(row.dil) ?? 1
    return { avg, result: r3(avg * dil) }
  },
  meta: [
    { label: '检验项目', key: 'analyte', fixed: true },
    { label: '培养温度/时间', key: 'culture' },
    { label: '设备编号', key: 'instrumentNo' },
    { label: '方法依据', key: 'basis' },
  ],
  latex: '\\text{菌落总数} = \\overline{N}\\times \\text{稀释倍数}',
  signRoles: ['检验', '复核', '审核'],
  seed: () => [
    { id: 'F260114-1', dil: 1, p1: 32, p2: 28, p3: 30, note: '' },
    { id: 'F260114-0', dil: 1, p1: 0, p2: 0, p3: 0, note: '空白' },
  ],
}

const noise: Schema = {
  id: 'noise',
  title: () => '噪声测量原始记录表',
  columns: [
    { key: 'point', label: '测点', kind: 'id', w: 80 },
    { key: 'time', label: '测量时间', kind: 'input', w: 90 },
    { key: 'src', label: '主要声源', kind: 'input', w: 90 },
    { key: 'l10', label: 'L10', unit: 'dB', kind: 'input' },
    { key: 'l50', label: 'L50', unit: 'dB', kind: 'input' },
    { key: 'l90', label: 'L90', unit: 'dB', kind: 'input' },
    { key: 'leq', label: 'Leq', unit: 'dB', kind: 'input' },
    { key: 'sd', label: '标准差', kind: 'auto' },
    { key: 'note', label: '备注', kind: 'input', w: 70 },
  ],
  compute: (row) => {
    const l10 = num(row.l10), l90 = num(row.l90)
    if (l10 == null || l90 == null) return { sd: null }
    return { sd: r3((l10 - l90) / 1.28) }
  },
  meta: [
    { label: '受检单位', key: 'client' },
    { label: '噪声仪型号/编号', key: 'instrument' },
    { label: '测量前校准值(dB)', key: 'cal0' },
    { label: '测量后校准值(dB)', key: 'cal1' },
    { label: '气象/风速', key: 'weather', wide: true },
  ],
  latex: 'SD = \\dfrac{L_{10} - L_{90}}{1.28}',
  signRoles: ['测量', '复核', '审核'],
  seed: () => [
    { point: '1#东', time: '10:00', src: '生产', l10: 58.2, l50: 54.1, l90: 50.3, leq: 55.6, note: '昼间' },
    { point: '2#南', time: '10:10', src: '生产', l10: 56.8, l50: 53.0, l90: 49.5, leq: 54.2, note: '昼间' },
  ],
}

const samplingWater: Schema = {
  id: 'samplingWater',
  title: () => '水质采样原始记录表',
  columns: [
    { key: 'point', label: '检测点位', kind: 'input', w: 130 },
    { key: 'time', label: '采样时间', kind: 'input', w: 100 },
    { key: 'id', label: '样品编号', kind: 'id', w: 100 },
    { key: 'items', label: '检测项目', kind: 'input', w: 140 },
    { key: 'vol', label: '采样体积', unit: 'ml', kind: 'input' },
    { key: 'preserve', label: '保存方法', kind: 'input', w: 120 },
    { key: 'ph', label: 'pH', kind: 'input' },
    { key: 'note', label: '样品描述', kind: 'input', w: 100 },
  ],
  meta: [
    { label: '受检单位', key: 'client' },
    { label: '采样器', key: 'sampler' },
    { label: '天气', key: 'weather' },
    { label: '采样日期', key: 'date' },
  ],
  signRoles: ['采样', '复核', '审核'],
  seed: () => [
    { point: '废水总排口 DW002', time: '08:30', id: 'F260114-1', items: 'COD·氨氮·总磷', vol: 1000, preserve: 'H₂SO₄ pH<2 冷藏', ph: '7.4', note: '无色无味' },
  ],
}

const handoff: Schema = {
  id: 'handoff',
  title: () => '样品交接记录表',
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 110 },
    { key: 'items', label: '检测项目', kind: 'input', w: 160 },
    { key: 'qty', label: '数量', unit: '个', kind: 'input' },
    { key: 'preserve', label: '保存方法', kind: 'input', w: 140 },
    { key: 'state', label: '样品状态', kind: 'input', w: 100 },
    { key: 'note', label: '备注', kind: 'input', w: 90 },
  ],
  meta: [
    { label: '受检单位', key: 'client' },
    { label: '采(送)样人', key: 'deliver' },
    { label: '收样人', key: 'receiver' },
    { label: '交接时间', key: 'date' },
  ],
  signRoles: ['采(送)样人', '收样人', '审核'],
  seed: () => [
    { id: 'F260114-1', items: 'COD·氨氮·总磷·pH·锰', qty: 1, preserve: '4℃冷藏', state: '完好', note: '' },
    { id: 'F260114-2', items: '质控平行', qty: 1, preserve: '4℃冷藏', state: '完好', note: '平行样' },
  ],
}

// 通用兜底（任何未匹配的表：可填数据网格 + 元数据 + 签名）
const generic: Schema = {
  id: 'generic',
  title: m => `${m || ''}原始记录表`,
  columns: [
    { key: 'id', label: '样品编号', kind: 'id', w: 110 },
    { key: 'V', label: '取样量', unit: 'ml', kind: 'input' },
    { key: 'reading', label: '测定值', kind: 'input' },
    { key: 'result', label: '结果', kind: 'input' },
    { key: 'note', label: '备注', kind: 'input', w: 100 },
  ],
  meta: [
    { label: '测量项目', key: 'analyte', fixed: true },
    { label: '测量方法', key: 'methodFull', wide: true },
    { label: '仪器型号', key: 'instrument' },
    { label: '仪器编号', key: 'instrumentNo' },
    { label: '方法依据', key: 'basis' },
    { label: '检出限', key: 'detectionLimit' },
  ],
  signRoles: ['检验', '复核', '审核'],
  seed: () => [
    { id: 'F260114-1', V: 50, reading: '', result: '', note: '' },
    { id: 'F260114-2', V: 50, reading: '', result: '', note: '平行样' },
  ],
}

// 冷原子吸收/原子荧光 测汞 校准曲线：无波长（测汞仪固定253.7nm）
const calibrationMercury: Schema = {
  ...calibration,
  id: 'calibrationMercury',
  meta: calibration.meta.filter(r => (r as any).key !== 'wavelength'),
}

// 火焰/石墨炉原子吸收 校准曲线：在波长后补"通带宽度""灯电流"两条仪器条件
const calibrationAAS: Schema = {
  ...calibration,
  id: 'calibrationAAS',
  meta: calibration.meta.flatMap(r => (r as any).key === 'wavelength'
    ? [r, { label: '通带宽度', key: 'slit' }, { label: '灯电流', key: 'lampCurrent' }]
    : [r]),
}

export function resolveSchema(sheetType: string, method: string, code?: string, methodFull?: string): Schema {
  if (code && FORMS[code]) return FORMS[code]
  if (sheetType === '校准曲线') {
    const mf = methodFull || ''
    if (mf.includes('色谱')) return calibrationChromatography       // 气相/离子/液相色谱：峰面积+保留时间
    if (mf.includes('电极')) return calibrationElectrode            // 离子选择电极：E~lg(ρ) 半对数
    if (mf.includes('汞') && mf.includes('原子')) return calibrationMercury  // 冷原子吸收/荧光测汞：无波长
    if ((mf.includes('原子吸收') || mf.includes('火焰') || mf.includes('石墨炉')) && !mf.includes('荧光'))
      return calibrationAAS                                        // 火焰/石墨炉原吸：补通带宽度+灯电流
    return calibration                                             // 默认：分光光度 吸光度法
  }
  if (sheetType === '样品交接') return handoff
  if (sheetType === '采样记录') return samplingWater
  if (sheetType === '原始记录' || sheetType === '前处理') {
    if (['分光光度', '原子吸收', '原子荧光'].includes(method)) return photometric
    if (method === '容量滴定') return titration
    if (method === '重量法') return gravimetric
    if (method.includes('色谱')) return method === '离子色谱' ? ic : chromatographySample
    if (method === '微生物') return micro
    if (method === '声级') return noise
  }
  if (method === '声级') return noise
  return generic
}
