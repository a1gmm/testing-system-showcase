import type { Schema, Col } from '../schemas'

// ============ 废气（无组织）共享列骨架：279/389/630/631 表头完全一致 ============
const fugitiveGasCols: Col[] = [
  { key: 'date', label: '日期', kind: 'input', w: 70 },
  { key: 'item', label: '项目', kind: 'input', w: 70 },
  { key: 'sampleNo', label: '样品编号', kind: 'id', w: 100 },
  { key: 'point', label: '点位', kind: 'input', w: 80 },
  { key: 'time', label: '采样时间', kind: 'input', w: 80 },
  { key: 's', label: '累积采样时间s', unit: 'min', kind: 'input', w: 80 },
  { key: 'V', label: '采样流量V', unit: 'L/min', kind: 'input', w: 80 },
  { key: 'V0', label: '标况下采样体积V0', unit: 'L', kind: 'input', w: 100 },
  { key: 't', label: '温度t', unit: '℃', kind: 'input', w: 60 },
  { key: 'P', label: '气压P', unit: 'Kpa', kind: 'input', w: 60 },
]

// 0139.pdf：kv(项目编号/企业名称/企业签字/采样器名称/采样方式checks) → table(11列，含标干流量) → diagram+note(备注) → note(计算公式)
export const wasteGasOrganized: Schema = {
  id: 'wasteGasOrganized',
  title: () => '废气（有组织）采样原始记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '项目编号', key: 'projNo' },
      { label: '企业名称', key: 'org' },
      { label: '企业签字', key: 'orgSign' },
      { label: '采样器名称', key: 'sampler' },
      { label: '采样方式', checks: ['连续', '间歇'], checksKey: 'samplingMode' },
    ] },
    { type: 'table', id: 'main', seedRows: 14, columns: [
      ...fugitiveGasCols,
      { key: 'stdFlow', label: '标干流量', unit: 'm3/h', kind: 'input', w: 80 },
    ] },
    { type: 'diagram', id: 'diagram', label: '采样点位示意图（·为采样点位）' },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 2 },
    { type: 'note', id: 'formula', label: '计算公式', key: 'formula', rows: 1 },
  ],
}

// 0140.pdf：kv(项目编号/采样地点/采样器名称/企业签字) → table(11列，含V1/V0两种体积) → kv(计算公式=V1=V*S 定值)
export const ambientAir: Schema = {
  id: 'ambientAir',
  title: () => '环境空气采样原始记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '项目编号', key: 'projNo' },
      { label: '采样地点', key: 'site' },
      { label: '采样器名称', key: 'sampler' },
      { label: '企业签字', key: 'orgSign' },
    ] },
    { type: 'table', id: 'main', seedRows: 16, columns: [
      { key: 'date', label: '日期', kind: 'input', w: 70 },
      { key: 'item', label: '项目', kind: 'input', w: 70 },
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 100 },
      { key: 'point', label: '点位', kind: 'input', w: 80 },
      { key: 'time', label: '采样时间', unit: 'min', kind: 'input', w: 80 },
      { key: 's', label: '累积采样时间s', unit: 'min', kind: 'input', w: 80 },
      { key: 'V', label: '采样流量V', unit: 'L/min', kind: 'input', w: 80 },
      { key: 'V1', label: '采样体积V1', unit: 'L', kind: 'input', w: 90 },
      { key: 'V0', label: '参比状态采样体积V0', unit: 'L', kind: 'input', w: 100 },
      { key: 't', label: '温度t', unit: '℃', kind: 'input', w: 60 },
      { key: 'P', label: '气压P', unit: 'hpa', kind: 'input', w: 60 },
      { key: 'note', label: '备注', kind: 'input', w: 90 },
    ] },
    { type: 'kv', id: 'formula', cols: 1, rows: [
      { label: '计算公式', fixed: true, value: 'V1=V*S' },
    ] },
  ],
}

// 0210.pdf：无组织空白版，同 fugitiveGasCols(10列，无标干流量) → diagram(北/△) → note备注 → note公式
export const wasteGasFugitiveBlank: Schema = {
  id: 'wasteGasFugitiveBlank',
  title: () => '废气（无组织）采样原始记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '项目编号', key: 'projNo' },
      { label: '企业名称', key: 'org' },
      { label: '企业签字', key: 'orgSign' },
      { label: '采样器名称', key: 'sampler' },
      { label: '采样方式', checks: ['连续', '间歇'], checksKey: 'samplingMode' },
    ] },
    { type: 'table', id: 'main', seedRows: 14, columns: fugitiveGasCols },
    { type: 'diagram', id: 'diagram', label: '采样点位示意图（北，△为采样点位）' },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 2 },
    { type: 'note', id: 'formula', label: '计算公式', key: 'formula', rows: 1 },
  ],
}

