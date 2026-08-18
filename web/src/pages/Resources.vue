<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, currentUser, type Instrument, type RefMaterial, type Reagent, type ResourceAlert } from '../api'
import { can } from '../permissions'
import { settleAll } from '../utils/settle'
import { daysTo } from '../utils/date'
import SymbolInput from '../components/SymbolInput.vue'

const INST_STATUS: Record<string, string> = { normal: '正常', repair: '维修', busy: '使用中', retired: '停用' }
// 仪器状态圆点：正常 good / 维修 warn / 使用中 accent / 停用 灰（无 class）
const INST_DOT: Record<string, string> = { normal: 'good', repair: 'warn', busy: 'accent', retired: '' }
function instDot(s: string | null | undefined) { return s && s in INST_DOT ? INST_DOT[s] : 'good' }

const TABS = [['inst', '仪器设备'], ['ref', '标准物质'], ['reagent', '试剂耗材']] as [string, string][]
const tab = ref('inst')
const instruments = ref<Instrument[]>([])
const refs = ref<RefMaterial[]>([])
const reagents = ref<Reagent[]>([])
const alerts = ref<ResourceAlert[]>([])
const checkouts = ref<import('../api').Checkout[]>([])
const loading = ref(false)
const canCheckout = computed(() => can('instrument_checkout'))
function holderOf(instId: string) { return checkouts.value.find(c => c.instrument_id === instId && c.status === 'out') || null }
// 与后端 /api/instruments|ref-materials|reagents 的 need(c,'admin','tech') 对齐。
// 建/改台账限管理员·技术负责人——防止伪造检定/效期。检测员只读。
const canEdit = computed(() => can('resource_manage'))

async function refresh() {
  loading.value = true
  // 逐个降级：一个接口挂掉不该把整个台账清空
  const r = await settleAll([
    { p: api.listInstruments(), fallback: [] as Instrument[] },
    { p: api.listRefMaterials(), fallback: [] as RefMaterial[] },
    { p: api.listReagents(), fallback: [] as Reagent[] },
    { p: api.resourceAlerts(), fallback: [] as ResourceAlert[] },
  ] as const)
  ;[instruments.value, refs.value, reagents.value, alerts.value] = r.values
  if (!r.ok) ElMessage.warning(`有 ${r.failed} 项资源数据没加载出来，下面显示的可能不全`)
  try { checkouts.value = await api.listCheckouts(true) } catch { /* */ }
  loading.value = false
}

