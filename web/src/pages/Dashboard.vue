<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import templates from '../data/templates.json'
import { api, currentUser, hasRole, type ArchivePackage, type DueRound, type HandoverSheet, type ProfessionalScope, type ProjectSummary, type RecordRow, type ReportBatch, type Sample, type Report, type StatsOverview, type WorkflowTask, type WorkflowView } from '../api'
import { can, PAGE_ROLES } from '../permissions'
import { settleAll } from '../utils/settle'
import { matchesActorWorkflowQueue } from '../workflow/actorQueueMatching'
import { confirmedArchiveScopesForRound } from '../workflow/archiveSelection'

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
const sentSheets = ref<HandoverSheet[]>([])
const handoverSheets = ref<HandoverSheet[]>([])
const allRounds = ref<DueRound[]>([])
const archivePackages = ref<ArchivePackage[]>([])
const reportBatches = ref<ReportBatch[]>([])
const workflowBySubject = ref<Record<string, WorkflowView | null>>({})
const professionalTasks = ref<Record<ProfessionalScope, WorkflowTask[]>>({ sampling: [], quality: [], laboratory: [], report: [] })
const PROFESSIONAL_TASK_SCOPES: ProfessionalScope[] = ['sampling', 'quality', 'laboratory', 'report']
const qualificationOnly = computed(() => (currentUser.value?.roles?.length ?? 0) === 0)

const workflowKey = (type: string, id: string) => `${type}:${id}`
async function loadActorWorkflowContext() {
  let professionalScopesLoaded = true
  const professionalEntries = await Promise.all(PROFESSIONAL_TASK_SCOPES.map(async scope => {
    try { return [scope, await api.listWorkflowTasks(scope)] as const }
    catch (error: any) {
      if (error?.response?.status !== 403) professionalScopesLoaded = false
      return [scope, [] as WorkflowTask[]] as const
    }
  }))
  professionalTasks.value = Object.fromEntries(professionalEntries) as Record<ProfessionalScope, WorkflowTask[]>
  const subjects = due.value.map(round => ({ type: 'round_sampling' as const, id: round.id }))
  const subjectEntries = await Promise.all(subjects.map(async subject => {
    try { return [workflowKey(subject.type, subject.id), await api.getWorkflow(subject.type, subject.id)] as const }
    catch { return [workflowKey(subject.type, subject.id), null] as const }
  }))
  workflowBySubject.value = Object.fromEntries(subjectEntries)
  return professionalScopesLoaded
}

async function refresh() {
  loading.value = true
  if (qualificationOnly.value) {
    due.value = []; projects.value = []; submitted.value = []; reviewed.value = []; samples.value = []; reports.value = []
    resAlerts.value = []; pendingHo.value = []; myTasks.value = []; cAlerts.value = []; stats.value = null
    handoverSheets.value = []; sentSheets.value = []; allRounds.value = []; archivePackages.value = []; reportBatches.value = []
    partial.value = !(await loadActorWorkflowContext())
    loading.value = false
    return
  }
  const r = await settleAll([
    { p: api.dueRounds(), fallback: [] as DueRound[] },
    { p: api.listProjects(), fallback: [] as ProjectSummary[] },
    { p: api.listRecordsByStatus('submitted'), fallback: [] as RecordRow[] },
    { p: api.listRecordsByStatus('reviewed'), fallback: [] as RecordRow[] },
    { p: api.listSamples(), fallback: [] as Sample[] },
    // 报告接口只放行报告链上的岗位；采样员/实验室分析人员/质控别去撞 403，撞了会误报「部分数据没加载」
    { p: hasRole(...PAGE_ROLES.reports) ? api.listReports() : Promise.resolve([] as Report[]), fallback: [] as Report[] },
    { p: api.resourceAlerts(), fallback: [] as import('../api').ResourceAlert[] },
    { p: api.listPendingHandovers(), fallback: [] as import('../api').Handover[] },
    { p: api.listTasks({ assignee: 'me' }), fallback: [] as import('../api').TestTask[] },
    { p: api.contractAlerts(), fallback: [] as { id: string; client: string; project: string; period_end: string; bucket: string }[] },
    { p: api.statsOverview(), fallback: null as StatsOverview | null },
    { p: api.listHandoverSheets({}), fallback: [] as HandoverSheet[] },
    { p: hasRole(...PAGE_ROLES.plans, ...PAGE_ROLES.reports) ? api.listAllRounds() : Promise.resolve([] as DueRound[]), fallback: [] as DueRound[] },
    { p: can('report_generate') ? api.listArchivePackages() : Promise.resolve([] as ArchivePackage[]), fallback: [] as ArchivePackage[] },
    { p: can('report_generate') ? api.listReportBatches() : Promise.resolve([] as ReportBatch[]), fallback: [] as ReportBatch[] },
  ] as const)
  ;[due.value, projects.value, submitted.value, reviewed.value, samples.value, reports.value, resAlerts.value, pendingHo.value, myTasks.value, cAlerts.value, stats.value, handoverSheets.value, allRounds.value, archivePackages.value, reportBatches.value] = r.values
  sentSheets.value = handoverSheets.value.filter(sheet => sheet.status === 'sent')
  const professionalScopesLoaded = await loadActorWorkflowContext()
  partial.value = !r.ok || !professionalScopesLoaded
  loading.value = false
}
const dueCount = computed(() => due.value.filter(round => round.bucket !== 'later'
  && matchesActorWorkflowQueue('write', workflowBySubject.value[workflowKey('round_sampling', round.id)],
    null, currentUser.value?.username, round.sampler_ids)).length)
