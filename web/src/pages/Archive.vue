<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, type RecordRow, type Audit } from '../api'
import { auditText, actionLabel } from '../utils/auditText'

const STATUS = [['', '全部'], ['draft', '草稿'], ['submitted', '待复核'], ['reviewed', '待审核'], ['approved', '已定稿'], ['rejected', '已打回']] as [string, string][]
const statusLabel: Record<string, string> = { draft: '草稿', submitted: '待复核', reviewed: '待审核', approved: '已定稿', rejected: '已打回' }
// 记录状态 → 圆点语义：已定稿 good / 已打回 crit / 流转中 accent / 草稿 灰
const statusDot: Record<string, string> = { draft: '', submitted: 'accent', reviewed: 'accent', approved: 'good', rejected: 'crit' }

const all = ref<RecordRow[]>([])
const keyword = ref('')
const _route = useRoute()
if (typeof _route.query.inst === 'string') keyword.value = _route.query.inst   // 资源台账「查记录」跳来：按仪器号过滤
const statusFilter = ref('')
const selected = ref<RecordRow | null>(null)
const audit = ref<Audit[]>([])
const loading = ref(false)

async function refresh() {
  loading.value = true
  try { all.value = await api.listRecordsByStatus() }
  catch (e: any) { ElMessage.error('后端未连接？' + (e?.message || e)) }
  finally { loading.value = false }
}
const filtered = computed(() => all.value.filter(r => {
  if (statusFilter.value && r.status !== statusFilter.value) return false
  if (keyword.value) {
    const k = keyword.value.toLowerCase()
    if (!(r.sample_id + r.template_code + r.analyte + (r.template_name || '') + (r.instrument_id || '') + ((r.data as any)?.meta?.refMaterials || []).join(' ')).toLowerCase().includes(k)) return false
  }
  return true
}))
// 记录只增不删，一年下来上千条，全量渲染会卡：轻量分页，每页 50；搜索/筛选变了回到第 1 页
const PAGE_SIZE = 50
const page = ref(1)
const paged = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
watch([keyword, statusFilter], () => { page.value = 1 })
const auditError = ref(false)
async function select(r: RecordRow) {
  selected.value = r
  auditError.value = false
  // 拉取失败必须如实报错——合规系统里把「加载失败」显示成「无留痕」是误导
  try { audit.value = await api.getAudit(r.id) }
  catch { audit.value = []; auditError.value = true; ElMessage.error('留痕加载失败（不是没有留痕）——请刷新重试') }
}
function fmt(iso: string) { return iso ? iso.slice(0, 19).replace('T', ' ') : '' }

// —— 任意实体留痕查询：合同受理/派工/报告签发/点位改动等都写了库，以前没界面能看 ——
const entityId = ref('')
const entityAudit = ref<Audit[]>([])
const entityLoading = ref(false)
const entityTried = ref(false)
async function queryEntity() {
  const id = entityId.value.trim()
  if (!id) return ElMessage.warning('输入委托号 / 期次号 / 报告号 / 样品号')
  entityLoading.value = true; entityTried.value = true
  try { entityAudit.value = await api.listAudit(id) }
  catch (e: any) { entityAudit.value = []; ElMessage.error('查询失败：' + (e?.response?.data?.error || e?.message || e)) }
  finally { entityLoading.value = false }
}

onMounted(refresh)
</script>

