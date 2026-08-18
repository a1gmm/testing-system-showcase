<script setup lang="ts">
// 报告打印页（批次二）：照 0096"最新标准"制式排版——封面→委托信息+三签→检测结果
// （废水横表插槽 v1）→检测技术规范→报告说明（双语7条）。页码"第X页/共N页"、封面计页。
// 报告编号一号两显示（拍板）：系统 BG2026-0092 ↔ 纸质 No(环)字(2026)第(0092)号。
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api, type Report, type OrgProfile, type Instrument, type Contract } from '../api'
import { roundGB } from '../data/schemas'

const route = useRoute()
const rp = ref<Report | null>(null)
const org = ref<OrgProfile | null>(null)
const instMap = ref<Record<string, Instrument>>({})
const contract = ref<Contract | null>(null)
const err = ref('')
onMounted(async () => {
  try {
    const [r, o] = await Promise.all([api.getReport(String(route.params.id)), api.getOrgProfile()])
    rp.value = r; org.value = o
    try { for (const i of await api.listInstruments()) instMap.value[i.id] = i } catch { /* */ }
    if (r.contract_id) { try { contract.value = await api.getContract(r.contract_id) } catch { /* */ } }
  } catch (e: any) { err.value = e?.response?.data?.error || e?.message || String(e) }
})

