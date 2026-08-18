import type { Audit } from '../api'

// 留痕明细渲染：把后端 diffData 的 change 记录翻成审核员看的人话。
// 归档页和录入页共用同一份——两边曾各存一份拷贝并已漂移，改一处漏一处。
export const actionLabel: Record<string, string> = {
  create: '新建', update: '修改', submit: '提交',
  review_pass: '复核通过', review_reject: '复核打回',
  approve: '审核通过', reject: '审核打回',
}

// 曲线核查各项（键见 StructuredSheet.vue 的 ccKey）
const CELL_LABEL: Record<string, string> = {
  date: '核查日期', zero: '零浓度点测定值',
  midStd: '中间点标准值', midMeasured: '中间点实测值', by: '核查人',
}
// 校准曲线系数 y=a+bx，r 为相关系数（合格判据如 ≥0.995）
const REG_LABEL: Record<string, string> = { a: '曲线系数a', b: '曲线系数b', r: '相关系数r' }

// 只有真空值才显示「空」。0 是真实数据（如零浓度点测定值应＜检出限），不能吞掉。
const val = (v: any) => (v === '' || v == null ? '空' : String(v))

function changeText(c: any): string {
  const comp = c.comp ? c.comp + '·' : ''
  const vs = `${val(c.from)}→${val(c.to)}`
  if (c.row === 0) {
    if (String(c.col).startsWith('meta:')) return `${comp}${String(c.col).slice(5)}：${vs}`
    if (String(c.col).startsWith('cell:')) {
      const k = String(c.col).slice(5)
      return `${comp}曲线核查·${CELL_LABEL[k] ?? k}：${vs}`
    }
    if (String(c.col).startsWith('reg:')) {
      const k = String(c.col).slice(4)
      return `${comp}${REG_LABEL[k] ?? k}：${vs}`
    }
    return `${comp}${c.col}：${vs}`
  }
  return `${comp}第${c.row}行·${c.col}：${vs}`
}

export function auditText(a: Audit): string {
  const ch = (a as any).detail?.changes
  if (Array.isArray(ch) && ch.length) return ch.map(changeText).join('；')
  if (a.action === 'create') return `新建记录（${(a as any).detail?.rows ?? 0} 行）`
  if ((a as any).detail?.comment) return (a as any).detail.comment
  return actionLabel[a.action] || a.action
}
