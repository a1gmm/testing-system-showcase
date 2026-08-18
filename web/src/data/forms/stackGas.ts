import type { Schema } from '../schemas'

// 0188.pdf：左侧 分/秒 0–29 行 × 0/15/30/45 秒列 目视观察矩阵；右侧观测条件 + 天气/烟羽勾选 + 累计统计
export const ringelmann: Schema = {
  id: 'ringelmann',
  title: () => '烟气黑度观测记录',
  columns: [], meta: [], signRoles: ['观测', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '受检单位', key: 'org' }, { label: '单位地址', key: 'addr' },
      { label: '设备名称', key: 'dev' }, { label: '净化设施', key: 'purify' },
      { label: '观测时间', key: 'obsTime' }, { label: '分析方法', key: 'method', fixed: true, value: '林格曼黑度图法' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'HJ/T 398-2007' },
    ] },
    { type: 'matrix', id: 'grid', transpose: true,
      rowHeaders: Array.from({ length: 30 }, (_, i) => ({ label: String(i), key: `s${i}`, kind: 'input' as const })),
      colHeaders: [ { label: '0', key: 'c0' }, { label: '15', key: 'c15' }, { label: '30', key: 'c30' }, { label: '45', key: 'c45' } ],
      cellKind: 'input', note: '表体为分(行)×秒(列)的林格曼级观测值' },
    { type: 'kv', id: 'cond', cols: 2, rows: [
      { label: '烟囱距离(m)', key: 'dist' }, { label: '烟囱所在方向', key: 'dir' },
      { label: '烟囱高度(m)', key: 'height' }, { label: '烟囱出口形状', key: 'shape' },
      { label: '风向', key: 'wind' }, { label: '风速(m/s)', key: 'windSpeed' },
    ] },
    { type: 'checks', id: 'weather', label: '天气情况', key: 'weather', options: ['晴朗', '少云', '多云', '晴天'] },
    { type: 'checks', id: 'plume', label: '烟羽背景', key: 'plume', options: ['无云', '薄云', '白云', '灰云'] },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 1 },
    { type: 'kv', id: 'stat', cols: 2, rows: [
      { label: '观测开始时间', key: 'startTime' }, { label: '观测结束时间', key: 'endTime' },
      { label: '5级累计次数', key: 'lv5cnt' }, { label: '5级累计时间(分)', key: 'lv5min' },
    ] },
  ],
}

// —— 检测项目、方法、设备（HJ-TC-140/709/653 共用文案）——
const dustMethodOptionsFull = [
  'HJ 836-2017《固定污染源废气 低浓度颗粒物的测定 重量法》',
  '烟气（水分、流速、温度、压力）《固定污染源排气中颗粒物测定与气态污染物采样方法》GB/T16157-1996',
  '烟气氧含量，HJ/T 397-2007 固定源废气监测技术规范',
  'SO2、HJ 57-2017 固定污染源废气 二氧化硫的测定 定电位电解法',
  'NOX、HJ 693-2014 固定污染源废气 氮氧化物的测定 定电位电解法',
  'CO HJ 973-2018 固定污染源废气一氧化碳的测定定电位电解法',
  'SO2 HJ 1131-2020 固定污染源废气 二氧化硫的测定 便携式紫外吸收法',
  'NOX HJ 1132-2020 固定污染源废气 氮氧化物的测定 便携式紫外吸收法',
]
const stackGasSamplerOptions = ['3012H', 'GH-60E', '3012H-D', '3012D', 'JF-3012HD', '崂应3023（紫外）']

