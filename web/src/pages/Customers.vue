<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { api, hasRole, type Customer, type Contract } from '../api'

const rows = ref<Customer[]>([])
const loading = ref(false)
const selected = ref<Customer | null>(null)
const contracts = ref<Contract[]>([])
const contractsError = ref(false)
const canEdit = computed(() => hasRole('registrar', 'tech', 'admin'))

// 客户一多就翻不动了：按名称/联系人/电话过滤
const keyword = ref('')
const shown = computed(() => rows.value.filter(c => {
  if (!keyword.value) return true
  const k = keyword.value.toLowerCase()
  return (c.name + (c.contact || '') + (c.phone || '')).toLowerCase().includes(k)
}))

async function refresh() {
  loading.value = true
  try {
    rows.value = await api.listCustomers()
    if (selected.value) selected.value = rows.value.find(c => c.name === selected.value!.name) || null
  } catch (e: any) { ElMessage.error('后端未连接？' + (e?.message || e)) }
  finally { loading.value = false }
}

async function open(c: Customer) {
  selected.value = c
  edit.value = { name: c.name, contact: c.contact || '', phone: c.phone || '', address: c.address || '', note: c.note || '' }
  contractsError.value = false
  try { contracts.value = await api.customerContracts(c.name) }
  catch { contracts.value = []; contractsError.value = true }   // 拉不到≠没有合同，界面要分开说
}

const edit = ref({ name: '', contact: '', phone: '', address: '', note: '' })
const saveBusy = ref(false)
async function save() {
  if (!selected.value || saveBusy.value) return
  saveBusy.value = true
  try {
    await api.upsertCustomer({ name: edit.value.name, contact: edit.value.contact, phone: edit.value.phone, address: edit.value.address, note: edit.value.note })
    ElMessage.success('客户信息已保存')
    await refresh()
  } catch (e: any) { ElMessage.error(e?.response?.data?.error || e?.message || e) }
  finally { saveBusy.value = false }
}

onMounted(refresh)
</script>

<template>
  <div class="pagewrap">
    <div class="phead">
      <div>
        <h1 class="page">客户档案</h1>
        <p class="sub">委托单位独立建档——建合同时自动补建；可补联系人/地址，并按客户查历史合同</p>
      </div>
    </div>

    <div class="split">
      <!-- 客户列表 -->
      <section class="left">
        <div class="sechead"><h2>客户</h2><span class="seccount num">共 {{ rows.length }} 家</span></div>
        <div class="card list" v-loading="loading">
          <div class="sbar"><input v-model="keyword" class="search" placeholder="搜客户名称 / 联系人 / 电话…" /></div>
          <div v-if="!rows.length" class="empty">还没有客户——去「委托项目」建第一份合同，客户会自动建档。</div>
          <div v-else-if="!shown.length" class="empty">没有匹配的客户</div>
          <div v-for="c in shown" :key="c.id" class="citem" :class="{ on: selected?.name === c.name }" @click="open(c)">
            <div class="cname">{{ c.name }}</div>
            <div class="cmeta">
              <span class="pill">{{ c.contract_count }} 单</span>
              <span v-if="c.contact" class="cinfo">{{ c.contact }}</span>
              <span v-else class="cinfo faint">未填联系人</span>
              <span v-if="c.phone" class="cinfo">{{ c.phone }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 详情：编辑信息 + 该客户合同 -->
      <section class="right" v-if="selected">
        <div class="sechead"><h2>{{ selected.name }}</h2></div>
        <div class="card form">
          <div class="row2">
            <label>联系人<input v-model="edit.contact" :disabled="!canEdit" placeholder="如 张经理" /></label>
            <label>联系电话<input v-model="edit.phone" :disabled="!canEdit" placeholder="如 13800000000" /></label>
          </div>
          <label class="wide">地址<input v-model="edit.address" :disabled="!canEdit" placeholder="如 山东临沂…" /></label>
          <label class="wide">备注<input v-model="edit.note" :disabled="!canEdit" placeholder="可空" /></label>
          <div class="acts" v-if="canEdit">
            <el-button size="small" type="primary" :loading="saveBusy" @click="save">保存客户信息</el-button>
          </div>
        </div>

        <div class="sechead"><h2>历史合同</h2><span class="seccount num">共 {{ contracts.length }} 单</span></div>
        <div class="card list">
          <div v-if="contractsError" class="empty" style="color:var(--crit)">合同列表加载失败（不代表没有合同）——请刷新重试</div>
          <div v-else-if="!contracts.length" class="empty">该客户暂无合同。</div>
          <div v-for="ct in contracts" :key="ct.id" class="ctitem">
            <span class="mono">{{ ct.id }}</span>
            <span class="ctproj">{{ ct.project || '（未填项目名）' }}</span>
            <span class="pill" :class="ct.status === 'terminated' ? 'crit' : ct.accepted_at ? 'good' : ''">{{ ct.status === 'terminated' ? '已终止' : ct.accepted_at ? '进行中' : '待受理' }}</span>
          </div>
        </div>
      </section>
      <section class="right empty-pane" v-else>
        <div class="empty">← 选一个客户，查看联系信息和历史合同</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.split{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:18px;align-items:start}
.citem{padding:11px 13px;border-radius:9px;cursor:pointer;border:1px solid transparent;transition:background .12s}
.citem:hover{background:var(--surface-2)}
.citem.on{background:var(--accent-soft);border-color:var(--accent)}
.cname{font-weight:650;font-size:14px}
.cmeta{display:flex;align-items:center;gap:9px;margin-top:3px;font-size:12px;color:var(--faint)}
.cinfo.faint{opacity:.7}
.ctitem{display:flex;align-items:center;gap:12px;padding:9px 4px;border-bottom:1px solid var(--line);font-size:13px}
.ctitem:last-child{border-bottom:none}
.ctproj{flex:1;color:var(--muted)}
.empty{padding:20px;text-align:center;color:var(--faint);font-size:13px}
.sbar{padding:10px 12px;border-bottom:1px solid var(--line)}
.search{width:100%;box-sizing:border-box;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:7px 10px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.search:focus{outline:2px solid var(--accent);outline-offset:-1px}
.empty-pane{display:flex;align-items:center;justify-content:center;min-height:200px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted)}
.form .wide{margin-top:12px}
.form input{margin-top:2px}
.acts{margin-top:14px;display:flex;justify-content:flex-end}
@media (max-width:820px){.split{grid-template-columns:1fr}}
</style>
