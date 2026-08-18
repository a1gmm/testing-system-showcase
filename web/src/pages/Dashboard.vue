<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import templates from '../data/templates.json'
import { api, currentUser, hasRole, type DueRound, type ProjectSummary, type RecordRow, type Sample, type Report, type StatsOverview } from '../api'
import { PAGE_ROLES } from '../permissions'
import { settleAll } from '../utils/settle'

const router = useRouter()

// —— 我的待办：一眼看到今天该干啥 ——
const due = ref<DueRound[]>([])
const projects = ref<ProjectSummary[]>([])
const submitted = ref<RecordRow[]>([])
const reviewed = ref<RecordRow[]>([])
const samples = ref<Sample[]>([])
const reports = ref<Report[]>([])
const resAlerts = ref<import('../api').ResourceAlert[]>([])
const pendingHo = ref<import('../api').Handover[]>([])
const myTasks = ref<import('../api').TestTask[]>([])
const cAlerts = ref<{ id: string; client: string; project: string; period_end: string; bucket: string }[]>([])
const stats = ref<StatsOverview | null>(null)
// 有接口没拉到 → 页面上如实说明，不能让人把"加载失败"看成"没活儿干"
const partial = ref(false)
const loading = ref(false)
const sentSheets = ref<import('../api').HandoverSheet[]>([])
const allRounds = ref<DueRound[]>([])

async function refresh() {
  loading.value = true
  const r = await settleAll([
    { p: api.dueRounds(), fallback: [] as DueRound[] },
    { p: api.listProjects(), fallback: [] as ProjectSummary[] },
    { p: api.listRecordsByStatus('submitted'), fallback: [] as RecordRow[] },
    { p: api.listRecordsByStatus('reviewed'), fallback: [] as RecordRow[] },
    { p: api.listSamples(), fallback: [] as Sample[] },
    // 报告接口只放行报告链上的岗位；采样员/检测员/质控别去撞 403，撞了会误报「部分数据没加载」
    { p: hasRole(...PAGE_ROLES.reports) ? api.listReports() : Promise.resolve([] as Report[]), fallback: [] as Report[] },
    { p: api.resourceAlerts(), fallback: [] as import('../api').ResourceAlert[] },
    { p: api.listPendingHandovers(), fallback: [] as import('../api').Handover[] },
    { p: api.listTasks({ assignee: 'me' }), fallback: [] as import('../api').TestTask[] },
    { p: api.contractAlerts(), fallback: [] as { id: string; client: string; project: string; period_end: string; bucket: string }[] },
    { p: api.statsOverview(), fallback: null as StatsOverview | null },
    { p: api.listHandoverSheets({ status: 'sent' }), fallback: [] as import('../api').HandoverSheet[] },
    { p: hasRole(...PAGE_ROLES.reports) ? api.listAllRounds() : Promise.resolve([] as DueRound[]), fallback: [] as DueRound[] },
  ] as const)
  ;[due.value, projects.value, submitted.value, reviewed.value, samples.value, reports.value, resAlerts.value, pendingHo.value, myTasks.value, cAlerts.value, stats.value, sentSheets.value, allRounds.value] = r.values
  partial.value = !r.ok
  loading.value = false
}
const dueCount = computed(() => due.value.filter(r => r.bucket !== 'later').length)
// §9 提醒2：临期（14天内/逾期）还没派工的期次
const toDispatch = computed(() => due.value.filter(r => r.bucket !== 'later' && !r.sampler).length)
// 检测员看「派给我的活」；tech/admin 统揽全部在检样品
const myOpenTasks = computed(() => myTasks.value.filter(t => t.record_status !== 'approved').length)
const toTest = computed(() => hasRole('tech') ? samples.value.filter(s => s.status === 'pending' || s.status === 'testing').length : myOpenTasks.value)
// 签字人只签「审核通过」的报告（draft 是编制/审核阶段的活，他无权办；原来统计错阶段，
// 报告一过审他的待办反而归零——唯一该提醒他的时刻提醒消失）
const toIssue = computed(() => reports.value.filter(r => r.status === 'checked').length)
const toCheckReport = computed(() => reports.value.filter(r => r.status === 'draft').length)
// 技术负责人两件签批活（原来全靠项目一览逐行扫）
const schemeToReview = computed(() => projects.value.filter(p => p.accepted_at && p.scheme && p.scheme.status === 'draft').length)
const contractToSign = computed(() => projects.value.filter(p => p.accepted_at && !p.tech_review_result && p.status !== 'terminated').length)
// 可出报告：某期全部样品三级审核走完、还没生成报告 → 登记员该动手了
const roundsReportable = computed(() => {
  const has = new Set(reports.value.map(r => (r as any).round_id).filter(Boolean))
  return allRounds.value.filter(r => r.rollup === 'approved' && r.status === 'done' && !has.has(r.id)).length
})
// 拒收待补采：采样员的活（补采入口在检测录入页样品详情）
const rejectedToResample = computed(() => samples.value.filter(s => s.status === 'rejected' && !s.replaced_by).length)
// 被打回待重录：检测员单列（混在"我的任务"总数里根本看不见）
const myRejected = computed(() => myTasks.value.filter(t => t.record_status === 'rejected').length)