// 0137.pdf HJ-TC-140：烟尘（生产性粉尘）、烟气及废气采样原始记录（颗粒物采样表 + SO2/CO/NOx/氧含量转置矩阵 + 烟道截面示意图 + 方法设备）
export const stackDust140: Schema = {
  id: 'stackDust140',
  title: () => '烟尘（生产性粉尘）、烟气及废气采样原始记录',
  columns: [], meta: [], signRoles: ['分析', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '企业名称', key: 'org' }, { label: '排气筒名称', key: 'stackName' },
    ] },
    { type: 'table', id: 'dustTable', seedRows: 2, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'time', label: '采样时间', kind: 'input', w: 90 },
      { key: 'dur', label: '采样时长', unit: 'min', kind: 'input', w: 70 },
      { key: 'vol', label: '标况体积', unit: 'L', kind: 'input', w: 70 },
      { key: 'flow', label: '标杆流量', unit: 'Ndm³/h', kind: 'input', w: 80 },
      { key: 'moisture', label: '水分', unit: '%', kind: 'input', w: 60 },
      { key: 'pDyn', label: '动压', unit: 'Pa', kind: 'input', w: 60 },
      { key: 'pStat', label: '静压', unit: 'kPa', kind: 'input', w: 60 },
      { key: 'velocity', label: '烟气流速', unit: 'm/s', kind: 'input', w: 70 },
      { key: 'temp', label: '烟气温度', unit: '℃', kind: 'input', w: 60 },
      { key: 'w0_1', label: '1', kind: 'input', group: '滤筒初重（g）', w: 55 },
      { key: 'w0_2', label: '2', kind: 'input', group: '滤筒初重（g）', w: 55 },
      { key: 'w1_1', label: '1', kind: 'input', group: '采样后滤筒重量（g）', w: 55 },
      { key: 'w1_2', label: '2', kind: 'input', group: '采样后滤筒重量（g）', w: 55 },
      { key: 'dustMeasured', label: '烟尘实测浓度', unit: 'mg/m³', kind: 'input', w: 80 },
      { key: 'dustEmit', label: '烟尘排放浓度', unit: 'mg/m³', kind: 'input', w: 80 },
      { key: 'dustRate', label: '烟尘排放速率', unit: 'kg/h', kind: 'input', w: 80 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'matrix', id: 'gasMatrix', transpose: true,
      rowHeaders: [
        { label: '排气筒名称', key: 'gasStackName', kind: 'input' },
        { label: '采样时间', key: 'gasTime', kind: 'input' },
        { label: '第一次 mg/m³', key: 'r1', kind: 'input' },
        { label: '第二次 mg/m³', key: 'r2', kind: 'input' },
        { label: '第三次 mg/m³', key: 'r3', kind: 'input' },
        { label: '平均值 mg/m³', key: 'avg', kind: 'input' },
        { label: '排放浓度 mg/m³', key: 'emit', kind: 'input' },
        { label: '排放速率 kg/h', key: 'rate', kind: 'input' },
      ],
      colHeaders: [ { label: 'SO2', key: 'so2' }, { label: 'CO', key: 'co' }, { label: 'NOx', key: 'nox' } ],
      cellKind: 'input', note: '排放浓度=实测浓度×折算系数；折算系数由基准氧含量与实测氧含量换算所得' },
    { type: 'kv', id: 'o2', cols: 3, rows: [
      { label: '氧含量平均值(%)', key: 'o2avg' }, { label: '基准氧含量(%)', key: 'o2base' }, { label: '折算系数', key: 'o2factor' },
    ] },
    { type: 'diagram', id: 'duct', label: '烟道截面示意图' },
    { type: 'note', id: 'ductNote', label: '示意图说明（"·"为采样点位；计算公式 Vnd=…×10⁶，见原表公式）', key: 'ductNote', rows: 1 },
    { type: 'checks', id: 'method', label: '检测项目、方法、设备', key: 'methods', options: dustMethodOptionsFull, multi: true },
    { type: 'checks', id: 'sampler', label: '烟尘、烟气采样器', key: 'sampler', options: stackGasSamplerOptions },
  ],
}

