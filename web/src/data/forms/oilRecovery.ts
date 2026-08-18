import type { Schema } from '../schemas'

// 四张表共用的抬头：检测目的(勾选) + 检测日期/天气状况/环境温度/大气压(同一行四联)
const headerRows = [
  { label: '检测目的', checks: ['验收', '抽查', '年度检查'], checksKey: 'purpose', colspan: 4 },
  { label: '检测日期', key: 'date' },
  { label: '天气状况', key: 'weather' },
  { label: '环境温度（℃）', key: 'temp' },
  { label: '大气压（kPa）', key: 'pressure' },
]

// 0337.pdf：密闭性原始记录表。抬头 + 连通/处理装置勾选 + 回收系统勾选 + 检测设备 +
// 油罐1-4/连通油罐 × (标号/容积/体积/空间/初始压力/1-5min压力/剩余最小压力限值) 转置矩阵 + 结论 + 备注
export const tightness: Schema = {
  id: 'oilRecoveryTightness',
  title: () => '密闭性原始记录表',
  columns: [], meta: [], signRoles: ['检测', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 4, rows: headerRows },
    { type: 'kv', id: 'site', cols: 1, rows: [
      { label: '加油站名称', key: 'org' },
      { label: '加油站地址', key: 'addr' },
    ] },
    { type: 'kv', id: 'basis', cols: 1, rows: [
      { label: '检测依据', checks: ['GB20952-2020加油站大气污染物排放标准', '其他'], checksKey: 'basis' },
    ] },
    { type: 'kv', id: 'linkage', cols: 2, rows: [
      { label: '各油罐油气管线是否连通', checks: ['是', '否'], checksKey: 'pipeLinked' },
      { label: '是否有油气处理装置', checks: ['是', '否'], checksKey: 'hasTreatment' },
    ] },
    { type: 'checks', id: 'system', label: '加油油气回收系统', key: 'recoverySystem', options: ['集中式真空辅助平衡式', '分散式真空辅助平衡式'] },
    { type: 'kv', id: 'device', cols: 2, rows: [
      { label: '检测设备名称', key: 'device', fixed: true, value: '油气回收多参数检测仪' },
      { label: '检测设备型号/编号', key: 'deviceNo', fixed: true, value: '崂应7003型/TC-203' },
    ] },
    { type: 'matrix', id: 'tanks', transpose: true,
      rowHeaders: [
        { label: '汽油标号', key: 'grade', kind: 'input' },
        { label: '油罐容积（L）', key: 'tankVol', kind: 'input' },
        { label: '汽油体积（L）', key: 'gasVol', kind: 'input' },
        { label: '油气空间（L）', key: 'vaporSpace', kind: 'input' },
        { label: '初始压力（Pa）', key: 'p0', kind: 'const', value: '500' },
        { label: '1min之后的压力（Pa）', key: 'p1', kind: 'input' },
        { label: '2min之后的压力（Pa）', key: 'p2', kind: 'input' },
        { label: '3min之后的压力（Pa）', key: 'p3', kind: 'input' },
        { label: '4min之后的压力（Pa）', key: 'p4', kind: 'input' },
        { label: '5min之后的压力（Pa）', key: 'p5', kind: 'input' },
        { label: '剩余最小压力限值（Pa）', key: 'pMin', kind: 'input' },
      ],
      colHeaders: [
        { label: '1', key: 'c1' }, { label: '2', key: 'c2' }, { label: '3', key: 'c3' }, { label: '4', key: 'c4' },
        { label: '连通油罐', key: 'cLink' },
      ],
      cellKind: 'input',
      note: '原件"连通油罐"列：汽油标号处填"——"；初始压力各油罐及连通油罐均定值500Pa',
    },
    { type: 'kv', id: 'conclusion', cols: 1, rows: [
      { label: '密闭性检测结果（符合GB 20952-2020加油站大气污染物排放标准的要求）', checks: ['是', '否'], checksKey: 'result' },
    ] },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 1 },
  ],
}

// 0335.pdf：气液比检测原始记录。抬头 + 检测设备 + 加油机/枪 × 品牌/档位/加油体积/回收油气体积/气液比 表格 +
// 标准要求值(定值1.00~1.20) + 结论 + 备注
export const gasLiquidRatio: Schema = {
  id: 'oilRecoveryGasLiquidRatio',
  title: () => '气液比检测原始记录',
  columns: [], meta: [], signRoles: ['检测', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 4, rows: headerRows },
    { type: 'kv', id: 'site', cols: 1, rows: [
      { label: '加油站名称', key: 'org' },
      { label: '加油站地址', key: 'addr' },
    ] },
    { type: 'kv', id: 'basis', cols: 1, rows: [
      { label: '检测依据', checks: ['GB20952-2020加油站大气污染物排放标准', '其他'], checksKey: 'basis' },
    ] },
    { type: 'kv', id: 'device', cols: 2, rows: [
      { label: '检测设备名称', key: 'device', fixed: true, value: '油气回收多参数检测仪' },
      { label: '检测设备型号/编号', key: 'deviceNo', fixed: true, value: '崂应7003型/TC-203' },
    ] },
    { type: 'table', id: 'data', seedRows: 13, columns: [
      { key: 'pumpNo', label: '加油机编号', kind: 'id', w: 90 },
      { key: 'gunNo', label: '加油枪编号', kind: 'input', w: 90 },
      { key: 'brand', label: '加油枪品牌', kind: 'input', w: 100 },
      { key: 'gear', label: '档位', kind: 'input', w: 70 },
      { key: 'fuelVol', label: '加油体积', unit: 'L', kind: 'input' },
      { key: 'vaporVol', label: '回收油气体积', unit: 'L', kind: 'input' },
      { key: 'ratio', label: '气液比', kind: 'input' },
    ] },
    { type: 'kv', id: 'std', cols: 1, rows: [
      { label: '标准要求值（气液比）', key: 'stdReq', fixed: true, value: '1.00~1.20' },
    ] },
    { type: 'kv', id: 'conclusion', cols: 1, rows: [
      { label: '气液比检测结果（符合GB 20952-2020加油站大气污染物排放标准的要求）', checks: ['是', '否'], checksKey: 'result' },
    ] },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 1 },
  ],
}