// 领用弹窗：领用人默认当前登录人（可改）；必选「为哪次采样领」——台账才能对上号（PRD 决策11）
const coDlg = ref(false)
const coInst = ref<Instrument | null>(null)
const coForm = ref({ takenBy: '', roundId: '' })
const openRounds = ref<{ id: string; client: string; round_no: number; due_date: string; sampler: string | null }[]>([])
async function doCheckout(i: Instrument) {
  coInst.value = i
  coForm.value = { takenBy: currentUser.value?.name || '', roundId: '' }
  try {
    const all = await api.listAllRounds()
    // 待采/已改期的期次都可关联；默认给派了当前登录人的期次排前面
    const me = currentUser.value?.name || ''
    openRounds.value = all.filter((r: any) => r.status !== 'done')
      .sort((a: any, b: any) => Number((b.sampler || '').includes(me)) - Number((a.sampler || '').includes(me)))
      .map((r: any) => ({ id: r.id, client: r.client, round_no: r.round_no, due_date: r.due_date, sampler: r.sampler }))
    const mine = openRounds.value.find(r => (r.sampler || '').includes(me))
    if (mine) coForm.value.roundId = mine.id
  } catch { openRounds.value = [] }
  coDlg.value = true
}
const coBusy = ref(false)   // 防连点：连点会领用两次
async function submitCheckout() {
  if (!coInst.value || coBusy.value) return
  if (!coForm.value.takenBy.trim()) return ElMessage.warning('填领用人')
  coBusy.value = true
  try {
    const co = await api.checkoutInstrument(coInst.value.id, coForm.value.takenBy.trim(), coForm.value.roundId || undefined)
    if (co.warning) ElMessage.warning(co.warning)
    else ElMessage.success('已领用')
    coDlg.value = false
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { coBusy.value = false }
}
async function doReturn(instId: string) {
  const co = holderOf(instId)
  if (!co) return
  try { await api.returnInstrument(co.id); ElMessage.success('已归还'); await refresh() }
  catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}

function expClass(d: string | null) { if (!d) return ''; const n = daysTo(d); return n < 0 ? 'over' : n <= 30 ? 'soon' : '' }
function expText(d: string | null) { if (!d) return '—'; const n = daysTo(d); return n < 0 ? `${d}（已过期）` : n <= 30 ? `${d}（${n}天）` : d }
// 效期状态圆点：已过期 crit / 30天内 warn / 有效 good；无日期不显示
function expDot(d: string | null) { if (!d) return ''; const c = expClass(d); return c === 'over' ? 'crit' : c === 'soon' ? 'warn' : 'good' }

// 新增 / 编辑（后端同编号覆盖保存，编辑=重新提交）
const showAdd = ref(false)
const editingId = ref<string | null>(null)   // null=新增，否则=编辑该编号
const form = ref<any>({})
function openAdd() { form.value = tab.value === 'inst' ? { status: 'normal' } : {}; editingId.value = null; showAdd.value = true }
function openEdit(row: any) {
  editingId.value = row.id
  if (tab.value === 'inst') form.value = { id: row.id, name: row.name, model: row.model, certUntil: row.cert_until, certNo: row.cert_no, status: row.status || 'normal' }
  else form.value = { ...row }   // 标物/试剂字段与列名一致
  showAdd.value = true
}
const saveBusy = ref(false)
async function save() {
  if (saveBusy.value) return
  saveBusy.value = true
  try {
    if (!form.value.id || !form.value.name) return ElMessage.warning('填编号和名称')
    if (tab.value === 'inst') await api.createInstrument(form.value)
    else if (tab.value === 'ref') await api.createRefMaterial(form.value)
    else await api.createReagent(form.value)
    ElMessage.success(editingId.value ? '已保存修改' : '已登记'); showAdd.value = false; await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { saveBusy.value = false }
}
// 删除（标物/试剂）
async function del(row: any) {
  const ok = await ElMessageBox.confirm(`确定删除「${row.name} · ${row.id}」？此操作会留痕。`, '删除', { type: 'warning' }).catch(() => null)
  if (!ok) return
  try {
    tab.value === 'ref' ? await api.deleteRefMaterial(row.id) : await api.deleteReagent(row.id)
    ElMessage.success('已删除'); await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}

onMounted(refresh)
</script>

<template>
  <div class="pagewrap">
    <div class="phead">
      <div>
        <h1 class="page">资源台账</h1>
        <p class="sub">仪器设备 · 标准物质 · 试剂耗材的登记与效期管控</p>
      </div>
      <el-button v-if="canEdit" type="primary" @click="openAdd">登记资源</el-button>
    </div>

    <!-- 到期提醒 -->
    <section v-if="alerts.length">
      <div class="sechead">
        <h2>到期提醒</h2>
        <span class="seccount num">{{ alerts.length }} 项需关注</span>
      </div>
      <div class="card alist">
        <div v-for="a in alerts" :key="a.type + a.id" class="al">
          <span class="sdot" :class="a.bucket === 'overdue' ? 'crit' : 'warn'"></span>
          <span class="al-b">{{ a.bucket === 'overdue' ? '已过期' : '快到期' }}</span>
          <span class="al-n">{{ a.name }} <span class="mono al-i">{{ a.id }}</span></span>
          <span class="al-t">{{ a.typeLabel }}</span>
          <span class="al-d mono">{{ a.date }}</span>
        </div>
      </div>
    </section>

    <section>
      <div class="sechead">
        <h2>资源台账</h2>
        <span class="tabs"><span v-for="[v, l] in TABS" :key="v" class="tab" :class="{ on: tab === v }" @click="tab = v">{{ l }}</span></span>
      </div>

      <div class="card tcard">
        <div v-if="showAdd" class="addbox">
          <span class="editflag">{{ editingId ? '编辑 ' + editingId : '新增登记' }}</span>
          <template v-if="tab === 'inst'">
            <input v-model="form.id" placeholder="编号 TC-010" :readonly="!!editingId" :class="{ ro: editingId }" /><input v-model="form.name" placeholder="名称 pH计" />
            <input v-model="form.model" placeholder="型号" /><input v-model="form.certUntil" type="date" title="检定有效期" />
            <input v-model="form.certNo" placeholder="证书号" />
            <select v-model="form.status" title="状态"><option v-for="(l, k) in INST_STATUS" :key="k" :value="k">{{ l }}</option></select>
          </template>
          <template v-else-if="tab === 'ref'">
            <input v-model="form.id" placeholder="编号" :readonly="!!editingId" :class="{ ro: editingId }" /><input v-model="form.name" placeholder="名称 锌标准溶液" />
            <!-- 规格/标准值常要填 1000μg/mL 这类符号，带符号小键盘 -->
            <SymbolInput v-model="form.spec" placeholder="规格/标准值 如 1000μg/mL" /><input v-model="form.batch" placeholder="批号" />
            <input v-model="form.expiry" type="date" title="有效期" /><input v-model="form.stock" placeholder="库存" /><input v-model="form.supplier" placeholder="厂家" />
          </template>
          <template v-else>
            <input v-model="form.id" placeholder="编号" :readonly="!!editingId" :class="{ ro: editingId }" /><input v-model="form.name" placeholder="名称 硫酸" />
            <input v-model="form.grade" placeholder="级别 优级纯" /><input v-model="form.spec" placeholder="规格" />
            <input v-model="form.batch" placeholder="批号" /><input v-model="form.expiry" type="date" title="有效期" /><input v-model="form.stock" placeholder="库存" />
          </template>
          <el-button size="small" @click="showAdd = false">取消</el-button>
          <el-button size="small" type="primary" :loading="saveBusy" @click="save">保存</el-button>
        </div>

        <div class="tblwrap" v-loading="loading">
          <table v-if="tab === 'inst'">
            <thead><tr><th>编号</th><th>名称</th><th>型号</th><th>检定有效期</th><th>证书号</th><th>状态</th><th>领用 / 操作</th></tr></thead>
            <tbody>
              <tr v-for="i in instruments" :key="i.id" :class="{ off: i.status === 'retired' }">
                <td class="mono b">{{ i.id }}</td><td>{{ i.name }}</td><td>{{ i.model || '—' }}</td>
                <td><span class="exp"><span v-if="expDot(i.cert_until)" class="sdot" :class="expDot(i.cert_until)"></span>{{ expText(i.cert_until) }}</span></td>
                <td class="mono muted">{{ i.cert_no || '—' }}</td>
                <td><span class="st"><span class="sdot" :class="instDot(i.status)"></span>{{ INST_STATUS[i.status] || i.status || '正常' }}</span>
                  <span v-if="holderOf(i.id)" class="holder">· {{ holderOf(i.id)!.taken_by }} 领用中</span>
                </td>
                <td class="acts">
                  <template v-if="canCheckout && i.status !== 'retired' && i.status !== 'repair'">
                    <button v-if="holderOf(i.id)" class="lk" @click="doReturn(i.id)">归还</button>
                    <button v-else class="lk" @click="doCheckout(i)">领用</button>
                  </template>
                  <button v-if="canEdit" class="lk" @click="openEdit(i)">编辑</button>
                  <a class="lk" :href="`/archive?inst=${encodeURIComponent(i.id)}`" title="期间核查不合格时按仪器追溯经手数据">查记录</a>
                </td>
              </tr>
              <tr v-if="!instruments.length && !loading"><td class="empty" colspan="7">还没有仪器设备</td></tr>
            </tbody>
          </table>
          <table v-else-if="tab === 'ref'">
            <thead><tr><th>编号</th><th>名称</th><th>规格/标准值</th><th>批号</th><th>有效期</th><th>库存</th><th>厂家</th><th v-if="canEdit">操作</th></tr></thead>
            <tbody>
              <tr v-for="m in refs" :key="m.id">
                <td class="mono b">{{ m.id }}</td><td>{{ m.name }}</td><td>{{ m.spec || '—' }}</td><td class="mono">{{ m.batch || '—' }}</td>
                <td><span class="exp"><span v-if="expDot(m.expiry)" class="sdot" :class="expDot(m.expiry)"></span>{{ expText(m.expiry) }}</span></td>
                <td class="num">{{ m.stock || '—' }}</td><td class="muted">{{ m.supplier || '—' }}</td>
                <td v-if="canEdit" class="acts"><button class="lk" @click="openEdit(m)">编辑</button><button class="lk danger" @click="del(m)">删除</button></td>
              </tr>
              <tr v-if="!refs.length && !loading"><td class="empty" colspan="8">还没有标准物质</td></tr>
            </tbody>
          </table>
          <table v-else>
            <thead><tr><th>编号</th><th>名称</th><th>级别</th><th>规格</th><th>批号</th><th>有效期</th><th>库存</th><th v-if="canEdit">操作</th></tr></thead>
            <tbody>
              <tr v-for="r in reagents" :key="r.id">
                <td class="mono b">{{ r.id }}</td><td>{{ r.name }}</td><td>{{ r.grade || '—' }}</td><td>{{ r.spec || '—' }}</td><td class="mono">{{ r.batch || '—' }}</td>
                <td><span class="exp"><span v-if="expDot(r.expiry)" class="sdot" :class="expDot(r.expiry)"></span>{{ expText(r.expiry) }}</span></td>
                <td class="num">{{ r.stock || '—' }}</td>
                <td v-if="canEdit" class="acts"><button class="lk" @click="openEdit(r)">编辑</button><button class="lk danger" @click="del(r)">删除</button></td>
              </tr>
              <tr v-if="!reagents.length && !loading"><td class="empty" colspan="8">还没有试剂耗材</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 领用设备（决策11）：领用人默认当前登录人；关联期次让台账对上号 -->
    <el-dialog v-model="coDlg" :title="`领用「${coInst?.name || ''}」`" width="420px">
      <div class="co-form">
        <label>领用人<input v-model="coForm.takenBy" /></label>
        <label>为哪次采样领
          <select v-model="coForm.roundId">
            <option value="">（不关联具体期次）</option>
            <option v-for="r in openRounds" :key="r.id" :value="r.id">{{ r.client }} 第{{ r.round_no }}期 · {{ r.due_date }}{{ r.sampler ? ' · ' + r.sampler : '' }}</option>
          </select>
        </label>
        <p class="co-hint">关联期次后，报告与台账都能查到「这台设备是为哪次采样领的」。</p>
      </div>
      <template #footer>
        <el-button @click="coDlg = false">取消</el-button>
        <el-button type="primary" :loading="coBusy" :disabled="coBusy" @click="submitCheckout">领用</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.co-form{display:flex;flex-direction:column;gap:10px}
.co-form label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted)}
.co-form input,.co-form select{border:1px solid var(--line-strong);border-radius:6px;height:30px;padding:0 9px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}
.co-hint{font-size:11.5px;color:var(--faint);margin:0}
.phead{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:26px}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
section{margin-bottom:28px}
.seccount{font-size:12px;color:var(--faint)}

/* 到期提醒：行式清单，状态靠圆点不靠底色 */
.alist{overflow:hidden}
.al{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--line);font-size:12.5px}
.al:last-child{border-bottom:0}
.al-b{color:var(--muted);flex:none;width:44px}
.al-n{font-weight:600;color:var(--ink);flex:1;min-width:0}
.al-i{font-weight:400;color:var(--faint)}
.al-t{color:var(--faint)}
.al-d{color:var(--faint);flex:none}