// 0233.pdf：一天4次（上风向/下风向1-3 × 4组=16行），累积采样时间s/采样流量V/V0/温度t/气压P 5列原件为"—"占位（表体仍可填写，不作为定值处理，见报告）
export const wasteGasFugitive4x: Schema = {
  id: 'wasteGasFugitive4x',
  title: () => '废气（无组织）采样原始记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '项目编号', key: 'projNo' },
      { label: '企业名称', key: 'org' },
      { label: '企业签字', key: 'orgSign' },
      { label: '采样器名称', key: 'sampler' },
      { label: '采样方式', checks: ['连续', '间歇'], checksKey: 'samplingMode' },
    ] },
    { type: 'table', id: 'main', seedRows: 16, columns: fugitiveGasCols },
    { type: 'diagram', id: 'diagram', label: '采样点位示意图（北，△为采样点位）' },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 2 },
    { type: 'note', id: 'formula', label: '计算公式', key: 'formula', rows: 1 },
  ],
}

// 0353.pdf：与389同为一天4次(16行)，但表体无"—"占位，结构与279一致
export const wasteGasFugitive4xB: Schema = {
  id: 'wasteGasFugitive4xB',
  title: () => '废气（无组织）采样原始记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '项目编号', key: 'projNo' },
      { label: '企业名称', key: 'org' },
      { label: '企业签字', key: 'orgSign' },
      { label: '采样器名称', key: 'sampler' },
      { label: '采样方式', checks: ['连续', '间歇'], checksKey: 'samplingMode' },
    ] },
    { type: 'table', id: 'main', seedRows: 16, columns: fugitiveGasCols },
    { type: 'diagram', id: 'diagram', label: '采样点位示意图（北，△为采样点位）' },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 2 },
    { type: 'note', id: 'formula', label: '计算公式', key: 'formula', rows: 1 },
  ],
}

// 0354.pdf：一天一次，前4行=上风向/下风向1-3，其后为空白扩展行；footer 多出 设备设定值100L/min + 设备编号/校准值 小表
export const wasteGasFugitive1x: Schema = {
  id: 'wasteGasFugitive1x',
  title: () => '废气（无组织）采样原始记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '项目编号', key: 'projNo' },
      { label: '企业名称', key: 'org' },
      { label: '企业签字', key: 'orgSign' },
      { label: '采样器名称', key: 'sampler' },
      { label: '采样方式', checks: ['连续', '间歇'], checksKey: 'samplingMode' },
    ] },
    { type: 'table', id: 'main', seedRows: 16, columns: fugitiveGasCols },
    { type: 'diagram', id: 'diagram', label: '采样点位示意图（北，△为采样点位；设备设定值100L/min）' },
    { type: 'table', id: 'calib', seedRows: 4, columns: [
      { key: 'devNo', label: '设备编号', kind: 'input', w: 100 },
      { key: 'calibValue', label: '校准值', unit: 'L/min', kind: 'input', w: 90 },
    ] },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 1 },
    { type: 'note', id: 'formula', label: '计算公式', key: 'formula', rows: 1 },
  ],
}

// 0380.pdf：一天1次带颗粒物；kv 仅 项目编号/企业名称 → checks 采样设备(16个TC编号,含原件重复项TC-087) → table(表头为"采样时间s(min)"，非"累积") →
// diagram(北/△/设备设定值100L/min) → table(calib, 设备编号前缀TC-) → note空白 → note计算公式
export const wasteGasFugitive1xParticulate: Schema = {
  id: 'wasteGasFugitive1xParticulate',
  title: () => '废气（无组织）采样原始记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '项目编号', key: 'projNo' },
      { label: '企业名称', key: 'org' },
    ] },
    { type: 'checks', id: 'device', label: '采样设备', key: 'device', multi: true, options: [
      'TC-074', 'TC-086', 'TC-087', 'TC-087', 'TC-089', 'TC-090', 'TC-091', 'TC-092',
      'TC-029', 'TC-030', 'TC-063', 'TC-064', 'TC-065', 'TC-066', 'TC-081', 'TC-082',
    ] },
    { type: 'table', id: 'main', seedRows: 16, columns: [
      { key: 'date', label: '日期', kind: 'input', w: 70 },
      { key: 'item', label: '项目', kind: 'input', w: 70 },
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 100 },
      { key: 'point', label: '点位', kind: 'input', w: 80 },
      { key: 'time', label: '采样时间', kind: 'input', w: 80 },
      { key: 's', label: '采样时间s', unit: 'min', kind: 'input', w: 80 },
      { key: 'V', label: '采样流量V', unit: 'L/min', kind: 'input', w: 80 },
      { key: 'V0', label: '标况下采样体积V0', unit: 'L', kind: 'input', w: 100 },
      { key: 't', label: '温度t', unit: '℃', kind: 'input', w: 60 },
      { key: 'P', label: '气压P', unit: 'Kpa', kind: 'input', w: 60 },
    ] },
    { type: 'diagram', id: 'diagram', label: '采样点位示意图（北，△为采样点位；设备设定值100L/min）' },
    { type: 'table', id: 'calib', seedRows: 4, columns: [
      { key: 'devNo', label: '设备编号(TC-)', kind: 'input', w: 100 },
      { key: 'calibValue', label: '校准值', unit: 'L/min', kind: 'input', w: 90 },
    ] },
    { type: 'note', id: 'blank', label: '空白', key: 'blank', rows: 1 },
    { type: 'note', id: 'formula', label: '计算公式', key: 'formula', rows: 1 },
  ],
}

