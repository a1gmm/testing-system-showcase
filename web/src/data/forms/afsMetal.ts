import type { Schema } from '../schemas'

// HJ694-2014 水质 汞、砷、硒、铋和锑的测定 原子荧光法 原始记录表
// 共用版式：负高压/灯电流/检出限/测量项目按各表自己的 meta 显示（表1参考测量条件）
// 结果按公式(1) ρ=ρ₁×f×V₁/V 自动换算，单位 μg/L
function n(v: any): number | null { const x = parseFloat(v); return isFinite(x) ? x : null }

const afsMetal: Schema = {
  id: 'afsMetal',
  title: () => '水质 汞、砷、硒、铋和锑的测定 原子荧光法 原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'],
  seed: () => [],
  compute(row: Record<string, any>) {
    const rho1 = n(row.rho1), f = n(row.f) ?? 1, v1 = n(row.v1), v = n(row.v)
    if (rho1 == null || v1 == null || v == null || v === 0) return { rho: null }
    const rho = (rho1 * f * v1) / v // μg/L
    return { rho: Math.round(rho * 1000) / 1000 }
  },
  layout: [
    { type: 'table', id: 'tbl', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'v', label: '分取体积V', unit: 'mL', kind: 'input', w: 70 },
      { key: 'v1', label: '定容体积V₁', unit: 'mL', kind: 'input', w: 70 },
      { key: 'f', label: '稀释倍数f', kind: 'input', w: 60 },
      { key: 'ifb', label: '空白荧光', kind: 'input', group: '原子荧光强度If', w: 80 },
      { key: 'ifs', label: '样品荧光', kind: 'input', group: '原子荧光强度If', w: 80 },
      { key: 'rho1', label: '曲线查得浓度ρ₁', unit: 'μg/L', kind: 'input', w: 110 },
      { key: 'rho', label: '结果ρ', unit: 'μg/L', kind: 'auto', w: 90 },
      { key: 'note', label: '备注', kind: 'input', w: 70 },
    ] },
    { type: 'kv', id: 'meta', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true },
      { label: '测量方法', key: 'methodFull', fixed: true, colspan: 2 },
      { label: '仪器型号', key: 'instrument' },
      { label: '仪器编号', key: 'instrumentNo' },
      { label: '负高压', key: 'negHV', fixed: true },
      { label: '灯电流', key: 'lampCurrent', fixed: true },
      { label: '方法依据', key: 'basis', fixed: true },
      { label: '检出限', key: 'detectionLimit', fixed: true },
      { label: '计算公式', key: 'formula', colspan: 2, latex: '\\rho\\,(\\mu g/L)=\\dfrac{\\rho_1\\times f\\times V_1}{V}' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'ρ₁—由校准曲线查得的试样中待测元素质量浓度(μg/L)；f—试样稀释倍数；V₁—分取后测定试样的定容体积(mL)；V—分取试样的体积(mL)。原子化器温度200℃、载气流量400mL/min、屏蔽气900~1000mL/min、积分方式峰面积。结果表示：汞<1μg/L保留2位小数、>1μg/L保留3位有效数字；砷/硒/锑<10μg/L保留1位小数、>10μg/L保留3位有效数字。' },
    ] },
  ],
}

export const afsMetalForms: Record<string, Schema> = {
  'HJ-TC-577': afsMetal, // 汞·水质
  'HJ-TC-578': afsMetal, // 砷·水质
  'HJ-TC-579': afsMetal, // 硒·水质
  'HJ-TC-580': afsMetal, // 锑·水质
}
