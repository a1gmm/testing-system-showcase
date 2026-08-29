<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, hasRole, type ArchivePackage, type ArchiveReadiness, type ProjectSummary, type ReportBatch } from '../api'

type QueueRow = {
  key: string; scopeKey: string; contractId: string; reportBatchId: string | null; client: string; scopeLabel: string
  status: 'ready' | 'blocked' | 'confirmed' | 'invalidated'; archive?: ArchivePackage
  readiness: ArchiveReadiness; message: string; canRebuild?: boolean
}
const rows = ref<QueueRow[]>([])
const loading = ref(false)
const error = ref('')
const busy = ref('')
const canConfirm = computed(() => hasRole('archivist'))
const statusLabel = { ready: '待归档', blocked: '阻塞', confirmed: '已确认归档', invalidated: '已失效' } as const
const scopeKey = (contractId: string, reportBatchId?: string | null) => `${contractId}::${reportBatchId || 'project'}`

async function refresh() {
  loading.value = true; error.value = ''
  try {
    const [packages, projects, batches] = await Promise.all([api.listArchivePackages(), api.listProjects(), api.listReportBatches()])
    const projectById = new Map(projects.map((project: ProjectSummary) => [project.id, project]))
    const batchById = new Map(batches.map((batch: ReportBatch) => [batch.id, batch]))
    const scopes = [
      ...projects.map((project: ProjectSummary) => ({ contractId: project.id, reportBatchId: null, client: project.client, label: '项目全部期次' })),
      ...batches.map((batch: ReportBatch) => ({ contractId: batch.contract_id, reportBatchId: batch.id, client: projectById.get(batch.contract_id)?.client || '—', label: `${batch.name} · ${batch.id}` })),
    ]
    const readinessByScope = new Map((await Promise.all(scopes.map(async scope => [
      scopeKey(scope.contractId, scope.reportBatchId),
      await api.getArchiveReadiness(scope.contractId, scope.reportBatchId || undefined),
    ] as const))))
    const latest = new Map<string, ArchivePackage>()
    for (const archive of packages) {
      const key = scopeKey(archive.contract_id, archive.report_batch_id)
      const existing = latest.get(key)
      if (!existing || archive.version > existing.version) latest.set(key, archive)
    }
    const packageRows: QueueRow[] = packages.map(archive => ({
      key: archive.id, scopeKey: scopeKey(archive.contract_id, archive.report_batch_id), contractId: archive.contract_id,
      reportBatchId: archive.report_batch_id, client: projectById.get(archive.contract_id)?.client || '—',
      scopeLabel: archive.report_batch_id ? `${batchById.get(archive.report_batch_id)?.name || '报告批次'} · ${archive.report_batch_id}` : '项目全部期次',
      status: archive.status === 'confirmed' ? 'confirmed' : archive.status === 'invalidated' ? 'invalidated' : archive.status === 'draft' ? 'blocked' : 'ready',
      archive, readiness: latest.get(scopeKey(archive.contract_id, archive.report_batch_id))?.id === archive.id
        ? readinessByScope.get(scopeKey(archive.contract_id, archive.report_batch_id)) || archive.readiness : archive.readiness,
      message: archive.status === 'invalidated'
        ? [archive.invalidation_reason || '上游内容变更，需要重新归档', readinessByScope.get(scopeKey(archive.contract_id, archive.report_batch_id))?.ready ? '上游已修正，可以构建新版本' : readinessByScope.get(scopeKey(archive.contract_id, archive.report_batch_id))?.issues.map(issue => issue.message).join('；')].filter(Boolean).join('；')
        : archive.status === 'draft' ? (readinessByScope.get(scopeKey(archive.contract_id, archive.report_batch_id))?.ready
          ? '上游已修正，可以构建新版本' : (readinessByScope.get(scopeKey(archive.contract_id, archive.report_batch_id)) || archive.readiness).issues.map(issue => issue.message).join('；')) : '',
      canRebuild: latest.get(scopeKey(archive.contract_id, archive.report_batch_id))?.id === archive.id
        && ['draft', 'invalidated'].includes(archive.status)
        && readinessByScope.get(scopeKey(archive.contract_id, archive.report_batch_id))?.ready === true,
    }))
    const readinessRows = scopes.filter(scope => !latest.has(scopeKey(scope.contractId, scope.reportBatchId))).map(scope => {
      const readiness = readinessByScope.get(scopeKey(scope.contractId, scope.reportBatchId))!
      return {
        key: `readiness-${scopeKey(scope.contractId, scope.reportBatchId)}`, scopeKey: scopeKey(scope.contractId, scope.reportBatchId),
        contractId: scope.contractId, reportBatchId: scope.reportBatchId, client: scope.client, scopeLabel: scope.label,
        status: readiness.ready ? 'ready' : 'blocked', readiness,
        message: readiness.issues.map(issue => issue.message).join('；'),
      } as QueueRow
    })
    rows.value = [...readinessRows, ...packageRows]
  } catch (reason: any) { error.value = reason?.response?.data?.error || reason?.message || '归档队列加载失败' }
  finally { loading.value = false }
}