// 0208.pdf：kv(监测任务名称/项目编号/采样日期) → table(监测点位/采样时间/样品编号/监测项目/样品描述/水深/采样现场及天气等情况描述) → note备注
export const sediment: Schema = {
  id: 'sediment',
  title: () => '沉积物采样原始记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '监测任务名称', key: 'task' },
      { label: '项目编号', key: 'projNo' },
      { label: '采样日期', key: 'samplingDate' },
    ] },
    { type: 'table', id: 'main', seedRows: 8, columns: [
      { key: 'point', label: '监测点位', kind: 'input', w: 100 },
      { key: 'time', label: '采样时间', kind: 'input', w: 80 },
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 100 },
      { key: 'item', label: '监测项目', kind: 'input', w: 140 },
      { key: 'desc', label: '样品描述', kind: 'input', w: 140 },
      { key: 'depth', label: '水深', unit: 'm', kind: 'input', w: 60 },
      { key: 'siteWeather', label: '采样现场及天气等情况描述', kind: 'input', w: 160 },
    ] },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 2 },
  ],
}

// 0297.pdf：全 kv 抬头（2列8行+受检单位负责人签字整行）→ table(样品编号/检测项目)
export const industrialSolidWaste: Schema = {
  id: 'industrialSolidWaste',
  title: () => '工业固体废物采样原始记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '受检单位', key: 'org' }, { label: '单位地址', key: 'addr' },
      { label: '采样地点', key: 'site' }, { label: '采样时间', key: 'samplingTime' },
      { label: '采样人员', key: 'sampler' }, { label: '采样方法', key: 'method' },
      { label: '固体废物名称', key: 'wasteName' }, { label: '废物来源', key: 'wasteSource' },
      { label: '贮存方式', key: 'storage' }, { label: '堆放固体废物数量(吨)', key: 'stockQty' },
      { label: '性状', key: 'appearance' }, { label: '采样位置确定方法', key: 'posMethod' },
      { label: '份样数', key: 'sampleCount' }, { label: '份样量', key: 'sampleWeight' },
      { label: '受检单位负责人签字（陪同采样人员签字）', key: 'witnessSign', colspan: 2 },
    ] },
    { type: 'table', id: 'main', seedRows: 6, columns: [
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 120 },
      { key: 'item', label: '检测项目', kind: 'input', w: 300 },
    ] },
  ],
}

// 0327.pdf：kv(受检单位名称/海区/采样日期,3列) → table(11列) → kv(固定剂说明，定值大段参考文本)
export const seawater: Schema = {
  id: 'seawater',
  title: () => '海水采样记录',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 3, rows: [
      { label: '受检单位名称', key: 'org' },
      { label: '海区', key: 'area' },
      { label: '采样日期', key: 'samplingDate' },
    ] },
    { type: 'table', id: 'main', seedRows: 16, columns: [
      { key: 'time', label: '采样时间', unit: '时、分', kind: 'input', w: 80 },
      { key: 'point', label: '采样点位', kind: 'input', w: 90 },
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 100 },
      { key: 'depth', label: '水深', unit: 'm', kind: 'input', w: 60 },
      { key: 'layer', label: '层次', unit: 'm', kind: 'input', w: 70 },
      { key: 'item', label: '检测项目', kind: 'input', w: 160 },
      { key: 'preserve', label: '保存方法', kind: 'input', w: 100 },
      { key: 'desc', label: '样品描述', kind: 'input', w: 100 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'kv', id: 'preservative', cols: 1, rows: [
      { label: '固定剂', fixed: true, colspan: 1, value: '1、重金属：铜、铅、镉、锌、镍、硒 硝酸pH≤2 P/G 1L；2、汞 硫酸pH≤2 G 500ml；3、总铬 硫酸pH≤2 P/G 500ml；4、砷 硫酸pH≤2 P/G 500ml；5、石油类 现场萃取 G棕 500ml；6、硫化物 每升水样加入1ml乙酸锌（50g/L）G 24h 4L；7、挥发酚 加磷酸pH≤4 每升水样加2个硫酸铜 G 24h 500ml；8、氰化物 加NaOH pH12-13 G 24h 500ml；9、阴离子表面活性剂、氯化物、浑浊度 G 24h；10、悬浮物 P/G 现场过滤；11、盐度 P/G 现场测定 500ml；12、溶解氧 加1mlMnCl2和1ml碱性碘化钾 G 现场测定 500ml；13、五日生化需氧量 6h/冷冻48h G 500ml；14、无机氮(氨、硝酸盐、亚硝酸盐) 过滤 P/G 3h/-20度7d 1L；15、无机磷 过滤48h P/G 500ml；16、总磷、总氮 过滤 P/G 3h 500ml；17、化学需氧量 现场测定 P/G 500ml' },
    ] },
  ],
}