// 0381.pdf HJ-TC-709：烟尘（生产性粉尘）、烟气及废气采样原始记录（同140家族，仅颗粒物采样表，无SO2/CO/NOx矩阵）
export const stackDust709: Schema = {
  id: 'stackDust709',
  title: () => '烟尘（生产性粉尘）、烟气及废气采样原始记录',
  columns: [], meta: [], signRoles: ['分析', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '采样日期', key: 'sampleDate' },
    ] },
    { type: 'table', id: 'dustTable', seedRows: 2, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'time', label: '采样时间', kind: 'input', w: 90 },
      { key: 'dur', label: '采样时长', unit: 'min', kind: 'input', w: 70 },
      { key: 'vol', label: '标况体积', unit: 'L', kind: 'input', w: 70 },
      { key: 'flow', label: '标杆流量', unit: 'Ndm³/h', kind: 'input', w: 80 },
      { key: 'moisture', label: '水分', unit: '%', kind: 'input', w: 60 },
      { key: 'pDyn', label: '动压', unit: 'Pa', kind: 'input', w: 60 },
      { key: 'pStat', label: '静压', unit: 'kPa', kind: 'input', w: 60 },
      { key: 'velocity', label: '烟气流速', unit: 'm/s', kind: 'input', w: 70 },
      { key: 'temp', label: '烟气温度', unit: '℃', kind: 'input', w: 60 },
      { key: 'w0_1', label: '1', kind: 'input', group: '滤筒初重', w: 55 },
      { key: 'w0_2', label: '2', kind: 'input', group: '滤筒初重', w: 55 },
      { key: 'w1_1', label: '1', kind: 'input', group: '采样后滤筒重量', w: 55 },
      { key: 'w1_2', label: '2', kind: 'input', group: '采样后滤筒重量', w: 55 },
      { key: 'dustMeasured', label: '烟尘实测浓度', unit: 'mg/m³', kind: 'input', w: 80 },
      { key: 'dustEmit', label: '烟尘排放浓度', unit: 'mg/m³', kind: 'input', w: 80 },
      { key: 'dustRate', label: '烟尘排放速率', unit: 'kg/h', kind: 'input', w: 80 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'kv', id: 'formula', cols: 2, rows: [
      { label: '折算系数', key: 'convFactor' }, { label: '计算公式', key: 'formula' },
    ] },
    { type: 'checks', id: 'method', label: '检测项目、方法、设备', key: 'methods', options: dustMethodOptionsFull, multi: true },
    { type: 'checks', id: 'sampler', label: '烟尘、烟气采样器', key: 'sampler', options: stackGasSamplerOptions },
  ],
}

// 0370.pdf HJ-TC-653：烟尘（生产性粉尘）、烟气及废气采样原始记录-比对（SO2/CO/NOx/氧含量按9轮次实测/排放转置矩阵）
export const stackGasCompare653: Schema = {
  id: 'stackGasCompare653',
  title: () => '烟尘（生产性粉尘）、烟气及废气采样原始记录',
  columns: [], meta: [], signRoles: ['分析', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '企业名称', key: 'org' }, { label: '采样日期', key: 'sampleDate' },
    ] },
    { type: 'matrix', id: 'gasMatrix', transpose: true,
      rowHeaders: [
        { label: '排气筒名称', key: 'stackName', kind: 'input' },
        { label: '采样时间', key: 'time', kind: 'input' },
        { label: 'SO2实测浓度 mg/m³', key: 'so2', kind: 'input' },
        { label: 'CO实测浓度 mg/m³', key: 'co', kind: 'input' },
        { label: 'NOx实测浓度 mg/m³', key: 'nox', kind: 'input' },
        { label: '氧含量 %', key: 'o2', kind: 'input' },
      ],
      colHeaders: ['一', '二', '三', '四', '五', '六', '七', '八', '九'].flatMap((n, i) => [
        { label: `第${n}次实测`, key: `r${i + 1}a` }, { label: `第${n}次排放`, key: `r${i + 1}e` },
      ]),
      cellKind: 'input', note: '基准氧含量、折算系数见下方；折算系数=（21-基准氧含量）/（21-实测氧含量）' },
    { type: 'kv', id: 'o2', cols: 2, rows: [
      { label: '基准氧含量', key: 'o2base' }, { label: '折算系数', key: 'convFactor', colspan: 2 },
    ] },
    { type: 'checks', id: 'method', label: '检测项目、方法、设备', key: 'methods', multi: true, options: [
      '烟气（水分、流速、温度、压力）《固定污染源排气中颗粒物测定与气态污染物采样方法》GB/T16157-1996',
      '烟气氧含量，HJ/T 397-2007 固定源废气监测技术规范',
      'SO2、HJ 57-2017 固定污染源废气 二氧化硫的测定 定电位电解法',
      'NOX、HJ 693-2014 固定污染源废气 氮氧化物的测定 定电位电解法',
      'CO HJ 973-2018 固定污染源废气一氧化碳的测定定电位电解法',
      'SO2 HJ 1131-2020 固定污染源废气 二氧化硫的测定 便携式紫外吸收法',
      'NOX HJ 1132-2020 固定污染源废气 氮氧化物的测定 便携式紫外吸收法',
    ] },
    { type: 'checks', id: 'sampler', label: '烟尘、烟气采样器', key: 'sampler', options: ['3012H', 'GH-60E', '3012H-D', '3012D', 'JF-3012HD'] },
    { type: 'kv', id: 'calcFormula', cols: 1, rows: [
      { label: '计算公式（折算系数=）', key: 'calcFormula' },
    ] },
  ],
}

