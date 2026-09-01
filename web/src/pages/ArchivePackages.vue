<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, hasRole, type ArchiveItem, type ArchivePackage, type ArchiveReadiness, type ProjectSummary, type ReportBatch } from '../api'
import ArchiveSnapshotPreview from '../components/ArchiveSnapshotPreview.vue'
import { ARCHIVE_STAGES, archiveItemSearchText, archiveStageForItem, type ArchiveStageKey } from '../archive/archiveViewer'

type QueueRow = {
  key: string; scopeKey: string; contractId: string; reportBatchId: string | null; client: string; scopeLabel: string
  status: 'ready' | 'blocked' | 'confirmed' | 'invalidated'; archive?: ArchivePackage
  readiness: ArchiveReadiness; message: string; canRebuild?: boolean
}
const rows = ref<QueueRow[]>([])
const loading = ref(false)
const error = ref('')
const busy = ref('')
const manifestOpen = ref(false)
const selectedArchive = ref<ArchivePackage | null>(null)
const selectedStage = ref<ArchiveStageKey | 'all'>('all')
const selectedItemId = ref<number | null>(null)
const archiveKeyword = ref('')
const canConfirm = computed(() => hasRole('archivist'))
const statusLabel = { ready: '待归档', blocked: '阻塞', confirmed: '已确认归档', invalidated: '已失效' } as const
const scopeKey = (contractId: string, reportBatchId?: string | null) => `${contractId}::${reportBatchId || 'project'}`
const stageRows = computed(() => ARCHIVE_STAGES.map(stage => ({
  ...stage,
  items: (selectedArchive.value?.items || []).filter(item => archiveStageForItem(item) === stage.key),
})))
const visibleArchiveItems = computed(() => {
  const keyword = archiveKeyword.value.trim().toLocaleLowerCase()
  return (selectedArchive.value?.items || []).filter(item => {
    if (selectedStage.value !== 'all' && archiveStageForItem(item) !== selectedStage.value) return false
    return !keyword || archiveItemSearchText(item).includes(keyword)
  })
})
const selectedItem = computed<ArchiveItem | null>(() => {
  const exact = selectedArchive.value?.items.find(item => item.id === selectedItemId.value)
  if (exact && visibleArchiveItems.value.some(item => item.id === exact.id)) return exact
  return visibleArchiveItems.value[0] || null
})

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
    const requestedId = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('archive') || ''
    if (requestedId && selectedArchive.value?.id !== requestedId) {
      const requested = packages.find(archive => archive.id === requestedId) || await api.getArchivePackage(requestedId)
      showManifest(requested)
    }
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
function showManifest(archive: ArchivePackage) {
  selectedArchive.value = archive
  selectedStage.value = 'all'
  selectedItemId.value = archive.items.find(item => item.entity_type !== 'audit_entry')?.id ?? archive.items[0]?.id ?? null
  archiveKeyword.value = ''
  manifestOpen.value = true
}
function selectStage(stage: ArchiveStageKey | 'all') {
  selectedStage.value = stage
  selectedItemId.value = visibleArchiveItems.value[0]?.id ?? null
}
function clearManifest() {
  selectedArchive.value = null
  selectedItemId.value = null
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('archive')) {
    const url = new URL(window.location.href)
    url.searchParams.delete('archive')
    url.searchParams.delete('report')
    window.history.replaceState({}, '', url.pathname + url.search + url.hash)
  }
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
          <div v-if="row.archive" class="manifest-summary">
            <span>归档清单 {{ row.archive.items.length }} 项 · 创建于 {{ fmt(row.archive.created_at) }}</span>
            <button class="manifest-link" type="button" :data-view-archive="row.archive.id" @click="showManifest(row.archive)">查看全部 {{ row.archive.items.length }} 项</button>
            <a v-if="row.archive.status === 'confirmed' || row.archive.status === 'invalidated'" class="book-link"
              :href="`/archive-packages/${encodeURIComponent(row.archive.id)}/original-records`"
              :data-open-electronic-record-book="row.archive.id">连续查看电子记录册</a>
          </div>
          <p v-else-if="!row.message">前八阶段已满足归档条件，可以构建冻结清单。</p>
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
    <el-dialog v-if="selectedArchive" v-model="manifestOpen" :title="`${selectedArchive.contract_id} · 第1–8步原始档案`" width="min(1180px, calc(100vw - 32px))" @closed="clearManifest">
      <section class="manifest" :data-archive-manifest="selectedArchive.id">
        <div class="manifest-meta">
          <div>
            <span class="archive-status" :class="selectedArchive.status">{{ statusLabel[selectedArchive.status === 'draft' ? 'blocked' : selectedArchive.status] }}</span>
            <b class="mono">归档版本 {{ selectedArchive.version }}</b>
            <span>{{ selectedArchive.report_batch_id ? `报告批次 ${selectedArchive.report_batch_id}` : '项目全部期次' }}</span>
            <span>{{ selectedArchive.items.length }} 项</span>
          </div>
          <p>这里显示报告实际引用的冻结版本。选择左侧业务步骤，再从中间打开具体记录。</p>
        </div>
        <div v-if="selectedArchive.items.length" class="archive-viewer">
          <nav class="stage-nav" aria-label="第1至第8步档案导航">
            <button type="button" :class="{ active: selectedStage === 'all' }" data-archive-stage="all" @click="selectStage('all')">
              <span class="stage-number">全部</span><span><b>全部原始档案</b><small>按归档顺序查看</small></span><em>{{ selectedArchive.items.length }}</em>
            </button>
            <button v-for="stage in stageRows" :key="stage.key" type="button" :class="{ active: selectedStage === stage.key }"
              :data-archive-stage="stage.key" @click="selectStage(stage.key)">
              <span class="stage-number">{{ stage.number }}</span><span><b>{{ stage.label }}</b><small>{{ stage.hint }}</small></span><em>{{ stage.items.length }}</em>
            </button>
          </nav>
          <section class="record-index" aria-label="归档记录清单">
            <label class="archive-search"><span>查找记录</span><input v-model="archiveKeyword" placeholder="输入样品号、表号或检测项目" /></label>
            <div class="record-count">{{ visibleArchiveItems.length }} 项记录</div>
            <div class="record-list">
              <button v-for="item in visibleArchiveItems" :key="item.id" type="button"
                :class="{ active: selectedItem?.id === item.id }" :data-archive-item="item.id" @click="selectedItemId = item.id">
                <span class="record-order mono">{{ item.item_order }}</span>
                <span><b>{{ item.label }}</b><small>{{ ARCHIVE_STAGES.find(stage => stage.key === archiveStageForItem(item))?.label }}<template v-if="item.revision !== null"> · 定稿版本 {{ item.revision }}</template></small></span>
              </button>
              <p v-if="!visibleArchiveItems.length" class="no-result">没有找到匹配的记录，请换一个关键词或业务步骤。</p>
            </div>
          </section>
          <div class="preview-pane">
            <ArchiveSnapshotPreview v-if="selectedItem" :item="selectedItem" />
            <p v-else class="manifest-empty">请选择一条记录查看原始内容。</p>
          </div>
        </div>
        <p v-else class="manifest-empty">该归档版本没有清单项。</p>
      </section>
    </el-dialog>
  </div>