// 0384.pdf：kv(采样日期/海水浴场名称/沙滩长度) → kv(天气现象/气温/降水量/风向/风速/总云量/能见度/浪高/赤潮) → kv(保存方式定值)
// → table(检测断面名称/经纬度/采样深度/水温/检测项目/样品编号/保存方式/水色/嗅和味/沙滩环境/漂浮物质)，原件为每断面3行(肠球菌/粪大肠菌群/色嗅和味)
export const bathingBeach: Schema = {
  id: 'bathingBeach',
  title: () => '海水浴场采样记录',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 3, rows: [
      { label: '采样日期', key: 'samplingDate' },
      { label: '海水浴场名称', key: 'beachName' },
      { label: '沙滩长度', key: 'beachLength' },
    ] },
    { type: 'kv', id: 'weather', cols: 3, rows: [
      { label: '天气现象', key: 'weather' },
      { label: '气温(℃)', key: 'temp' },
      { label: '降水量', key: 'precip' },
      { label: '风向', key: 'windDir' },
      { label: '风速', key: 'windSpeed' },
      { label: '总云量', key: 'cloud' },
      { label: '能见度', key: 'visibility' },
      { label: '浪高', key: 'waveHeight' },
      { label: '赤潮', key: 'redTide' },
    ] },
    { type: 'kv', id: 'preserveNote', cols: 1, rows: [
      { label: '保存方式', fixed: true, value: '1、低温冷藏 2、避光 3、加硫酸至pH＜2 4、加盐酸至pH＜2 5、现场测定' },
    ] },
    { type: 'table', id: 'main', seedRows: 9, columns: [
      { key: 'section', label: '检测断面名称', kind: 'input', w: 140 },
      { key: 'lng', label: '经', group: '检测断面经纬度', kind: 'input', w: 70 },
      { key: 'lat', label: '纬', group: '检测断面经纬度', kind: 'input', w: 70 },
      { key: 'depth', label: '采样深度', unit: 'cm', kind: 'input', w: 70 },
      { key: 'waterTemp', label: '水温', unit: '℃', kind: 'input', w: 60 },
      { key: 'item', label: '检测项目', kind: 'input', w: 100 },
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 100 },
      { key: 'preserve', label: '保存方式', kind: 'input', w: 80 },
      { key: 'waterColor', label: '水色', kind: 'input', w: 60 },
      { key: 'smellTaste', label: '嗅和味', kind: 'input', w: 60 },
      { key: 'beachEnv', label: '沙滩环境', kind: 'input', w: 80 },
      { key: 'floating', label: '漂浮物质', kind: 'input', w: 80 },
    ] },
  ],
}

// 0339.pdf：kv(任务编号/企业名称/企业地址) → kv(检测日期/检测依据定值/仪器型号名称编号) → table(8列) → note备注；签字为 采样/校核/审核
export const cookingFumes: Schema = {
  id: 'cookingFumes',
  title: () => '饮食业油烟采样原始记录',
  columns: [], meta: [], signRoles: ['采样', '校核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 3, rows: [
      { label: '任务编号', key: 'taskNo' },
      { label: '企业名称', key: 'org' },
      { label: '企业地址', key: 'addr' },
    ] },
    { type: 'kv', id: 'meta', cols: 3, rows: [
      { label: '检测日期', key: 'testDate' },
      { label: '检测依据', fixed: true, value: 'GB18483-2001、DB37/597-2006、HJ 1077-2019' },
      { label: '仪器型号、名称及编号', key: 'instrument' },
    ] },
    { type: 'table', id: 'main', seedRows: 12, columns: [
      { key: 'point', label: '测点名称', kind: 'input', w: 100 },
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 100 },
      { key: 'Vnd', label: '标态采样体积Vnd', unit: 'L', kind: 'input', w: 100 },
      { key: 'stdFlow', label: '标干流量', unit: 'm3/h', kind: 'input', w: 90 },
      { key: 'burners', label: '运行灶头数n', unit: '个', kind: 'input', w: 80 },
      { key: 'stackHeight', label: '排气筒高度', unit: 'm', kind: 'input', w: 80 },
      { key: 'stackDia', label: '排气筒内径', unit: 'm', kind: 'input', w: 80 },
      { key: 'treatment', label: '治理设备/工艺', kind: 'input', w: 120 },
    ] },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 2 },
  ],
}