// 只给你看你岗位的活；管理员/技术负责人统揽全部
type Todo = { key: string; n: number; label: string; sub: string; to: string; roles: string[] }
const seeAll = computed(() => hasRole('tech'))   // admin 自动 true
const todos = computed<Todo[]>(() => {
  const all: Todo[] = [
    { key: 'due', n: dueCount.value, label: '监测到期该采样', sub: '逾期 / 14 天内', to: '/plans', roles: ['sampler', 'registrar', 'qc'] },
    { key: 'dispatch', n: toDispatch.value, label: '期次待派工', sub: '临期还没派人', to: '/plans', roles: ['registrar', 'qc'] },
    { key: 'contract', n: cAlerts.value.length, label: '合同快到期', sub: '30 天内到期 / 已过期未完结', to: '/contracts', roles: ['registrar', 'signer'] },
    { key: 'sign', n: sentSheets.value.length, label: '交接单待签收', sub: '采样员已发出整单', to: '/qc', roles: ['qc'] },
    { key: 'rejected', n: rejectedToResample.value, label: '拒收样待补采', sub: '质控拒收，需重新采样', to: '/samples', roles: ['sampler', 'qc'] },
    { key: 'test', n: toTest.value, label: hasRole('tech') ? '样品待检测录入' : '我的检测任务', sub: hasRole('tech') ? '待检测 + 检测中' : '质控派给我的项目', to: '/samples', roles: ['tester'] },
    { key: 'myrej', n: myRejected.value, label: '被打回待重录', sub: '复核/审核打回的记录', to: '/samples', roles: ['tester'] },
    { key: 'review', n: submitted.value.length, label: '记录待复核', sub: '检测员已提交', to: '/review', roles: ['reviewer'] },
    { key: 'approve', n: reviewed.value.length, label: '记录待终审', sub: '复核已通过', to: '/review', roles: ['approver'] },
    { key: 'reportable', n: roundsReportable.value, label: '可出报告', sub: '全样审核已过，待编制', to: '/reports', roles: ['registrar'] },
    { key: 'rptcheck', n: toCheckReport.value, label: '报告待审核', sub: '编制完成待审', to: '/reports', roles: ['reviewer', 'approver'] },
    { key: 'issue', n: toIssue.value, label: '报告待签发', sub: '审核已通过', to: '/reports', roles: ['signer'] },
    { key: 'scheme', n: schemeToReview.value, label: '监测方案待审核', sub: '登记员已编制', to: '/contracts', roles: ['tech'] },
    { key: 'techsign', n: contractToSign.value, label: '合同评审待签批', sub: '同意后可打印正本', to: '/contracts', roles: ['tech'] },
    { key: 'res', n: resAlerts.value.length, label: '资源到期待处理', sub: '仪器检定 / 效期', to: '/instruments', roles: ['tester', 'tech'] },
  ]
  if (seeAll.value) return all.sort((a, b) => Number(hasRole(...b.roles)) - Number(hasRole(...a.roles)))
  return all.filter(t => hasRole(...t.roles))
})
function isMine(t: Todo) { return hasRole(...t.roles) }
function toneDot(tone?: 'good' | 'warn' | 'bad') { return tone === 'bad' ? 'crit' : tone }
const myTotal = computed(() => todos.value.filter(isMine).reduce((s, t) => s + t.n, 0))

