import type { Schema, Col } from '../schemas'

// ============ 嗅辨/臭气/感官 家族（1:1 还原自 web/public/sheets/ 原件 PDF）============

// —— 共用：嗅和味/臭/肉眼可见物 系列的数据表列（0191/0225/0357/0367/0192.pdf 一致） ——
const smellTasteCols: Col[] = [
  { key: 'id', label: '样品编号', kind: 'id', w: 110 },
  { key: 'V', label: '取样体积V', unit: 'ml', kind: 'input' },
  { key: 'result', label: '结果', kind: 'input', w: 220 },
  { key: 'note', label: '备注', kind: 'input', w: 110 },
]
const smellTasteSeed = () => Array.from({ length: 8 }, () => ({ id: '', V: '', result: '', note: '' }))

// —— 共用：漂浮物质（0226.pdf，无 取样体积V 列） ——
const floatingCols: Col[] = [
  { key: 'id', label: '样品编号', kind: 'id', w: 110 },
  { key: 'result', label: '结果', kind: 'input', w: 260 },
  { key: 'note', label: '备注', kind: 'input', w: 130 },
]

// ===================================================================
// HJ-TC-186（0153.pdf）污染源臭气测定结果登记表
// 顶部信息 → (采样/分析日期+平均阈值) → 稀释倍数×嗅辨员解答矩阵(含对数值/注入量定值列) → 备注 → 计算公式
// ===================================================================
const dilA = ['10', '30', '100', '300', '1000', '3000', '1万', '3万', '10万', '30万', '100万', '300万', '1000万']
const dilLga = ['1.00', '1.48', '2.00', '2.48', '3.00', '3.48', '4.00', '4.48', '5.00', '5.48', '6.00', '6.48', '7.00']
const dilInj = ['300ml', '100ml', '30ml', '10ml', '3ml', '1ml', '300ul', '100ul', '30ul', '10ul', '3ul', '1ul', '0.3ul']

export const odor186: Schema = {
  id: 'odor186',
  title: () => '污染源臭气测定结果登记表',
  columns: [], meta: [], signRoles: ['判定师', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '样品编号', key: 'sampleId' },
      { label: '开始环境温度(℃)', key: 'tStart' },
      { label: '分析方法及来源', key: 'methodSrc', fixed: true, value: '环境空气和废气 臭气的测定 三点比较式臭袋法HJ 1262-2022', colspan: 2 },
      { label: '结束环境温度(℃)', key: 'tEnd' },
      { label: '湿度(%)', key: 'humidity' },
    ] },
    { type: 'kv', id: 'cond', cols: 2, rows: [
      { label: '采样日期', key: 'sampleDate' },
      { label: '分析日期', key: 'analysisDate' },
      { label: '平均阈值(x)', key: 'avgThreshold', colspan: 2 },
    ] },
    // 列 = 稀释倍数(a)/对数值(lga)/注入量 三行定值信息合并进列头；行 = 嗅辨员 A1~D2 的解答
    { type: 'matrix', id: 'grid', transpose: true,
      rowHeaders: ['A1', 'B1', 'C1', 'D1', 'A2', 'B2', 'C2', 'D2'].map(n => ({ label: n, key: n, unit: '解答', kind: 'input' as const })),
      colHeaders: dilA.map((a, i) => ({ label: `${a}(lga${dilLga[i]}/${dilInj[i]})`, key: `d${i}` })),
      cellKind: 'input',
      note: 'Xi=(lga1+lga2)/2（个人嗅阈值：A由A1、A2两次lga均值计算，B/C/D同理）；计算公式 y=10ˣ',
    },
    { type: 'kv', id: 'remark', cols: 4, rows: [
      { label: '备注A', key: 'remarkA' }, { label: '备注B', key: 'remarkB' },
      { label: '备注C', key: 'remarkC' }, { label: '备注D', key: 'remarkD' },
      { label: '说明', key: 'legend', fixed: true, value: 'О：表示准确，×：表示错误', colspan: 4 },
    ] },
  ],
}

// ===================================================================
// HJ-TC-185（0152.pdf）环境臭气测定结果登记表
// 顶部信息 → 稀释倍数(10/100/1000)×实验次序(1-3)×嗅辨员1-6 解答矩阵 → 小组平均正确率(a/b/c/M) → M1/M2/α/β/人员/浓度公式 → 图例
// ===================================================================
const dils185 = ['10', '100', '1000']