// 0390.pdf：kv(项目编号/受检单位/天气情况/采样日期,4列) → kv(点位名称/高程测量标识/点位坐标/筛管上端.../采样设备checks/筛管下端.../是否发现非水相液体/泵进水口.../洗井依据checks)
// → table(10列洗井参数) → kv(水质稳定标准定值) → checks×5(各仪器设备编号) → note其它 → note修订记录
export const groundwaterWellFlush: Schema = {
  id: 'groundwaterWellFlush',
  title: () => '地下水采样洗井记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 4, rows: [
      { label: '项目编号', key: 'projNo' },
      { label: '受检单位', key: 'org' },
      { label: '天气情况', key: 'weather' },
      { label: '采样日期', key: 'samplingDate' },
    ] },
    { type: 'kv', id: 'site', cols: 2, rows: [
      { label: '点位名称（监测井编号）', key: 'pointName' },
      { label: '高程测量标识', key: 'elevMark' },
      { label: '点位坐标', key: 'coord' },
      { label: '筛管上端距标识距离', key: 'screenTopDist' },
      { label: '采样设备', checks: ['贝勒管', '不锈钢潜水泵', '气囊泵', '其它'], checksKey: 'device' },
      { label: '筛管下端距标识距离', key: 'screenBottomDist' },
      { label: '是否发现非水相液体', key: 'nonAqueousPhase' },
      { label: '泵进水口距标识距离', key: 'pumpInletDist' },
      { label: '洗井依据', checks: ['HJ 164-2020地下水环境监测技术规范', 'HJ 1019-2019 地块土壤和地下水中挥发性有机物采样技术导则', '其它'], checksKey: 'flushBasis', colspan: 2 },
    ] },
    { type: 'table', id: 'main', seedRows: 12, columns: [
      { key: 'time', label: '时间', kind: 'input', w: 70 },
      { key: 'flowRate', label: '出水流速', unit: 'L/min', kind: 'input', w: 80 },
      { key: 'cumVol', label: '累计洗井体积', unit: 'L', kind: 'input', w: 90 },
      { key: 'pH', label: 'pH', unit: '无量纲', kind: 'input', w: 60 },
      { key: 'conductivity', label: '电导率', unit: 'µS/cm', kind: 'input', w: 80 },
      { key: 'turbidity', label: '浊度', unit: 'NTU', kind: 'input', w: 70 },
      { key: 't', label: '温度', unit: '℃', kind: 'input', w: 60 },
      { key: 'DO', label: '溶解氧', unit: 'mg/L', kind: 'input', w: 70 },
      { key: 'ORP', label: '氧化还原电位', unit: 'mV', kind: 'input', w: 90 },
      { key: 'note', label: '备注', kind: 'input', w: 80 },
    ] },
    { type: 'kv', id: 'stableStd', cols: 1, rows: [
      { label: '水质稳定标准', fixed: true, value: 'pH±0.1以内；电导率：±10%以内；浊度：≤10NTU或±10%以内；温度：±0.5℃以内；溶解氧：±0.3mg/L以内或±10%以内；氧化还原电位：±10mV以内或±10%以内。至少3项检测指标连续三次测定的变化达到以上稳定标准' },
    ] },
    { type: 'checks', id: 'devConductivity', label: '仪器名称型号：便携式电导率 设备编号', key: 'devConductivity', multi: true, options: ['TC-257'] },
    { type: 'checks', id: 'devTurbidity', label: '仪器名称型号：便携式浊度计 设备编号', key: 'devTurbidity', multi: true, options: ['TC130', 'TC-273', 'TC-274'] },
    { type: 'checks', id: 'devTemp', label: '仪器名称型号：表层水温计 设备编号', key: 'devTemp', multi: true, options: ['TC-73', 'TC-79'] },
    { type: 'checks', id: 'devPH', label: '仪器名称型号：便携式pH/ORP计 设备编号', key: 'devPH', multi: true, options: ['TC-258', 'TC-267', 'TC-268', 'TC-269', 'TC-270'] },
    { type: 'checks', id: 'devDO', label: '仪器名称型号：便携式溶解氧仪 设备编号', key: 'devDO', multi: true, options: ['TC-075', 'TC-271', 'TC-272'] },
    { type: 'note', id: 'other', label: '其它', key: 'other', rows: 1 },
    { type: 'kv', id: 'rev', cols: 1, rows: [
      { label: '修订记录', fixed: true, value: '2024/07/31 第一次修订' },
    ] },
  ],
}

// 0329.pdf：kv(方法及依据定值) → kv(被测单位/单位地址/排放类型checks/接待人/联系电话/监测日期/监测仪器checks/排气筒高度)
// → table(8列) → diagram(无组织排放采样点位布设示意图,东南西北指北针) → kv(臭气强度描述定值)；签字为 监测/复核/审核
export const odorConcentration: Schema = {
  id: 'odorConcentration',
  title: () => '臭气浓度监测原始记录',
  columns: [], meta: [], signRoles: ['监测', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'methodBasis', cols: 1, rows: [
      { label: '方法及依据', fixed: true, value: 'GB/T 14675-1993 空气质量 恶臭的测定 三点比较式臭袋法' },
    ] },
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '被测单位', key: 'org' },
      { label: '单位地址', key: 'addr' },
      { label: '排放类型', checks: ['无组织排放', '有组织排放'], checksKey: 'emissionType' },
      { label: '接待人', key: 'contact' },
      { label: '联系电话', key: 'phone' },
      { label: '监测日期', key: 'monitorDate' },
      { label: '监测仪器', checks: ['真空瓶——真空泵', '采气袋——真空采样箱'], checksKey: 'instrument' },
      { label: '排气筒高度(m)', key: 'stackHeight' },
    ] },
    { type: 'table', id: 'main', seedRows: 16, columns: [
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 100 },
      { key: 'point', label: '采样点位', kind: 'input', w: 80 },
      { key: 'time', label: '采样时间', kind: 'input', w: 80 },
      { key: 'windDir', label: '主导风向', kind: 'input', w: 70 },
      { key: 'temp', label: '环境温度', kind: 'input', w: 70 },
      { key: 'windSpeed', label: '风速', kind: 'input', w: 60 },
      { key: 'pressure', label: '大气压', kind: 'input', w: 70 },
      { key: 'intensity', label: '臭气强度', kind: 'input', w: 70 },
    ] },
    { type: 'diagram', id: 'diagram', label: '无组织排放采样点位布设示意图（东/南/西/北指北针；图例：○—臭气浓度采样点位）' },
    { type: 'kv', id: 'intensityDesc', cols: 1, rows: [
      { label: '臭气强度描述', fixed: true, value: '[0级：无臭无味] [1级：勉强感觉] [2级：气味较弱] [3级：容易感觉] [4级：气味强烈] [5级：无法忍受]' },
    ] },
  ],
}

