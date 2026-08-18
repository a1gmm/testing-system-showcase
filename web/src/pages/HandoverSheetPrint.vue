<script setup lang="ts">
// 交接单打印页：水类照 HJ-TC-135（送样为 135-1，多"点位"列），气类照 HJ-TC-596。
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api, type HandoverSheet, type Sample } from '../api'

const route = useRoute()
const sh = ref<HandoverSheet | null>(null)
const smap = ref<Record<string, Sample>>({})
const client = ref('')
const err = ref('')
onMounted(async () => {
  try {
    sh.value = await api.getHandoverSheet(String(route.params.id))
    const all = await api.listSamples()
    for (const s of all) if (sh.value!.sample_ids.includes(s.id)) smap.value[s.id] = s
    if (sh.value!.contract_id) {
      try { client.value = (await api.getContract(sh.value!.contract_id)).client } catch { /* */ }
    }
  } catch (e: any) { err.value = e?.response?.data?.error || e?.message || String(e) }
})

const GAS = ['废气', '有组织废气', '无组织废气', '环境空气', '大气降水']
const isGas = computed(() => Object.values(smap.value).some(s => GAS.includes(s.matrix)))
const isSelf = computed(() => sh.value?.source === 'self')
const formNo = computed(() => (isGas.value ? 'HJ–TC-596' : isSelf.value ? 'HJ–TC-135-1' : 'HJ–TC-135'))
const title = computed(() => (isGas.value ? '环境空气、废气样品交接单' : '水和废水交接记录表'))
// 明细列数随表式变化（气5列 / 送样5列 / 水4列），"以下空白"行的 colspan 要跟着走
const colCount = computed(() => (isGas.value ? 5 : isSelf.value ? 5 : 4))
const dt = (iso?: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '')
function doPrint() { window.print() }
// 直接输 URL 进来的标签 window.close() 无效——关不掉就退回检测录入页
function doClose() { window.close(); setTimeout(() => { location.href = '/samples' }, 200) }
</script>

<template>
  <div class="printwrap">
    <div class="toolbar noprint">
      <button class="btn primary" @click="doPrint">🖨 打印</button>
      <button class="btn" @click="doClose">关闭</button>
      <span v-if="sh && sh.status !== 'confirmed'" class="tip warn">还没签收——打印件仅供预览</span>
    </div>
    <div v-if="err" class="errbox noprint">{{ err }}</div>

    <div v-if="sh" class="page">
      <div class="head">
        <span class="formno">{{ formNo }}</span>
        <span>受检单位名称：{{ client || '＿＿＿＿＿＿' }}</span>
        <span class="tname">{{ title }}</span>
        <span>项目编号：{{ sh.contract_id || '' }} · {{ sh.id }}</span>
      </div>
      <table class="ftbl meta">
        <tbody>
          <tr>
            <td class="k">样品来源</td><td>{{ isSelf ? '送样' : '现场采样' }}</td>
            <td class="k">样品数量</td><td>{{ sh.sample_ids.length }}</td>
            <td class="k">保存条件</td><td>{{ sh.storage || '常温' }}</td>
          </tr>
          <tr>
            <td class="k">{{ isSelf ? '送样' : '采样' }}人 / 时间</td><td colspan="2">{{ sh.from_person || '' }}　{{ dt(sh.from_at) }}</td>
            <td class="k">收样人 / 时间</td><td colspan="2">{{ sh.to_person || '＿＿＿＿' }}　{{ dt(sh.to_at) }}</td>
          </tr>
        </tbody>
      </table>
      <table class="ftbl rows">
        <thead>
          <tr v-if="isGas"><td class="k">样品编号</td><td class="k">样品名称</td><td class="k">样品状态</td><td class="k">检测项目</td><td class="k">备注</td></tr>
          <tr v-else><td class="k">样品编号</td><td v-if="isSelf" class="k">点位</td><td class="k">检测项目</td><td class="k">容器保存方法</td><td class="k">采样记录及样品运储检查</td></tr>
        </thead>
        <tbody>
          <template v-if="isGas">
            <tr v-for="r in sh.detail" :key="r.sampleId">
              <td>{{ r.sampleId }}</td>
              <td>{{ smap[r.sampleId]?.matrix === '环境空气' ? '环境空气' : (smap[r.sampleId]?.matrix || '废气') }}</td>
              <td :class="{ rejected: r.rejected }">{{ r.rejected ? '拒收：' + r.rejectReason : (r.condition || '完好') }}</td>
              <td>{{ (r.items || []).join('、') }}</td>
              <td>{{ smap[r.sampleId]?.qc_type || '' }}</td>
            </tr>
          </template>
          <template v-else>
            <tr v-for="r in sh.detail" :key="r.sampleId">
              <td>{{ r.sampleId }}</td>
              <td v-if="isSelf">{{ smap[r.sampleId]?.point_name || '' }}</td>
              <td>{{ (r.items || []).join('、') }}</td>
              <td>{{ r.container || sh.storage || '' }}</td>
              <td :class="{ rejected: r.rejected }">{{ r.rejected ? '拒收：' + r.rejectReason : '样品完整无异常' }}</td>
            </tr>
          </template>
          <tr><td class="blank" :colspan="colCount">以下空白</td></tr>
        </tbody>
      </table>
      <p v-if="!isGas" class="foot">保存方法：G-玻璃瓶 P-塑料瓶 J-灭菌瓶（袋）O-溶解氧瓶；COD/总氮/总磷/氨氮加硫酸至pH≤2，氰化物加NaOH至pH≥12冷藏，溶解氧现场固定；其余按 HJ 91.1-2019 执行。</p>
      <p v-if="sh.note" class="foot">备注：{{ sh.note }}</p>
    </div>
  </div>
</template>

<style scoped>
.printwrap{background:#e8e8e8;min-height:100vh;padding:20px 0;font-family:"Songti SC","SimSun",serif;color:#000}
.toolbar{max-width:1000px;margin:0 auto 14px;display:flex;align-items:center;gap:10px}
.btn{padding:8px 20px;border:1px solid #bbb;border-radius:6px;background:#fff;font-size:14px;cursor:pointer}
.btn.primary{background:#2563eb;color:#fff;border-color:#2563eb}
.tip.warn{color:#b45309;font-weight:600;font-size:12px}
.errbox{max-width:1000px;margin:0 auto;padding:14px;background:#fee;border:1px solid #fbb;border-radius:8px;color:#900}
.page{width:1000px;margin:0 auto 20px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.15);padding:50px 55px;box-sizing:border-box}
.head{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;font-size:13px;margin-bottom:10px}
.head .formno{font-size:12px;color:#333}
.head .tname{font-size:20px;font-weight:700;letter-spacing:6px;flex:1;text-align:center}
.ftbl{width:100%;border-collapse:collapse;font-size:13px}
.ftbl td{border:1px solid #000;padding:8px 10px;line-height:1.6}
.ftbl .k{background:#fafafa;text-align:center;white-space:nowrap}
.ftbl.meta{margin-bottom:-1px}
.rejected{color:#900;font-weight:700}
.blank{text-align:center;color:#666}
.foot{font-size:11px;color:#333;margin-top:10px;line-height:1.7}
@media print {
  .noprint{display:none}
  .printwrap{background:#fff;padding:0}
  .page{box-shadow:none;margin:0;width:auto;padding:0}
  @page{size:A4 landscape;margin:12mm}
}
</style>
