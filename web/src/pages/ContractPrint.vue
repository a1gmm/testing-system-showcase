<script setup lang="ts">
// 合同打印页：照示例纸质合同模板（TCHT 委托检测合同）排版，浏览器打印、线下盖章。
// 内容 = 封面 + 正文条款 + 附件1报价单 + 合同评审记录表（QTCYT/JL141）
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api, hasRole, type Contract } from '../api'
import { rmbUpper } from '../../../server/src/rmb'

const route = useRoute()
const c = ref<Contract | null>(null)
const err = ref('')
onMounted(async () => {
  try { c.value = await api.getContract(String(route.params.id)) }
  catch (e: any) { err.value = e?.response?.data?.error || e?.message || String(e) }
})

const q = computed(() => c.value?.quote ?? null)
const buyer = computed(() => q.value?.buyer ?? {})
// 评审受理通过才能打印：没受理只给提示，不给打印
const accepted = computed(() => !!c.value?.accepted_at)
// 报价单是商务数据，服务端只给 登记员/技术负责人/授权签字人（admin恒真）——没权限时提示语要说实话
const canSeeQuote = computed(() => hasRole('admin', 'registrar', 'tech', 'signer'))
const extNo = computed(() => q.value?.extNo || c.value?.id || '')
const discount = computed(() => q.value?.discount ?? 0)
const upper = computed(() => q.value?.discountUpper || rmbUpper(discount.value))
const fmt = (d?: string | null) => {
  if (!d) return '    年  月  日'
  const [y, m, dd] = d.split('-')
  return `${y}年${Number(m)}月${Number(dd)}日`
}
const rowItems = (r: { items: string[]; extraItems?: string }) =>
  [...r.items, ...(r.extraItems ? r.extraItems.split(/[,，、\s]+/).filter(Boolean) : [])].join('、')
const review = computed(() => c.value?.review_info ?? null)
// 监测目的一行：勾中评审时选的那个（老数据没存目的则默认勾委托检测）
const PURPOSES = ['委托检测', '环评检测', '验收监测', '送样检测', '其他']
const purposeLine = computed(() => {
  const sel = review.value ? ((review.value as any).purpose || '委托检测') : ''
  return PURPOSES.map(p => (p === sel ? '☑' : '□') + p).join('  ')
})
// 资源确认 是/否：新字段缺省回退老 ability 字段；没评审就全空框
function yn(key: string): string {
  const r = review.value as any
  if (!r) return '□是  □否'
  const v = r[key] !== undefined ? r[key] : r.ability !== false
  return v ? '☑是  □否' : '□是  ☑否'
}
function doPrint() { window.print() }
function doClose() { window.close() }
</script>