<template>
  <div class="pagewrap wide">
    <div class="phead">
      <div>
        <h1 class="page">数据留痕归档</h1>
        <p class="sub">全部检测记录与其全程操作留痕（防篡改 · 只增不改）</p>
      </div>
      <span class="hcount num">共 {{ filtered.length }} 条</span>
    </div>

    <!-- 任意实体留痕：合同受理/派工/改期/点位改动/报告签发作废…按编号直查 -->
    <div class="card entq">
      <b>按编号查留痕</b>
      <input v-model="entityId" placeholder="委托号 WT2026-0001 / 期次号 / 报告号 BG2026-0001 / 样品号" @keyup.enter="queryEntity" />
      <el-button size="small" type="primary" :loading="entityLoading" @click="queryEntity">查留痕</el-button>
      <span class="entq-hint">检测记录的逐格留痕在下方列表里点开看</span>
      <div v-if="entityTried" class="entq-res">
        <div v-for="a in entityAudit" :key="a.id" class="arow">
          <b>{{ a.who }}</b><span v-if="a.username" class="mono un">@{{ a.username }}</span>
          <span class="atag">{{ actionLabel[a.action] || a.action }}</span>
          <span class="adetail">{{ typeof a.detail === 'object' ? JSON.stringify(a.detail) : a.detail }}</span>
          <span class="mono t">{{ fmt(a.at) }}</span>
        </div>
        <div v-if="!entityAudit.length && !entityLoading" class="empty">这个编号下没有留痕（检查编号是否输对）</div>
      </div>
    </div>

    <div class="archive">
      <div class="left card">
        <div class="lhead">
          <input v-model="keyword" class="search" placeholder="搜样品编号 / 表号 / 项目…" />
          <div class="frow">
            <span v-for="[v, l] in STATUS" :key="v" class="chip" :class="{ on: statusFilter === v }" @click="statusFilter = v">{{ l }}</span>
          </div>
        </div>
        <div class="list" v-loading="loading">
          <div v-for="r in paged" :key="r.id" class="item" :class="{ on: selected?.id === r.id }" @click="select(r)">
            <div class="itop">
              <span class="rid mono">{{ r.sample_id }}</span>
              <span class="rst"><span class="sdot" :class="statusDot[r.status]"></span>{{ statusLabel[r.status] }}</span>
            </div>
            <div class="isub">{{ r.analyte }}<span v-if="r.method"> · {{ r.method }}</span> · <span class="mono">{{ r.template_code }}</span></div>
          </div>
          <div v-if="!filtered.length && !loading" class="empty">没有符合条件的记录</div>
        </div>
        <el-pagination v-if="filtered.length > PAGE_SIZE" class="pager" layout="total, prev, pager, next"
          :total="filtered.length" :page-size="PAGE_SIZE" v-model:current-page="page" size="small" />
      </div>

      <div class="right card">
        <template v-if="selected">
          <div class="dhead">
            <div class="dname">
              <span class="mono">{{ selected.sample_id }} · {{ selected.template_code }}</span>
              <span class="pill" :class="statusDot[selected.status]">{{ statusLabel[selected.status] }}</span>
            </div>
            <div class="dsub">{{ selected.template_name || selected.analyte }}</div>
          </div>
          <div class="dbody">
            <div class="meta-grid">
              <div><b>检测项目</b>{{ selected.analyte || '—' }}</div>
              <div><b>检测方法</b>{{ selected.method || '—' }}</div>
              <div><b>认领仪器</b>{{ selected.instrument_id || '—' }}</div>
              <div><b>复核人</b>{{ selected.reviewer || '—' }}</div>
              <div><b>审核人</b>{{ selected.approver || '—' }}</div>
              <div><b>最后更新</b><span class="num">{{ fmt(selected.updated_at) }}</span></div>
            </div>
            <div v-if="selected.reject_reason" class="reject">
              <span class="sdot crit"></span>被打回：{{ selected.reject_reason }}
            </div>

            <div class="sechead"><h2>全程留痕</h2><span class="seccount num">{{ audit.length }} 条</span></div>
            <div class="trail">
              <div v-for="a in audit" :key="a.id" class="trow">
                <span class="tw">{{ a.who }}</span>
                <span class="ta">{{ actionLabel[a.action] || a.action }}</span>
                <span class="tt">{{ auditText(a) }}</span>
                <span class="tm mono">{{ fmt(a.at) }}</span>
              </div>
              <div v-if="auditError" class="empty" style="color:var(--crit)">留痕加载失败（不代表没有留痕）——请刷新重试</div>
              <div v-else-if="!audit.length" class="empty">无留痕</div>
            </div>
          </div>
        </template>
        <div v-else class="empty pick">左侧选一条记录，查看它的全程留痕</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pagewrap{display:flex;flex-direction:column;height:calc(100vh - 58px - 44px)}