export const odor185: Schema = {
  id: 'odor185',
  title: () => '环境臭气测定结果登记表',
  columns: [], meta: [], signRoles: ['判定师', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '采样日期', key: 'sampleDate' }, { label: '样品编号', key: 'sampleId' },
      { label: '分析方法及来源', key: 'methodSrc', fixed: true, value: '环境空气和废气的测定 三点比较式臭袋法 HJ 1262—2022', colspan: 2 },
      { label: '实验日期', key: 'testDate' },
      { label: '开始环境温度(℃)', key: 'tStart' }, { label: '结束环境温度(℃)', key: 'tEnd' }, { label: '湿度(%)', key: 'humidity' },
    ] },
    { type: 'matrix', id: 'grid', transpose: true,
      rowHeaders: [1, 2, 3, 4, 5, 6].map(n => ({ label: `嗅辨员${n}`, key: `p${n}`, kind: 'input' as const })),
      colHeaders: dils185.flatMap(d => [1, 2, 3].map(t => ({ label: `${d}倍-第${t}次`, key: `d${d}t${t}` }))),
      cellKind: 'input',
      note: '每格填该嗅辨员在对应稀释倍数/实验次序下的判断结果（× 错误 0 正确 △ 不明）',
    },
    { type: 'matrix', id: 'stat', transpose: true,
      rowHeaders: [
        { label: 'a', key: 'a', kind: 'input' as const }, { label: 'b', key: 'b', kind: 'input' as const },
        { label: 'c', key: 'c', kind: 'input' as const }, { label: 'M', key: 'M', kind: 'input' as const },
      ],
      colHeaders: dils185.map(d => ({ label: `稀释${d}倍`, key: `d${d}` })),
      cellKind: 'input',
      note: 'M=(1.00×a+0.33×b+0×c)/n （n=解答总数18；a-答案正确人次数；b-答案不明人次数；c-答案错误人次数）',
    },
    { type: 'kv', id: 'stat2', cols: 2, rows: [
      { label: 'M₁（0.58＜M1＜1）', key: 'm1' }, { label: 'M₂（M2＜0.58）', key: 'm2' },
      { label: 'α=(M1-0.58)/(M1-M2)', key: 'alpha' }, { label: 'β=lg(t2/t1)', key: 'beta' },
      { label: '人员', key: 'staff', fixed: true, value: '郭星 白春玉 宋丽娜 贺春方 王晓彤 崔丽丽 李岩', colspan: 2 },
      { label: '臭气浓度Y=t1×10^(αβ)', key: 'Y', colspan: 2 },
      { label: '注', key: 'legend', fixed: true, colspan: 2, value:
        '× 错误 0 正确 △ 不明；若稀释10倍时的M1＜0.58，臭气浓度=10或＜10；t1-小组平均正解率M1时的稀释倍数；t2-小组平均正解率M2时的稀释倍数' },
    ] },
  ],
}

// ===================================================================
// HJ-TC-620（0348.pdf）嗅辨员嗅辨记录 —— 袋号/嗅辨结果 三列组 × 12 行（第2/3组默认带 -1/-2 袋号后缀）
// ===================================================================
const bagCols: Col[] = [
  { key: 'bag1', label: '袋号', kind: 'input', w: 70 }, { key: 'res1', label: '嗅辨结果', kind: 'input' },
  { key: 'bag2', label: '袋号', kind: 'input', w: 70 }, { key: 'res2', label: '嗅辨结果', kind: 'input' },
  { key: 'bag3', label: '袋号', kind: 'input', w: 70 }, { key: 'res3', label: '嗅辨结果', kind: 'input' },
]

// bags 表的初始 12 行：第2/3列组按原件预印 -1/-2 后缀
const smell620Seed = () => Array.from({ length: 12 }, () => (
  { bag1: '', res1: '', bag2: '-1', res2: '', bag3: '-2', res3: '' }
))

export const smell620: Schema = {
  id: 'smell620',
  title: () => '嗅辨员嗅辨记录',
  columns: [], meta: [], signRoles: ['嗅辨员', '复核', '审核'],
  seed: smell620Seed,
  layout: [
    { type: 'table', id: 'bags', columns: bagCols, seedRows: 12 },
    { type: 'kv', id: 'basis', cols: 1, rows: [
      { label: '方法依据', key: 'basis', fixed: true, value: '三点比较式臭袋法 HJ1262-2022' },
    ] },
  ],
}

// ===================================================================
// HJ-TC-622（0349.pdf）有组织嗅辨表格 —— 与620同版式，但全部留空（11行）
// ===================================================================
export const smell622: Schema = {
  id: 'smell622',
  title: () => '嗅辨员嗅辨记录',
  columns: [], meta: [], signRoles: ['嗅辨员', '复核', '审核'],
  seed: () => Array.from({ length: 11 }, () => ({ bag1: '', res1: '', bag2: '', res2: '', bag3: '', res3: '' })),
  layout: [
    { type: 'table', id: 'bags', columns: bagCols, seedRows: 11 },
    { type: 'kv', id: 'basis', cols: 1, rows: [
      { label: '方法依据', key: 'basis', fixed: true, value: '三点比较式臭袋法 HJ1262-2022' },
    ] },
  ],
}

