<script setup lang="ts">
// 质控交接（流程第4、5步的家）：质控员在这签收交接单 → 一键生成任务通知单 → 下达。
// 之前这两块塞在"检测录入"页顶部，质控员要去检测员的页面干活——按确认的7步流程拆出来独立成页。
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, type HandoverSheet, type TestNotice } from '../api'
import { can } from '../permissions'

const sheets = ref<HandoverSheet[]>([])          // 待签收（sent）+ 草稿（draft，看得到催采样员发）
const confirmedSheets = ref<HandoverSheet[]>([])
const notices = ref<TestNotice[]>([])
const sheetOpen = ref<string | null>(null)
const rejectReasons = ref<Record<string, string>>({})
const loading = ref(true)
const loadErr = ref('')
const busy = ref<Record<string, boolean>>({})    // 按单号防连点

// 按合同排：同一家的单挨在一起，行上带 单位·项目·委托号
const byContract = (a: any, b: any) => String(a.contract_id || '').localeCompare(String(b.contract_id || '')) || String(a.id).localeCompare(String(b.id))
const who = (x: any) => [x.client, x.project].filter(Boolean).join(' · ')

async function loadAll() {
  loading.value = true
  try {
    const all = await api.listHandoverSheets({})
    sheets.value = all.filter(s => s.status !== 'confirmed').sort(byContract)
    confirmedSheets.value = all.filter(s => s.status === 'confirmed')
    notices.value = (await api.listTestNotices()).sort(byContract)
    loadErr.value = ''
  } catch (e: any) {
    // 加载失败≠没活儿干：必须亮出来，不能演成空队列
    loadErr.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally { loading.value = false }
}
onMounted(loadAll)

async function doConfirmSheet(sh: HandoverSheet) {
  const rejects = sh.sample_ids
    .map(id => ({ sampleId: id, reason: (rejectReasons.value[id] || '').trim() }))
    .filter(r => r.reason)
  try {
    await ElMessageBox.confirm(
      rejects.length ? `整单签收 ${sh.id}，其中 ${rejects.length} 个样品拒收？签收后留痕不可改。` : `整单签收 ${sh.id}？签收后留痕不可改。`,
      '签收确认', { confirmButtonText: '签收', cancelButtonText: '再看看', type: 'warning' },
    )
  } catch { return }
  if (busy.value[sh.id]) return
  busy.value[sh.id] = true
  try {
    await api.confirmHandoverSheet(sh.id, rejects)
    ElMessage.success(rejects.length ? `已签收（拒收 ${rejects.length} 个样品）` : '已整单签收')
    rejectReasons.value = {}; sheetOpen.value = null
    await loadAll()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { busy.value[sh.id] = false }
}

const sheetsNeedNotice = computed(() => {
  const has = new Set(notices.value.map(x => x.sheet_id))
  return confirmedSheets.value.filter(s => !has.has(s.id) && s.detail.some(d => !d.rejected)).sort(byContract)
})
const draftNotices = computed(() => notices.value.filter(x => x.status === 'draft'))
const issuedNotices = computed(() => notices.value.filter(x => x.status === 'issued').slice(0, 8))

async function doCreateNotice(sh: HandoverSheet) {
  if (busy.value[sh.id]) return
  busy.value[sh.id] = true
  try { await api.createNoticeFromSheet(sh.id); ElMessage.success('已生成任务通知单'); await loadAll() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { busy.value[sh.id] = false }
}
async function doSaveNotice(n: TestNotice) {
  if (busy.value[n.id]) return
  busy.value[n.id] = true
  try { await api.updateTestNotice(n.id, { dueAt: n.due_at || '', note: n.note || '' }); ElMessage.success('已保存') }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { busy.value[n.id] = false }
}
async function doIssueNotice(n: TestNotice) {
  try {
    await ElMessageBox.confirm(`下达 ${n.id}？任务将进入检测员待认领池，下达后不可撤回。`, '下达确认',
      { confirmButtonText: '下达', cancelButtonText: '再看看', type: 'warning' })
  } catch { return }
  if (busy.value[n.id]) return
  busy.value[n.id] = true
  try { await api.issueTestNotice(n.id); ElMessage.success('已下达，任务进入待认领池'); await loadAll() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { busy.value[n.id] = false }
}
// 撤回下达（下错了）：没人认领才能撤，后端会拦
async function doRevokeNotice(n: TestNotice) {
  try {
    const { value } = await ElMessageBox.prompt(`撤回 ${n.id}？任务将从认领池撤下、通知单回草稿。填原因（记入留痕）`, '撤回下达', { confirmButtonText: '撤回', cancelButtonText: '不撤', inputValidator: (v: string) => (v && v.trim() ? true : '原因必填') })
    if (value == null) return
    await api.revokeNotice(n.id, value.trim())
    ElMessage.success('已撤回，通知单回到草稿'); await loadAll()
  } catch (e: any) { if (e !== 'cancel') ElMessage.error(e?.response?.data?.error || e?.message || e) }
}
const dt = (iso?: string | null) => (iso ? iso.slice(5, 16).replace('T', ' ') : '')
</script>

<template>
  <div class="pagewrap">
    <div class="phead">
      <div>
        <h1 class="page">质控交接</h1>
        <p class="sub">流程 ④交接签收 → ⑤下达检测任务通知单（HJ-TC-137）· 解密单由质控专管</p>
      </div>
    </div>

    <div v-if="loadErr" class="card errbar">加载失败（不代表没有待办）：{{ loadErr }} <el-button size="small" text type="primary" @click="loadAll">重试</el-button></div>

    <div v-loading="loading">
    <!-- 待签收交接单 -->
    <div class="card blk">
      <div class="blk-head"><b>待签收交接单</b><span class="muted">采样员发来的整单；可逐样拒收（写原因）</span></div>
      <div v-for="sh in sheets" :key="sh.id" class="row">
        <div class="line">
          <b class="num">{{ sh.id }}</b>
          <el-tag size="small" :type="sh.status === 'sent' ? 'warning' : 'info'">{{ sh.status === 'sent' ? '待签收' : '草稿（等采样员发出）' }}</el-tag>
          <span class="ctx"><b>{{ who(sh) || '散样' }}</b><span v-if="sh.contract_id" class="num cid"> {{ sh.contract_id }}</span></span>
          <span>{{ sh.sample_ids.length }} 个样品 · {{ sh.from_person }} {{ dt(sh.from_at) }}</span>
          <span class="spacer"></span>
          <el-button size="small" text type="primary" @click="sheetOpen = sheetOpen === sh.id ? null : sh.id">{{ sheetOpen === sh.id ? '收起' : '看明细' }}</el-button>
          <a class="plink" :href="`/handover-sheets/${sh.id}/print`" target="_blank">打印</a>
          <el-button v-if="sh.status === 'sent' && can('handover_confirm')" size="small" type="primary" :loading="busy[sh.id]" @click="doConfirmSheet(sh)">整单签收</el-button>
        </div>
        <table v-if="sheetOpen === sh.id" class="dtl">
          <tbody>
            <tr><th>样品编号</th><th>检测项目</th><th>拒收原因（留空=正常签收）</th></tr>
            <tr v-for="d in sh.detail" :key="d.sampleId">
              <td class="num">{{ d.sampleId }}</td>
              <td>{{ (d.items || []).join('、') }}</td>
              <td><el-input v-model="rejectReasons[d.sampleId]" size="small" placeholder="如：采样瓶破损" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!sheets.length && !loading" class="empty">没有待签收的交接单</div>
    </div>

    <!-- 任务通知单 -->
    <div class="card blk">
      <div class="blk-head"><b>检测任务通知单</b><span class="muted">HJ-TC-137 · 从已签收交接单生成 → 改完成时限 → 下达（任务进待认领池）</span></div>
      <div v-for="sh in sheetsNeedNotice" :key="sh.id" class="row">
        <div class="line">
          <b class="num">{{ sh.id }}</b>
          <el-tag size="small" type="success">已签收</el-tag>
          <span class="ctx"><b>{{ who(sh) || '散样' }}</b><span v-if="sh.contract_id" class="num cid"> {{ sh.contract_id }}</span></span>
          <span>{{ sh.detail.filter(d => !d.rejected).length }} 个样品待下任务</span>
          <span class="spacer"></span>
          <el-button size="small" type="primary" plain :loading="busy[sh.id]" @click="doCreateNotice(sh)">生成任务通知单</el-button>
        </div>
      </div>
      <div v-for="n in draftNotices" :key="n.id" class="row">
        <div class="line">
          <b class="num">{{ n.id }}</b>
          <el-tag size="small" type="info">草稿</el-tag>
          <span class="ctx"><b>{{ who(n) || '散样' }}</b></span>
          <span>{{ n.groups.length }} 个样品 · {{ n.category }}</span>
          <el-input v-model="n.due_at" size="small" type="date" style="width:150px" />
          <el-input v-model="n.note" size="small" placeholder="备注（如 BOD5 08.05）" style="width:190px" />
          <span class="spacer"></span>
          <el-button size="small" text type="primary" :loading="busy[n.id]" @click="doSaveNotice(n)">保存</el-button>
          <a class="plink" :href="`/test-notices/${n.id}/print`" target="_blank">预览打印</a>
          <el-button size="small" type="primary" :loading="busy[n.id]" @click="doIssueNotice(n)">下达</el-button>
        </div>
      </div>
      <div v-if="!sheetsNeedNotice.length && !draftNotices.length && !loading" class="empty">没有待处理的通知单</div>
    </div>

    <!-- 已下达（含解密单入口） -->
    <div v-if="issuedNotices.length" class="card blk">
      <div class="blk-head"><b>最近已下达</b><span class="muted">打印件含第2页解密单（HJ-TC-149，质控留存，不随任务下发）</span></div>
      <div v-for="n in issuedNotices" :key="n.id" class="row">
        <div class="line">
          <b class="num">{{ n.id }}</b>
          <el-tag size="small" type="success">已下达</el-tag>
          <span class="ctx"><b>{{ who(n) || '散样' }}</b></span>
          <span>{{ n.groups.length }} 个样品 · 下达 {{ dt(n.issued_at) }}<template v-if="n.due_at"> · 限 {{ n.due_at }}</template></span>
          <span class="spacer"></span>
          <a class="plink" :href="`/test-notices/${n.id}/print`" target="_blank">打印 137+149</a>
          <el-button size="small" text type="danger" :loading="busy[n.id]" @click="doRevokeNotice(n)">撤回</el-button>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
.errbar{padding:10px 14px;margin-bottom:14px;color:var(--crit);background:var(--crit-soft);font-size:13px}
.blk{padding:14px 18px;margin-bottom:14px}
.blk-head{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.blk-head b{font-size:14.5px}
.muted{color:var(--faint);font-size:12px}
.row{border-top:1px solid var(--line);padding:8px 0}
.line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.num{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:13px}
.ctx{font-size:13px}
.cid{color:var(--faint);font-size:11.5px;margin-left:6px}
.spacer{flex:1}
.plink{font-size:12px;color:var(--accent);text-decoration:none;white-space:nowrap}
.plink:hover{text-decoration:underline}
.dtl{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
.dtl th{text-align:left;color:var(--faint);font-weight:600;padding:4px 8px;border-bottom:1px solid var(--line)}
.dtl td{padding:5px 8px;border-bottom:1px solid var(--line)}
.empty{color:var(--faint);font-size:12.5px;padding:8px 0}
</style>
