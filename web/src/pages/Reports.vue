<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import RecordAttachments from '../components/RecordAttachments.vue'
import { api, currentUser, type Report, type RecordRow } from '../api'
import { can } from '../permissions'
import { settleAll } from '../utils/settle'

const reports = ref<Report[]>([])
const approved = ref<RecordRow[]>([])
const rounds = ref<import('../api').DueRound[]>([])
const samplesAll = ref<import('../api').Sample[]>([])
const selected = ref<Report | null>(null)
const loading = ref(false)
const keyword = ref('')
// 报告按合同分组（无合同的散样归"散样/自送样"一组），组内保持原倒序
const reportGroups = computed(() => {
  const m = new Map<string, { key: string; client: string; items: Report[] }>()
  for (const r of shownReports.value) {
    const key = r.contract_id || '散样'
    if (!m.has(key)) m.set(key, { key, client: r.client || '（散样/自送样）', items: [] })
    m.get(key)!.items.push(r)
  }
  return [...m.values()]
})
const shownReports = computed(() => reports.value.filter(r => {
  if (!keyword.value) return true
  const k = keyword.value.toLowerCase()
  // 样号反查（批次二修补）：期次报告 sample_id 为空，关键词也要能命中报告内每行结果的样品编号
  return (r.id + r.client + (r.sample_id || '') + (r.contract_id || '') + r.title).toLowerCase().includes(k)
    || (r.data?.results || []).some((x: any) => String(x.sampleId || '').toLowerCase().includes(k))
}))