async function build(row: QueueRow) {
  if (!canConfirm.value || busy.value) return
  busy.value = row.key
  try { await api.buildArchivePackage(row.contractId, row.reportBatchId || undefined); await refresh() }
  catch (reason: any) { error.value = reason?.response?.data?.error || reason?.message || '归档包构建失败' }
  finally { busy.value = '' }
}
async function confirm(row: QueueRow) {
  if (!canConfirm.value || !row.archive || busy.value) return
  busy.value = row.key
  try { await api.confirmArchivePackage(row.archive.id); await refresh() }
  catch (reason: any) { error.value = reason?.response?.data?.error || reason?.message || '确认归档失败' }
  finally { busy.value = '' }
}
function fmt(value: string | null | undefined) { return value ? value.slice(0, 16).replace('T', ' ') : '—' }
function needsAssignments(row: QueueRow) { return row.readiness.issues.some(issue => issue.code === 'ASSIGNMENT_NOT_ACTIVE') }
function needsLaboratory(row: QueueRow) { return row.readiness.issues.some(issue => issue.code.startsWith('LAB_')) }
onMounted(refresh)
</script>

<template>
  <div class="archive-page" v-loading="loading">
    <div class="phead"><div><h1 class="page">1–8 档案归档</h1><p>前八阶段资料由系统汇集；确认后冻结当前归档版本，报告只能引用当前有效版本。</p></div><button class="secondary" :disabled="loading" @click="refresh">刷新</button></div>
    <p v-if="error" class="page-error" role="alert">{{ error }}</p>
    <div class="legend"><span v-for="(label, key) in statusLabel" :key="key"><i :class="key"></i>{{ label }}</span></div>
    <section class="queue">
      <article v-for="row in rows" :key="row.key" class="archive-row">
        <div class="identity"><b class="mono">{{ row.contractId }}</b><span>{{ row.client }}</span><small>{{ row.scopeLabel }}</small></div>
        <div class="state"><span class="pill" :class="row.status">{{ statusLabel[row.status] }}</span><span v-if="row.archive" class="mono">版本 {{ row.archive.version }}</span></div>
        <div class="detail">
          <p v-if="row.message" :class="{ blocker: row.status === 'blocked' || row.status === 'invalidated' }">{{ row.message }}</p>
          <p v-else-if="row.archive">归档清单 {{ row.archive.items.length }} 项 · 创建于 {{ fmt(row.archive.created_at) }}</p>
          <p v-else>前八阶段已满足归档条件，可以构建冻结清单。</p>
          <div v-if="row.message" class="fix-links">
            <a v-if="needsAssignments(row)" href="/plans?stage=dispatch" data-fix-assignments>去④采样指派设置复核/审核人</a>
            <a v-if="needsLaboratory(row)" href="/samples?stage=laboratory" data-fix-laboratory>去⑧实验室分析补录/完成审核</a>
          </div>
        </div>
        <div v-if="canConfirm" class="actions">
          <button v-if="row.status === 'ready' && !row.archive" class="primary" :disabled="!!busy" @click="build(row)">构建归档包</button>
          <button v-else-if="row.archive?.status === 'ready'" class="primary" :data-confirm-archive="row.archive.id" :disabled="!!busy" @click="confirm(row)">确认归档</button>
          <button v-else-if="row.canRebuild" class="primary" :data-rebuild-scope="row.scopeKey" :disabled="!!busy" @click="build(row)">构建新版本</button>
        </div>
      </article>
      <div v-if="!rows.length && !loading" class="empty">当前没有归档项目</div>
    </section>
  </div>
</template>

<style scoped>
.phead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.page{font-size:24px;font-weight:650;margin:0}.phead p{font-size:14px;color:var(--muted);margin:5px 0 0}.secondary,.primary{min-height:44px;border-radius:7px;padding:0 16px;font:600 14px inherit;cursor:pointer}.secondary{background:var(--surface);border:1px solid var(--line);color:var(--ink)}.primary{background:var(--accent);border:1px solid var(--accent);color:#fff}.page-error{padding:10px 12px;background:#FDECEA;color:var(--crit);border-radius:6px;font-size:14px}.legend{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:12px;color:var(--muted);font-size:13px}.legend span{display:flex;align-items:center;gap:6px}.legend i{width:8px;height:8px;border-radius:50%;background:var(--line)}.legend i.ready{background:var(--warn)}.legend i.blocked,.legend i.invalidated{background:var(--crit)}.legend i.confirmed{background:var(--good)}.queue{border-top:1px solid var(--line)}.archive-row{display:grid;grid-template-columns:minmax(160px,1fr) 150px minmax(240px,2fr) auto;gap:16px;align-items:center;min-height:72px;border-bottom:1px solid var(--line);padding:12px 4px}.identity{display:grid;gap:4px}.identity span,.detail p{font-size:13px;color:var(--muted);margin:0}.mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums}.state{display:flex;align-items:center;gap:8px;font-size:12px}.pill{border-radius:999px;padding:4px 9px;background:var(--surface-2)}.pill.ready{background:var(--warn-soft);color:var(--warn)}.pill.confirmed{background:var(--good-soft);color:var(--good)}.pill.blocked,.pill.invalidated{background:#FDECEA;color:var(--crit)}.detail .blocker{color:var(--crit)}.fix-links{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}.fix-links a{display:inline-flex;align-items:center;min-height:32px;color:var(--accent);font-size:13px;font-weight:600;text-decoration:none}.fix-links a:hover{text-decoration:underline}.fix-links a:focus-visible{outline:2px solid var(--accent-ring);outline-offset:2px}.empty{padding:28px;text-align:center;color:var(--muted)}@media(max-width:860px){.archive-row{grid-template-columns:1fr auto}.detail,.actions{grid-column:1/-1}.actions button{width:100%}}
</style>