// ===================================================================
// HJ-TC-625（0350.pdf）臭气浓度配气记录（无组织嗅辨表格100倍）
// 项目(固定:环境/无组织臭气) → 样品号/稀释倍数/注入量(ml)/注入袋号 数据表(空白+12组×100倍/1000倍交替×-1/-2)
// ===================================================================
const dilRecCols: Col[] = [
  { key: 'sampleNo', label: '样品号', kind: 'input', w: 90 },
  { key: 'dil', label: '稀释倍数', kind: 'input', w: 90 },
  { key: 'inject', label: '注入量(ml)', kind: 'input', w: 90 },
  { key: 'bag', label: '注入袋号', kind: 'input', w: 90 },
]
function dilRecSeed() {
  const rows: Record<string, any>[] = [{ sampleNo: '', dil: '空白', inject: '', bag: '' }]
  for (let i = 0; i < 12; i++) {
    const isEven = i % 2 === 0
    const dil = isEven ? '100' : '1000'
    const inject = isEven ? '30' : '3'
    rows.push({ sampleNo: '', dil, inject, bag: '-1' })
    rows.push({ sampleNo: '', dil, inject, bag: '-2' })
  }
  return rows
}

export const odor625: Schema = {
  id: 'odor625',
  title: () => '臭气浓度配气记录',
  columns: [], meta: [], signRoles: ['配气人', '复核', '审核'],
  seed: dilRecSeed,
  layout: [
    { type: 'kv', id: 'top', cols: 1, rows: [
      { label: '项目', key: 'project', fixed: true, value: '环境/无组织臭气' },
    ] },
    { type: 'table', id: 'dilTable', columns: dilRecCols, seedRows: 25 },
    { type: 'kv', id: 'basis', cols: 1, rows: [
      { label: '方法依据', key: 'basis', fixed: true, value: '三点比较式臭袋法 HJ1262-2022' },
    ] },
  ],
}

// ===================================================================
// HJ-TC-435（0267.pdf）嗅辨员日常培训管理结果登记表
// 方法及依据(固定) → 实验次序1-10 × 嗅辨员(郭星/白春玉/贺春方/宋丽娜/王晓彤/崔丽丽/李岩)+平均阈值/臭气浓度/阈值浓度 矩阵
// → 嗅辨员阈值/标准偏差(S)/10S 汇总矩阵
// ===================================================================
const judges435 = ['郭星', '白春玉', '贺春方', '宋丽娜', '王晓彤', '崔丽丽', '李岩']

export const smellTraining435: Schema = {
  id: 'smellTraining435',
  title: () => '嗅辨员日常培训管理结果登记表',
  columns: [], meta: [], signRoles: ['统计', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 1, rows: [
      { label: '方法及依据', key: 'basis', fixed: true, value: '环境空气和废气 臭气的测定 三点比较式臭袋法 HJ 1262-2022' },
    ] },
    { type: 'matrix', id: 'grid', transpose: true,
      rowHeaders: Array.from({ length: 10 }, (_, i) => ({ label: `第${i + 1}次`, key: `n${i + 1}`, kind: 'input' as const })),
      colHeaders: [
        ...judges435.map(j => ({ label: j, key: j })),
        { label: '平均阈值', key: 'avg' }, { label: '臭气浓度(无量纲)', key: 'conc' },
        { label: '阈值浓度×10⁻³µmol/mol', key: 'concUmol' },
      ],
      cellKind: 'input',
      note: '每行为一次实验，按嗅辨员列填个人阈值；平均阈值/臭气浓度/阈值浓度按行汇总',
    },
    { type: 'matrix', id: 'stat', transpose: true,
      rowHeaders: [
        { label: '嗅辨员阈值', key: 'threshold', kind: 'input' as const },
        { label: '标准偏差(S)', key: 'sd', kind: 'input' as const },
        { label: '10S', key: 's10', kind: 'input' as const },
      ],
      colHeaders: judges435.map(j => ({ label: j, key: j })),
      cellKind: 'input',
    },
  ],
}

// ===================================================================
// HJ-TC-233（0191.pdf）臭和味 分析原始记录（生活饮用水，无采样日期行）
// ===================================================================
export const smellTaste233: Schema = {
  id: 'smellTaste233',
  title: () => '臭和味分析原始记录',
  columns: [], meta: [], signRoles: ['检测', '复核', '审核'],
  seed: smellTasteSeed,
  layout: [
    { type: 'table', id: 'main', columns: smellTasteCols, seedRows: 8 },
    { type: 'kv', id: 'method', cols: 1, rows: [
      { label: '分析方法', key: 'method', fixed: true, value: '生活饮用水检验标准 第4部分 感观性状和物理指标（6.1） 嗅气和尝味法' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'GB/T 5750.4-2023' },
    ] },
  ],
}