// 一期一报告：该期全部样品都审完、且这期还没出过（未作废的）报告
const eligibleRounds = computed(() => {
  const has = new Set(reports.value.filter(r => !r.voided).map(r => r.round_id).filter(Boolean))
  return rounds.value.filter(r => r.status === 'done' && (r.sample_count || 0) > 0 && r.rollup === 'approved' && !has.has(r.id))
})
// 合同总报告：该合同所有期都完成且都出过期报告、还没出过总报告
const eligibleTotals = computed(() => {
  const byContract = new Map<string, { total: number; done: number; reported: number; client: string }>()
  for (const r of rounds.value) {
    if (!r.contract_id) continue
    const e = byContract.get(r.contract_id) || { total: 0, done: 0, reported: 0, client: r.client || '' }
    e.total++; if (r.status === 'done') e.done++
    if (reports.value.some(rp => rp.round_id === r.id && !rp.voided)) e.reported++
    byContract.set(r.contract_id, e)
  }
  const hasTotal = new Set(reports.value.filter(r => !r.round_id && !r.sample_id && !r.voided).map(r => r.contract_id))
  return [...byContract.entries()]
    .filter(([cid, e]) => e.total > 1 && e.done === e.total && e.reported === e.total && !hasTotal.has(cid))
    .map(([cid, e]) => ({ contractId: cid, client: e.client, rounds: e.total }))
})
async function genTotal(contractId: string) {
  if (genBusy.value) return
  genBusy.value = true
  try {
    const rep = await api.generateContractReport(contractId)
    ElMessage.success('已生成合同总报告 ' + rep.id)
    await refresh(); selected.value = rep
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { genBusy.value = false }
}
// 决策17：签发后要改走作废重出
const canVoid = () => can('report_issue')
// —— 批次三：发放登记 + 归档清单 ——
const deliveries = ref<any[]>([])
const archive = ref<{ section: string; items: { type: string; id: string; label: string }[] }[]>([])
const archiveOpen = ref(false)
async function loadDeliveries() {
  deliveries.value = []
  if (selected.value?.status !== 'issued') return
  try { deliveries.value = await api.listReportDeliveries(selected.value.id) } catch { /* */ }
}
watch(() => selected.value?.id, loadDeliveries, { immediate: false })
async function doDeliver() {
  if (!selected.value) return
  try {
    const { value } = await ElMessageBox.prompt('发放方式+份数+领取人，如：自取 2份 老王', '报告发放登记', { confirmButtonText: '登记', cancelButtonText: '取消', inputPlaceholder: '自取 2份 张三' })
    if (!value?.trim()) return
    const m = value.match(/(自取|邮寄|电子送达)?\s*(\d+)?\s*份?\s*(.*)/)
    await api.addReportDelivery(selected.value.id, { method: m?.[1] || '自取', copies: m?.[2] ? Number(m[2]) : 1, receiver: (m?.[3] || '').trim() || undefined })
    ElMessage.success('已登记发放')
    await loadDeliveries()
  } catch { /* 取消 */ }
}
async function showArchive() {
  if (!selected.value) return
  try { archive.value = await api.archiveIndex(selected.value.id); archiveOpen.value = true }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}

async function doVoid() {
  if (!selected.value) return
  try {
    const { value } = await ElMessageBox.prompt(
      `作废已签发的报告 ${selected.value.id}？作废后全程留痕，可重新生成新报告（新报告会标注重出自本报告）。填作废原因：`,
      '作废报告', { confirmButtonText: '作废', cancelButtonText: '取消', inputPlaceholder: '如：结果誊录错误' })
    if (!value?.trim()) return ElMessage.warning('作废原因必填')
    selected.value = await api.voidReport(selected.value.id, value.trim())
    ElMessage.success('报告已作废，可重新生成'); await refresh()
  } catch { /* 取消 */ }
}
// 散样（免采样、不属于任何期）的单样报告
const eligible = computed(() => {
  const roundless = new Set(samplesAll.value.filter(s => !s.round_id).map(s => s.id))
  const m = new Map<string, { sampleId: string; n: number }>()
  for (const r of approved.value) {
    if (!roundless.has(r.sample_id)) continue
    const e = m.get(r.sample_id) || { sampleId: r.sample_id, n: 0 }
    e.n++; m.set(r.sample_id, e)
  }
  const done = new Set(reports.value.map(r => r.sample_id))
  return [...m.values()].filter(e => !done.has(e.sampleId))
})

async function refresh() {
  loading.value = true
  // 逐个降级：一个接口挂掉不该把整个报告列表清空
  const r = await settleAll([
    { p: api.listReports(), fallback: [] as Report[] },
    { p: api.listRecordsByStatus('approved'), fallback: [] as RecordRow[] },
    { p: api.listAllRounds(), fallback: [] as import('../api').DueRound[] },
    { p: api.listSamples(), fallback: [] as import('../api').Sample[] },
  ] as const)
  ;[reports.value, approved.value, rounds.value, samplesAll.value] = r.values
  if (selected.value) selected.value = reports.value.find(r2 => r2.id === selected.value!.id) || selected.value
  if (!r.ok) ElMessage.warning(`有 ${r.failed} 项数据没加载出来，「可出报告」清单可能不全`)
  loading.value = false
}
const genBusy = ref(false)   // 防双击：后端也有查重，双保险
async function genRound(roundId: string) {
  if (genBusy.value) return
  genBusy.value = true
  try {
    const rep = await api.generateRoundReport(roundId)
    ElMessage.success('已生成本期报告 ' + rep.id)
    await refresh(); selected.value = rep
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { genBusy.value = false }
}
async function gen(sampleId: string) {
  if (genBusy.value) return
  genBusy.value = true
  try {
    const rep = await api.generateReport(sampleId)
    ElMessage.success('已生成报告 ' + rep.id)
    await refresh(); selected.value = rep
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { genBusy.value = false }
}
async function saveField(field: 'title' | 'conclusion', val: string) {
  if (!selected.value || selected.value.status !== 'draft') return   // 只有编制中(草稿)能改
  try { selected.value = await api.updateReport(selected.value.id, { [field]: val }); await refresh() }
  catch (e: any) { ElMessage.error('保存失败：' + (e?.response?.data?.error || e?.message || e)) }  // 保存没成不能装没事
}
const canGen = () => can('report_generate')
const canEdit = () => can('report_update')
const canCheck = () => can('report_check')
const canSign = () => can('report_issue')
async function doCheck() {
  if (!selected.value) return
  const ok = await ElMessageBox.confirm(`确认审核通过报告 ${selected.value.id}？审核后交授权签字人签发，签发前不再可改。`, '报告审核', { confirmButtonText: '审核通过', cancelButtonText: '取消', type: 'warning' }).catch(() => null)
  if (!ok) return
  try { selected.value = await api.checkReport(selected.value.id); ElMessage.success('报告已审核'); await refresh() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
// §8.1：已审核的报告不能直接改内容——发现问题退回编制（带原因留痕）
async function doReject() {
  if (!selected.value) return
  try {
    const { value } = await ElMessageBox.prompt(`把报告 ${selected.value.id} 退回编制？退回后编制人可修改重走审核。填退回原因：`, '退回编制',
      { confirmButtonText: '退回', cancelButtonText: '取消', inputPlaceholder: '如：结论表述不当' })
    if (!value?.trim()) return ElMessage.warning('退回原因必填')
    selected.value = await api.rejectReport(selected.value.id, value.trim())
    ElMessage.success('已退回编制'); await refresh()
  } catch { /* 取消 */ }
}
// 删除草稿：只删没签发的（draft/checked），删了可重新生成；防连点
const delBusy = ref(false)
async function doDelete() {
  if (!selected.value || delBusy.value) return
  const ok = await ElMessageBox.confirm(`删除报告草稿 ${selected.value.id}？删了就没了，需要时可重新生成。`, '删除草稿', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }).catch(() => null)
  if (!ok) return
  delBusy.value = true
  try {
    await api.deleteReport(selected.value.id)
    ElMessage.success('草稿已删除')
    selected.value = null
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { delBusy.value = false }
}
const RSTATUS: Record<string, string> = { draft: '编制中', checked: '待签发', issued: '已签发' }
// 状态圆点语义（仅展示用）：编制中=待办、待签发=进行中、已签发=完成
const RDOT: Record<string, string> = { draft: 'warn', checked: 'accent', issued: 'good' }
const issueBusy = ref(false)
async function issue() {
  if (!selected.value || issueBusy.value) return
  const me = currentUser.value?.name || ''
  const ok = await ElMessageBox.confirm(`以授权签字人「${me}」签发盖章？签发后报告不可再改。`, '签发盖章', { confirmButtonText: '签发盖章', cancelButtonText: '取消', type: 'warning' }).catch(() => null)
  if (!ok) return
  issueBusy.value = true
  try {
    selected.value = await api.issueReport(selected.value.id)
    ElMessage.success('报告已签发'); await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { issueBusy.value = false }
}
function fmt(iso?: string | null) { return iso ? iso.slice(0, 10) : '' }
// 打印 / 导出 PDF：浏览器原生打印，弹窗里选「另存为 PDF」即可（零依赖、数据不出境）
// 批次二：打印走 0096 制式专用页（封面/委托信息/结果/方法表/双语声明五段）；屏显视图保持不变
function printReport() {
  if (selected.value) window.open(`/reports/${encodeURIComponent(selected.value.id)}/print`, '_blank')
  else window.print()
}
// 新报告不再自动判达标（决策15）：限值列供人工对照；verdict 列只对老报告（已存判定）显示
const hasVerdict = computed(() => (selected.value?.data?.results || []).some((r: any) => r.verdict))
const hasLimit = computed(() => (selected.value?.data?.results || []).some((r: any) => r.limit))
const overCount = computed(() => (selected.value?.data?.results || []).filter((r: any) => r.verdict === '超标').length)

onMounted(refresh)
</script>

<template>
  <div class="pagewrap wide rpage">
    <div class="phead">
      <div>
        <h1 class="page">报告签发</h1>
        <p class="sub">一期一报告 · 编制 → 审核 → 授权签字人签发盖章</p>
      </div>
      <span class="hcount num">共 {{ reports.length }} 份</span>
    </div>

    <div class="split">
      <div class="left">
        <section class="sec-elig">
          <div class="sechead">
            <h2>可出报告</h2>
            <span v-if="eligibleRounds.length + eligible.length" class="seccount num">{{ eligibleRounds.length + eligible.length }} 项</span>
          </div>
          <div class="card elig">
            <!-- 一期一报告（主路） -->
            <div v-for="r in eligibleRounds" :key="r.id" class="erow">
              <span class="ername">{{ r.client }} <b>第{{ r.round_no }}期</b></span>
              <span class="en"><span class="num">{{ r.sample_count }}</span> 样品已全审核</span>
              <el-button size="small" type="primary" :disabled="!canGen()" :title="canGen() ? '' : '报告编制需要登记员/技术负责人权限'" @click="genRound(r.id)">出本期报告</el-button>
            </div>
            <!-- 合同总报告（项目结束按合同汇总一份，决策17） -->
            <div v-for="t in eligibleTotals" :key="t.contractId" class="erow">
              <span class="ername">{{ t.client }} <b>总报告</b></span>
              <span class="en"><span class="num">{{ t.rounds }}</span> 期已全部出报告</span>
              <el-button size="small" type="primary" plain :disabled="!canGen()" @click="genTotal(t.contractId)">出总报告</el-button>
            </div>
            <!-- 散样单报告 -->
            <div v-for="e in eligible" :key="e.sampleId" class="erow">
              <span class="mono ername">{{ e.sampleId }}</span>
              <span class="en"><span class="num">{{ e.n }}</span> 项已审核</span>
              <el-button size="small" :disabled="!canGen()" :title="canGen() ? '' : '报告编制需要登记员/技术负责人权限'" @click="gen(e.sampleId)">出单样报告</el-button>
            </div>
            <div v-if="!eligibleRounds.length && !eligible.length" class="ehint">暂无。某一期的<b>全部样品</b>走完三级审核后，这里会出现「出本期报告」。</div>
          </div>
        </section>

        <section class="sec-list">
          <div class="sechead">
            <h2>报告列表</h2>
            <span v-if="keyword" class="seccount num">{{ shownReports.length }} / {{ reports.length }}</span>
          </div>
          <div class="card listcard">
            <div class="sbar"><input v-model="keyword" class="search" placeholder="搜报告号 / 单位 / 样品 / 委托号…" /></div>
            <div class="list" v-loading="loading">
              <!-- 按合同分组（2026-07-31：全部平铺会混在一起） -->
              <div v-for="g in reportGroups" :key="g.key" class="rgrp">
                <div class="rgrp-head">
                  <b>{{ g.client }}</b>
                  <span class="mono rgrp-cid">{{ g.key }}</span>
                  <span class="rgrp-n num">{{ g.items.length }} 份</span>
                </div>
                <div v-for="r in g.items" :key="r.id" class="item ingrp" :class="{ on: selected?.id === r.id }" @click="selected = r">
                  <div class="itop">
                    <span class="rid mono">{{ r.id }}</span>
                    <span v-if="r.voided" class="rst"><span class="sdot crit"></span>已作废</span>
                    <span v-else class="rst"><span class="sdot" :class="RDOT[r.status]"></span>{{ RSTATUS[r.status] || r.status }}</span>
                  </div>
                  <div class="isub">{{ r.round_id ? `第${r.data?.round?.no ?? '?'}期 · ${r.data?.results?.length ?? 0} 项结果` : `样品 ${r.sample_id}` }}</div>
                </div>
              </div>
              <div v-if="!shownReports.length && !loading" class="empty">{{ reports.length ? '没有匹配的报告' : '还没有报告' }}</div>
            </div>
          </div>
        </section>
      </div>

      <div class="right card">
        <div v-if="selected" class="rpwrap">
          <div class="rptoolbar">
            <span class="mono rpid">{{ selected.id }}</span>
            <div class="rpt-actions">
              <el-button @click="printReport"><el-icon><Printer /></el-icon><span class="btxt">打印 / 导出 PDF</span></el-button>
              <template v-if="selected.status === 'draft'">
                <el-button v-if="canGen()" size="small" :loading="delBusy" :disabled="delBusy" @click="doDelete">删除草稿</el-button>
                <el-button type="primary" :disabled="!canCheck()" :title="canCheck() ? '' : '需要复核员/审核员/技术负责人权限'" @click="doCheck">{{ canCheck() ? '报告审核 →' : '待审核' }}</el-button>
              </template>
              <template v-else-if="selected.status === 'checked'">
                <span class="pill accent"><span class="sdot accent"></span>已审核 · {{ selected.checker }}</span>
                <el-button v-if="canGen()" size="small" :loading="delBusy" :disabled="delBusy" @click="doDelete">删除草稿</el-button>
                <el-button v-if="canCheck()" size="small" @click="doReject">退回编制</el-button>
                <el-button type="primary" :disabled="!canSign()" :title="canSign() ? '' : '需要授权签字人权限'" @click="issue">{{ canSign() ? '签发盖章 →' : '待签发' }}</el-button>
              </template>
              <template v-else>
                <span v-if="selected.voided" class="pill crit"><span class="sdot crit"></span>已作废 · {{ selected.voided_by }}：{{ selected.void_reason }}</span>
                <el-button v-if="selected.voided" size="small" @click="doDeliver">收回登记</el-button>
                <template v-else>
                  <span class="pill good"><span class="sdot good"></span>已签发 · {{ selected.issuer }} · {{ fmt(selected.issued_at) }}</span>
                  <el-button size="small" @click="doDeliver">发放登记</el-button>
                  <el-button v-if="canVoid()" size="small" @click="doVoid">作废重出</el-button>
                </template>
              </template>
              <el-button size="small" text type="primary" @click="showArchive">归档清单</el-button>
            </div>
          </div>
          <!-- 发放登记记录（签发后） -->
          <div v-if="deliveries.length" class="card" style="padding:10px 16px;margin-bottom:12px">
            <b style="font-size:13px">发放登记</b>
            <div v-for="dv in deliveries" :key="dv.id" style="font-size:12.5px;color:var(--muted);margin-top:4px">
              {{ dv.at?.slice(0, 16).replace('T', ' ') }} · {{ dv.method }} {{ dv.copies }}份 · 领取人：{{ dv.receiver || '—' }} · 发放人：{{ dv.deliverer }}
            
              <RecordAttachments type="delivery" :id="String(dv.id)" />
            </div>
          </div>
          <!-- 归档清单（装订顺序索引，照扫描包实证顺序） -->
          <el-dialog v-model="archiveOpen" title="归档清单（装订顺序）" width="560px">
            <div v-for="sec in archive" :key="sec.section" style="margin-bottom:10px">
              <b style="font-size:13px">{{ sec.section }}</b>
              <div v-if="!sec.items.length" style="font-size:12px;color:var(--faint)">（无）</div>
              <div v-for="it in sec.items" :key="it.type + it.id" style="font-size:12.5px;color:var(--muted)">· {{ it.label }}</div>
            </div>
          </el-dialog>
          <div class="paper">
            <!-- 未签发的报告打印带斜向水印，防止草稿被当正式报告用（只在打印时显示） -->
            <div v-if="selected.status !== 'issued'" class="print-watermark" aria-hidden="true">未签发，仅供内部校对</div>
            <div class="rp-h">
              <div class="rp-org">示例环境检测技术服务有限公司</div>
              <input v-if="selected.status === 'draft' && canEdit()" class="rp-title" :value="selected.title" @change="saveField('title', ($event.target as HTMLInputElement).value)" />
              <div v-else class="rp-title-fixed">{{ selected.title }}</div>
              <div class="rp-no mono">报告编号：{{ selected.id }}</div>
            </div>
            <table class="rp-info">
              <tr>
                <td class="k">委托单位</td><td>{{ selected.client || '—' }}</td>
                <td class="k">{{ selected.round_id ? '监测期次' : '样品编号' }}</td>
                <td class="mono">{{ selected.round_id ? `第 ${selected.data?.round?.no ?? '?'} 期 · ${fmt(selected.data?.round?.due)}` : selected.sample_id }}</td>
              </tr>
              <tr><td class="k">委托单号</td><td class="mono">{{ selected.contract_id || '—' }}</td><td class="k">签发日期</td><td>{{ fmt(selected.issued_at) || '（未签发）' }}</td></tr>
            </table>
            <div v-if="selected.reissue_of" class="rp-reissue mono">本报告系作废报告 {{ selected.reissue_of }} 的重出版本</div>
            <div v-if="selected.data?.qcWarning && selected.status !== 'issued'" class="rp-qcwarn">{{ selected.data.qcWarning }}</div>

            <!-- 过程信息（决策17：报告串全过程——方案→谁何时去哪采→交接→分析分工） -->
            <template v-if="selected.data?.process">
              <div class="rp-sec">监测过程</div>
              <table class="rp-info rp-proc">
                <tr v-if="selected.data.process.scheme">
                  <td class="k">监测方案</td>
                  <td colspan="3">{{ selected.data.process.scheme.id }} · 审核 {{ selected.data.process.scheme.reviewer || '—' }}<template v-if="selected.data.process.scheme.standards?.length"> · 执行标准 {{ selected.data.process.scheme.standards.join('、') }}</template></td>
                </tr>
                <tr v-if="selected.data.process.sampling">
                  <td class="k">现场采样</td>
                  <td colspan="3">第 {{ selected.data.process.sampling.roundNo }} 期 · 采样员 {{ selected.data.process.sampling.sampler || '—' }} · 采样日期 {{ selected.data.process.sampling.fieldDate || selected.data.process.sampling.planDate || fmt(selected.data.process.sampling.sampledAt) }}<template v-if="selected.data.process.sampling.weather"> · 天气 {{ selected.data.process.sampling.weather }}</template></td>
                </tr>
                <tr v-if="selected.data.process.points?.length">
                  <td class="k">采样点位</td>
                  <td colspan="3">
                    <span v-for="p in selected.data.process.points" :key="p.code" class="rp-pt">
                      {{ p.code }} {{ p.name }}<template v-if="p.actual && p.actual !== p.planned">（实际：{{ p.actual }}）</template><template v-if="p.source === 'field'">（现场补）</template>
                    </span>
                  </td>
                </tr>
                <tr v-if="selected.data.process.handovers?.length">
                  <td class="k">样品交接</td>
                  <td colspan="3">{{ selected.data.process.handovers.length }} 个样品交接，签收 {{ [...new Set(selected.data.process.handovers.map((h: any) => h.confirmedBy).filter(Boolean))].join('、') || '—' }}</td>
                </tr>
                <tr v-if="selected.data.process.tasks?.length">
                  <td class="k">分析分工</td>
                  <td colspan="3">{{ [...new Set(selected.data.process.tasks.map((t: any) => `${t.analyte}→${t.assignee}`))].join(' · ') }}</td>
                </tr>
              </table>
            </template>
            <template v-if="selected.data?.kind === 'total' && selected.data?.rounds?.length">
              <div class="rp-sec">各期采样一览</div>
              <table class="rp-info rp-proc">
                <tr v-for="r in selected.data.rounds" :key="r.no">
                  <td class="k">第 {{ r.no }} 期</td>
                  <td colspan="3">约定 {{ r.due }} · 采样员 {{ r.sampler || '—' }} · 完成 {{ fmt(r.sampledAt) || '—' }}</td>
                </tr>
              </table>
            </template>
            <div class="rp-sec">检测结果<span v-if="hasLimit" class="rp-note">（标准限值供人工比对判定）</span></div>
            <table class="rp-res">
              <thead><tr>
                <th v-if="selected.data?.kind === 'total'">期次</th>
                <th v-if="selected.round_id || selected.data?.kind === 'total'">样品编号</th><th>检测项目</th><th>检测方法</th><th>结果</th><th>单位</th>
                <th v-if="hasLimit">标准限值</th><th v-if="hasVerdict">单项判定</th><th>记录号</th>
              </tr></thead>
              <tbody>
                <tr v-for="(r, i) in (selected.data?.results || [])" :key="i">
                  <td v-if="selected.data?.kind === 'total'" class="num">第{{ r.roundNo }}期</td>
                  <td v-if="selected.round_id || selected.data?.kind === 'total'" class="mono">{{ r.sampleId }}</td>
                  <td>{{ r.analyte || '—' }}</td><td>{{ r.method || '—' }}</td>
                  <td class="v num">{{ r.value }}</td><td>{{ r.unit }}</td>
                  <td v-if="hasLimit" class="mono lim">{{ r.limit || '—' }}</td>
                  <td v-if="hasVerdict">
                    <span v-if="r.verdict" class="vd" :class="r.verdict === '超标' ? 'over' : 'ok'">
                      <span class="sdot" :class="r.verdict === '超标' ? 'crit' : 'good'"></span>{{ r.verdict }}
                    </span>
                    <span v-else class="vd none">—</span>
                  </td>
                  <td class="mono">{{ r.serial || r.code }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="hasVerdict" class="rp-verdict" :class="overCount ? 'over' : 'ok'">
              <span v-if="overCount" class="pill crit"><span class="sdot crit"></span>有 <span class="num">{{ overCount }}</span> 项超标</span>
              <span v-else class="pill good"><span class="sdot good"></span>所检项目全部达标</span>
            </div>
            <div class="rp-sec">结论</div>
            <template v-if="selected.status === 'draft' && canEdit()">
              <textarea class="rp-concl" :value="selected.conclusion" @change="saveField('conclusion', ($event.target as HTMLTextAreaElement).value)"></textarea>
              <!-- 打印时结论用 div 完整展开——textarea 是固定高度，长结论打出来会被截掉 -->
              <div class="rp-concl-print">{{ selected.conclusion }}</div>
            </template>
            <div v-else class="rp-concl-fixed">{{ selected.conclusion }}</div>

            <!-- 报告声明：CMA 报告标准有效性条款 -->
            <div class="rp-decl">
              <div class="rp-decl-h">声明</div>
              <ol>
                <li>本报告无“检验检测专用章”（CMA）或检测单位公章无效。</li>
                <li>本报告无编制、审核、批准（授权签字）人签字无效。</li>
                <li>复制报告未重新加盖检验检测专用章无效；报告涂改、增删无效。</li>
                <li>结果中“—”表示未检出或低于方法检出限。</li>
                <li>对本报告若有异议，应于收到报告之日起十五日内向本单位提出。</li>
              </ol>
            </div>

            <div class="rp-sign">
              <div class="rp-by">
                <div>编制：<b>{{ selected.data?.author || '—' }}</b><br><span class="sdate mono">{{ fmt(selected.created_at) || '' }}</span></div>
                <div>审核：<b>{{ selected.checker || selected.data?.reviewer || '—' }}</b><br><span class="sdate mono">{{ fmt(selected.checked_at) || '（待审核）' }}</span></div>
              </div>
              <div class="rp-seal-wrap">
                <template v-if="selected.status === 'issued'">
                  <div class="rp-seal">检验检测<br>专用章<br><small>CMA</small></div>
                  <div>授权签字人：<b>{{ selected.issuer }}</b><br><span class="mono">{{ fmt(selected.issued_at) }}</span></div>
                </template>
                <div v-else class="rp-nosign">签发后此处盖章</div>
              </div>
            </div>
            <div class="rp-foot">报告编号 {{ selected.id }} · 以下空白</div>
          </div>
        </div>
        <div v-else class="empty rempty">左侧选一份报告，或先生成一份</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 页头 */
.phead{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
.hcount{color:var(--faint);font-size:12.5px;padding-top:9px}
.seccount{font-size:12px;color:var(--faint)}

/* 双栏：页头固定，两栏各自内滚 */
.rpage{display:flex;flex-direction:column;height:calc(100vh - 58px - 44px)}
.split{flex:1;min-height:0;display:grid;grid-template-columns:320px 1fr;gap:16px}
.left{display:flex;flex-direction:column;min-height:0;gap:20px}
.sec-elig{flex:none}
.sec-list{flex:1;min-height:0;display:flex;flex-direction:column}

/* 可出报告：队列行 */
.elig{padding:2px 0;max-height:196px;overflow-y:auto}
.erow{display:flex;align-items:center;gap:9px;padding:9px 14px;font-size:12.5px;border-bottom:1px solid var(--line)}
.erow:last-child{border-bottom:0}
.ername{font-weight:600;font-size:12.5px}
.ername b{color:var(--accent-ink)}
.en{color:var(--faint);flex:1}
.ehint{font-size:12px;color:var(--faint);padding:14px;line-height:1.6}
.ehint b{font-weight:600;color:var(--muted)}

/* 报告列表 */
.listcard{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.sbar{padding:10px 12px;border-bottom:1px solid var(--line)}
.search{width:100%;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 10px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.search:focus{outline:2px solid var(--accent);outline-offset:-1px}
.list{flex:1;min-height:0;overflow-y:auto}
/* 报告按合同分组 */
.rgrp{border-bottom:1px solid var(--line)}
.rgrp-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--surface-2);font-size:12.5px}
.rgrp-cid{color:var(--faint);font-size:11px}
.rgrp-n{font-size:11px;background:var(--accent-soft);color:var(--accent-ink);border-radius:10px;padding:1px 8px;font-weight:600;margin-left:auto}
.item.ingrp{padding-left:26px}
.item{padding:11px 14px;cursor:pointer;border-bottom:1px solid var(--line);border-left:2px solid transparent;transition:background .12s ease}
.item:last-child{border-bottom:0}
.item:hover{background:var(--surface-2)}
.item.on{background:var(--accent-soft);border-left-color:var(--accent)}
.itop{display:flex;align-items:center;justify-content:space-between;gap:8px}
.rid{font-size:13px;font-weight:600}
.rst{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);white-space:nowrap}
.isub{font-size:12px;color:var(--muted);margin-top:4px}
.empty{padding:24px 16px;text-align:center;color:var(--faint);font-size:13px}

/* 右栏：报告预览 */
.right{overflow:hidden;display:flex;flex-direction:column}
.rempty{margin:auto}
.rpwrap{display:flex;flex-direction:column;height:100%;min-height:0}
.rptoolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);flex:none}
.rpid{font-weight:600;font-size:13px}
.rpt-actions{display:flex;align-items:center;gap:10px}
.rpt-actions .btxt{margin-left:5px}
.paper{flex:1;overflow-y:auto;padding:28px 40px;background:var(--surface-2)}

/* 报告纸 */
.rp-h{text-align:center;border-bottom:2px solid var(--ink);padding-bottom:14px;margin-bottom:14px}
.rp-org{font-size:13px;color:var(--muted)}
.rp-title,.rp-title-fixed{font-size:22px;font-weight:700;text-align:center;letter-spacing:2px;margin:8px 0;width:100%;border:0;background:transparent;font-family:inherit;color:var(--ink)}
.rp-title{border-bottom:1px solid var(--line-strong)}
.rp-title:focus{outline:none;border-bottom-color:var(--accent)}
.rp-no{font-size:12px;color:var(--muted)}
.rp-info{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px}
.rp-info td{border:1px solid var(--line-strong);padding:7px 10px}
.rp-info .k{background:var(--surface);color:var(--muted);width:90px;font-weight:600}
.rp-sec{font-size:14px;font-weight:700;margin:16px 0 8px;padding-left:8px;border-left:3px solid var(--accent)}
.rp-res{width:100%;border-collapse:collapse;font-size:13px}
.rp-res th,.rp-res td{border:1px solid var(--line-strong);padding:8px 10px;text-align:center}
.rp-res th{background:var(--surface);color:var(--muted);font-weight:600}
.rp-res .v{font-weight:700;font-family:var(--font-mono);color:var(--ink)}
.rp-res .lim{color:var(--muted);font-size:12px}
.rp-note{font-size:11px;font-weight:400;color:var(--muted);margin-left:8px}
/* 单项判定：圆点 + 墨字，不铺底色（一列全是胶囊=噪音） */
.vd{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--ink)}
.vd.none{color:var(--faint);font-weight:400}
.rp-verdict{margin:14px 0 4px}
.rp-concl,.rp-concl-fixed{width:100%;min-height:56px;font-size:13px;line-height:1.7;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:10px;font-family:inherit;color:var(--ink);background:var(--surface);box-sizing:border-box}
/* 打印专用的结论 div / 未签发水印：屏幕上不显示 */
.rp-concl-print{display:none}
.print-watermark{display:none}
.rp-concl:focus{outline:2px solid var(--accent);outline-offset:-1px}
.rp-sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:32px;font-size:13px}
.rp-seal-wrap{display:flex;align-items:center;gap:22px;position:relative}
.rp-seal{width:88px;height:88px;border:3px solid #c0392b;border-radius:50%;color:#c0392b;display:grid;place-items:center;text-align:center;font-size:12px;font-weight:700;line-height:1.35;transform:rotate(-14deg);opacity:.86}
.rp-seal small{font-size:9px}
.rp-nosign{font-size:12px;color:var(--faint)}
.rp-by{display:flex;gap:26px}
.rp-by .sdate{font-size:11px;color:var(--faint)}
.rp-reissue{font-size:11.5px;color:var(--crit);margin:-10px 0 12px}
.rp-qcwarn{font-size:12px;color:var(--crit);background:var(--crit-soft);border-radius:var(--radius-sm);padding:7px 10px;margin:0 0 12px}
.rp-proc td{font-size:12px}
.rp-pt{display:inline-block;margin-right:12px}
.rp-decl{margin-top:26px;border-top:1px solid var(--line-strong);padding-top:12px}
.rp-decl-h{font-size:12px;font-weight:700;color:var(--muted);margin-bottom:4px;letter-spacing:.05em}
.rp-decl ol{margin:0;padding-left:18px;font-size:11.5px;color:var(--muted);line-height:1.8}
.rp-foot{margin-top:22px;text-align:center;font-size:11px;color:var(--faint);border-top:1px solid var(--line);padding-top:8px}

@media (max-width:1100px){
  .split{grid-template-columns:280px 1fr}
  .paper{padding:20px}
  .hcount{display:none}
}

/* 手机：双栏堆叠 + 报告纸/结果表横滚 */
@media (max-width:760px){
  .rpage{height:auto}
  .split{grid-template-columns:1fr}
  .list{max-height:40vh}
  .paperwrap{overflow-x:auto}
  .rp-res{display:block;overflow-x:auto}
}
</style>

<!-- 打印专用：只印报告纸，隐藏侧栏/工具栏/其余界面（未 scoped，作用到打印全局） -->
<style>
@media print {
  body * { visibility: hidden !important; }
  .paper, .paper * { visibility: visible !important; }
  .paper { position: absolute; left: 0; top: 0; width: 100%; padding: 0 6mm !important; background: #fff !important; overflow: visible !important; }
  .rp-title, .rp-title-fixed, .rp-concl, .rp-concl-fixed { color: #000 !important; }
  .rp-concl { border-style: solid !important; }
  /* 结论：打印时藏 textarea（固定高度会截断），换完整展开的 div */
  textarea.rp-concl { display: none !important; }
  .rp-concl-print { display: block !important; width: 100%; min-height: 56px; font-size: 13px; line-height: 1.7; border: 1px solid #333; border-radius: 4px; padding: 10px; color: #000 !important; box-sizing: border-box; white-space: pre-wrap; }
  /* 未签发水印：斜着盖一层，每页都有（position:fixed 打印时逐页重复） */
  .print-watermark { display: block !important; position: fixed; top: 45%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg); font-size: 46px; font-weight: 700; letter-spacing: 10px; white-space: nowrap; color: rgba(192, 57, 43, .22) !important; z-index: 9999; pointer-events: none; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* 状态圆点是背景色，必须强制打印出来，否则「超标/达标」在纸上分不出 */
  .paper .sdot { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .paper .pill { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .paper .vd.over { color: #c0392b !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .paper .vd.ok { color: #2f7a4e !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .rp-verdict.over .pill { color: #c0392b !important; }
  .rp-verdict.ok .pill { color: #2f7a4e !important; }
  .rp-seal { border-color: #c0392b !important; color: #c0392b !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  @page { size: A4; margin: 14mm 10mm; }
}
</style>