// 0336.pdf：液阻检测原始记录表。抬头 + 检测设备 + 氮气流量18/28/38L/min(限值40/90/155Pa) ×
// 加油机编号/品牌型号 液阻压力 表格 + 结论 + 备注
export const liquidResistance: Schema = {
  id: 'oilRecoveryLiquidResistance',
  title: () => '液阻检测原始记录表',
  columns: [], meta: [], signRoles: ['检测', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 4, rows: headerRows },
    { type: 'kv', id: 'site', cols: 1, rows: [
      { label: '加油站名称', key: 'org' },
      { label: '加油站地址', key: 'addr' },
    ] },
    { type: 'kv', id: 'basis', cols: 1, rows: [
      { label: '检测依据', checks: ['GB20952-2020加油站大气污染物排放标准', '其他'], checksKey: 'basis' },
    ] },
    { type: 'kv', id: 'device', cols: 2, rows: [
      { label: '检测设备名称', key: 'device', fixed: true, value: '油气回收多参数检测仪' },
      { label: '检测设备型号/编号', key: 'deviceNo', fixed: true, value: '崂应7003型/TC-203' },
    ] },
    { type: 'table', id: 'data', seedRows: 11, columns: [
      { key: 'pumpNo', label: '加油机编号', kind: 'id', w: 90 },
      { key: 'brandModel', label: '加油机品牌/型号', kind: 'input', w: 130 },
      { key: 'p18', label: '氮气流量18.0 L/min（限值≤40）', unit: 'Pa', kind: 'input', group: '液阻压力（Pa）' },
      { key: 'p28', label: '氮气流量28.0 L/min（限值≤90）', unit: 'Pa', kind: 'input', group: '液阻压力（Pa）' },
      { key: 'p38', label: '氮气流量38.0 L/min（限值≤155）', unit: 'Pa', kind: 'input', group: '液阻压力（Pa）' },
    ] },
    { type: 'kv', id: 'conclusion', cols: 1, rows: [
      { label: '液阻检测结果（符合GB20952-2020加油站大气污染物排放标准的要求）', checks: ['是', '否'], checksKey: 'result' },
    ] },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 1 },
  ],
}

// 0338.pdf：油气回收系统密闭点位油气泄露原始记录。抬头(检测依据为HJ 733-2014) + 检测设备 +
// 编号/点位/泄露浓度/是否达标 表格 + 标准限值(定值≤500ppm) + 备注(无独立"结论"勾选行)
export const gasLeak: Schema = {
  id: 'oilRecoveryGasLeak',
  title: () => '油气回收系统密闭点位油气泄露原始记录',
  columns: [], meta: [], signRoles: ['检测', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 4, rows: headerRows },
    { type: 'kv', id: 'site', cols: 1, rows: [
      { label: '加油站名称', key: 'org' },
      { label: '加油站地址', key: 'addr' },
    ] },
    { type: 'kv', id: 'basis', cols: 1, rows: [
      { label: '检测依据', checks: ['HJ 733-2014 泄漏和敞开液面排放的挥发性有机物检测技术导则', '其他'], checksKey: 'basis' },
    ] },
    { type: 'kv', id: 'device', cols: 2, rows: [
      { label: '检测设备名称', key: 'device', fixed: true, value: '挥发性有机气体检测仪' },
      { label: '检测设备型号/编号', key: 'deviceNo', fixed: true, value: '崂应3033/TC-204' },
    ] },
    { type: 'table', id: 'data', seedRows: 12, columns: [
      { key: 'no', label: '编号', kind: 'id', w: 70 },
      { key: 'point', label: '点位', kind: 'input', w: 160 },
      { key: 'conc', label: '泄露浓度', unit: 'ppm', kind: 'input' },
      { key: 'pass', label: '是否达标（是/否）', kind: 'input', w: 110 },
    ] },
    { type: 'kv', id: 'std', cols: 1, rows: [
      { label: '标准限值', key: 'stdLimit', fixed: true, value: '≤500ppm' },
    ] },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 1 },
  ],
}

export const oilRecoveryForms: Record<string, Schema> = {
  'HJ-TC-606': tightness,
  'HJ-TC-603': gasLiquidRatio,
  'HJ-TC-604': liquidResistance,
  'HJ-TC-607': gasLeak,
}