// ===================================================================
// HJ-TC-370（0225.pdf）嗅和味 分析原始记录（海水，含采样日期）
// ===================================================================
export const smellTaste370: Schema = {
  id: 'smellTaste370',
  title: () => '嗅和味分析原始记录',
  columns: [], meta: [], signRoles: ['检测', '复核', '审核'],
  seed: smellTasteSeed,
  layout: [
    { type: 'kv', id: 'date', cols: 1, rows: [{ label: '采样日期', key: 'sampleDate' }] },
    { type: 'table', id: 'main', columns: smellTasteCols, seedRows: 8 },
    { type: 'kv', id: 'method', cols: 1, rows: [
      { label: '分析方法', key: 'method', fixed: true, value: '海洋监测规范第4部分：海水分析(24)感官法' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'GB/T 17378.4-2007' },
    ] },
  ],
}

// —— 共用：640/650 臭 分析原始记录（废水，含采样日期）工厂 ——
function smellWaterForm(id: string): Schema {
  return {
    id,
    title: () => '臭分析原始记录',
    columns: [], meta: [], signRoles: ['检测', '复核', '审核'],
    seed: smellTasteSeed,
    layout: [
      { type: 'kv', id: 'date', cols: 1, rows: [{ label: '采样日期', key: 'sampleDate' }] },
      { type: 'table', id: 'main', columns: smellTasteCols, seedRows: 8 },
      { type: 'kv', id: 'method', cols: 1, rows: [
        { label: '分析方法', key: 'method', fixed: true, value: '水和废水监测分析方法 第三篇 第一章 三(一)文字描述法（B）' },
        { label: '方法依据', key: 'basis', fixed: true, value: '国家环境保护总局 水和废水监测分析方法（第四版）增补版' },
      ] },
    ],
  }
}
// HJ-TC-640（0357.pdf）
export const smell640: Schema = smellWaterForm('smell640')
// HJ-TC-650（0367.pdf）与640同版式同方法（不同表号）
export const smell650: Schema = smellWaterForm('smell650')

// ===================================================================
// HJ-TC-234（0192.pdf）肉眼可见物 分析原始记录（生活饮用水，无采样日期行）
// ===================================================================
export const visibleMatter234: Schema = {
  id: 'visibleMatter234',
  title: () => '肉眼可见物分析原始记录',
  columns: [], meta: [], signRoles: ['检测', '复核', '审核'],
  seed: smellTasteSeed,
  layout: [
    { type: 'table', id: 'main', columns: smellTasteCols, seedRows: 8 },
    { type: 'kv', id: 'method', cols: 1, rows: [
      { label: '分析方法', key: 'method', fixed: true, value: '生活饮用水检验标准 第4部分 感观性状和物理指标（7.1）直接观察法。' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'GB/T 5750.4-2023' },
    ] },
  ],
}

// ===================================================================
// HJ-TC-371（0226.pdf）漂浮物质 分析原始记录（海水，含采样日期，无取样体积V列）
// ===================================================================
export const floatingMatter371: Schema = {
  id: 'floatingMatter371',
  title: () => '漂浮物质分析原始记录',
  columns: [], meta: [], signRoles: ['检测', '复核', '审核'],
  seed: () => Array.from({ length: 8 }, () => ({ id: '', result: '', note: '' })),
  layout: [
    { type: 'kv', id: 'date', cols: 1, rows: [{ label: '采样日期', key: 'sampleDate' }] },
    { type: 'table', id: 'main', columns: floatingCols, seedRows: 8 },
    { type: 'kv', id: 'method', cols: 1, rows: [
      { label: '测量项目', key: 'analyte', fixed: true, value: '漂浮物质' },
      { label: '测量方法', key: 'method', fixed: true, value: '海水水质标准 目测法' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'GB 3097-1997' },
    ] },
  ],
}

export const olfactoryForms: Record<string, Schema> = {
  'HJ-TC-186': odor186,
  'HJ-TC-185': odor185,
  'HJ-TC-620': smell620,
  'HJ-TC-622': smell622,
  'HJ-TC-625': odor625,
  'HJ-TC-435': smellTraining435,
  'HJ-TC-233': smellTaste233,
  'HJ-TC-370': smellTaste370,
  'HJ-TC-640': smell640,
  'HJ-TC-650': smell650,
  'HJ-TC-234': visibleMatter234,
  'HJ-TC-371': floatingMatter371,
}