<template>
  <div class="printwrap">
    <div class="toolbar noprint">
      <button v-if="accepted" class="btn primary" @click="doPrint">🖨 打印</button>
      <span v-else class="tip warn">该合同还没做「合同评审 · 确认受理」，评审通过后才能打印（下面仅供预览）</span>
      <button class="btn" @click="doClose">关闭</button>
      <span v-if="accepted" class="tip">打印时请在浏览器打印设置里选 A4、去掉页眉页脚</span>
    </div>
    <div v-if="err" class="errbox noprint">{{ err }}</div>

    <template v-if="c && q">
      <!-- 封面 -->
      <section class="page cover">
        <div v-if="!accepted" class="wm" aria-hidden="true">未受理，仅供预览</div>

        <div class="cover-title">委 托 检 测<br />合  同</div>
        <table class="cover-tbl">
          <tbody>
            <tr><td class="k">项目名称：</td><td class="v">{{ c.project || c.client + '  检测项目' }}</td></tr>
            <tr><td class="k">合同编号：</td><td class="v">{{ extNo }}</td></tr>
            <tr><td class="k">委托单位：</td><td class="v">{{ c.client }}</td></tr>
            <tr><td class="k">检测单位：</td><td class="v">示例环境检测技术服务有限公司</td></tr>
            <tr><td class="k">签订日期：</td><td class="v">{{ q.signDate || '' }}</td></tr>
          </tbody>
        </table>
      </section>

      <!-- 正文 -->
      <section class="page body">
        <div v-if="!accepted" class="wm" aria-hidden="true">未受理，仅供预览</div>

        <h1>委 托 检 测 合 同</h1>
        <p>委托单位（甲方）：{{ c.client }}</p>
        <p>检测单位（乙方）：示例环境检测技术服务有限公司</p>
        <p class="indent">委托单位（甲方）委托检测单位（乙方）根据 附表1 进行检测，并支付检测费用。双方经过平等协商，在真实充分地表达各自意愿的基础上，根据《中华人民共和国民法典》的规定，达成如下协议，并由双方共同恪守。</p>
        <p><b>一、委托检测的项目、点位和频率：</b>按照附表1执行。</p>
        <p><b>二、检测费用及支付方式：</b></p>
        <p class="indent">本合同检测费用：{{ discount.toFixed(2) }}（大写：{{ upper }}）合同生效后，检测单位开具{{ q.invoice || '6%增值税专用发票' }}，入厂检测前委托单位支付全部检测费用。</p>
        <p><b>三、双方责任</b></p>
        <p>（一）委托单位责任</p>
        <p class="indent">1、委托单位负责提供检测工作所需的基础资料，并配合协助检测单位进行现场工作。</p>
        <p class="indent">2、按合同相关条款规定支付检测费用。</p>
        <p class="indent">3、本单位同意检测单位将没有通过资质认定的项目进行分包。</p>
        <p>（二）检测单位责任：</p>
        <p class="indent">1.接受甲方委托，现场采样人员与委托单位负责人对现场点位、项目、频次进行确认无误后进行采样，乙方人员进入甲方厂区应严格遵守甲方的相关规章制度。</p>
        <p class="indent">2.乙方应为甲方提供的资料、产品技术、生产工艺、样品等相关检测数据保密。未经甲方书面同意不得泄露甲方提供的检测数据给其他第三方，也不得将与样品有关的技术资料用于任何经营及开发活动。</p>
        <p class="indent">3.乙方按照合同附表1规定的点位、频次、项目按时完成采样检测及报告编制工作，出具检测报告。</p>
        <p class="indent">4.工作中应与甲方保持联系，及时沟通工作中的问题。</p>
        <p><b>四、适用法律及纠纷解决</b></p>
        <p class="indent">1.本合同适用中华人民共和国法律及其相关规定，如双方约定的内容与国家法律及其相关规定相抵触时，双方可依法经协商一致后变更本合同。</p>
        <p class="indent">2.在本合同履行过程中，双方当事人因本合同发生任何争议的，双方应尽最大努力友好协商解决；如协商未果，应向示例市高新区人民法院提出申请，诉讼解决。</p>
        <p><b>五、</b>本合同双方盖章即生效，一式 贰 份，甲方执 壹 份，乙方执 壹 份。</p>
        <p><b>六、附则、开票信息</b></p>
        <p class="indent">1.本合同附件1是本合同组成部分，具有同等法律效力。</p>
        <p><b>七、合同有效期：</b>{{ fmt(c.period_start) }}至{{ fmt(c.period_end) }}。</p>

        <table class="sign-tbl">
          <tbody>
            <tr><td>委托单位（盖章）：{{ c.client }}</td><td>检测单位（盖章）：示例环境检测技术服务有限公司</td></tr>
            <tr><td>地址：{{ buyer.addr || '' }}</td><td>地址：山东省示例市高新区创新路100号  010-55550000</td></tr>
            <tr><td>开户银行：{{ buyer.bank || '' }}</td><td>开户银行：恒丰银行烟台蓬莱支行</td></tr>
            <tr><td>银行账号：{{ buyer.account || '' }}</td><td>银行账号：853544010122804263</td></tr>
            <tr><td>税号：{{ buyer.taxNo || '' }}</td><td>税号：91370684312984168G</td></tr>
            <tr><td>行号：{{ buyer.bankNo || '' }}</td><td>行号：315456103104</td></tr>
            <tr><td>企业法人：{{ buyer.legal || '' }}</td><td>企业法人：顾作宁</td></tr>
            <tr><td>业务联系人：{{ c.contact || '' }}{{ c.phone ? '  ' + c.phone : '' }}</td><td>业务联系人：</td></tr>
            <tr><td colspan="2">备注：如不便填写开票信息，请将开票信息附合同内。</td></tr>
          </tbody>
        </table>
      </section>

      <!-- 附件1 报价单 -->
      <section class="page quote">
        <div v-if="!accepted" class="wm" aria-hidden="true">未受理，仅供预览</div>

        <h2>附件1</h2>
        <h1>示例环境检测技术服务有限公司∽报价单</h1>
        <table class="meta-tbl">
          <tbody>
            <tr><td class="k">名     称：</td><td>{{ c.project || c.client + '  检测项目' }}</td></tr>
            <tr><td class="k">联系人电话：</td><td>{{ [c.contact, c.phone].filter(Boolean).join('  ') }}</td></tr>
          </tbody>
        </table>
        <table class="q-tbl">
          <thead>
            <tr><th>序号</th><th>类别</th><th>点位名称</th><th>项目</th><th>报价</th><th>点位</th><th>频次（次/天）</th><th>频次（次/年）</th><th>合计报价</th><th>备注</th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in q.rows" :key="i">
              <td>{{ i + 1 }}</td><td>{{ r.category }}</td><td>{{ r.point }}</td>
              <td class="left">{{ rowItems(r) }}</td>
              <td>{{ r.price }}</td><td>{{ r.points }}</td><td>{{ r.perDay }}</td><td>{{ r.perYear || '单次' }}</td>
              <td>{{ r.subtotal?.toLocaleString() }}</td><td>{{ r.note || '' }}</td>
            </tr>
            <tr><td colspan="8" class="left b">费用合计（含增值税）：</td><td colspan="2">{{ q.total.toLocaleString() }}</td></tr>
            <tr><td colspan="8" class="left b">折后费用价格（含增值税）：</td><td colspan="2">{{ q.discount.toLocaleString() }}</td></tr>
            <tr><td colspan="8" class="left b">折后费用大写（含增值税）：</td><td colspan="2">{{ upper }}</td></tr>
          </tbody>
        </table>
      </section>

      <!-- 附件2 资质（CMA 资质认定证书） -->
      <section class="page cert">
        <div v-if="!accepted" class="wm" aria-hidden="true">未受理，仅供预览</div>

        <h2>附件2  资质</h2>
        <img src="/cert-cma-placeholder.svg" alt="检验检测机构资质认定证书" />
      </section>

      <!-- 合同评审记录表 -->
      <section class="page reviewform">
        <div v-if="!accepted" class="wm" aria-hidden="true">未受理，仅供预览</div>

        <div class="rf-head"><span>示例环境检测技术服务有限公司</span><span>QTCYT/JL141</span></div>
        <h1>检测业务合同评审记录表</h1>
        <table class="rf-tbl">
          <tbody>
            <tr><td class="k">合同编号</td><td colspan="3">{{ extNo }}</td></tr>
            <tr><td class="k">合同签订起止日期</td><td colspan="3">{{ fmt(c.period_start) }}至{{ fmt(c.period_end) }}</td></tr>
            <tr><td class="k">委托单位</td><td colspan="3">{{ c.client }}</td></tr>
            <tr><td class="k">监测目的</td><td colspan="3">{{ purposeLine }}</td></tr>
            <tr><td class="k">类别 / 检测项目</td><td colspan="3">见合同正本</td></tr>
            <tr>
              <td class="k">人力物质资源</td><td>{{ yn('manpower') }}</td>
              <td class="k">仪器设备</td><td>{{ yn('instruments') }}</td>
            </tr>
            <tr>
              <td class="k">环境条件</td><td>{{ yn('environment') }}</td>
              <td class="k">检测方法</td><td>{{ yn('method') }}</td>
            </tr>
            <tr>
              <td class="k">合同金额</td><td>{{ discount.toFixed(2) }}</td>
              <td class="k">是、否需分包</td><td>{{ review ? (review.subcontract ? '☑是  □否' : '□是  ☑否') : '□是  □否' }}</td>
            </tr>
            <tr>
              <td class="k">分包费用</td><td>{{ (review as any)?.subFee || (review?.subcontract ? '' : '/') }}</td>
              <td class="k">分包项目</td><td>{{ review?.subcontract ? '见合同明细' : '/' }}</td>
            </tr>
            <tr><td class="k">评审意见</td><td colspan="3" class="tall">{{ (review as any)?.conclusion || review?.note || '' }}</td></tr>
            <tr>
              <td class="k">评审人员</td><td>{{ c.accepted_by || '' }}</td>
              <td class="k">评审日期</td><td>{{ c.accepted_at ? c.accepted_at.slice(0, 10) : '' }}</td>
            </tr>
            <tr><td class="k">技术负责人意见</td><td colspan="3" class="tall">{{ c.tech_review_result === 'approve' ? '☑' : '□' }}同意签订    {{ c.tech_review_result === 'reject' ? '☑' : '□' }}不同意签订<span v-if="c.tech_approve_note">（{{ c.tech_approve_note }}）</span><br /><br />技术负责人签字：{{ c.tech_approved_by || '' }}<span v-if="c.tech_approved_at">　{{ fmt(c.tech_approved_at.slice(0, 10)) }}</span></td></tr>
          </tbody>
        </table>
      </section>
    </template>
    <div v-else-if="c && !q && !canSeeQuote" class="errbox noprint">你的岗位看不到报价单（商务数据），打印合同正本需要登记员 / 技术负责人 / 授权签字人操作。</div>
    <div v-else-if="c && !q" class="errbox noprint">这份合同是快速登记建的，没有报价单数据，打印不了合同正本。</div>
  </div>