// 0403.pdf HJ-TC-136：kv(受检单位名称/受检单位签字) → table(13列，样品描述5列分组) → kv(保存方法定值大段)
export const waterWastewaterSampling: Schema = {
  id: 'waterWastewaterSampling',
  title: () => '水和废水采样原始记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '受检单位名称', key: 'org' },
      { label: '受检单位签字', key: 'orgSign' },
    ] },
    { type: 'table', id: 'main', seedRows: 17, columns: [
      { key: 'point', label: '检测点位', kind: 'input', w: 100 },
      { key: 'time', label: '采样时间', kind: 'input', w: 80 },
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 110 },
      { key: 'item', label: '检测项目', kind: 'input', w: 180 },
      { key: 'volume', label: '采样体积', unit: 'ml', kind: 'input', w: 70 },
      { key: 'preserve', label: '保存容器及方法', kind: 'input', w: 90 },
      { key: 'waterColor', label: '水色', group: '样品描述', kind: 'input', w: 55 },
      { key: 'smell', label: '气味', group: '样品描述', kind: 'input', w: 55 },
      { key: 'oil', label: '浮油', group: '样品描述', kind: 'input', w: 55 },
      { key: 'floating', label: '漂浮物', group: '样品描述', kind: 'input', w: 60 },
      { key: 'anomaly', label: '其他异常现象', group: '样品描述', kind: 'input', w: 90 },
      { key: 'note', label: '备注', kind: 'input', w: 70 },
    ] },
    { type: 'kv', id: 'preserveNote', cols: 1, rows: [
      { label: '保存方法', fixed: true, value: '采样容器中：G-玻璃瓶 P-塑料瓶。样品保存方法：1.P重金属、铜、锌、铅、镉、铬、铁、锰、镍、银、钡、铍、硼、锡、铊：1L水样中加浓硝酸10ml；2.G挥发酚：加磷酸至pH约为2，每升水样加0.01-0.02g抗坏血酸去除残余氯；3.G COD/TOC/TN/TP/氨氮、高锰酸盐指数等：加硫酸至pH≤2；4.P总氰：加氢氧化钠至pH≥9，冷藏；5.G六价铬：加氢氧化钠，至pH8-9；6.P砷、硒、锑、铋：用原子荧光法测定，每升水样中加浓盐酸10毫升；7.G石油类和动植物油：500毫升棕色玻璃瓶，加盐酸pH值≤2；8.G甲醛：0.2-0.5g/L硫代硫酸钠（五水），冷藏避光；9.硫化物G：水样充满容器，每升水样加氢氧化钠调节pH值约为9，加入5%的抗坏血酸5ml，加EDTA 3ml，滴加饱和锌(AC)2至胶体产生常温避光；10.汞P：每升水样加10ml浓盐酸，pH≤1；11.G溶解氧：250毫升棕色溶解氧瓶，加1ml二价硫酸锰溶液和2ml碱性碘化物-叠氮化钠溶液（现场固定）；12.G总余氯：预先加入采样体积1% 2.0mol/L的氢氧化钠，pH>12低温避光；13.P总硬度、全盐量、氯化物、硫酸盐、硝酸盐氮、亚硝酸盐氮、浊度、溶解性总固体、色度、氟化物、磷酸盐、悬浮物等不加保存剂；14.G阴离子表面活性剂：低温避光；15.G（灭菌）或无菌袋：总大肠菌群、粪大肠菌群、细菌总数、大肠菌总数；16.P总α放射性、总β放射性：1L水样中加浓硝酸10ml，采样体积10L；17.G可吸附有机卤素：水样充满采样瓶HNO3，pH值1-2，冷藏、避光；18.G棕色瓶：丁基黄原酸，加盐酸调至中性，低温避光；19.P五日生化需氧量：1000毫升水样，冷藏、避光；20.砷DDTC法：盐酸2ml。注：如果在采样中，在以上查不到的项目的保存方法，请查阅《污水监测技术规范》HJ 91.1-2019 中的项目保存方法' },
    ] },
  ],
}