// §9 提醒2：临期（14天内/逾期）还没派工的期次
const toDispatch = computed(() => due.value.filter(r => r.bucket !== 'later' && !r.sampler).length)
// 实验室分析人员看「派给我的活」；tech/admin 统揽全部在检样品
const myOpenTasks = computed(() => myTasks.value.filter(t => t.record_status !== 'approved').length)
const toTest = computed(() => hasRole('tech') ? samples.value.filter(s => s.status === 'pending' || s.status === 'testing').length : myOpenTasks.value)
// 签字人只签「审核通过」的报告（draft 是编制/审核阶段的活，他无权办；原来统计错阶段，
// 报告一过审他的待办反而归零——唯一该提醒他的时刻提醒消失）
const toIssue = computed(() => reports.value.filter(r => r.status === 'checked').length)
const professionalTaskCount = (scope: ProfessionalScope, level: 'review' | 'approve') => professionalTasks.value[scope]
  .filter(task => task.decision_level === level).length
const toReviewReport = computed(() => professionalTaskCount('report', 'review'))
const toApproveReport = computed(() => professionalTaskCount('report', 'approve'))
const recordsToReview = computed(() => professionalTaskCount('laboratory', 'review'))
const recordsToApprove = computed(() => professionalTaskCount('laboratory', 'approve'))
const samplingToReview = computed(() => professionalTaskCount('sampling', 'review'))
const samplingToApprove = computed(() => professionalTaskCount('sampling', 'approve'))
const qualityToReview = computed(() => professionalTaskCount('quality', 'review'))
const qualityToApprove = computed(() => professionalTaskCount('quality', 'approve'))
// 技术负责人两件签批活（原来全靠项目一览逐行扫）
const schemeToReview = computed(() => projects.value.filter(p => p.accepted_at && p.scheme && p.scheme.status === 'draft').length)
const contractToSign = computed(() => projects.value.filter(p => p.accepted_at && !p.tech_review_result && p.status !== 'terminated').length)
// 可出报告：某期实验室记录全部专业批准、还没生成报告 → 报告编制人员该动手了
const roundsReportable = computed(() => {
  const has = new Set(reports.value.filter(report => !report.voided).map(report => report.round_id).filter(Boolean))
  return allRounds.value.filter(round => round.rollup === 'approved' && round.status === 'done' && (round.sample_count || 0) > 0
    && !has.has(round.id)
    && confirmedArchiveScopesForRound(archivePackages.value, reportBatches.value, allRounds.value, round).length > 0).length
})
// 拒收待补采：采样员的活（补采入口在检测录入页样品详情）
const rejectedToResample = computed(() => samples.value.filter(s => s.status === 'rejected' && !s.replaced_by).length)
// 被打回待重录：实验室分析人员单列（混在"我的任务"总数里根本看不见）
const myRejected = computed(() => myTasks.value.filter(t => t.record_status === 'rejected').length)