.phead{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;flex:none}
.page{font-size:22px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0;font-size:13px}
.hcount{color:var(--faint);font-size:12.5px;padding-top:9px}
.seccount{font-size:12px;color:var(--faint)}

.archive{display:grid;grid-template-columns:340px 1fr;gap:16px;flex:1;min-height:0}
@media (max-width:760px){.archive{grid-template-columns:1fr}.meta-grid{grid-template-columns:1fr 1fr}}
.left{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.lhead{padding:12px 14px;border-bottom:1px solid var(--line);flex:none}
.search{width:100%;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:8px 11px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}
.search:focus{outline:2px solid var(--accent);outline-offset:-1px}
.frow{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip{font-size:11.5px;padding:2px 9px;border-radius:20px;background:var(--surface);border:1px solid var(--line-strong);color:var(--muted);cursor:pointer;transition:border-color .13s ease,color .13s ease}
.chip:hover{border-color:var(--accent);color:var(--accent-ink)}
.chip.on{background:var(--accent);color:#fff;border-color:var(--accent)}

.list{flex:1;overflow-y:auto;min-height:0}
.pager{flex:none;padding:8px 12px;border-top:1px solid var(--line);justify-content:center}
.item{padding:11px 14px;cursor:pointer;border-bottom:1px solid var(--line);border-left:2px solid transparent;transition:background .12s ease}
.item:hover{background:var(--surface-2)}
.item.on{background:var(--accent-soft);border-left-color:var(--accent)}
.itop{display:flex;align-items:center;justify-content:space-between;gap:8px}
.rid{font-size:13px;font-weight:600}
.rst{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);white-space:nowrap}
.isub{font-size:12px;color:var(--faint);margin-top:4px}

.right{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.dhead{padding:16px 18px;border-bottom:1px solid var(--line);flex:none}
.dname{font-size:15px;font-weight:650;display:flex;align-items:center;gap:9px}
.dsub{font-size:12.5px;color:var(--muted);margin-top:4px}
.dbody{padding:18px;overflow-y:auto;min-height:0}
.meta-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px 20px;margin-bottom:20px}
.meta-grid div{font-size:13px}
.meta-grid b{color:var(--faint);font-weight:400;margin-right:8px;font-size:12px}
.reject{display:flex;align-items:center;gap:8px;background:var(--crit-soft);color:var(--crit);border-radius:var(--radius-sm);padding:9px 12px;font-size:12.5px;margin-bottom:20px}

/* 留痕：行式，动作用文字不用彩色胶囊 */
.trail{display:flex;flex-direction:column}
.trow{display:flex;align-items:baseline;gap:10px;padding:9px 2px;border-bottom:1px solid var(--line);font-size:12.5px}
.trow:last-child{border-bottom:0}
.tw{font-weight:600;color:var(--ink);flex:none;min-width:52px}
.ta{color:var(--accent-ink);font-weight:600;flex:none;min-width:56px}
.tt{flex:1;color:var(--muted);min-width:0}
.tm{color:var(--faint);flex:none}
.empty{color:var(--faint);font-size:13px;padding:20px 14px;text-align:center}
/* 按编号查留痕 */
.entq{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;margin-bottom:14px;font-size:13px}
.entq input{flex:1;min-width:220px;border:1px solid var(--line-strong);border-radius:7px;height:30px;padding:0 10px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.entq-hint{font-size:11.5px;color:var(--faint)}
.entq-res{flex-basis:100%;max-height:260px;overflow-y:auto;border-top:1px solid var(--line);margin-top:6px;padding-top:6px}
.entq-res .arow{display:flex;align-items:baseline;gap:8px;font-size:12.5px;color:var(--muted);padding:5px 0;border-bottom:1px dashed var(--line)}
.entq-res .un{font-size:11px;color:var(--faint)}
.entq-res .atag{font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:10px;background:var(--surface-2);border:1px solid var(--line);white-space:nowrap}
.entq-res .adetail{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--faint)}
.entq-res .t{color:var(--faint);white-space:nowrap}
.pick{margin:auto}
</style>
