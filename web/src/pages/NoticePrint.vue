<script setup lang="ts">
// 检测任务通知单打印页：照纸质 HJ-TC-137 版式；第二页附样品解密单 HJ-TC-149（仅质控/技术可见）。
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api, type TestNotice, type NoticeDecodeRow, type OrgProfile } from '../api'

const route = useRoute()
const n = ref<TestNotice | null>(null)
const decode = ref<NoticeDecodeRow[] | null>(null)
const org = ref<OrgProfile | null>(null)
const err = ref('')
// 单位抬头走公司主数据（org-profile），拉不到再退回默认——换抬头不用改代码
const orgName = computed(() => org.value?.name || '示例环境检测技术服务有限公司')
onMounted(async () => {
  try {
    n.value = await api.getTestNotice(String(route.params.id))
    try { org.value = await api.getOrgProfile() } catch { org.value = null }
    try { decode.value = await api.decodeNotice(String(route.params.id)) } catch { decode.value = null }
  } catch (e: any) { err.value = e?.response?.data?.error || e?.message || String(e) }
})

const CATS = ['地表水', '地下水', '污水', '生活饮用水', '废气', '环境空气', '土壤', '固废', '盲样', '其他（海水）']
const NATURES = ['自行监测', '环评监测', '验收检测', '其他']
const SOURCES = ['现场检测', '现场采样', '来样检测', '其他']
const tick = (opts: string[], sel: string | null) => opts.map(o => ((sel || '').includes(o) ? '☑' : '□') + o)
const cats = computed(() => tick(CATS, n.value?.category ?? null))
const natures = computed(() => tick(NATURES, n.value?.nature ?? null))
const sources = computed(() => tick(SOURCES, n.value?.source ?? null))
const qcNos = computed(() => (n.value?.groups || []).map(g => g.sampleId).join('、'))
const d = (iso?: string | null) => (iso ? iso.slice(0, 10).replaceAll('-', '.') : '')
function doPrint() { window.print() }
// 直接输 URL 进来的标签 window.close() 无效——关不掉就退回质控交接页
function doClose() { window.close(); setTimeout(() => { location.href = '/qc' }, 200) }
</script>

<template>
  <div class="printwrap">
    <div class="toolbar noprint">
      <button class="btn primary" @click="doPrint">🖨 打印</button>
      <button class="btn" @click="doClose">关闭</button>
      <span class="tip">A4 打印，浏览器设置里去掉页眉页脚</span>
      <span v-if="n && n.status === 'draft'" class="tip warn">草稿（未下达）——打印件仅供预览</span>
    </div>
    <div v-if="err" class="errbox noprint">{{ err }}</div>

    <div v-if="n" class="page">
      <div class="formno">HJ-TC-137</div>
      <div class="org">{{ orgName }}</div>
      <div class="title">检测任务通知单</div>
      <table class="ftbl">
        <tbody>
          <tr><td class="k">质控编号</td><td colspan="3">{{ qcNos }}</td></tr>
          <tr><td class="k">样品份数/状态</td><td colspan="3">{{ n.sample_desc || '' }}</td></tr>
          <tr><td class="k">任务类别</td><td colspan="3" class="opts">{{ cats.join('　') }}</td></tr>
          <tr><td class="k">接样时间</td><td colspan="3">{{ d(n.received_at) }}</td></tr>
          <tr><td class="k">任务性质</td><td colspan="3" class="opts">{{ natures.join('　') }}</td></tr>
          <tr><td class="k">样品来源</td><td colspan="3" class="opts">{{ sources.join('　') }}</td></tr>
          <tr>
            <td class="k tall">检测项目</td>
            <td colspan="3" class="items">
              <p v-for="g in n.groups" :key="g.sampleId">{{ g.sampleId }}：{{ g.analytes.join('、') }}</p>
            </td>
          </tr>
          <tr>
            <td class="k">下达时间</td><td>{{ d(n.issued_at) || d(n.created_at) }}</td>
            <td class="k">完成时间</td><td>{{ d(n.due_at) || '' }}</td>
          </tr>
          <tr><td class="k">承接科室</td><td>{{ n.dept || '环境室' }}</td><td class="k">承办人</td><td>{{ n.issuer || '' }}</td></tr>
          <tr><td class="k">备注</td><td colspan="3">{{ n.note || '╱' }}</td></tr>
        </tbody>
      </table>
      <div class="signs"><span>审核人：＿＿＿＿＿＿</span><span>共 {{ decode ? 2 : 1 }} 页 第 1 页</span></div>
    </div>

    <div v-if="n && decode" class="page">
      <div class="formno">HJ-TC-149</div>
      <div class="org">{{ orgName }}</div>
      <div class="title">样品解密单</div>
      <div class="meta"><span>接样日期：{{ d(n.received_at) }}</span><span>通知单号：{{ n.id }}</span></div>
      <table class="ftbl">
        <thead><tr><td class="k">样品编号</td><td class="k">采样点位</td><td class="k">受检单位</td><td class="k">备注</td></tr></thead>
        <tbody>
          <tr v-for="r in decode" :key="r.sampleId">
            <td>{{ r.sampleId }}</td>
            <td>{{ r.qcType ? '—' : (r.pointName || '') }}</td>
            <td>{{ r.client }}</td>
            <td>{{ r.matrix }}{{ r.qcType ? '·' + r.qcType : '' }}</td>
          </tr>
          <tr><td class="blank" colspan="4">以下空白</td></tr>
        </tbody>
      </table>
      <div class="signs"><span class="warn">※ 解密单由质控员存档，不随任务下发</span><span>共 2 页 第 2 页</span></div>
    </div>
  </div>
</template>

<style scoped>
.printwrap{background:#e8e8e8;min-height:100vh;padding:20px 0;font-family:"Songti SC","SimSun",serif;color:#000}
.toolbar{max-width:794px;margin:0 auto 14px;display:flex;align-items:center;gap:10px}
.btn{padding:8px 20px;border:1px solid #bbb;border-radius:6px;background:#fff;font-size:14px;cursor:pointer}
.btn.primary{background:#2563eb;color:#fff;border-color:#2563eb}
.tip{font-size:12px;color:#666}
.tip.warn,.warn{color:#b45309;font-weight:600}
.errbox{max-width:794px;margin:0 auto;padding:14px;background:#fee;border:1px solid #fbb;border-radius:8px;color:#900}
.page{width:794px;min-height:1050px;margin:0 auto 20px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.15);padding:70px 75px;box-sizing:border-box}
.formno{text-align:right;font-size:12px;color:#333}
.org{text-align:center;font-size:20px;font-weight:700;letter-spacing:4px;margin-top:8px}
.title{text-align:center;font-size:24px;font-weight:700;letter-spacing:10px;margin:14px 0 22px}
.meta{display:flex;justify-content:space-between;font-size:14px;margin-bottom:8px}
.ftbl{width:100%;border-collapse:collapse;font-size:14px}
.ftbl td{border:1px solid #000;padding:10px 12px;vertical-align:top;line-height:1.7}
.ftbl .k{width:110px;background:#fafafa;white-space:nowrap;text-align:center;vertical-align:middle}
.ftbl .tall{height:220px}
.ftbl .opts{letter-spacing:1px}
.items p{margin:2px 0}
.blank{text-align:center;color:#666}
.signs{display:flex;justify-content:space-between;margin-top:18px;font-size:14px}
@media print {
  .noprint{display:none}
  .printwrap{background:#fff;padding:0}
  .page{box-shadow:none;margin:0;width:auto;min-height:auto;page-break-after:always}
  .page:last-child{page-break-after:auto}
}
</style>