// 0402.pdf HJ-TC-146：kv(项目编号/单位名称/企业签字确认) → table(12列，水深/井深，样品外观描述3列分组) → kv(样品保存方法定值大段)
export const waterQualitySampling: Schema = {
  id: 'waterQualitySampling',
  title: () => '水质采样原始记录',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 3, rows: [
      { label: '项目编号', key: 'projNo' },
      { label: '单位名称', key: 'org' },
      { label: '企业签字确认', key: 'orgSign' },
    ] },
    { type: 'table', id: 'main', seedRows: 20, columns: [
      { key: 'time', label: '采样时间', kind: 'input', w: 80 },
      { key: 'point', label: '点位', kind: 'input', w: 90 },
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 110 },
      { key: 'item', label: '项目', kind: 'input', w: 200 },
      { key: 'volume', label: '采样体积', kind: 'input', w: 70 },
      { key: 'preserve', label: '保存方法', kind: 'input', w: 80 },
      { key: 'waterDepth', label: '水深', kind: 'input', w: 60 },
      { key: 'wellDepth', label: '井深', kind: 'input', w: 60 },
      { key: 'color', label: '颜色', group: '样品外观描述', kind: 'input', w: 60 },
      { key: 'smell', label: '气味', group: '样品外观描述', kind: 'input', w: 60 },
      { key: 'oil', label: '浮油', group: '样品外观描述', kind: 'input', w: 60 },
      { key: 'note', label: '备注', kind: 'input', w: 70 },
    ] },
    { type: 'kv', id: 'preserveNote', cols: 1, rows: [
      { label: '样品保存方法', fixed: true, value: '1.色度、嗅和味、浑浊度、肉眼可见物、pH、总硬度（以CaCO3计）、溶解性总固体、硫酸盐、氯化物、铁、阴离子合成洗涤剂、耗氧量（CODMn法，以O2计）、氟化物、铬（六价）、钾、钙、镁、钠、碘化物；2.锰、铜、锌、铝、镉、铅、镍、铍、锑、钡、钴、铊、银、钼——硝酸pH≤2；3.硝酸盐、亚硝酸盐、氨氮——硫酸pH≤2，4℃贮存；4.挥发性酚类、氰化物——氢氧化钠pH≥12，4℃贮存；5.总大肠菌群、菌落总数 J；6.硫化物——每100ml水中加入4滴乙酸锌溶液（200g/L）和氢氧化钠溶液（40g/L），避光 G棕色；7.汞 盐酸2ml；8.砷、硒、铍、锑 盐酸5ml；9.卤代烃——三氯甲烷、四氯化碳 2*40 加0.3g抗坏血酸；10.苯系物 2*40 1+1盐酸1ml、25mg抗坏血酸 pH小于2；11.总α、β放射性 盐酸pH小于2；12.石油类 盐酸pH小于2。G-玻璃瓶 P-塑料瓶 J-灭菌瓶 O-溶解氧瓶' },
    ] },
  ],
}

// 0410.pdf HJ-TC-201：kv(项目编号/天气) → kv(单位/电话/日期/目的/地点/层次/深度) → kv勾选×4(质地/湿度/根系/周围情况) → table(5列) → note备注
export const soilSampling: Schema = {
  id: 'soilSampling',
  title: () => '土壤采样记录',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 2, rows: [
      { label: '项目编号', key: 'projNo' },
      { label: '天气', key: 'weather' },
    ] },
    { type: 'kv', id: 'info', cols: 2, rows: [
      { label: '受检单位名称/地址', key: 'org', colspan: 2 },
      { label: '联系电话', key: 'phone' },
      { label: '采样日期', key: 'samplingDate' },
      { label: '检测目的', key: 'purpose' },
      { label: '采样地点', key: 'site' },
      { label: '采样层次', key: 'layer' },
      { label: '采样深度(cm)', key: 'depth' },
    ] },
    { type: 'kv', id: 'soilDesc', cols: 1, rows: [
      { label: '土壤质地', checks: ['砂土', '壤土', '砂壤土', '粘土'], checksKey: 'texture' },
      { label: '土壤湿度', checks: ['干', '潮', '湿', '重潮', '极潮'], checksKey: 'humidity' },
      { label: '土壤根系情况', checks: ['无根系', '少量', '中量', '多量', '根密集'], checksKey: 'roots' },
      { label: '采样地点周围情况', checks: ['村庄', '农田', '工厂', '森林', '草地', '山', '其他'], checksKey: 'surroundings' },
    ] },
    { type: 'table', id: 'main', seedRows: 10, columns: [
      { key: 'sampleNo', label: '土样编号', kind: 'id', w: 120 },
      { key: 'coords', label: '经纬度', kind: 'input', w: 140 },
      { key: 'character', label: '样品性状', kind: 'input', w: 120 },
      { key: 'amount', label: '采样量', unit: 'kg', kind: 'input', w: 80 },
      { key: 'item', label: '检测项目', kind: 'input', w: 220 },
    ] },
    { type: 'kv', id: 'itemHint', cols: 1, rows: [
      { label: '常见检测项目', fixed: true, value: 'pH值 / 含水率 / 有机质 / 汞 / 砷 / 铜 / 锌 / 铅 / 镉 / 铬 / 镍 / 阳离子交换量 / 其它' },
    ] },
    { type: 'note', id: 'remark', label: '备注', key: 'remark', rows: 2 },
  ],
}

