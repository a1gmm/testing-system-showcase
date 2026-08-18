import type { Schema } from '../schemas'

// ============ HJ-TC-651 硫代硫酸钠标准溶液标定记录（0368.pdf）============
// kv(标定日期/标定人/碘酸钾溶液用量与浓度) → matrix(项目×编号1/2: V1/V2/V/标定浓度测量值, 公式c=6×20×1.66/V)
// → kv(硫代硫酸钠溶液浓度, 最终定值)
export const thiosulfateCalib651: Schema = {
  id: 'thiosulfateCalib651',
  title: () => '硫代硫酸钠标准溶液标定记录',
  columns: [], meta: [], signRoles: ['标定', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 1, rows: [
      { label: '标定日期', key: 'date' },
      { label: '标定人', key: 'operator' },
      { label: '碘酸钾溶液用量（ml）', key: 'kio3Vol' },
      { label: '碘酸钾溶液浓度（mmol/L）', key: 'kio3Conc' },
    ] },
    { type: 'matrix', id: 'grid', transpose: true,
      rowHeaders: [
        { label: '滴定管起始读数V1（ml）', key: 'v1', kind: 'input' },
        { label: '滴定管终点读数V2（ml）', key: 'v2', kind: 'input' },
        { label: '滴定液消耗体积V（ml）', key: 'v', kind: 'auto' },
        { label: '标定浓度测量值 (mmol/L)', key: 'measured', kind: 'auto' },
      ],
      colHeaders: [ { label: '1', key: 'c1' }, { label: '2', key: 'c2' } ],
      cellKind: 'input', note: '计算公式：c = 6×20×1.66 / V' },
    { type: 'kv', id: 'result', cols: 1, rows: [
      { label: '硫代硫酸钠溶液浓度( mmol/L)', key: 'finalConc' },
    ] },
  ],
}

// ============ HJ-TC-652 硫代硫酸钠标准溶液标定记录（0369.pdf）============
// 与 HJ-TC-651 同版式，单位换为 mol/L，原件计算公式框内容为空（仅印 "C =" ）
export const thiosulfateCalib652: Schema = {
  id: 'thiosulfateCalib652',
  title: () => '硫代硫酸钠标准溶液标定记录',
  columns: [], meta: [], signRoles: ['标定', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 1, rows: [
      { label: '标定日期', key: 'date' },
      { label: '标定人', key: 'operator' },
      { label: '碘酸钾溶液用量（ml）', key: 'kio3Vol' },
      { label: '碘酸钾溶液浓度（mol/L）', key: 'kio3Conc' },
    ] },
    { type: 'matrix', id: 'grid', transpose: true,
      rowHeaders: [
        { label: '滴定管起始读数V1（ml）', key: 'v1', kind: 'input' },
        { label: '滴定管终点读数V2（ml）', key: 'v2', kind: 'input' },
        { label: '滴定液消耗体积V（ml）', key: 'v', kind: 'auto' },
        { label: '标定浓度测量值 ( mol/L)', key: 'measured', kind: 'auto' },
      ],
      colHeaders: [ { label: '1', key: 'c1' }, { label: '2', key: 'c2' } ],
      cellKind: 'input', note: '计算公式： C =（原件公式框未印具体系数）' },
    { type: 'kv', id: 'result', cols: 1, rows: [
      { label: '硫代硫酸钠溶液浓度( mol/L)', key: 'finalConc' },
    ] },
  ],
}

// ============ HJ-TC-660 溶液配制记录（0374.pdf）============
// kv(溶液名称/浓度, 配置日期/有效期, 配制总量/配制人, 方法依据全宽) → note(配制方法, 大空白区)
export const solutionPrep660: Schema = {
  id: 'solutionPrep660',
  title: () => '溶液配制记录',
  columns: [], meta: [], signRoles: ['配制', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '溶液名称', key: 'name' }, { label: '溶液浓度', key: 'conc' },
      { label: '配置日期', key: 'date' }, { label: '有效期', key: 'expiry' },
      { label: '配制总量', key: 'amount' }, { label: '配制人', key: 'operator' },
      { label: '方法依据', key: 'basis', colspan: 2 },
    ] },
    { type: 'note', id: 'method', label: '配制方法：', key: 'method', rows: 5 },
  ],
}

