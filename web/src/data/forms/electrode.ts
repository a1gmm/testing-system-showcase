import type { Schema } from '../schemas'

// 0063.pdf HJ-TC-066：离子选择电极法测量原始记录表(地表水氟化物)。
// 顶部采样日期 → 逐行数据表(样品编号/取样量V1/定容体积V/稀释倍数k/电位值E/浓度ρ/备注) → 方法/仪器/公式/依据 kv 页脚
export const electrodeSurfaceWaterF: Schema = {
  id: 'electrodeSurfaceWaterF',
  title: () => '离子选择电极法测量原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 1, rows: [
      { label: '采样日期', key: 'sampleDate' },
    ] },
    { type: 'table', id: 'data', seedRows: 10, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'v1', label: '取样量V₁', unit: 'ml', kind: 'input' },
      { key: 'vf', label: '定容体积V', unit: 'ml', kind: 'input' },
      { key: 'k', label: '稀释倍数k', kind: 'input' },
      { key: 'e', label: '测定电位值E', unit: 'mV', kind: 'input' },
      { key: 'rho', label: '样品浓度ρ', unit: 'mg/L', kind: 'input' },
      { key: 'note', label: '备注', kind: 'input', w: 90 },
    ] },
    { type: 'kv', id: 'method', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true, value: '氟化物' },
      { label: '仪器型号', key: 'instrument', fixed: true, value: 'PXJ-1B型数字式离子计' },
      { label: '仪器编号', key: 'instrumentNo', fixed: true, value: 'TC-016' },
      { label: '计算公式', key: 'formula', fixed: true, value: 'ρ（mg/L）=logcF⁻' },
      { label: '测量方法', key: 'methodFull', fixed: true, value: '水质 氟化物的测定 离子选择电极法', colspan: 2 },
      { label: '回归方程', key: 'regression' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'GB/T 7484-1987' },
      { label: '电极斜率', key: 'slope' },
      { label: 'E空白(mv)', key: 'eBlank' },
      { label: '检出限', key: 'detectionLimit', fixed: true, value: '0.05mg/L' },
    ] },
  ],
}

// 0066.pdf HJ-TC-068：离子选择电极法测量原始记录表(地下水氟化物)。与地表水版式一致，质控编号列+不同方法依据/检出限
export const electrodeGroundWaterF: Schema = {
  id: 'electrodeGroundWaterF',
  title: () => '离子选择电极法测量原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 1, rows: [
      { label: '采样日期', key: 'sampleDate' },
    ] },
    { type: 'table', id: 'data', seedRows: 10, columns: [
      { key: 'id', label: '质控编号', kind: 'id', w: 100 },
      { key: 'v1', label: '取样量V', unit: 'ml', kind: 'input' },
      { key: 'vf', label: '定容体积V', unit: 'ml', kind: 'input' },
      { key: 'k', label: '稀释倍数k', kind: 'input' },
      { key: 'e', label: '测定电位值E', unit: 'mV', kind: 'input' },
      { key: 'rho', label: '样品浓度ρ', unit: 'mg/L', kind: 'input' },
      { key: 'note', label: '备注', kind: 'input', w: 90 },
    ] },
    { type: 'kv', id: 'method', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true, value: '氟化物' },
      { label: '仪器型号', key: 'instrument', fixed: true, value: 'PXJ-1B型数字式离子计' },
      { label: '仪器编号', key: 'instrumentNo', fixed: true, value: 'TC-016' },
      { label: '计算公式', key: 'formula', fixed: true, value: 'ρ（mg/L）=logcF⁻' },
      { label: '测量方法', key: 'methodFull', fixed: true, value: '生活饮用水标准检验方法无机非金属指标（3.1）离子选择电极法', colspan: 2 },
      { label: '回归方程', key: 'regression' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'GB/T 5750.5-2006' },
      { label: '电极斜率', key: 'slope' },
      { label: 'E空白(mv)', key: 'eBlank' },
      { label: '检出限', key: 'detectionLimit', fixed: true, value: '0.2mg/L' },
    ] },
  ],
}