// 0434.pdf HJ-TC-591：kv(委托单位) → kv(断面信息/日期天气/宽深/表观) → table(7列) → kv(注1~注7定值大段)
export const surfaceWaterLakeSampling: Schema = {
  id: 'surfaceWaterLakeSampling',
  title: () => '地表水（湖库）采样记录表',
  columns: [], meta: [], signRoles: ['采样', '复核', '审核'],
  seed: () => [],
  layout: [
    { type: 'kv', id: 'top', cols: 1, rows: [
      { label: '委托单位名称', key: 'org' },
    ] },
    { type: 'kv', id: 'section', cols: 2, rows: [
      { label: '水体/断面名称', key: 'sectionName' },
      { label: '断面周边环境描述', key: 'envDesc' },
      { label: '经度', key: 'lng' },
      { label: '纬度', key: 'lat' },
      { label: '采样日期(年月日)', key: 'samplingDate' },
      { label: '天气状况', key: 'weather' },
      { label: '水面宽度(m)约', key: 'width' },
      { label: '深度(m)约', key: 'depth' },
      { label: '断面水质表观', key: 'appearance', colspan: 2 },
    ] },
    { type: 'table', id: 'main', seedRows: 18, columns: [
      { key: 'time', label: '采样时间', unit: '时分', kind: 'input', w: 80 },
      { key: 'sampleNo', label: '样品编号', kind: 'id', w: 110 },
      { key: 'item', label: '监测项目', kind: 'input', w: 220 },
      { key: 'preserve', label: '材质/保存方式（填序号）', kind: 'input', w: 110 },
      { key: 'volume', label: '采样体积', unit: 'ml', kind: 'input', w: 80 },
      { key: 'pretreat', label: '前处理方式', kind: 'input', w: 90 },
      { key: 'desc', label: '样品颜色、气味、澄清度', kind: 'input', w: 130 },
    ] },
    { type: 'kv', id: 'notes', cols: 1, rows: [
      { label: '注', fixed: true, value: '注1 断面周边环境：有无排污口、是否死水区/回水区、有无居民区/工业区/农业区等。注2 天气状况：晴、雨、雪等。注3 断面水质表观：水体颜色、气味（嗅）、有无悬浮物或泥沙、水面有无油膜、水体有无藻类等。注4 样品状态感官描述包括：样品颜色、有无沉淀等。注5 前处理方式：①静置30min；②静置60min；③离心2000r/min,1min；④离心2000r/min,2min；⑤63μm筛网过滤；⑥0.45μm滤膜过滤。注6 保存剂名称：1.重金属、总铬：水样加硝酸，调节pH1-2；2.酚类：加磷酸至pH4.0，每升水样加1g硫酸铜；3.COD/TOC/TN/TP/氨氮、高锰酸盐指数、甲醛等：加硫酸至pH≤2；4.总氰：加氢氧化钠至pH≥12；5.六价铬：加氢氧化钠，至pH8-9；6.总砷：加盐酸2ml；7.油类：加盐酸至pH≤2；8.农药类等：加抗坏血酸0.01-0.02g；9.硫化物：每升水样加2ml 1mol/L的乙酸锌、1ml 1mol/L的氢氧化钠，2ml抗氧化剂；10.汞：每升水样加10ml浓盐酸，pH≤1；11.溶解氧：加1ml二价硫酸锰溶液，和2ml碱性碘化物-叠氮化物；12.总余氯：预先加入采样体积1% 2.0mol/L的氢氧化钠，pH>12；13.其他保存剂直接注明。注7 保存方式：①冷藏；②避光；③标签完好，采取有效减震措施；④其他保存方式直接注明。' },
    ] },
  ],
}

export const samplingForms: Record<string, Schema> = {
  'HJ-TC-136': waterWastewaterSampling,
  'HJ-TC-146': waterQualitySampling,
  'HJ-TC-201': soilSampling,
  'HJ-TC-591': surfaceWaterLakeSampling,
  'HJ-TC-143': wasteGasOrganized,
  'HJ-TC-145': ambientAir,
  'HJ-TC-279': wasteGasFugitiveBlank,
  'HJ-TC-389': wasteGasFugitive4x,
  'HJ-TC-630': wasteGasFugitive4xB,
  'HJ-TC-631': wasteGasFugitive1x,
  'HJ-TC-708': wasteGasFugitive1xParticulate,
  'HJ-TC-275': sediment,
  'HJ-TC-472': industrialSolidWaste,
  'HJ-TC-593': seawater,
  'HJ-TC-715': bathingBeach,
  'HJ-TC-608': cookingFumes,
  'HJ-TC-724': groundwaterWellFlush,
  'HJ-TC-595': odorConcentration,
}