const greet = computed(() => {
  const h = new Date().getHours()
  return h < 9 ? '早上好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好'
})
const today = computed(() => {
  const d = new Date()
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${'日一二三四五六'[d.getDay()]}`
})

// 项目一览（当前环；周期项目带第几期）
const stageOf = (p: ProjectSummary) => p.pipeline.activeIndex < 0 ? null : p.pipeline.stages[p.pipeline.activeIndex]
const stageLabel = (p: ProjectSummary) => {
  const s = stageOf(p)
  if (!s) return ''
  return p.pipeline.round?.no ? `第${p.pipeline.round.no}期 · ${s.label}` : s.label
}

// —— 管理数字条：全所家底一眼看全（技术负责人/管理员视角）——
type Stat = { label: string; n: string | number; sub: string; tone?: 'good' | 'warn' | 'bad'; to?: string }
const board = computed<Stat[]>(() => {
  const s = stats.value
  if (!s) return []
  return [
    { label: '在办项目', n: s.contracts.accepted, sub: `累计 ${s.contracts.total} 单`, to: '/contracts' },
    { label: '待检样品', n: s.samples.pending, sub: `本月新收 ${s.samples.month}`, tone: s.samples.pending ? 'warn' : undefined, to: '/samples' },
    { label: '本月签发报告', n: s.reports.monthIssued, sub: `待签发 ${s.reports.draft + s.reports.checked}`, to: '/reports' },
    { label: '质控合格率', n: s.qc.rate == null ? '—' : s.qc.rate + '%', sub: `${s.qc.pass}/${s.qc.total} 合格`, tone: s.qc.rate == null ? undefined : (s.qc.rate >= 90 ? 'good' : 'bad') },
    { label: '报告超标批次', n: s.reports.exceed, sub: `占已出报告`, tone: s.reports.exceed ? 'bad' : 'good' },
    { label: '资源预警', n: s.resource.alerts, sub: s.resource.overdue ? `${s.resource.overdue} 项已过期` : '效期30天内', tone: s.resource.overdue ? 'bad' : (s.resource.alerts ? 'warn' : 'good'), to: '/instruments' },
  ]
})
// 体系合规健康度：年度内审/管评/培训是否已完成
const compliance = computed(() => {
  const s = stats.value?.system
  return [
    { k: '内审', ok: !!s?.audit }, { k: '管评', ok: !!s?.review }, { k: '培训', ok: !!s?.train },
  ]
})

const total = computed(() => templates.length)
// 年度盘点（管理评审/年终要用的数）：管理视角按需拉，不挤普通岗位的首屏
const yearly = ref<any>(null)
async function loadYearly() {
  if (!seeAll.value) return
  try { yearly.value = await api.statsYearly() } catch { yearly.value = null }
}
onMounted(() => { refresh(); loadYearly() })
</script>

<template>
  <!-- 首屏挂 v-loading：数据没回来前不渲染"假 0 待办"（正是下面 partial 警示防的那类误导） -->
  <div class="pagewrap" v-loading="loading">
    <div class="phead">
      <div>
        <h1 class="page">{{ greet }}，{{ currentUser?.name || '' }}</h1>
        <p class="sub">{{ seeAll ? '全所动态一览' : myTotal ? `你今天有 ${myTotal} 件待办` : '今日暂无待办' }}</p>
      </div>
      <span class="date num">{{ today }}</span>
    </div>

    <!-- 有接口没拉到就明说：合规系统里，假的「0 待办」比空白更危险 -->
    <div v-if="partial" class="partial">
      <span class="sdot warn"></span>
      部分数据没能加载，下面的数字可能不完整——别按这个安排工作
      <button :disabled="loading" @click="refresh">{{ loading ? '重试中…' : '重试' }}</button>
    </div>

    <!-- 全所概览：一条统计条（技术负责人/管理员可见） -->
    <section v-if="seeAll && board.length">
      <div class="sechead">
        <h2>全所概览</h2>
        <div class="comps" @click="router.push('/system-records')" title="体系运行记录">
          <span v-for="c in compliance" :key="c.k" class="citem">
            <span class="sdot" :class="c.ok ? 'good' : 'warn'"></span>{{ c.k }}<em>{{ c.ok ? '已完成' : '未完成' }}</em>
          </span>
        </div>
      </div>
      <div class="statbar">
        <div v-for="b in board" :key="b.label" class="cell" :class="{ clk: b.to }" @click="b.to && router.push(b.to)">
          <div class="sl">{{ b.label }}<span v-if="b.tone" class="sdot" :class="toneDot(b.tone)"></span></div>
          <div class="sn num">{{ b.n }}</div>
          <div class="ss">{{ b.sub }}</div>
        </div>
      </div>
    </section>

    <!-- 年度盘点：管理评审/年终统计（管理视角） -->
    <section v-if="seeAll && yearly">
      <div class="sechead"><h2>年度盘点 · {{ yearly.year }}</h2><span class="seccount num">检测员工作量按记录条数计</span></div>
      <div class="statbar">
        <div class="cell"><div class="sl">新签合同</div><div class="sn num">{{ yearly.contracts }}</div><div class="ss">客户前三：{{ (yearly.clients || []).slice(0, 3).map((c: any) => c.client).join('、') || '—' }}</div></div>
        <div class="cell"><div class="sl">收样</div><div class="sn num">{{ yearly.samples }}</div><div class="ss">全年累计</div></div>
        <div class="cell"><div class="sl">签发报告</div><div class="sn num">{{ yearly.reportsIssued }}</div><div class="ss">超标 {{ yearly.exceed }} 批</div></div>
        <div class="cell"><div class="sl">质控合格</div><div class="sn num">{{ yearly.qc.total ? Math.round(yearly.qc.pass / yearly.qc.total * 100) + '%' : '—' }}</div><div class="ss">{{ yearly.qc.pass }}/{{ yearly.qc.total }}</div></div>
        <div class="cell"><div class="sl">检测员工作量</div><div class="sn num">{{ (yearly.testers || []).length }}</div><div class="ss">{{ (yearly.testers || []).slice(0, 3).map((t: any) => `${t.name} ${t.n}`).join(' · ') || '—' }}</div></div>
      </div>
    </section>

    <!-- 我的待办：工作队列 -->
    <section>
      <div class="sechead">
        <h2>我的待办</h2>
        <span v-if="myTotal" class="seccount num">共 {{ myTotal }} 件</span>
      </div>
      <div class="card qlist">
        <div v-for="t in todos" :key="t.key" class="qrow" :class="{ zero: !t.n }" @click="router.push(t.to)">
          <span class="sdot" :class="isMine(t) && t.n ? 'accent' : ''"></span>
          <span class="ql">{{ t.label }}</span>
          <span class="qs">{{ t.sub }}</span>
          <span class="qn num">{{ t.n }}</span>
          <span class="qc">›</span>
        </div>
        <div v-if="!seeAll && !myTotal" class="rest">今天你岗位上没有待办</div>
      </div>
    </section>

    <!-- 项目一览：每单走到哪 -->
    <section>
      <div class="sechead">
        <h2>项目一览</h2>
        <span class="link" @click="router.push('/contracts')">全部项目 →</span>
      </div>
      <div class="card projs">
        <div v-for="p in projects" :key="p.id" class="prow" @click="router.push('/contracts')">
          <span class="pc mono">{{ p.id }}</span>
          <span class="pn">{{ p.client }}<span v-if="p.project" class="pp"> · {{ p.project }}</span></span>
          <span v-if="stageOf(p)" class="pst"><em>{{ stageLabel(p) }}</em><i>→ {{ stageOf(p)!.who }}</i></span>
          <span v-else class="pst done"><span class="sdot good"></span>{{ p.pipeline.round ? `${p.pipeline.round.total} 期全部完成` : '已完成归档' }}</span>
        </div>
        <div v-if="!projects.length" class="empty">还没有项目</div>
      </div>
    </section>

    <div class="tpl" @click="router.push('/templates')">{{ total }} 张检测记录表已 1:1 入库 · 进入模板库 →</div>
  </div>
</template>

<style scoped>
.phead{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:26px}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
.date{color:var(--faint);font-size:12.5px;padding-top:9px}
section{margin-bottom:28px}
.seccount{font-size:12px;color:var(--faint)}

.partial{display:flex;align-items:center;gap:9px;margin-bottom:20px;padding:10px 14px;border-radius:var(--radius-sm);background:var(--warn-soft);color:var(--warn);font-size:12.5px;font-weight:500}
.partial button{margin-left:auto;background:none;border:1px solid currentColor;color:inherit;font:inherit;font-size:12px;padding:2px 11px;border-radius:6px;cursor:pointer}
.partial button:hover:not(:disabled){background:rgba(0,0,0,.05)}
.partial button:disabled{opacity:.5;cursor:default}
.link{font-size:12.5px;color:var(--accent);cursor:pointer}

/* 体系合规：分区标题右侧的静默摘要 */
.comps{display:flex;gap:16px;cursor:pointer;font-size:12px}
.citem{display:inline-flex;align-items:center;gap:5px;color:var(--ink);font-weight:500}
.citem em{font-style:normal;color:var(--faint)}
.comps:hover .citem em{color:var(--accent-ink)}

/* 统计条：一个整卡，1px 分隔 */
.statbar{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow-sm)}
.cell{background:var(--surface);padding:16px 18px 14px}
.cell.clk{cursor:pointer;transition:background .13s ease}
.cell.clk:hover{background:var(--surface-2)}
.sl{font-size:12px;font-weight:500;color:var(--muted);display:flex;align-items:center;gap:6px}
.sn{font-size:26px;font-weight:650;color:var(--ink);margin-top:7px;line-height:1.1;letter-spacing:-.02em}
.ss{font-size:11.5px;color:var(--faint);margin-top:3px}

/* 待办队列：行式 */
.qlist{overflow:hidden}
.qrow{display:flex;align-items:center;gap:12px;padding:13px 18px;cursor:pointer;border-bottom:1px solid var(--line);transition:background .12s ease}
.qrow:last-child{border-bottom:0}
.qrow:hover{background:var(--surface-2)}
.ql{font-size:13.5px;font-weight:600}
.qs{font-size:12px;color:var(--faint);flex:1}
.qn{font-size:16px;font-weight:650}
.qrow.zero .ql{color:var(--muted);font-weight:500}
.qrow.zero .qn{color:var(--faint);font-weight:500}
.qc{color:var(--faint);font-size:17px;line-height:1;margin-left:-2px}
.rest{padding:22px;text-align:center;color:var(--muted);font-size:13px}

/* 项目一览 */
.projs{overflow:hidden}
.prow{display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid var(--line);cursor:pointer;font-size:13px;transition:background .12s ease}
.prow:last-child{border-bottom:0}
.prow:hover{background:var(--surface-2)}
.pc{color:var(--faint);font-size:12px;width:104px;flex:none}
.pn{font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp{font-weight:400;color:var(--muted)}
.pst{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--faint);white-space:nowrap}
.pst em{font-style:normal;color:var(--accent-ink);font-weight:600}
.pst i{font-style:normal;color:var(--faint)}
.pst.done{color:var(--good)}
.empty{padding:18px;color:var(--faint);font-size:13px;text-align:center}

.tpl{font-size:12.5px;color:var(--faint);cursor:pointer;padding:2px;text-align:center}
.tpl:hover{color:var(--accent)}

@media (max-width:1100px){
  .statbar{grid-template-columns:repeat(3,1fr)}
  .comps{display:none}
  .date{display:none}
  .qs{display:none}
}
</style>