// ============ HJ-TC-106 标准物质稀释记录（0105.pdf, 原件页眉印 QTCYT/JL106）============
// kv(标准物质名称及编号全宽, 稀释前/后浓度, 稀释时间/稀释人, 使用介质/有效期) → note(稀释方法, 大空白区)
export const refMaterialDilution106: Schema = {
  id: 'refMaterialDilution106',
  title: () => '标准物质稀释记录',
  columns: [], meta: [], signRoles: ['稀释', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '标准物质名称及编号', key: 'name', colspan: 2 },
      { label: '稀释前浓度', key: 'before' }, { label: '稀释后浓度', key: 'after' },
      { label: '稀释时间', key: 'time' }, { label: '稀释人', key: 'operator' },
      { label: '使用介质', key: 'medium' }, { label: '有效期', key: 'expiry' },
    ] },
    { type: 'note', id: 'method', label: '稀释方法：', key: 'method', rows: 5 },
  ],
}

// ============ HJ-TC-103 化学需氧量(CODcr)测量原始记录表（0100.pdf）============
// table(样品编号/氯化物浓度/取样量/重铬酸钾加入量/稀释倍数/[硫酸亚铁铵消耗量组:空白V0/样品V1/V0-V1]/CODcr浓度/备注)
// → kv(硫酸亚铁铵浓度/重铬酸钾浓度/计算公式(定值)/式中定义(定值)/方法依据(定值)/测量方法(定值)/检出限(定值)/空白1/空白2/空白平均值V0/测量日期)
export const codCr103: Schema = {
  id: 'codCr103',
  title: () => '化学需氧量（CODcr）测量原始记录表',
  columns: [], meta: [], signRoles: ['检验', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'table', id: 'main', seedRows: 10, columns: [
      { key: 'no', label: '样品编号', kind: 'id', w: 110 },
      { key: 'cl', label: '氯化物浓度ρ', unit: 'mg/L', kind: 'input' },
      { key: 'V', label: '取样量V', unit: 'ml', kind: 'input' },
      { key: 'k2cr2o7', label: '重铬酸钾加入量', unit: 'ml', kind: 'input' },
      { key: 'f', label: '稀释倍数(f)', kind: 'input' },
      { key: 'v0', label: '空白(V0)', unit: 'ml', kind: 'input', group: '硫酸亚铁铵溶液消耗量(ml)' },
      { key: 'v1', label: '样品(V1)', unit: 'ml', kind: 'input', group: '硫酸亚铁铵溶液消耗量(ml)' },
      { key: 'vdiff', label: 'V0－V1', unit: 'ml', kind: 'auto', group: '硫酸亚铁铵溶液消耗量(ml)' },
      { key: 'rho', label: 'CODcr浓度ρ', unit: 'mg/L', kind: 'auto' },
      { key: 'note', label: '备注', kind: 'input', w: 90 },
    ] },
    { type: 'kv', id: 'params', cols: 2, rows: [
      { label: '硫酸亚铁铵标准溶液的浓度(mol/L)', key: 'C' },
      { label: '重铬酸钾浓度(mol/L)', key: 'k2cr2o7Conc' },
      { label: '计算公式', key: 'formula', fixed: true, value: 'ρ (mg/L) = C×(V0－V1)×8000×f / V', colspan: 2 },
      { label: '式中', key: 'formulaNote', fixed: true, colspan: 2,
        value: 'C—硫酸亚铁铵标准溶液的浓度(mol/L)；V1—样品消耗硫酸亚铁铵体积(ml)；V0—空白消耗硫酸亚铁铵体积(ml)；V—水样的体积；f—样品稀释倍数' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'HJ828-2017' },
      { label: '检出限', key: 'detectionLimit', fixed: true, value: '4mg/L' },
      { label: '测量方法', key: 'method', fixed: true, colspan: 2, value: '水质 化学需氧量的测定 重铬酸盐法' },
      { label: '空白1', key: 'blank1', colspan: 1 }, { label: '空白2', key: 'blank2', colspan: 1 },
      { label: '空白平均值V0', key: 'blankAvg' }, { label: '测量日期', key: 'date' },
    ] },
  ],
}

export const solutionPrepForms: Record<string, Schema> = {
  'HJ-TC-651': thiosulfateCalib651,
  'HJ-TC-652': thiosulfateCalib652,
  'HJ-TC-660': solutionPrep660,
  'HJ-TC-106': refMaterialDilution106,
  'HJ-TC-103': codCr103,
}