// 0119.pdf HJ-TC-119：环境空气 PM10和PM2.5的测定原始记录
export const ambientAirPM119: Schema = {
  id: 'ambientAirPM119',
  title: () => '环境空气原始记录表',
  columns: [], meta: [], signRoles: ['分析', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 1, rows: [
      { label: '采样日期', key: 'sampleDate' },
    ] },
    { type: 'table', id: 'pmTable', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'item', label: '项目', kind: 'input', w: 70 },
      { key: 'vn', label: '标准状况下体积Vn', unit: 'L', kind: 'input', w: 90 },
      { key: 'w2', label: '空膜W₂', kind: 'input', group: '滤膜重量（g）', w: 70 },
      { key: 'w1', label: '尘膜W₁', kind: 'input', group: '滤膜重量（g）', w: 70 },
      { key: 'wd', label: '尘重', kind: 'input', group: '滤膜重量（g）', w: 70 },
      { key: 'c', label: '含量C', unit: 'mg/m³', kind: 'input', w: 80 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'kv', id: 'method', cols: 2, rows: [
      { label: '测量方法', key: 'method', fixed: true, value: '环境空气 PM10和PM2.5的测定 重量法' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'HJ 618-2011' },
      { label: '平衡前温度', key: 'preTemp' }, { label: '平衡前湿度', key: 'preHumidity' },
      { label: '使用天平', key: 'balance', fixed: true, value: 'ME204E/02电子分析天平' },
      { label: '计算公式', key: 'formula', fixed: true, value: 'C(mg/m³)=(W1−W2)/Vn×1000', colspan: 2 },
      { label: '平衡温度', key: 'balTemp' }, { label: '平衡湿度', key: 'balHumidity' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'W1—尘膜重量（g）；W2—空膜重量（g）；Vn—标况下采样体积（L）' },
    ] },
  ],
}

