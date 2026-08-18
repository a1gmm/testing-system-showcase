<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api, SUBCONTRACT_STATUS, type Subcontract, type Contract } from '../api'

const rows = ref<Subcontract[]>([])
const contracts = ref<Contract[]>([])
const loading = ref(false)

async function refresh() {
  loading.value = true
  try {
    rows.value = await api.listSubcontracts()
    if (!contracts.value.length) contracts.value = await api.listContracts()
  } catch (e: any) { ElMessage.error('后端未连接？' + (e?.message || e)) }
  finally { loading.value = false }
}

// 分包状态语言：结果已核 good / 已分包 warn / 计划中 灰
function statusTone(s: string) { return s === '结果已核' ? 'good' : s === '已分包' ? 'warn' : '' }

// 新增分包
const showAdd = ref(false)
const blank = () => ({ contractId: '', items: '', subcontractor: '', qualification: '', reason: '', consent: false, status: '计划中', note: '' })
const form = ref(blank())
function openAdd() { form.value = blank(); showAdd.value = true }
const adding = ref(false)
async function add() {
  if (adding.value) return
  if (!form.value.subcontractor.trim()) return ElMessage.warning('分包方（承接实验室）必填')
  adding.value = true
  try {
    await api.addSubcontract(form.value)
    ElMessage.success('已登记分包')
    showAdd.value = false
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { adding.value = false }
}

// 编辑（改状态/委托方同意/结果核验）
const editing = ref<Subcontract | null>(null)
const edit = ref({ items: '', subcontractor: '', qualification: '', reason: '', consent: false, status: '', resultNote: '', note: '' })
function openEdit(r: Subcontract) {
  editing.value = r
  edit.value = { items: r.items || '', subcontractor: r.subcontractor, qualification: r.qualification || '', reason: r.reason || '', consent: !!r.consent, status: r.status, resultNote: r.result_note || '', note: r.note || '' }
}
async function save() {
  if (!editing.value) return
  try {
    await api.updateSubcontract(editing.value.id, edit.value)
    ElMessage.success('已保存'); editing.value = null; await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}

onMounted(refresh)
</script>

<template>
  <div class="pagewrap">
    <div class="phead">
      <div>
        <h1 class="page">分包管理</h1>
        <p class="sub">分包给有资质的实验室——须核查对方资质、征得委托方书面同意、并核验分包结果（CMA 6.1.2）</p>
      </div>
      <el-button type="primary" @click="openAdd">登记分包</el-button>
    </div>

    <!-- 登记：独立分区，不做卡中卡 -->
    <section v-if="showAdd">
      <div class="sechead"><h2>登记分包</h2></div>
      <div class="card form">
        <div class="row3">
          <label>关联委托单
            <select v-model="form.contractId">
              <option value="">（不关联）</option>
              <option v-for="c in contracts" :key="c.id" :value="c.id">{{ c.id }} · {{ c.client }}</option>
            </select>
          </label>
          <label>分包项目<input v-model="form.items" placeholder="如 二噁英 / 总铬" /></label>
          <label>分包方（承接实验室）<input v-model="form.subcontractor" placeholder="省环科院" /></label>
          <label>分包方资质证号<input v-model="form.qualification" placeholder="CMA / CNAS 证号" /></label>
          <label>状态
            <select v-model="form.status">
              <option v-for="s in SUBCONTRACT_STATUS" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
          <label class="chk"><input type="checkbox" v-model="form.consent" /> 委托方已书面同意分包</label>
        </div>
        <label class="wide">分包原因<textarea v-model="form.reason" rows="2" placeholder="本所无该项资质 / 设备不可用…" /></label>
        <div class="acts">
          <el-button size="small" @click="showAdd = false">取消</el-button>
          <el-button size="small" type="primary" :loading="adding" @click="add">保存</el-button>
        </div>
      </div>
    </section>

    <section>
      <div class="sechead">
        <h2>分包台账</h2>
        <span class="seccount num">共 {{ rows.length }} 条</span>
      </div>
      <div class="card list" v-loading="loading">
        <table>
          <thead><tr><th>委托单</th><th>分包项目</th><th>分包方 / 资质</th><th>委托方同意</th><th>状态</th><th>结果核验</th><th>登记人</th><th class="ta-r">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id">
              <td class="mono dim">{{ r.contract_id || '—' }}</td>
              <td class="tt">{{ r.items || '—' }}</td>
              <td>
                <div class="sc">{{ r.subcontractor }}</div>
                <div v-if="r.qualification" class="ql mono">{{ r.qualification }}</div>
                <div v-else class="ql miss"><span class="sdot warn"></span>未填资质证号</div>
              </td>
              <td>
                <!-- 已同意是常态，安静表达；未确认是 CMA 6.1.2 红线未闭环，才需要跳出来 -->
                <span v-if="r.consent" class="cs"><span class="sdot good"></span>已同意</span>
                <span v-else class="pill warn"><span class="sdot warn"></span>未确认</span>
              </td>
              <td><span class="st"><span class="sdot" :class="statusTone(r.status)"></span>{{ r.status }}</span></td>
              <td class="rz">{{ r.result_note || '—' }}</td>
              <td class="dim">{{ r.who }}</td>
              <td class="ta-r"><button class="lk" @click="openEdit(r)">编辑</button></td>
            </tr>
            <tr v-if="!rows.length && !loading"><td colspan="8" class="empty">暂无分包记录。本所不能做的项目分包给有资质实验室时，点右上角「登记分包」建档。</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="editing" class="drawer" @click.self="editing = null">
      <div class="dbody">
        <div class="dh">
          <span class="dt">编辑分包「{{ editing.subcontractor }}」</span>
          <button class="dx" aria-label="关闭" @click="editing = null"><el-icon><Close /></el-icon></button>
        </div>
        <div class="row3">
          <label>分包项目<input v-model="edit.items" /></label>
          <label>分包方<input v-model="edit.subcontractor" /></label>
          <label>资质证号<input v-model="edit.qualification" /></label>
          <label>状态
            <select v-model="edit.status">
              <option v-for="s in SUBCONTRACT_STATUS" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
        </div>
        <label class="chk"><input type="checkbox" v-model="edit.consent" /> 委托方已书面同意分包</label>
        <label class="wide">分包原因<textarea v-model="edit.reason" rows="2" /></label>
        <label class="wide">结果核验情况<textarea v-model="edit.resultNote" rows="3" placeholder="分包结果已复核，数据可用 / 报告中已标注分包项…" /></label>
        <label class="wide">备注<textarea v-model="edit.note" rows="2" /></label>
        <div class="acts">
          <el-button size="small" @click="editing = null">取消</el-button>
          <el-button size="small" type="primary" @click="save">保存</el-button>
        </div>
      </div>
    </div>

    <p class="note">
      <b>分包三条红线：</b>① 只能分包给<b>有相应资质（CMA/CNAS）</b>的实验室，证号要留档；② 分包前须<b>征得委托方书面同意</b>；③ 分包结果要<b>核验</b>并在最终报告中<b>标注分包项</b>。评审时这三条会逐条查，这里的记录就是证据。
    </p>
  </div>
</template>

<style scoped>
.phead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:26px}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
section{margin-bottom:28px}
.seccount{font-size:12px;color:var(--faint)}

/* 表单：整卡，无卡中卡 */
.form{padding:16px 18px}
.row3{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:12px}
label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--muted)}
label.wide{margin-bottom:12px}
label.chk{flex-direction:row;align-items:center;gap:7px;font-size:12.5px;color:var(--ink);align-self:end;padding-bottom:7px}
label.chk input{width:15px;height:15px;accent-color:var(--accent)}
input,select,textarea{border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 9px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
textarea{resize:vertical}
.acts{display:flex;justify-content:flex-end;gap:8px}

/* 台账表格 */
.list{overflow:hidden}
.list table{width:100%}
@media (max-width:760px){.list{overflow-x:auto}.list table{min-width:720px}}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 18px;font-size:11.5px;color:var(--muted);font-weight:600;background:var(--surface-2);border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:12px 18px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--surface-2)}
.ta-r{text-align:right}
.tt{font-weight:600}
.sc{font-weight:600}
.ql{font-size:11.5px;color:var(--muted);margin-top:3px}
.ql.miss{display:inline-flex;align-items:center;gap:6px;color:var(--warn);font-weight:500}
.rz{max-width:260px;color:var(--muted);font-size:12.5px}
.st{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12.5px}
.cs{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12.5px;color:var(--muted)}
.dim{color:var(--faint);font-size:12px}
.lk{background:none;border:0;color:var(--accent);font-size:12.5px;cursor:pointer;padding:2px 0;font-family:inherit}
.lk:hover{text-decoration:underline}
.empty{text-align:center;color:var(--faint);padding:30px 0}

/* 编辑抽屉 */
.drawer{position:fixed;inset:0;background:rgba(20,28,48,.35);display:flex;justify-content:flex-end;z-index:50}
.dbody{width:min(480px,92vw);background:var(--surface);height:100%;overflow-y:auto;padding:20px;box-shadow:-8px 0 30px -12px rgba(0,0,0,.3)}
.dh{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
.dt{font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dx{background:none;border:0;cursor:pointer;color:var(--faint);font-size:16px;line-height:1;padding:4px;display:flex;border-radius:var(--radius-sm);flex:none}
.dx:hover{color:var(--ink);background:var(--surface-2)}

.note{font-size:12px;color:var(--muted);line-height:1.75;margin:0;padding:0 2px}
.note b{color:var(--ink)}
</style>
