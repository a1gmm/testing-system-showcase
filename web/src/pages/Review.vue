<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, currentUser, type RecordRow } from '../api'
import { can } from '../permissions'
import StructuredSheet from '../components/StructuredSheet.vue'

// 待复核(submitted) / 待审核(reviewed) / 已定稿(approved)
const tab = ref<'submitted' | 'reviewed' | 'approved'>('submitted')
const tabs = [['submitted', '待复核'], ['reviewed', '待审核'], ['approved', '已定稿']] as [string, string][]
const list = ref<RecordRow[]>([])
const selected = ref<RecordRow | null>(null)
const loading = ref(false)
const keyword = ref('')
const shown = computed(() => list.value.filter(r => {
  if (!keyword.value) return true
  const k = keyword.value.toLowerCase()
  return (r.sample_id + r.template_code + r.analyte + (r.method || '') + (r.template_name || '') + (r.client || '') + (r.contract_id || '')).toLowerCase().includes(k)
}))
// 队列按合同聚合（全站列表原则）：同一家的记录归一组；盲用户拿到的 contract_id 已脱敏，自然落"散样"
const recGroups = computed(() => {
  const m = new Map<string, { key: string; client: string; contractId: string; rows: RecordRow[] }>()
  for (const r of shown.value) {
    const key = (r as any).contract_id || '散样'
    if (!m.has(key)) m.set(key, { key, client: (r as any).client || '', contractId: (r as any).contract_id || '', rows: [] })
    m.get(key)!.rows.push(r)
  }
  return [...m.values()]
})

async function refresh() {
  loading.value = true
  try {
    list.value = await api.listRecordsByStatus(tab.value)
    if (selected.value && !list.value.find(r => r.id === selected.value!.id)) selected.value = null
  } catch (e: any) { ElMessage.error('后端未连接？' + (e?.message || e)) }
  finally { loading.value = false }
}
function setTab(t: string) { tab.value = t as any; selected.value = null; refresh() }

const level = computed(() => tab.value === 'submitted' ? '复核' : '审核')
// 权限：复核环节要复核员，终审环节要审核员（admin/tech 兜底）；口径走权限矩阵，签名 = 登录账号
const canAct = computed(() => tab.value === 'submitted' ? can('record_review') : can('record_approve'))
const actTip = computed(() => canAct.value ? '' : `${currentUser.value?.name || '当前账号'}没有「${tab.value === 'submitted' ? '复核员' : '审核员'}」权限，只能查看`)

// 防连点：每个动作各自一个 busy（参考 Reports.vue 的 genBusy 样板）
const passBusy = ref(false)
const rejectBusy = ref(false)
const revokeBusy = ref(false)