</template>

<style scoped>
.phead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.page{font-size:24px;font-weight:650;margin:0}.phead p{font-size:14px;color:var(--muted);margin:5px 0 0}.secondary,.primary{min-height:44px;border-radius:7px;padding:0 16px;font:600 14px inherit;cursor:pointer}.secondary{background:var(--surface);border:1px solid var(--line);color:var(--ink)}.primary{background:var(--accent);border:1px solid var(--accent);color:#fff}.page-error{padding:10px 12px;background:#FDECEA;color:var(--crit);border-radius:6px;font-size:14px}.legend{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:12px;color:var(--muted);font-size:13px}.legend span{display:flex;align-items:center;gap:6px}.legend i{width:8px;height:8px;border-radius:50%;background:var(--line)}.legend i.ready{background:var(--warn)}.legend i.blocked,.legend i.invalidated{background:var(--crit)}.legend i.confirmed{background:var(--good)}.queue{border-top:1px solid var(--line)}.archive-row{display:grid;grid-template-columns:minmax(160px,1fr) 150px minmax(240px,2fr) auto;gap:16px;align-items:center;min-height:72px;border-bottom:1px solid var(--line);padding:12px 4px}.identity{display:grid;gap:4px}.identity span,.detail p{font-size:13px;color:var(--muted);margin:0}.mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums}.state{display:flex;align-items:center;gap:8px;font-size:12px}.pill{border-radius:999px;padding:4px 9px;background:var(--surface-2)}.pill.ready{background:var(--warn-soft);color:var(--warn)}.pill.confirmed{background:var(--good-soft);color:var(--good)}.pill.blocked,.pill.invalidated{background:#FDECEA;color:var(--crit)}.detail .blocker{color:var(--crit)}.manifest-summary{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:13px;color:var(--muted)}.manifest-link{min-height:44px;padding:0 12px;border:1px solid var(--accent);border-radius:7px;background:var(--surface);color:var(--accent);font:600 13px inherit;cursor:pointer}.manifest-link:hover{background:var(--accent-soft)}
.book-link{min-height:44px;display:inline-flex;align-items:center;padding:0 12px;border:1px solid var(--accent);border-radius:7px;background:var(--surface);color:var(--accent);font:600 13px inherit;text-decoration:none}.book-link:hover{background:var(--accent-soft)}
.manifest{margin:-8px -12px -16px}.manifest-meta{display:grid;gap:7px;padding:0 16px 14px;border-bottom:1px solid var(--line)}.manifest-meta>div{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;color:var(--muted);font-size:13px}.manifest-meta p{margin:0;color:var(--muted);font-size:13px}.archive-status{padding:4px 8px;border-radius:999px;font-size:12px}.archive-status.confirmed{background:var(--good-soft);color:var(--good)}.archive-status.ready{background:var(--warn-soft);color:var(--warn)}.archive-status.invalidated,.archive-status.draft{background:#FDECEA;color:var(--crit)}
.archive-viewer{display:grid;grid-template-columns:220px 300px minmax(0,1fr);height:min(72vh,760px);min-height:520px}.stage-nav,.record-index{min-height:0;border-right:1px solid var(--line);background:var(--surface)}.stage-nav{overflow-y:auto}.stage-nav button{width:100%;min-height:58px;display:grid;grid-template-columns:36px minmax(0,1fr) 24px;gap:8px;align-items:center;padding:8px 10px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);text-align:left;cursor:pointer}.stage-nav button:hover,.stage-nav button.active{background:var(--accent-soft)}.stage-nav button.active{box-shadow:inset 3px 0 var(--accent)}.stage-number{font:600 12px var(--font-mono);color:var(--accent)}.stage-nav b,.stage-nav small{display:block}.stage-nav b{font-size:13px}.stage-nav small{margin-top:2px;color:var(--muted);font-size:11px;line-height:1.25}.stage-nav em{font-style:normal;color:var(--faint);font:500 11px var(--font-mono);text-align:right}
.record-index{display:flex;flex-direction:column}.archive-search{display:grid;gap:5px;padding:12px;border-bottom:1px solid var(--line)}.archive-search span,.record-count{color:var(--muted);font-size:12px}.archive-search input{height:40px;border:1px solid var(--line-strong);border-radius:6px;padding:0 10px;background:var(--surface);color:var(--ink);font:13px inherit}.archive-search input:focus{outline:2px solid var(--accent);outline-offset:-1px}.record-count{padding:8px 12px}.record-list{min-height:0;overflow-y:auto}.record-list button{width:100%;display:grid;grid-template-columns:28px minmax(0,1fr);gap:8px;padding:10px 12px;border:0;border-top:1px solid var(--line);background:transparent;text-align:left;color:var(--ink);cursor:pointer}.record-list button:hover,.record-list button.active{background:var(--accent-soft)}.record-list button.active{box-shadow:inset 3px 0 var(--accent)}.record-list b,.record-list small{display:block;overflow-wrap:anywhere}.record-list b{font-size:13px;line-height:1.4}.record-list small{margin-top:4px;color:var(--muted);font-size:11.5px}.record-order{color:var(--faint);font-size:11px;padding-top:2px}.no-result{padding:24px 14px;color:var(--muted);font-size:13px;line-height:1.5}.preview-pane{min-width:0;overflow-y:auto;background:var(--surface)}.manifest-empty,.empty{padding:28px;text-align:center;color:var(--muted)}
@media(max-width:980px){
  .archive-viewer{grid-template-columns:1fr;grid-template-rows:88px 220px minmax(340px,1fr);height:75vh;min-height:620px;overflow:hidden}
  .stage-nav{display:flex;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid var(--line)}
  .stage-nav button{min-width:180px;width:180px;border-right:1px solid var(--line);border-bottom:0}
  .stage-nav button.active{box-shadow:inset 0 -3px var(--accent)}
  .record-index{border-right:0;border-bottom:1px solid var(--line)}
  .preview-pane{overflow-y:auto}
  .archive-row{grid-template-columns:1fr auto}
  .detail,.actions{grid-column:1/-1}
  .actions button,.manifest-link,.book-link{width:100%;min-height:44px;justify-content:center}
}
</style>