// 0136.pdf HJ-TC-139：空气中总悬浮颗粒物原始记录
export const ambientAirTSP139: Schema = {
  id: 'ambientAirTSP139',
  title: () => '环境空气/无组织废气中原始记录表',
  columns: [], meta: [], signRoles: ['分析', '复核', '审核'],
  seed: () => [],
  // 系统样子按 HJ-TC-139 修订版原表逐字段对齐（单位mg/m³·μg/m³、W₁W₂纠正、天平分度值/两次称量/标准滤膜校核）
  layout: [
    { type: 'kv', id: 'top', cols: 1, rows: [
      { label: '采样日期', key: 'sampleDate' },
    ] },
    { type: 'table', id: 'tspTable', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'item', label: '项目（颗粒物/TSP）', kind: 'input', w: 90 },
      { key: 'vn', label: '标准状况下体积Vn', unit: 'm³', kind: 'input', w: 90 },
      { key: 'w1', label: '空膜W₁(采样前)', kind: 'input', group: '滤膜重量（mg）', w: 80 },
      { key: 'w2', label: '尘膜W₂(采样后)', kind: 'input', group: '滤膜重量（mg）', w: 80 },
      { key: 'wd', label: '尘重(W₂−W₁)', kind: 'input', group: '滤膜重量（mg）', w: 80 },
      { key: 'c', label: '含量C', unit: 'μg/m³', kind: 'input', w: 80 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'kv', id: 'weighNote', cols: 1, rows: [
      { label: '称量要求', key: 'weighNote', fixed: true,
        value: '空膜W₁、尘膜W₂均应各称量两次（间隔≥1h）取平均值填入；两次称量允差按天平实际分度值判定（0.0001g→差值<1mg；0.00001g→差值<0.1mg）（HJ1263-2022 6.3/8.2.3）' },
    ] },
    { type: 'kv', id: 'method', cols: 2, rows: [
      { label: '测量方法', key: 'method', fixed: true, value: '环境空气 总悬浮颗粒物的测定 重量法' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'HJ 1263-2022' },
      { label: '采样器类型', key: 'samplerType', checks: ['大流量', '中流量'], checksKey: 'samplerType', colspan: 2 },
      { label: '（说明）', key: 'samplerNote', fixed: true, colspan: 2, value: '采样器类型决定滤膜增重限值、标准滤膜允差、检出限的判定依据' },
      { label: '天平实际分度值', key: 'balanceReso', checks: ['0.0001g', '0.00001g'], checksKey: 'balanceReso', colspan: 2 },
      { label: '使用天平', key: 'balance', fixed: true, value: 'AUW120D电子分析天平' },
      { label: '平衡前温度', key: 'preTemp' },
      { label: '平衡前湿度', key: 'preHumidity' }, { label: '平衡后温度', key: 'balTemp' },
      { label: '平衡后湿度', key: 'balHumidity' },
      { label: '计算公式', key: 'formula', colspan: 2, latex: 'C\\,(\\mu g/m^3)=\\dfrac{W_2-W_1}{V_n}\\times 1000' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'W₁—空膜（采样前）质量（mg）；W₂—尘膜（采样后）质量（mg）；Vn—标况下采样体积（m³）' },
      { label: '结果保留', key: 'resultDigits', fixed: true, colspan: 2, value: '整数位（μg/m³）（HJ1263-2022 9.2）' },
    ] },
    // 标准滤膜(空白)校核 —— HJ1263-2022 11.2 强制质控
    { type: 'kv', id: 'qc', cols: 2, rows: [
      { label: '标准滤膜编号', key: 'stdFilterId' },
      { label: '标准滤膜原始质量(mg)', key: 'stdFilterOrig' },
      { label: '本批次称量值(mg)', key: 'stdFilterNow' },
      { label: '允差', key: 'stdFilterTol', checks: ['±5mg(大流量)', '±0.5mg(中流量)'], checksKey: 'stdFilterTol', colspan: 2 },
      { label: '校核判定', key: 'stdFilterResult', checks: ['合格', '不合格'], checksKey: 'stdFilterResult' },
    ] },
  ],
}

