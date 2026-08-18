import type { Schema } from '../schemas'

// HJ491-2019 土壤和沉积物 铜/锌/铅/镍/铬 火焰原子吸收分光光度法 原始记录表
// 共用版式：波长/狭缝/检出限/测量项目等按各表自己的 meta 显示；补齐原表缺的 取样量m/干物质含量Wdm/样品含量(mg/kg)自动换算
function n(v: any): number | null { const x = parseFloat(v); return isFinite(x) ? x : null }

const soilMetalAAS: Schema = {
  id: 'soilMetalAAS',
  title: () => '土壤和沉积物 金属元素的测定 火焰原子吸收分光光度法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'],
  seed: () => [],
  compute(row: Record<string, any>) {
    const rho = n(row.rho), v = n(row.vdef), d = n(row.d) ?? 1, m = n(row.m), wdm = n(row.wdm)
    if (rho == null || v == null || m == null || m === 0 || wdm == null || wdm === 0) return { w: null }
    const w = (rho * v * d) / (m * (wdm / 100)) // mg/L×mL/g = mg/kg，再按干物质率折干基
    return { w: Math.round(w * 100) / 100 }
  },
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 90 },
      { key: 'm', label: '取样量m', unit: 'g', kind: 'input', w: 70 },
      { key: 'vdef', label: '定容体积V', unit: 'mL', kind: 'input', w: 70 },
      { key: 'd', label: '稀释倍数D', kind: 'input', w: 60 },
      { key: 'a0', label: '空白A₀', kind: 'input', group: '信号值', w: 60 },
      { key: 'a', label: '信号值A', kind: 'input', group: '信号值', w: 60 },
      { key: 'rho', label: '样品浓度ρ', unit: 'mg/L', kind: 'input', w: 80 },
      { key: 'wdm', label: '干物质含量Wdm', unit: '%', kind: 'input', w: 80 },
      { key: 'w', label: '样品含量', unit: 'mg/kg', kind: 'auto', w: 80 },
      { key: 'note', label: '备注', kind: 'input', w: 70 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true },
      { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
      { label: '仪器型号', key: 'instrument' },
      { label: '仪器编号', key: 'instrumentNo' },
      { label: '测定波长', key: 'wavelength', fixed: true },
      { label: '狭缝', key: 'slit', fixed: true },
      { label: '方法依据', key: 'basis', fixed: true },
      { label: '检出限', key: 'detectionLimit', fixed: true },
      { label: '计算公式', key: 'formula', colspan: 2, latex: 'w\\,(mg/kg)=\\dfrac{\\rho\\times V\\times D}{m\\times W_{dm}}' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'ρ—由校准曲线查得的试液浓度(mg/L)；V—定容体积(mL)；D—稀释倍数；m—取样量(g)；Wdm—干物质含量(%)' },
    ] },
  ],
}

export const soilMetalForms: Record<string, Schema> = {
  'HJ-TC-029': soilMetalAAS,
  'HJ-TC-407': soilMetalAAS,
  'HJ-TC-409': soilMetalAAS,
  'HJ-TC-411': soilMetalAAS,
  'HJ-TC-413': soilMetalAAS,
  'HJ-TC-581': soilMetalAAS, // 六价铬·土壤 火焰AAS HJ1082
}