</template>

<style scoped>
.printwrap{background:#e8e8e8;min-height:100vh;padding:20px 0;font-family:"Songti SC","SimSun",serif;color:#000}
.toolbar{max-width:794px;margin:0 auto 14px;display:flex;align-items:center;gap:10px}
.btn{padding:8px 20px;border:1px solid #bbb;border-radius:6px;background:#fff;font-size:14px;cursor:pointer}
.btn.primary{background:#2563eb;color:#fff;border-color:#2563eb}
.tip{font-size:12px;color:#666}
.tip.warn{color:#b45309;font-weight:600}
.errbox{max-width:794px;margin:0 auto;padding:14px;background:#fee;border:1px solid #fbb;border-radius:8px;color:#900}
.page{width:794px;min-height:1050px;margin:0 auto 20px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.15);padding:70px 75px;box-sizing:border-box;position:relative}

.wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transform:rotate(-30deg);font-size:42px;color:rgba(200,60,60,.18);font-weight:700;pointer-events:none}

/* 封面 */
.cover{display:flex;flex-direction:column;align-items:center}
.cover-title{font-size:42px;font-weight:700;letter-spacing:14px;text-align:center;line-height:2;margin:130px 0 110px}
.cover-tbl{width:82%;border-collapse:collapse;font-size:16px}
.cover-tbl td{padding:13px 6px;vertical-align:bottom}
.cover-tbl .k{width:110px;white-space:nowrap}
.cover-tbl .v{border-bottom:1px solid #000;text-align:center}

/* 正文 */
.body h1{text-align:center;font-size:22px;letter-spacing:6px;margin:0 0 22px}
.body p{font-size:13.5px;line-height:1.9;margin:4px 0}
.body .indent{text-indent:2em}
.sign-tbl{width:100%;border-collapse:collapse;margin-top:26px;font-size:13px}
.sign-tbl td{border:1px solid #000;padding:8px 10px;width:50%}
.sign-tbl tr:first-child td{height:96px;vertical-align:top}  /* 公章直径4~4.5cm，落章不压后排开票信息 */

/* 报价单 */
.quote h2{font-size:15px;margin:0 0 6px}
.quote h1{text-align:center;font-size:19px;margin:0 0 16px}
.meta-tbl{width:100%;border-collapse:collapse;font-size:13.5px;margin-bottom:10px}
.meta-tbl td{padding:5px 4px;border-bottom:1px solid #000}
.meta-tbl .k{width:110px;white-space:nowrap;border-bottom:none}
.q-tbl{width:100%;border-collapse:collapse;font-size:12px}
.q-tbl th,.q-tbl td{border:1px solid #000;padding:6px 5px;text-align:center;vertical-align:middle}
.q-tbl .left{text-align:left}
.q-tbl .b{font-weight:700}

/* 附件2 资质 */
.cert h2{font-size:15px;margin:0 0 14px}
.cert img{display:block;max-width:88%;margin:0 auto;border:1px solid #ccc}

/* 评审记录表 */
.rf-head{display:flex;justify-content:space-between;font-size:13px;margin-bottom:10px}
.reviewform h1{text-align:center;font-size:19px;letter-spacing:3px;margin:0 0 16px}
.rf-tbl{width:100%;border-collapse:collapse;font-size:13px}
.rf-tbl td{border:1px solid #000;padding:9px 10px;vertical-align:top}
.rf-tbl .k{width:120px;font-weight:600;background:#fafafa}
.rf-tbl .tall{height:72px}

@media print{
  .noprint{display:none !important}
  .printwrap{background:#fff;padding:0}
  .page{box-shadow:none;margin:0;width:auto;min-height:auto;page-break-after:always;padding:40px 30px}
  .page:last-child{page-break-after:auto}
}
</style>