// 0298.pdf HJ-TC-475：空气中降尘测定原始记录
export const dustfall475: Schema = {
  id: 'dustfall475',
  title: () => '空气中降尘测定原始记录表',
  columns: [], meta: [], signRoles: ['采样', '分析', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'table', id: 'dustfallTable', seedRows: 4, columns: [
      { key: 'point', label: '采样点位', kind: 'input', w: 90 },
      { key: 'id', label: '样品编号', kind: 'id', w: 100 },
      { key: 'qcId', label: '质控编号', kind: 'input', w: 90 },
      { key: 'putDate', label: '放缸日期', kind: 'input', w: 90 },
      { key: 'takeDate', label: '取缸日期', kind: 'input', w: 90 },
      { key: 'days', label: '采样天数', kind: 'input', w: 60 },
      { key: 'w0', label: '初重', unit: 'g', kind: 'input', group: '蒸发器重量（g）', w: 70 },
      { key: 'w1', label: '终重', unit: 'g', kind: 'input', group: '蒸发器重量（g）', w: 70 },
      { key: 'wg', label: '增重', unit: 'g', kind: 'input', group: '蒸发器重量（g）', w: 70 },
      { key: 'area', label: '降尘缸截面积', unit: 'cm²', kind: 'input', w: 90 },
      { key: 'dustfall', label: '降尘量M', unit: '吨/平方公里·月', kind: 'input', w: 100 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'kv', id: 'method', cols: 2, rows: [
      { label: '分析方法', key: 'method', fixed: true, value: '环境空气 降尘的测定 重量法' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'HJ1221-2021' },
      { label: '使用天平', key: 'balance', fixed: true, value: 'ME204E/02 电子分析天平' },
      { label: '检出限', key: 'dl', fixed: true, value: '1.2t/Km².30d' },
      { label: '计算公式', key: 'formula', fixed: true, colspan: 2,
        value: 'M=(W1−Wa−Wc)/(A·t)×30×10⁴' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'M—降尘量（t/km²·30d）；W1—降尘和瓷坩埚重量（g）；Wa—瓷坩埚重量（g）；Wc—乙二醇溶液经蒸发烘干后的重量（g）；t—采样天数（d）；A—集尘缸截面积（cm²）' },
    ] },
  ],
}

// 0209.pdf HJ-TC-278：固定污染源有组织排放废气 硫酸雾 离子色谱法
// 双通道（滤筒颗粒态 + 吸收瓶气态），各扣各自空白后相加，SO₄²⁻按98.08/96.06换算H₂SO₄
function num278(v: any): number | null { const n = parseFloat(v); return isFinite(n) ? n : null }
export const sulfuricMist278: Schema = {
  id: 'sulfuricMist278',
  title: () => '固定污染源有组织排放废气 硫酸雾的测定 离子色谱法 原始记录表（标况采样体积0.4m³）',
  columns: [], meta: [], signRoles: ['分析', '复核', '审核'],
  seed: () => [],
  compute(row: Record<string, any>) {
    const rho01 = num278(row.rho01) ?? 0, rho1 = num278(row.rho1), d1 = num278(row.d1) ?? 1
    const rho02 = num278(row.rho02) ?? 0, rho2 = num278(row.rho2), d2 = num278(row.d2) ?? 1
    const vt1 = num278(row.vt1), vt2 = num278(row.vt2), vnd = num278(row.vnd)
    if (rho1 == null || rho2 == null || vt1 == null || vt2 == null || vnd == null || vnd === 0) return { result: null }
    const so4 = (rho1 - rho01) * vt1 * d1 + (rho2 - rho02) * vt2 * d2 // mg/L×mL，滤筒/吸收瓶各自定容体积
    const h2so4 = (so4 / (1000 * vnd)) * (98.08 / 96.06)              // → mg/m³
    return { result: Math.round(h2so4 * 1000) / 1000 }
  },
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '受检单位', key: 'org' }, { label: '采样日期', key: 'sampleDate' },
      { label: '测量项目', key: 'analyte', fixed: true, value: '硫酸雾' },
      { label: '仪器', key: 'instr', fixed: true, value: 'PIC-10型离子色谱仪（TC-060）' },
      { label: '滤膜处理方式', key: 'filterTreatment', fixed: true, value: '超声波萃取法' },
    ] },
    { type: 'table', id: 'mistTable', seedRows: 3, columns: [
      { key: 'id', label: '样品编号', kind: 'id', w: 90 },
      { key: 'vnd', label: '标况采样体积Vnd', unit: 'm³', kind: 'input', w: 90 },
      { key: 'vt1', label: '定容体积Vt1', unit: 'mL', kind: 'input', group: '滤筒(颗粒态)', w: 70 },
      { key: 'rho01', label: '空白ρ01', unit: 'mg/L', kind: 'input', group: '滤筒(颗粒态)', w: 70 },
      { key: 'rho1', label: '样品ρ1', unit: 'mg/L', kind: 'input', group: '滤筒(颗粒态)', w: 70 },
      { key: 'd1', label: '稀释D1', kind: 'input', group: '滤筒(颗粒态)', w: 60 },
      { key: 'vt2', label: '定容体积Vt2', unit: 'mL', kind: 'input', group: '吸收瓶(气态)', w: 70 },
      { key: 'rho02', label: '空白ρ02', unit: 'mg/L', kind: 'input', group: '吸收瓶(气态)', w: 70 },
      { key: 'rho2', label: '样品ρ2', unit: 'mg/L', kind: 'input', group: '吸收瓶(气态)', w: 70 },
      { key: 'd2', label: '稀释D2', kind: 'input', group: '吸收瓶(气态)', w: 60 },
      { key: 'result', label: '浓度ρ(H₂SO₄)', unit: 'mg/m³', kind: 'auto', w: 90 },
      { key: 'vs', label: '标杆流量Vs', unit: 'L/min', kind: 'input', w: 70 },
      { key: 'rate', label: '排放速率', unit: 'kg/h', kind: 'input', w: 70 },
      { key: 'note', label: '备注', kind: 'input', w: 70 },
    ] },
    { type: 'kv', id: 'method', cols: 2, rows: [
      { label: '测量方法', key: 'method', fixed: true, value: '固定污染源废气 硫酸雾的测定 离子色谱法' },
      { label: '方法依据', key: 'basis', fixed: true, value: 'HJ 544-2025' },
      { label: '检出限', key: 'dl', fixed: true, value: '0.06mg/m³（测定下限0.24mg/m³，有组织排放）' },
      { label: '吸收液', key: 'absorbent', fixed: true, value: 'c(OH⁻)=30mmol/L碱性吸收液，加1%甲醛消除SO₂干扰' },
      { label: '计算公式(HJ544-2025 式1)', key: 'formula', colspan: 2,
        latex: '\\rho_{H_2SO_4}=\\dfrac{(\\rho_1-\\rho_{01})\\,V_{t1} D_1+(\\rho_2-\\rho_{02})\\,V_{t2} D_2}{1000\\,V_{nd}}\\times\\dfrac{98.08}{96.06}' },
      { label: '式中', key: 'notation', fixed: true, colspan: 2,
        value: 'ρ01/ρ02—滤筒/吸收瓶空白(mg/L)；ρ1/ρ2—滤筒/吸收瓶样品(mg/L)；Vt1/Vt2—滤筒/吸收瓶定容体积(mL)；D1/D2—稀释倍数；Vnd—标况采样体积(m³)；98.08/96.06—SO₄²⁻换算H₂SO₄' },
      { label: '回归方程', key: 'regEq', colspan: 2 },
    ] },
    { type: 'kv', id: 'qc', cols: 1, rows: [
      { label: '质控要求', key: 'qcnote', fixed: true,
        value: '空白<2mg/L(1个/日+2个/批,12.2)；曲线核查每批中间点相对误差≤±10%(12.3)；空白加标回收60%~120%(12.4)；相关系数r≥0.999' },
    ] },
  ],
}

export const stackGasForms: Record<string, Schema> = {
  'HJ-TC-278': sulfuricMist278,
  'HJ-TC-228': ringelmann,
  'HJ-TC-140': stackDust140,
  'HJ-TC-709': stackDust709,
  'HJ-TC-653': stackGasCompare653,
  'HJ-TC-119': ambientAirPM119,
  'HJ-TC-139': ambientAirTSP139,
  'HJ-TC-475': dustfall475,
}
