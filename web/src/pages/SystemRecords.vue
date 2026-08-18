<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api, currentUser, SYSREC_CATEGORIES, SYSREC_STATUS, type SystemRecord } from '../api'
import { todayLocal } from '../utils/date'
import RecordAttachments from '../components/RecordAttachments.vue'

const records = ref<SystemRecord[]>([])
const loading = ref(false)
const filter = ref('全部')

// 每类记录的一句话说明（对标质量体系条款，稽查必查）
const CAT_HINT: Record<string, string> = {
  内部审核: '每年至少一次，覆盖体系全要素，开不符合项并整改闭环（CMA 4.5.15）',
  管理评审: '每年一次，输入含内审结果/客户反馈/资源需求，形成改进措施（CMA 4.5.16）',
  人员培训: '新标准/新方法培训 + 能力确认，持证上岗（CMA 4.2）',
  文件受控: '受控文件清单、发放回收、版本变更记录（CMA 4.3）',
  监督检查: '内部质量监督、能力验证、外部监督检查记录',
  其他: '其他体系运行记录',
}

const catCount = computed(() => {
  const m: Record<string, number> = {}
  for (const r of records.value) m[r.category] = (m[r.category] || 0) + 1
  return m
})
const shown = computed(() => filter.value === '全部' ? records.value : records.value.filter(r => r.category === filter.value))

// 状态语言与 Dashboard「体系合规」一致：已完成 good / 进行中 warn / 计划中 灰
function statusTone(s: string) { return s === '已完成' ? 'good' : s === '进行中' ? 'warn' : '' }

async function refresh() {
  loading.value = true
  try { records.value = await api.listSystemRecords() }
  catch (e: any) { ElMessage.error('后端未连接？' + (e?.message || e)) }
  finally { loading.value = false }
}