async function pass() {
  if (!selected.value || passBusy.value) return
  // 通过是签名动作，点错了没有后悔药——先确认一下
  const ok = await ElMessageBox.confirm(`确认${level.value}通过 ${selected.value.sample_id} 这条记录？将以「${currentUser.value?.name}」签名留痕。`, `${level.value}通过`, { confirmButtonText: `${level.value}通过`, cancelButtonText: '取消', type: 'warning' }).catch(() => null)
  if (!ok) return
  const op = tab.value === 'submitted' ? 'review_pass' : 'approve'
  passBusy.value = true
  try {
    await api.reviewRecord(selected.value.id, op)
    ElMessage.success(`${level.value}通过 · 签名 ${currentUser.value?.name}`)
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { passBusy.value = false }
}
async function reject() {
  if (!selected.value || rejectBusy.value) return
  const { value } = await ElMessageBox.prompt('填写打回原因（会记入留痕）', `${level.value}打回`, { confirmButtonText: '打回', cancelButtonText: '取消', inputPlaceholder: '如：空白值异常、平行样偏差过大…' }).catch(() => ({ value: null }))
  if (value == null) return
  const op = tab.value === 'submitted' ? 'review_reject' : 'reject'
  rejectBusy.value = true
  try {
    await api.reviewRecord(selected.value.id, op, undefined, value || '（未填原因）')
    ElMessage.success('已打回')
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { rejectBusy.value = false }
}
// 已定稿记录打回重录：审核员专用；进了已签发报告的后端会拦（返回中文报错）
async function revoke() {
  if (!selected.value || revokeBusy.value) return
  const { value } = await ElMessageBox.prompt('把这条已定稿记录打回重录？填原因（会记入留痕）', '打回重录', {
    confirmButtonText: '打回重录', cancelButtonText: '取消', inputPlaceholder: '如：结果誊录错误，需重新录入',
    inputValidator: (v: string) => (v && v.trim() ? true : '原因必填'),
  }).catch(() => ({ value: null }))
  if (value == null) return
  revokeBusy.value = true
  try {
    await api.revokeRecord(selected.value.id, value.trim())
    ElMessage.success('已打回重录，记录回到检测员手上')
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { revokeBusy.value = false }
}

const recheckBusy = ref(false)
async function toggleRecheck() {
  if (!selected.value || recheckBusy.value) return
  const on = selected.value.recheck === 1
  recheckBusy.value = true
  try {
    if (on) {
      await api.flagRecheck(selected.value.id, '', false)
      ElMessage.success('已取消复检标记')
    } else {
      const { value } = await ElMessageBox.prompt('这条结果超标/存疑，标记为需复检？填原因（记入留痕）', '标记复检', { confirmButtonText: '标记复检', cancelButtonText: '取消', inputPlaceholder: '如：COD 超标，需复检确认' }).catch(() => ({ value: null }))
      if (value == null) return
      if (!value.trim()) return ElMessage.warning('原因必填')
      await api.flagRecheck(selected.value.id, value.trim(), true)
      ElMessage.success('已标记复检 · 实际重测走「打回→重录」')
    }
    await refresh()
    selected.value = list.value.find(r => r.id === selected.value!.id) || null
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { recheckBusy.value = false }
}

onMounted(() => {
  // 审核员（非复核员）打开直接落在「待审核」——少点一下
  const u = currentUser.value
  if (u && !u.roles.includes('admin') && u.roles.includes('approver') && !u.roles.includes('reviewer')) tab.value = 'reviewed'
  refresh()
})
</script>

<template>
  <div class="pagewrap wide rpage">
    <div class="phead">
      <div>
        <h1 class="page">三级审核</h1>
        <p class="sub">检测员提交 → 复核 → 终审；通过与打回均签名留痕</p>
      </div>
      <div class="seg">
        <span v-for="[v, lab] in tabs" :key="v" class="segb" :class="{ on: tab === v }" @click="setTab(v)">{{ lab }}</span>
      </div>
    </div>

    <div class="split">
      <section class="left">
        <div class="sechead">
          <h2>{{ tab === 'submitted' ? '待复核队列' : tab === 'reviewed' ? '待审核队列' : '已定稿记录' }}</h2>
          <span class="seccount num">{{ shown.length }} 条</span>
        </div>
        <div class="card listcard">
          <div class="sbar"><input v-model="keyword" class="search" placeholder="搜样品编号 / 表号 / 项目…" /></div>
          <div class="list" v-loading="loading">
            <template v-for="g in recGroups" :key="g.key">
              <div class="grp-head">
                <b>{{ g.client || (g.contractId ? '' : '散样 / 盲样') }}</b>
                <span v-if="g.contractId" class="mono gcid">{{ g.contractId }}</span>
                <span class="gcnt num">{{ g.rows.length }} 条</span>
              </div>
              <div v-for="r in g.rows" :key="r.id" class="item ingrp" :class="{ on: selected?.id === r.id }" @click="selected = r">
                <div class="itop">
                  <span class="rid mono">{{ r.sample_id }}</span>
                  <span v-if="tab === 'approved'" class="rlvl"><span class="sdot good"></span>已定稿</span>
                  <span v-else class="rlvl"><span class="sdot warn"></span>待{{ level }}</span>
                </div>
                <div class="isub">{{ r.template_name || r.template_code }}</div>
                <div class="imeta"><span v-if="r.serial" class="jl mono">{{ r.serial }}</span>{{ r.analyte }}<span v-if="r.method"> · {{ r.method }}</span> · <span class="mono">{{ r.template_code }}</span></div>
              </div>
            </template>
            <div v-if="!shown.length && !loading" class="empty">{{ tab === 'submitted' ? '没有待复核的记录' : tab === 'reviewed' ? '没有待审核的记录' : '没有已定稿的记录' }}</div>
          </div>
        </div>
      </section>

      <div class="right card">
        <template v-if="selected">
          <div class="dhead">
            <div class="dinfo">
              <div class="dname mono">{{ selected.sample_id }} · {{ selected.template_code }}
                <span v-if="selected.recheck === 1" class="rechk">需复检</span>
              </div>
              <div class="dsub">{{ selected.template_name }}<span v-if="selected.recheck === 1" class="rechk-r"> · 复检原因：{{ selected.recheck_reason }}</span></div>
            </div>
            <div class="acts">
              <span v-if="actTip" class="acttip">{{ actTip }}</span>
              <template v-if="tab === 'approved'">
                <el-button v-if="can('record_approve')" :loading="revokeBusy" :disabled="revokeBusy" @click="revoke">打回重录</el-button>
              </template>
              <template v-else>
                <el-button :loading="recheckBusy" :disabled="!canAct || recheckBusy" @click="toggleRecheck">{{ selected.recheck === 1 ? '取消复检' : '标记复检' }}</el-button>
                <el-button :loading="rejectBusy" :disabled="!canAct || rejectBusy" @click="reject">打回</el-button>
                <el-button :loading="passBusy" :disabled="!canAct || passBusy" type="primary" @click="pass">{{ level }}通过</el-button>
              </template>
            </div>
          </div>
          <div class="dbody">
            <StructuredSheet
              :key="selected.id"
              :sample-id="selected.sample_id" :template-name="selected.template_name"
              :analyte="selected.analyte" :method="selected.method" :matrix="selected.matrix"
              :code="selected.template_code" :sheet-type="selected.sheet_type" />
          </div>
        </template>
        <div v-else class="empty rempty">左侧选一条记录进行复核 / 审核</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 页头 */
.phead{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
.seccount{font-size:12px;color:var(--faint)}

/* 环节切换：分段控件（交互控件，用强调色合理） */
.seg{display:inline-flex;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:2px;gap:2px;margin-top:4px}
.segb{font-size:12.5px;font-weight:500;padding:5px 14px;border-radius:6px;color:var(--muted);cursor:pointer;transition:background .12s ease,color .12s ease}
.segb:hover{color:var(--ink)}
.segb.on{background:var(--accent);color:#fff;font-weight:600}

/* 双栏：页头固定，两栏各自内滚 */
.rpage{display:flex;flex-direction:column;height:calc(100vh - 58px - 44px)}
.split{flex:1;min-height:0;display:grid;grid-template-columns:340px 1fr;gap:16px}
.left{display:flex;flex-direction:column;min-height:0;margin:0}

/* 记录队列 */
.listcard{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.sbar{padding:10px 12px;border-bottom:1px solid var(--line)}
.search{width:100%;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 10px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.search:focus{outline:2px solid var(--accent);outline-offset:-1px}
.list{flex:1;min-height:0;overflow-y:auto}
.grp-head{display:flex;align-items:center;gap:8px;padding:7px 14px;background:var(--surface-2);border-bottom:1px solid var(--line);font-size:12px;position:sticky;top:0;z-index:1}
.grp-head b{font-size:12.5px}
.gcid{color:var(--faint);font-size:11px}
.gcnt{margin-left:auto;color:var(--faint);font-size:11px}
.item{padding:11px 14px;cursor:pointer;border-bottom:1px solid var(--line);border-left:2px solid transparent;transition:background .12s ease}
.item:last-child{border-bottom:0}
.item:hover{background:var(--surface-2)}
.item.on{background:var(--accent-soft);border-left-color:var(--accent)}
.itop{display:flex;align-items:center;justify-content:space-between;gap:8px}
.rid{font-size:13px;font-weight:600;color:var(--ink)}
.rlvl{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);white-space:nowrap}
.isub{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.4}
.imeta{font-size:11.5px;color:var(--faint);margin-top:3px}
.imeta .jl{color:var(--accent-ink);margin-right:6px;font-weight:600}
.empty{padding:24px 16px;text-align:center;color:var(--faint);font-size:13px}

/* 右栏：记录详情 */
.right{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.rempty{margin:auto}
.dhead{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none}
.dinfo{min-width:0}
.dname{font-size:15px;font-weight:700}
.dsub{font-size:12.5px;color:var(--muted);margin-top:4px}
.acts{display:flex;gap:8px;flex:none;align-items:center}
.acttip{font-size:11.5px;color:var(--faint);max-width:220px;text-align:right;line-height:1.4}
.rechk{display:inline-block;font-size:11px;font-weight:700;color:var(--crit);background:var(--crit-soft);border-radius:5px;padding:1px 7px;margin-left:8px;vertical-align:middle}
.rechk-r{color:var(--crit);font-size:12px}
.dbody{flex:1;min-height:0;overflow-y:auto}

@media (max-width:1100px){
  .split{grid-template-columns:280px 1fr}
}

/* 手机：双栏堆叠 */
@media (max-width:760px){
  .rpage{height:auto}
  .split{grid-template-columns:1fr}
  .list{max-height:40vh}
}
</style>