// 0047.pdf HJ-TC-056：环境空气离子选择电极法测量原始记录表(滤膜采样氟离子选择电极法)。
// 无采样日期抬头行外的其他抬头；表体含标况采样体积Vn(m³)
export const electrodeAirF: Schema = {
  id: 'electrodeAirF',
  title: () => '环境空气离子选择电极法测量原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 1, rows: [
      { label: '采样日期', key: 'sampleDate' },
    ] },
    { type: 'table', id: 'data', seedRows: 10, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'vn', label: '标况下采样体积Vn', unit: 'm³', kind: 'input' },
      { key: 'v1', label: '定容体积V₁', unit: 'ml', kind: 'input' },
      { key: 'v2', label: '取样量V₂', unit: 'ml', kind: 'input' },
      { key: 'e', label: '测定电位值E', unit: 'mV', kind: 'input' },
      { key: 'rho', label: '样品浓度', unit: 'ug/m³', kind: 'input' },
      { key: 'note', label: '备注', kind: 'input', w: 90 },
    ] },
    { type: 'kv', id: 'method', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true, value: '氟化物' },
      { label: '仪器型号', key: 'instrument', fixed: true, value: 'PXJ-1B型数字式离子计' },
      { label: '仪器编号', key: 'instrumentNo', fixed: true, value: 'TC-014' },
      { label: '计算公式', key: 'formula' },
      { label: '测量方法', key: 'methodFull', fixed: true, value: '环境空气 氟化物的测定 滤膜采样氟离子选择电极法', colspan: 2 },
      { label: '方法依据', key: 'basis', fixed: true, value: 'HJ955-2018' },
      { label: '检出限', key: 'detectionLimit', fixed: true, value: '0.5ug/m3' },
      { label: '电极斜率', key: 'slope' },
    ] },
  ],
}

// 0131.pdf HJ-TC-128：废气离子选择电极法测量原始记录表。无采样日期抬头；宽表体(标况采样体积/标杆流量/…/
// 绝对量W1(气氟·尘氟分组)/结果/结果和/结果和平均值/折算浓度/排放速率/排放速率平均值) → 方法+双行计算公式 kv 页脚
export const electrodeWasteGasF: Schema = {
  id: 'electrodeWasteGasF',
  title: () => '废气离子选择电极法测量原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'table', id: 'data', seedRows: 10, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 70 },
      { key: 'vn', label: '标况下采样体积Vn', unit: 'L', kind: 'input' },
      { key: 'flow', label: '标杆流量', unit: 'Ndm³/h', kind: 'input' },
      { key: 'v1', label: '定容体积V₁', unit: 'ml', kind: 'input' },
      { key: 'v2', label: '取样量V₂', unit: 'ml', kind: 'input' },
      { key: 'e', label: '测定电位值E', unit: 'mV', kind: 'input' },
      { key: 'w1gas', label: '气氟', unit: 'ug', kind: 'input', group: '绝对量W₁' },
      { key: 'w1dust', label: '尘氟', unit: 'ug', kind: 'input', group: '绝对量W₁' },
      { key: 'result', label: '结果', unit: 'mg/m³', kind: 'input' },
      { key: 'resultSum', label: '结果和', unit: 'mg/m³', kind: 'input' },
      { key: 'resultAvg', label: '结果和平均值', unit: 'mg/m³', kind: 'input' },
      { key: 'conv', label: '折算浓度', unit: 'mg/m³', kind: 'input' },
      { key: 'rate', label: '排放速率', unit: 'kg/h', kind: 'input' },
      { key: 'rateAvg', label: '排放速率平均值', unit: 'kg/h', kind: 'input' },
    ] },
    { type: 'kv', id: 'method', cols: 2, rows: [
      { label: '测量项目', key: 'analyte', fixed: true, value: '氟化物' },
      { label: '仪器型号', key: 'instrument', fixed: true, value: 'PXJ-1B数字式离子计' },
      { label: '仪器编号', key: 'instrumentNo', fixed: true, value: 'TC-016' },
      { label: '回归方程a', key: 'regA' },
      { label: '回归方程b', key: 'regB' },
      { label: '测量方法', key: 'methodFull', fixed: true, value: '大气固定污染物 氟离子的测定 离子选择电极法', colspan: 2 },
      { label: '计算公式(气态氟)', key: 'formulaGas', fixed: true, colspan: 2,
        value: 'c=（W样-W空白+5）×Vt/Va/Vnd；W样/空白=10^((E-a)/b)；排放速率=c结果和×标干烟气量/10⁶' },
      { label: '计算公式(尘氟)', key: 'formulaDust', fixed: true, colspan: 2,
        value: 'c=(W样-W空白)×Vt/Va/Vnd；W空白=(W空白1+W空白2)/2；W样/空白1/空白2=10^((E-a)/b)' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'HJ/T67-2001' },
      { label: '电极斜率', key: 'slope' },
      { label: '检出限', key: 'detectionLimit', fixed: true, value: '6×10⁻²mg/m³' },
      { label: '折算系数', key: 'convFactor' },
    ] },
  ],
}

export const electrodeForms: Record<string, Schema> = {
  'HJ-TC-066': electrodeSurfaceWaterF,
  'HJ-TC-068': electrodeGroundWaterF,
  'HJ-TC-056': electrodeAirF,
  'HJ-TC-128': electrodeWasteGasF,
}