// 普通待办按基础岗位显示；专业复核/审核只认服务端资格+项目指派，不让粗岗位或管理概览代替。
type Todo = { key: string; n: number; label: string; sub: string; capacity: string; to: string; roles: string[]; actorScoped?: boolean }
const seeAll = computed(() => hasRole('tech'))   // admin 自动 true
const todos = computed<Todo[]>(() => {
  const all: Todo[] = [
    { key: 'due', n: dueCount.value, label: '监测到期该采样', sub: '逾期 / 14 天内', capacity: '现场采样', to: '/plans?stage=sampling&queue=write', roles: ['sampler', 'planner', 'qc'] },
    { key: 'sampling-review', n: samplingToReview.value, label: '采样待复核', sub: '精确指派给我的复核', capacity: '采样复核', to: '/plans?stage=sampling&queue=review', roles: [], actorScoped: true },
    { key: 'sampling-approve', n: samplingToApprove.value, label: '采样待审核', sub: '精确指派给我的审核', capacity: '采样审核', to: '/plans?stage=sampling&queue=approve', roles: [], actorScoped: true },
    { key: 'dispatch', n: toDispatch.value, label: '期次待派工', sub: '临期还没派人', capacity: '计划员', to: '/plans?stage=dispatch&queue=write', roles: ['planner'] },
    { key: 'contract', n: cAlerts.value.length, label: '合同快到期', sub: '30 天内到期 / 已过期未完结', capacity: '业务员', to: '/contracts?stage=contract&queue=write', roles: ['sales', 'signer'] },
    { key: 'sign', n: sentSheets.value.length, label: '交接单待签收', sub: '采样员已发出整单', capacity: '样品管理员', to: '/qc?stage=handover&queue=review', roles: ['sample_manager'] },
    { key: 'quality-review', n: qualityToReview.value, label: '质控待复核', sub: '精确指派给我的复核', capacity: '质控复核', to: '/qc?stage=quality&queue=review', roles: [], actorScoped: true },
    { key: 'quality-approve', n: qualityToApprove.value, label: '质控待审核', sub: '精确指派给我的审核', capacity: '质控审核', to: '/qc?stage=quality&queue=approve', roles: [], actorScoped: true },
    { key: 'rejected', n: rejectedToResample.value, label: '拒收样待补采', sub: '交接拒收，需重新采样', capacity: '采样员', to: '/plans?stage=sampling&queue=rejected', roles: ['sampler', 'qc'] },
    { key: 'test', n: toTest.value, label: hasRole('tech') ? '样品待检测录入' : '我的检测任务', sub: hasRole('tech') ? '待检测 + 检测中' : '质控派给我的项目', capacity: '实验室分析', to: '/samples?stage=laboratory&queue=write', roles: ['analyst'] },
    { key: 'myrej', n: myRejected.value, label: '被打回待重录', sub: '复核/审核打回的记录', capacity: '记录编制', to: '/samples?stage=laboratory&queue=rejected', roles: ['analyst'] },
    { key: 'review', n: recordsToReview.value, label: '记录待复核', sub: '精确指派给我的复核', capacity: '实验室复核', to: '/samples?stage=laboratory&queue=review', roles: ['analyst'] },
    { key: 'approve', n: recordsToApprove.value, label: '记录待审核', sub: '精确指派给我的审核', capacity: '实验室审核', to: '/samples?stage=laboratory&queue=approve', roles: ['analyst'] },
    { key: 'reportable', n: roundsReportable.value, label: '可出报告', sub: '1–8 归档已确认，待编制', capacity: '报告编制', to: '/reports?queue=write', roles: ['report_editor'] },
    { key: 'rptreview', n: toReviewReport.value, label: '报告待复核', sub: '精确指派给我的复核', capacity: '报告复核', to: '/reports?queue=review', roles: ['report_editor'] },
    { key: 'rptapprove', n: toApproveReport.value, label: '报告待审核', sub: '精确指派给我的审核', capacity: '报告审核', to: '/reports?queue=approve', roles: ['report_editor'] },
    { key: 'issue', n: toIssue.value, label: '报告待签发', sub: '审核已通过', capacity: '授权签字人', to: '/reports?queue=final', roles: ['signer'] },
    { key: 'scheme', n: schemeToReview.value, label: '监测方案待审核', sub: '计划员已编制', capacity: '技术负责人', to: '/contracts?stage=scheme&queue=review', roles: ['tech'] },
    { key: 'techsign', n: contractToSign.value, label: '合同评审待签批', sub: '同意后可打印正本', capacity: '技术负责人', to: '/contracts?stage=review&queue=review', roles: ['tech'] },
    { key: 'res', n: resAlerts.value.length, label: '资源到期待处理', sub: '仪器检定 / 效期', capacity: '资源管理员', to: '/instruments', roles: ['analyst', 'tech'] },
  ]
  if (seeAll.value) return all.filter(todo => !todo.actorScoped || todo.n > 0)
    .sort((a, b) => Number(isMine(b)) - Number(isMine(a)))
  return all.filter(todo => todo.actorScoped ? todo.n > 0 : hasRole(...todo.roles))
})
function isMine(t: Todo) { return t.actorScoped ? t.n > 0 : hasRole(...t.roles) }
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
      <div class="sechead"><h2>年度盘点 · {{ yearly.year }}</h2><span class="seccount num">实验室分析人员工作量按记录条数计</span></div>
      <div class="statbar">
        <div class="cell"><div class="sl">新签合同</div><div class="sn num">{{ yearly.contracts }}</div><div class="ss">客户前三：{{ (yearly.clients || []).slice(0, 3).map((c: any) => c.client).join('、') || '—' }}</div></div>
        <div class="cell"><div class="sl">收样</div><div class="sn num">{{ yearly.samples }}</div><div class="ss">全年累计</div></div>
        <div class="cell"><div class="sl">签发报告</div><div class="sn num">{{ yearly.reportsIssued }}</div><div class="ss">超标 {{ yearly.exceed }} 批</div></div>
        <div class="cell"><div class="sl">质控合格</div><div class="sn num">{{ yearly.qc.total ? Math.round(yearly.qc.pass / yearly.qc.total * 100) + '%' : '—' }}</div><div class="ss">{{ yearly.qc.pass }}/{{ yearly.qc.total }}</div></div>
        <div class="cell"><div class="sl">实验室分析人员工作量</div><div class="sn num">{{ (yearly.testers || []).length }}</div><div class="ss">{{ (yearly.testers || []).slice(0, 3).map((t: any) => `${t.name} ${t.n}`).join(' · ') || '—' }}</div></div>
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
          <span class="capacity">{{ t.capacity }}</span>
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
.capacity{font-size:11.5px;color:var(--accent-ink);background:var(--accent-soft);border-radius:999px;padding:3px 8px;white-space:nowrap}
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