/* 分区标题右侧的文字标签页 */
.tabs{display:flex;gap:16px}
.tab{font-size:12.5px;cursor:pointer;color:var(--muted);padding-bottom:3px;border-bottom:2px solid transparent}
.tab:hover{color:var(--ink)}
.tab.on{color:var(--accent-ink);font-weight:600;border-bottom-color:var(--accent)}

.tcard{overflow:hidden}
.addbox{padding:14px 18px;display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--line);background:var(--surface-2);align-items:center}
.addbox input,.addbox select{border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:6px 9px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink);min-width:120px}
.addbox input:focus,.addbox select:focus{outline:2px solid var(--accent);outline-offset:-1px}
.addbox input.ro{background:var(--surface-2);color:var(--faint)}
.editflag{font-size:12px;font-weight:600;color:var(--accent-ink);align-self:center;margin-right:4px}

.tblwrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border-bottom:1px solid var(--line);padding:11px 18px;text-align:left}
th{color:var(--muted);font-weight:600;font-size:12px;background:var(--surface-2);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--surface-2)}
td.b{font-weight:600}
td.muted{color:var(--faint)}
.st,.exp{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);white-space:nowrap}
tr.off td{color:var(--faint)}
.acts{white-space:nowrap}
.lk{background:none;border:0;color:var(--accent);font-size:12.5px;cursor:pointer;padding:2px 6px;font-family:inherit}
.holder{margin-left:8px;font-size:11.5px;color:var(--accent)}
.lk:hover{text-decoration:underline}
.lk.danger{color:var(--crit)}
.empty{color:var(--faint);font-size:13px;text-align:center;padding:20px 18px}
tbody tr:has(.empty):hover{background:transparent}
</style>