// 一号两显示：BG2026-0092 → No(环)字(2026)第(0092)号；页眉简写 环字2026第0092号
const paperNo = computed(() => {
  const m = (rp.value?.id || '').match(/^BG(\d{4})-(\d+)$/)
  return m ? `No(环)字(${m[1]})第(${m[2]})号` : rp.value?.id || ''
})
const headerNo = computed(() => {
  const m = (rp.value?.id || '').match(/^BG(\d{4})-(\d+)$/)
  return m ? `环字${m[1]}第${m[2]}号` : rp.value?.id || ''
})
const results = computed(() => (rp.value?.data?.results ?? []) as any[])
const proc = computed(() => rp.value?.data?.process ?? null)
const sampleDate = computed(() => proc.value?.sampling?.fieldDate || proc.value?.sampling?.planDate || '')
const handoverTime = computed(() => {
  const hs = proc.value?.handovers ?? []
  const t = hs.map((h: any) => (h.at || '').slice(0, 10)).filter(Boolean)
  return [...new Set(t)].join('、')
})
// 检测日期区间：取记录结果无日期时退回采样日；比对报告一律按现场采样（样本 5/6 如此）
const isField = computed(() => results.value.some(r => r.pointName) || (rp.value?.data?.compareBlocks?.length > 0))
// 方法表按 类别+项目+方法 去重
const methodRows = computed(() => {
  const seen = new Set<string>(), rows: any[] = []
  for (const r of results.value) {
    const key = `${r.matrix}|${r.analyte}|${r.method}`
    if (seen.has(key)) continue
    seen.add(key)
    const inst = r.instrumentId ? instMap.value[r.instrumentId] : null
    rows.push({ matrix: r.matrix || '', analyte: r.analyte, method: r.method || '—', inst: inst ? `${inst.model || ''}${inst.name}` : '—', instNo: r.instrumentId || '' })
  }
  return rows
})
// 备注拼接器：L 说明（有未检出才加）+ 限值来源固定句（有限值才加）+ 分包声明（有分包项才加）
const remark = computed(() => {
  const parts: string[] = []
  if (results.value.some(r => String(r.value).startsWith('L'))) parts.push('结果有"L"表示未检出，其数值为该项目检出限。')
  if (results.value.some(r => r.limit)) parts.push('限值的数值由委托单位提供。')
  if (rp.value?.data?.subNote) parts.push(rp.value.data.subNote)
  return parts.join('')
})
// —— 地下水/土壤转置表插槽：项目做行、点位做列（照 0090/0091 制式）——
const isTransposed = computed(() => {
  const rs = results.value.filter(r => !r.qcType)
  return rs.length > 0 && rs.every(r => ['地下水', '土壤'].includes(r.matrix))
})
const tpCols = computed(() => {
  const seen = new Map<string, { sampleId: string; pointName: string }>()
  for (const r of results.value.filter(r => !r.qcType)) if (!seen.has(r.sampleId)) seen.set(r.sampleId, { sampleId: r.sampleId, pointName: r.pointName || '—' })
  return [...seen.values()]
})
const tpRows = computed(() => {
  const rows = new Map<string, { analyte: string; unit: string; sub: boolean; limit: string; cells: Record<string, any> }>()
  for (const r of results.value.filter(r => !r.qcType)) {
    if (!rows.has(r.analyte)) rows.set(r.analyte, { analyte: r.analyte, unit: r.unit || '', sub: !!r.sub, limit: r.limit || '/', cells: {} })
    rows.get(r.analyte)!.cells[r.sampleId] = r.value
  }
  return [...rows.values()]
})
// —— 有组织废气插槽：气类且点位不含风向字样（上/下风向属无组织，走横表）——
const isGasOrganized = computed(() => {
  const rs = results.value.filter(r => !r.qcType)
  return rs.length > 0 && rs.every(r => r.matrix === '有组织废气' || r.matrix === '废气') && !rs.some(r => /风向/.test(r.pointName || ''))
})
const stacks = computed(() => (rp.value?.data?.stacks ?? []) as any[])
// 现场参数只展示标量项（field_info 里还混着 confirms 等内部结构，不上报告）
const fieldInfo = computed(() => {
  const fi = (rp.value?.data?.fieldInfo ?? null) as Record<string, any> | null
  if (!fi) return null
  const out = Object.fromEntries(Object.entries(fi).filter(([, v]) => v != null && typeof v !== 'object'))
  return Object.keys(out).length ? out : null
})
const avgOf = (vals: any[]) => {
  const ns = vals.map(Number).filter(v => isFinite(v))
  return ns.length ? roundGB(ns.reduce((s, v) => s + v, 0) / ns.length, 3) : ''
}
// 竖排块：点位 → 项目 → 平行样列（0096 制式：样号/实测×N/平均/折算×N/平均/限值/速率×N/平均）
const gasBlocks = computed(() => {
  if (!isGasOrganized.value) return []
  const byPoint = new Map<string, Map<string, any[]>>()
  for (const r of results.value.filter(r => !r.qcType)) {
    const pt = r.pointName || '—'
    if (!byPoint.has(pt)) byPoint.set(pt, new Map())
    const byA = byPoint.get(pt)!
    if (!byA.has(r.analyte)) byA.set(r.analyte, [])
    byA.get(r.analyte)!.push(r)
  }
  return [...byPoint.entries()].map(([point, byA]) => {
    const analytes = [...byA.entries()].map(([analyte, rows]) => ({
      analyte, unit: rows[0]?.unit || '', sub: rows.some(r => r.sub),
      samples: rows.map(r => r.sampleId), values: rows.map(r => r.value), avg: avgOf(rows.map(r => r.value)),
      correcteds: rows.map(r => r.corrected), avgCorrected: rows.some(r => r.corrected !== '' && r.corrected != null) ? avgOf(rows.map(r => r.corrected)) : '',
      rates: rows.map(r => r.rate), avgRate: rows.some(r => r.rate !== '' && r.rate != null) ? avgOf(rows.map(r => r.rate)) : '',
      limit: rows[0]?.limit || '/',
    }))
    return {
      point, analytes,
      cols: Math.max(...analytes.map(a => a.samples.length)),
      stack: stacks.value.find((s: any) => s.name === point) || null,
    }
  })
})
// 排气筒静态档案标签（地基3 stack_info 的键 → 表内中文）
const STACK_LABELS: Record<string, string> = {
  daCode: '排污许可排放口', height: '排气筒高度(m)', diameter: '内径(m)',
  process: '净化方式', fuel: '燃料', boiler: '锅炉型号', capacity: '锅炉容量(t/h)',
}
const hasAnnex = computed(() => isGasOrganized.value && stacks.value.some(s => s.stack_info))
// —— 比对插槽：报告带 compareBlocks 即走比对版式（0098~0103 制式）——
const compareBlocks = computed(() => (rp.value?.data?.compareBlocks ?? []) as any[])
const isCompare = computed(() => compareBlocks.value.length > 0)
// 二、水污染在线监测仪器运行技术指标（静态转录 HJ 355/354 要点，样本报告逐字固定此表）
const TECH_RULES: [string, string][] = [
  ['CODcr', '≥100mg/L ±15%；60~100mg/L ±20%；30~60mg/L ±30%；<30mg/L 用20-25mg/L标样替代 ±5mg/L'],
  ['氨氮', '≥2mg/L ±15%；<2mg/L ±0.3mg/L（1.5mg/L标样替代）'],
  ['总磷', '≥0.4mg/L ±15%；<0.4mg/L ±0.04mg/L'],
  ['总氮', '≥2mg/L ±15%；<2mg/L ±0.3mg/L'],
  ['pH', '绝对误差不超过±0.5'],
  ['超声波明渠流量计', '10分钟累计流量比对误差±10%；液位比对误差12mm（6组）'],
  ['质控样（0.5倍量程标样）', '相对误差≤±10%'],
  ['比对数量规则', '比对试验总数不少于3对：3对至少2对满足、4对至少3对满足、5对以上至少4对满足'],
]
const CMP_TYPE_LABEL: Record<string, string> = { conc: '实际水样测定', pH: '实际水样测定（pH）', qc: '质控样品测定', flow: '流量比对', level: '液位比对' }
// 噪声等带测量时间的结果（resultSummary.time 透传），横表自动加"测量时间"列
const hasTimeCol = computed(() => results.value.some(r => !r.qcType && r.time))
// 分包星号：项目名里已带 * 就不再叠加
const starred = (analyte: string, sub?: boolean) => (sub && !String(analyte).startsWith('*') ? '*' : '') + analyte
// 附表键值两两一行
function stackRows(info: Record<string, any>): [string, any, string, any][] {
  const entries = Object.entries(info || {}).filter(([k]) => STACK_LABELS[k]).map(([k, v]) => [STACK_LABELS[k], v] as [string, any])
  const rows: [string, any, string, any][] = []
  for (let i = 0; i < entries.length; i += 2) rows.push([entries[i][0], entries[i][1], entries[i + 1]?.[0] ?? '', entries[i + 1]?.[1] ?? ''])
  return rows
}
// —— 分页引擎：长表按行数切成多个 .page，页码全部算出来（修：页码写死，内容一多就与实际张数不符）——
function chunkBy<T>(items: T[], weight: (t: T) => number, cap: number): T[][] {
  const out: T[][] = []; let cur: T[] = []; let w = 0
  for (const it of items) {
    const iw = Math.max(1, weight(it))
    if (cur.length && w + iw > cap) { out.push(cur); cur = []; w = 0 }
    cur.push(it); w += iw
  }
  if (cur.length) out.push(cur)
  return out.length ? out : [[]]
}
// 质控样口径统一：平行/空白/质控样是内部质控数据，不上客户报告（原横表会印出来，与转置/竖排口径不一）
const plainResults = computed(() => results.value.filter(r => !r.qcType))
const plainChunks = computed(() => chunkBy(plainResults.value, () => 1, 20))
const tpChunks = computed(() => chunkBy(tpRows.value, () => 1, 18))
const gasChunks = computed(() => chunkBy(gasBlocks.value, b => 1 + b.analytes.length * 8, 24))
const compareChunks = computed(() => chunkBy(compareBlocks.value, b => 4 + (b.pairs?.length || 0), 20))
const methodChunks = computed(() => chunkBy(methodRows.value, () => 1, 20))
const annexStacks = computed(() => stacks.value.filter((x: any) => x.stack_info))
const annexChunks = computed(() => (hasAnnex.value ? chunkBy(annexStacks.value, (s: any) => 2 + stackRows(s.stack_info).length, 18) : []))
const resultPages = computed(() => (isCompare.value ? 1 + compareChunks.value.length : isGasOrganized.value ? gasChunks.value.length : isTransposed.value ? tpChunks.value.length : plainChunks.value.length))
const methodStart = computed(() => 3 + resultPages.value)
const annexStart = computed(() => methodStart.value + methodChunks.value.length)
const declPage = computed(() => annexStart.value + annexChunks.value.length)
const totalPages = computed(() => declPage.value)
const wm = computed(() => !!rp.value && rp.value.status !== 'issued')
const slash = (v: any) => (v === '' || v == null ? '/' : v)
const d = (iso?: string | null) => (iso ? iso.slice(0, 10) : '')
function doPrint() { window.print() }
// 直接输 URL 进来的标签 window.close() 无效——关不掉就退回报告页
function doClose() { window.close(); setTimeout(() => { location.href = '/reports' }, 200) }
</script>