// 新增记录
const showAdd = ref(false)
// 日期默认今天、负责人默认当前登录人（能改）
const blank = () => ({ category: '内部审核', title: '', recDate: todayLocal(), owner: currentUser.value?.name || '', status: '计划中', content: '', result: '', note: '' })
const form = ref(blank())
function openAdd() { form.value = blank(); if (filter.value !== '全部') form.value.category = filter.value; showAdd.value = true }
const adding = ref(false)
async function add() {
  if (adding.value) return
  if (!form.value.title.trim()) return ElMessage.warning('记录标题必填')
  adding.value = true
  try {
    await api.addSystemRecord(form.value)
    ElMessage.success('已新增')
    showAdd.value = false
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { adding.value = false }
}

// 编辑记录（改状态/结论——活台账，计划中→进行中→已完成）
const editing = ref<SystemRecord | null>(null)
const edit = ref({ title: '', recDate: '', owner: '', status: '', content: '', result: '', note: '' })
function openEdit(r: SystemRecord) {
  editing.value = r
  edit.value = { title: r.title, recDate: r.rec_date || '', owner: r.owner || '', status: r.status, content: r.content || '', result: r.result || '', note: r.note || '' }
}
async function save() {
  if (!editing.value) return
  try {
    await api.updateSystemRecord(editing.value.id, edit.value)
    ElMessage.success('已保存'); editing.value = null; await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
}

onMounted(refresh)
</script>

<template>
  <div class="pagewrap">
    <div class="phead">
      <div>
        <h1 class="page">体系运行记录</h1>
        <p class="sub">内审 · 管评 · 培训 · 文件受控——稽查每次必查的体系运行证据，统一台账留痕</p>
      </div>
      <el-button type="primary" @click="openAdd">新增记录</el-button>
    </div>

    <!-- 新增：独立分区，不做卡中卡 -->
    <section v-if="showAdd">
      <div class="sechead"><h2>新增记录</h2></div>
      <div class="card form">
        <div class="row3">
          <label>分类
            <select v-model="form.category">
              <option v-for="c in SYSREC_CATEGORIES" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <label>记录标题<input v-model="form.title" placeholder="如 2026年度内部审核" /></label>
          <label>日期<input v-model="form.recDate" type="date" /></label>
          <label>负责人/部门<input v-model="form.owner" placeholder="质量负责人" /></label>
          <label>状态
            <select v-model="form.status">
              <option v-for="s in SYSREC_STATUS" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
        </div>
        <label class="wide">明细内容<textarea v-model="form.content" rows="2" placeholder="参训人员 / 受控文件清单 / 评审输入项…" /></label>
        <label class="wide">结论/结果<textarea v-model="form.result" rows="2" placeholder="发现X项不符合，已整改闭环 / 体系运行有效…" /></label>
        <div class="acts">
          <el-button size="small" @click="showAdd = false">取消</el-button>
          <el-button size="small" type="primary" :loading="adding" @click="add">保存</el-button>
        </div>
      </div>
    </section>

    <section>
      <div class="sechead">
        <h2>记录台账</h2>
        <span class="seccount num">共 {{ shown.length }} 条</span>
      </div>

      <div class="tabs">
        <span class="tab" :class="{ on: filter === '全部' }" @click="filter = '全部'">全部 <b class="num">{{ records.length }}</b></span>
        <span v-for="c in SYSREC_CATEGORIES" :key="c" class="tab" :class="{ on: filter === c }" @click="filter = c">{{ c }} <b class="num">{{ catCount[c] || 0 }}</b></span>
      </div>
      <p v-if="filter !== '全部'" class="cathint">{{ CAT_HINT[filter] }}</p>

      <div class="card list" v-loading="loading">
        <table>
          <thead><tr><th>分类</th><th>标题</th><th>日期</th><th>负责人</th><th>状态</th><th>结论/结果</th><th>记录人</th><th class="ta-r">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in shown" :key="r.id">
              <td class="cat">{{ r.category }}</td>
              <td class="tt">{{ r.title }}</td>
              <td class="mono dim">{{ r.rec_date || '—' }}</td>
              <td>{{ r.owner || '—' }}</td>
              <td><span class="st"><span class="sdot" :class="statusTone(r.status)"></span>{{ r.status }}</span></td>
              <td class="rz">{{ r.result || '—' }}</td>
              <td class="dim">{{ r.who }}</td>
              <td class="ta-r"><button class="lk" @click="openEdit(r)">编辑</button></td>
            </tr>
            <tr v-if="!shown.length && !loading"><td colspan="8" class="empty">该分类下暂无记录，点右上角「新增记录」建立第一条。</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="editing" class="drawer" @click.self="editing = null">
      <div class="dbody">
        <div class="dh">
          <span class="dt">编辑「{{ editing.title }}」</span>
          <button class="dx" aria-label="关闭" @click="editing = null"><el-icon><Close /></el-icon></button>
        </div>
        <div class="row3">
          <label>标题<input v-model="edit.title" /></label>
          <label>日期<input v-model="edit.recDate" type="date" /></label>
          <label>负责人/部门<input v-model="edit.owner" /></label>
          <label>状态
            <select v-model="edit.status">
              <option v-for="s in SYSREC_STATUS" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
        </div>
        <label class="wide">明细内容<textarea v-model="edit.content" rows="3" /></label>
        <label class="wide">结论/结果<textarea v-model="edit.result" rows="3" /></label>
        <label class="wide">备注<textarea v-model="edit.note" rows="2" /></label>
        <RecordAttachments type="system_record" :id="editing.id" />
        <div class="acts">
          <el-button size="small" @click="editing = null">取消</el-button>
          <el-button size="small" type="primary" @click="save">保存</el-button>
        </div>
      </div>
    </div>

    <p class="note">
      <b>为什么要有这一页：</b>实验室资质认定（CMA）和监督检查时，评审员必查体系运行证据——每年的内审、管评有没有做，培训能不能持证上岗，文件是不是受控。这里把这些记录统一存档、留操作人和时间，随时能调出来应对检查。
    </p>
  </div>
</template>

<style scoped>
.phead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:26px}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
section{margin-bottom:28px}
.seccount{font-size:12px;color:var(--faint)}

/* 筛选：唯一强调色用在可交互处 */
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.tab{font-size:12.5px;padding:5px 13px;border-radius:20px;border:1px solid var(--line-strong);cursor:pointer;color:var(--muted);background:var(--surface);transition:border-color .13s ease,color .13s ease}
.tab:hover{border-color:var(--accent);color:var(--accent-ink)}
.tab b{font-family:var(--font-mono);font-size:11px;font-weight:600;opacity:.7;margin-left:3px}
.tab.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.cathint{font-size:12px;color:var(--muted);margin:0 0 12px;padding:0 2px;line-height:1.6}

/* 表单：整卡，无卡中卡 */
.form{padding:16px 18px}
.row3{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:12px}
label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--muted)}
label.wide{margin-bottom:12px}
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
.cat{color:var(--muted);font-size:12.5px;white-space:nowrap}
.tt{font-weight:600;max-width:240px}
.rz{max-width:280px;color:var(--muted);font-size:12.5px}
.st{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12.5px}
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