<template>
  <div class="printwrap">
    <div class="toolbar noprint">
      <button class="btn primary" @click="doPrint">🖨 打印 / 导出 PDF</button>
      <button class="btn" @click="doClose">关闭</button>
      <span v-if="rp && rp.status !== 'issued'" class="tip warn">未签发——打印带水印，仅供内部校对</span>
    </div>
    <div v-if="err" class="errbox noprint">{{ err }}</div>

    <template v-if="rp && org">
      <!-- P1 封面 -->
      <div class="page cover">
        <div v-if="rp.status !== 'issued'" class="wm" aria-hidden="true">未签发，仅供内部校对</div>
        <div class="logo"><b>天 辰 检 测</b><span>{{ org.name_en || 'Example Environmental Testing' }}</span></div>
        <div class="copytag">正本</div>
        <div class="ctitle">检 测 报 告</div>
        <div class="csub">（Testing Report)</div>
        <table class="ctbl">
          <tbody>
            <tr><td class="k">报告编号（Report ID）：</td><td>{{ paperNo }}</td></tr>
            <tr><td class="k">报告名称：<br><span class="en">（Report Description）</span></td><td>{{ rp.title }}</td></tr>
            <tr><td class="k">委托单位:<br><span class="en">（Applicant）</span></td><td>{{ rp.client }}</td></tr>
            <tr><td class="k">受检单位:<br><span class="en">（Inspected unit）</span></td><td>{{ rp.client }}</td></tr>
          </tbody>
        </table>
        <div class="cfoot">
          <div class="corg">{{ org.name }}</div>
          <div class="cdate">{{ d(rp.issued_at) || d(rp.created_at) }}</div>
        </div>
        <div class="pfoot">第 1 页/共 {{ totalPages }} 页</div>
      </div>

      <!-- P2 委托单位信息 + 签字区 -->
      <div class="page">
        <div v-if="wm" class="wm" aria-hidden="true">未签发，仅供内部校对</div>
        <div class="phead"><span>报告编号：{{ headerNo }}</span><span>{{ org.name }}</span></div>
        <div class="sec">一、委托单位信息</div>
        <table class="ftbl">
          <tbody>
            <tr><td class="k">委托单位</td><td>{{ rp.client }}</td><td class="k">样品交接时间</td><td>{{ handoverTime || '—' }}</td></tr>
            <tr><td class="k">受检单位</td><td>{{ rp.client }}</td><td class="k">样品来源</td><td>{{ isField ? '现场采样、现场检测' : '委托方送样' }}</td></tr>
            <tr><td class="k">受检单位地址</td><td>{{ (contract as any)?.address || '—' }}</td><td class="k">检测日期</td><td>{{ sampleDate || d(rp.created_at) }}</td></tr>
            <tr><td class="k">联系人</td><td>{{ contract?.contact || '—' }}</td><td class="k">联系方式</td><td>{{ (contract as any)?.phone || '—' }}</td></tr>
          </tbody>
        </table>
        <div class="signs">
          <span>报告编写人：{{ rp.data?.author || rp.author || '' }}</span>
          <span>审核人：{{ rp.checker || '' }}</span>
          <span>批准人：{{ rp.issuer || '' }}</span>
        </div>
        <div class="signs2">
          <span>时间：{{ d(rp.issued_at) || '　　年　　月　　日' }}</span>
          <span class="seal">(检验检测专用章)</span>
        </div>
        <div class="pfoot">第 2 页/共 {{ totalPages }} 页</div>
      </div>

      <!-- 结果页（自动分页）：比对=技术指标独占一页+比对块分页；其余插槽按行数切页 -->
      <template v-if="isCompare">
        <div class="page">
          <div v-if="wm" class="wm" aria-hidden="true">未签发，仅供内部校对</div>
          <div class="phead"><span>报告编号：{{ headerNo }}</span><span>{{ org.name }}</span></div>
          <div class="sec">二、水污染在线监测仪器运行技术指标</div>
          <table class="ftbl">
            <thead><tr><th>仪器类型</th><th>技术指标要求</th></tr></thead>
            <tbody><tr v-for="(t, ti) in TECH_RULES" :key="ti"><td class="k">{{ t[0] }}</td><td style="text-align:left">{{ t[1] }}</td></tr></tbody>
          </table>
          <div class="pfoot">第 3 页/共 {{ totalPages }} 页</div>
        </div>
        <div v-for="(chunk, ci) in compareChunks" :key="'cmp' + ci" class="page">
          <div v-if="wm" class="wm" aria-hidden="true">未签发，仅供内部校对</div>
          <div class="phead"><span>报告编号：{{ headerNo }}</span><span>{{ org.name }}</span></div>
          <div class="sec">三、比对检测结果{{ ci ? '（续）' : '' }}</div>
          <table v-for="(b, bi) in chunk" :key="bi" class="ftbl res cmp">
            <tbody>
              <tr><td class="k" colspan="4">{{ CMP_TYPE_LABEL[b.type] || '比对测定' }} · {{ b.analyte }}</td></tr>
              <tr><td class="k">比对时间</td><td class="k">在线仪器测定值</td><td class="k">实验室仪器测定值</td><td class="k">{{ b.errType }}</td></tr>
              <tr v-for="(p, pi) in b.pairs" :key="pi">
                <td>{{ p.time || '—' }}</td><td class="num">{{ p.online }}</td><td class="num">{{ p.lab }}</td>
                <td class="num">{{ b.errs?.[pi] }}{{ b.errType === '相对误差' ? '%' : '' }}</td>
              </tr>
              <tr v-if="b.stdValue != null"><td class="k">标准样品浓度</td><td class="num" colspan="3">{{ b.stdValue }}</td></tr>
              <tr>
                <td class="k">判定标准</td><td colspan="1" style="text-align:left">{{ b.limitText }}</td>
                <td class="k">结果判定</td><td><b>{{ b.pass ? '合格' : '不合格' }}</b></td>
              </tr>
            </tbody>
          </table>
          <table v-if="ci === compareChunks.length - 1" class="ftbl res">
            <tbody>
              <tr v-if="remark"><td class="k">备注</td><td>{{ remark }}</td></tr>
              <tr><td class="k">结论</td><td>{{ rp.conclusion }}</td></tr>
            </tbody>
          </table>
          <div class="pfoot">第 {{ 4 + ci }} 页/共 {{ totalPages }} 页</div>
        </div>
      </template>

      <!-- 有组织废气插槽：0096 制式竖排块（项目×排气筒，平行样N列），块不跨页拆 -->
      <template v-else-if="isGasOrganized">
        <div v-for="(chunk, ci) in gasChunks" :key="'gas' + ci" class="page">
          <div v-if="wm" class="wm" aria-hidden="true">未签发，仅供内部校对</div>
          <div class="phead"><span>报告编号：{{ headerNo }}</span><span>{{ org.name }}</span></div>
          <div class="sec">二、检测结果{{ ci ? '（续）' : '' }}</div>
          <table v-for="(b, bi) in chunk" :key="bi" class="ftbl res gas">
            <tbody>
              <tr>
                <td class="k">采样点位</td>
                <td :colspan="b.cols + 1"><b>{{ b.point }}</b><template v-if="b.stack?.stack_info?.daCode">（{{ b.stack.stack_info.daCode }}）</template>
                  　采样日期：{{ sampleDate || d(rp.created_at) }}</td>
              </tr>
              <template v-for="a in b.analytes" :key="a.analyte">
                <tr>
                  <td class="k" rowspan="8">{{ starred(a.analyte, a.sub) }}<template v-if="a.unit">（{{ a.unit }}）</template></td>
                  <td class="k">样品编号</td><td v-for="(s, i) in a.samples" :key="i" class="num">{{ s }}</td>
                </tr>
                <tr><td class="k">实测浓度</td><td v-for="(v, i) in a.values" :key="i" class="num">{{ v }}</td></tr>
                <tr><td class="k">平均实测浓度</td><td :colspan="a.samples.length" class="num">{{ slash(a.avg) }}</td></tr>
                <tr><td class="k">折算浓度</td><td v-for="(v, i) in a.correcteds" :key="i" class="num">{{ slash(v) }}</td></tr>
                <tr><td class="k">平均折算浓度</td><td :colspan="a.samples.length" class="num">{{ slash(a.avgCorrected) }}</td></tr>
                <tr><td class="k">限值</td><td :colspan="a.samples.length" class="num">{{ a.limit || '/' }}</td></tr>
                <tr><td class="k">排放速率(kg/h)</td><td v-for="(v, i) in a.rates" :key="i" class="num">{{ slash(v) }}</td></tr>
                <tr><td class="k">平均排放速率(kg/h)</td><td :colspan="a.samples.length" class="num">{{ slash(a.avgRate) }}</td></tr>
              </template>
            </tbody>
          </table>
          <table v-if="ci === gasChunks.length - 1" class="ftbl res">
            <tbody>
              <tr v-if="remark"><td class="k">备注</td><td>{{ remark }}</td></tr>
              <tr><td class="k">结论</td><td>{{ rp.conclusion }}</td></tr>
            </tbody>
          </table>
          <div class="pfoot">第 {{ 3 + ci }} 页/共 {{ totalPages }} 页</div>
        </div>
      </template>

      <!-- 地下水/土壤转置表插槽：项目做行、点位做列（0090/0091 制式） -->
      <template v-else-if="isTransposed">
        <div v-for="(chunk, ci) in tpChunks" :key="'tp' + ci" class="page">
          <div v-if="wm" class="wm" aria-hidden="true">未签发，仅供内部校对</div>
          <div class="phead"><span>报告编号：{{ headerNo }}</span><span>{{ org.name }}</span></div>
          <div class="sec">二、检测结果{{ ci ? '（续）' : '' }}</div>
          <table class="ftbl res">
            <thead>
              <tr>
                <th>检测项目</th>
                <th v-for="c2 in tpCols" :key="c2.sampleId">{{ c2.pointName }}<br><span class="num">{{ c2.sampleId }}</span></th>
                <th>限值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in chunk" :key="row.analyte">
                <td>{{ starred(row.analyte, row.sub) }}<template v-if="row.unit">（{{ row.unit }}）</template></td>
                <td v-for="c2 in tpCols" :key="c2.sampleId" class="num">{{ row.cells[c2.sampleId] ?? '/' }}</td>
                <td class="num">{{ row.limit }}</td>
              </tr>
              <template v-if="ci === tpChunks.length - 1">
                <tr v-if="remark"><td class="k">备注</td><td :colspan="tpCols.length + 1">{{ remark }}</td></tr>
                <tr><td class="k">结论</td><td :colspan="tpCols.length + 1">{{ rp.conclusion }}</td></tr>
              </template>
            </tbody>
          </table>
          <div class="pfoot">第 {{ 3 + ci }} 页/共 {{ totalPages }} 页</div>
        </div>
      </template>

      <!-- 默认横表插槽：废水/送样/无组织/噪声流水表（噪声带测量时间列，照 0089/0096 制式） -->
      <template v-else>
        <div v-for="(chunk, ci) in plainChunks" :key="'pl' + ci" class="page">
          <div v-if="wm" class="wm" aria-hidden="true">未签发，仅供内部校对</div>
          <div class="phead"><span>报告编号：{{ headerNo }}</span><span>{{ org.name }}</span></div>
          <div class="sec">二、检测结果{{ ci ? '（续）' : '' }}</div>
          <table class="ftbl res">
            <thead>
              <tr>
                <th>{{ isField ? '采样日期' : '送样日期' }}</th>
                <th>{{ isField ? '采样点位' : '样品标识' }}</th>
                <th v-if="hasTimeCol">测量时间</th>
                <th>样品编号</th><th>检测项目</th><th>检测结果</th><th>限值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in chunk" :key="i">
                <td>{{ sampleDate || d(rp.created_at) }}</td>
                <td>{{ r.pointName || '—' }}</td>
                <td v-if="hasTimeCol">{{ r.time || '—' }}</td>
                <td class="num">{{ r.sampleId }}</td>
                <td>{{ starred(r.analyte, r.sub) }}<template v-if="r.unit">（{{ r.unit }}）</template></td>
                <td class="num">{{ r.value }}</td>
                <td class="num">{{ r.limit || '/' }}</td>
              </tr>
              <template v-if="ci === plainChunks.length - 1">
                <tr v-if="remark"><td class="k">备注</td><td :colspan="hasTimeCol ? 6 : 5">{{ remark }}</td></tr>
                <tr><td class="k">结论</td><td :colspan="hasTimeCol ? 6 : 5">{{ rp.conclusion }}</td></tr>
              </template>
            </tbody>
          </table>
          <div class="pfoot">第 {{ 3 + ci }} 页/共 {{ totalPages }} 页</div>
        </div>
      </template>

      <!-- 检测技术规范、依据及使用仪器（自动分页） -->
      <div v-for="(chunk, mi) in methodChunks" :key="'m' + mi" class="page">
        <div v-if="wm" class="wm" aria-hidden="true">未签发，仅供内部校对</div>
        <div class="phead"><span>报告编号：{{ headerNo }}</span><span>{{ org.name }}</span></div>
        <div class="sec">{{ isCompare ? '四' : '三' }}、检测技术规范、依据及使用仪器{{ mi ? '（续）' : '' }}</div>
        <table class="ftbl">
          <thead><tr><th>样品类别</th><th>分析项目</th><th>分析方法和依据</th><th>仪器设备</th></tr></thead>
          <tbody>
            <tr v-for="(m, i) in chunk" :key="i">
              <td>{{ m.matrix }}</td><td>{{ m.analyte }}</td><td>{{ m.method }}</td>
              <td>{{ m.inst }}<template v-if="m.instNo"> {{ m.instNo }}</template></td>
            </tr>
          </tbody>
        </table>
        <div v-if="!hasAnnex && mi === methodChunks.length - 1" class="endmark">*******本报告结束*******</div>
        <div class="pfoot">第 {{ methodStart + mi }} 页/共 {{ totalPages }} 页</div>
      </div>

      <!-- 附表(可选)：排气筒参数统计表（有组织废气，地基3静态档案 + 现场参数，自动分页） -->
      <div v-for="(chunk, ai) in annexChunks" :key="'ax' + ai" class="page">
        <div v-if="wm" class="wm" aria-hidden="true">未签发，仅供内部校对</div>
        <div class="phead"><span>报告编号：{{ headerNo }}</span><span>{{ org.name }}</span></div>
        <div class="sec">{{ isCompare ? '五' : '四' }}、附表：排气筒废气检测期间参数统计表{{ ai ? '（续）' : '' }}</div>
        <table v-for="(s, si) in chunk" :key="si" class="ftbl stacktbl">
          <tbody>
            <tr><td class="k">排气筒名称</td><td>{{ s.name }}</td><td class="k">采样日期</td><td>{{ sampleDate || d(rp.created_at) }}</td></tr>
            <tr v-for="(row, ri) in stackRows(s.stack_info)" :key="ri">
              <td class="k">{{ row[0] }}</td><td>{{ row[1] }}</td>
              <td class="k">{{ row[2] }}</td><td>{{ row[3] }}</td>
            </tr>
            <tr v-if="fieldInfo && Object.keys(fieldInfo).length"><td class="k">现场参数</td>
              <td colspan="3">{{ Object.entries(fieldInfo).map(([k, v]) => `${k}：${v}`).join('　') }}</td></tr>
          </tbody>
        </table>
        <div v-if="ai === annexChunks.length - 1" class="endmark">*******本报告结束*******</div>
        <div class="pfoot">第 {{ annexStart + ai }} 页/共 {{ totalPages }} 页</div>
      </div>

      <!-- 末页 检测报告说明（双语7条，静态） -->
      <div class="page">
        <div v-if="wm" class="wm" aria-hidden="true">未签发，仅供内部校对</div>
        <div class="phead"><span>报告编号：{{ headerNo }}</span><span>{{ org.name }}</span></div>
        <div class="sec center">检测报告说明<br><span class="en">Instructions of Testing Report</span></div>
        <ol class="decl">
          <li>本报告无"检验检测专用章"无效，无骑缝章无效。<br><span class="en">The report is invalid without special seal for inspection and testing or seal on the perforation.</span></li>
          <li>本报告无编制人、审核人、批准人签字无效。<br><span class="en">The report is invalid without signatures of compiler, auditor and approver.</span></li>
          <li>本报告部分复制、转让、涂改无效。<br><span class="en">The report is invalid if partially copied, transferred or altered.</span></li>
          <li>未经本单位书面同意，本报告不得用于广告宣传。<br><span class="en">Without written approval, the report shall not be used for advertising.</span></li>
          <li>委托检测仅对所送样品负责，委托方对样品的代表性和资料的真实性负责。<br><span class="en">For commissioned testing, we are only responsible for the samples submitted.</span></li>
          <li>对本报告若有异议，应于收到报告之日起十五日内向本单位书面提出。<br><span class="en">Any objection should be submitted in written form within 15 days upon receipt.</span></li>
          <li>本单位对委托方的技术资料负有保密义务。<br><span class="en">We are obliged to keep the client's technical information confidential.</span></li>
        </ol>
        <div class="orgfoot">
          <p>单位地址：{{ org.address }}　邮编：{{ org.postcode }}</p>
          <p>电话：{{ org.phone }}　传真：{{ org.fax }}</p>
        </div>
        <div class="pfoot">第 {{ declPage }} 页/共 {{ totalPages }} 页</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.printwrap{background:#e8e8e8;min-height:100vh;padding:20px 0;font-family:"Songti SC","SimSun",serif;color:#000}
.toolbar{max-width:794px;margin:0 auto 14px;display:flex;align-items:center;gap:10px}
.btn{padding:8px 20px;border:1px solid #bbb;border-radius:6px;background:#fff;font-size:14px;cursor:pointer}
.btn.primary{background:#2563eb;color:#fff;border-color:#2563eb}
.tip.warn{color:#b45309;font-weight:600;font-size:12px}
.errbox{max-width:794px;margin:0 auto;padding:14px;background:#fee;border:1px solid #fbb;border-radius:8px;color:#900}
.page{width:794px;min-height:1050px;margin:0 auto 20px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.15);padding:60px 70px 70px;box-sizing:border-box;position:relative}
.pfoot{position:absolute;bottom:28px;left:0;right:0;text-align:center;font-size:12px}
.phead{display:flex;justify-content:space-between;font-size:11px;border-bottom:1px solid #000;padding-bottom:4px;margin-bottom:18px}
.sec{font-size:16px;font-weight:700;margin:8px 0 12px}
.sec.center{text-align:center;font-size:20px;margin-bottom:20px}
.sec .en{font-size:13px;font-weight:400}
/* 封面 */
.wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:rotate(-30deg);font-size:42px;color:rgba(200,60,60,.18);font-weight:700;pointer-events:none}
.logo{display:flex;align-items:baseline;gap:10px}
.logo b{font-size:26px;letter-spacing:6px}
.logo span{font-size:13px;color:#333}
.copytag{text-align:right;font-size:15px;border:1px solid #000;width:52px;margin-left:auto;text-align:center;padding:2px 0}
.ctitle{text-align:center;font-size:40px;font-weight:700;letter-spacing:16px;margin:110px 0 6px}
.csub{text-align:center;font-size:16px;margin-bottom:80px}
.ctbl{width:86%;margin:0 auto;border-collapse:collapse;font-size:15px}
.ctbl td{padding:14px 6px;vertical-align:top;border-bottom:1px solid #999}
.ctbl .k{width:190px;white-space:nowrap}
.ctbl .en{font-size:12px;color:#444}
.cfoot{position:absolute;bottom:110px;left:0;right:0;text-align:center}
.corg{font-size:20px;font-weight:700;letter-spacing:4px}
.cdate{font-size:15px;margin-top:10px}
/* 表 */
.ftbl{width:100%;border-collapse:collapse;font-size:13.5px}
.ftbl td,.ftbl th{border:1px solid #000;padding:9px 10px;line-height:1.7;text-align:center}
.ftbl th{background:#fafafa;font-weight:600}
.ftbl .k{background:#fafafa;white-space:nowrap}
.ftbl.res td{padding:8px 8px}
.num{font-variant-numeric:tabular-nums}
.signs{display:flex;justify-content:space-between;margin:26px 8px 0;font-size:14px}
.signs2{display:flex;justify-content:space-between;margin:16px 8px 0;font-size:14px}
.signs2 .seal{color:#333}
.endmark{text-align:center;margin-top:30px;font-size:14px;letter-spacing:2px}
.decl{padding-left:1.4em;font-size:13.5px}
.decl li{margin:12px 0;line-height:1.8}
.decl .en{font-size:11.5px;color:#444}
.orgfoot{margin-top:40px;font-size:13px;text-align:center}
@media print {
  @page{size:A4;margin:12mm}
  .noprint{display:none}
  .printwrap{background:#fff;padding:0}
  .page{box-shadow:none;margin:0;width:auto;min-height:auto;page-break-after:always}
  .page:last-child{page-break-after:auto}
  /* 封面高度固定，绝对定位的 cfoot（单位名+日期）才不会上浮压住信息表 */
  .page.cover{min-height:263mm}
  .ftbl tr{break-inside:avoid}
  .ftbl.gas,.ftbl.cmp,.stacktbl{break-inside:avoid}
  .pfoot{position:static;margin-top:24px}
}
</style>
