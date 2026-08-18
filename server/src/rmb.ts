// 人民币金额大写：独立零依赖模块，服务端（合同报价单）与前端（打印页）共用。
const DIG = '零壹贰叁肆伍陆柒捌玖'
const UNIT = ['', '拾', '佰', '仟']
const GROUP = ['', '万', '亿', '万亿']

export function rmbUpper(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  const cents = Math.round(n * 100)
  const yuan = Math.floor(cents / 100)
  const jiao = Math.floor(cents / 10) % 10
  const fen = cents % 10

  let intPart = ''
  if (yuan > 0) {
    const s = String(yuan)
    const groups: string[] = []
    for (let i = s.length; i > 0; i -= 4) groups.unshift(s.slice(Math.max(0, i - 4), i))
    const parts: string[] = []
    groups.forEach((g, gi) => {
      let seg = ''
      let zeroPending = false
      for (let i = 0; i < g.length; i++) {
        const d = Number(g[i])
        if (d === 0) { if (seg) zeroPending = true }
        else { seg += (zeroPending ? '零' : '') + DIG[d] + UNIT[g.length - 1 - i]; zeroPending = false }
      }
      if (seg) parts.push((g[0] === '0' && parts.length ? '零' : '') + seg + GROUP[groups.length - 1 - gi])
    })
    intPart = parts.join('')
  }

  if (jiao === 0 && fen === 0) return (intPart || '零') + '元整'
  let out = intPart ? intPart + '元' : ''
  if (jiao > 0) out += DIG[jiao] + '角'
  else if (intPart && fen > 0) out += '零'
  if (fen > 0) out += DIG[fen] + '分'
  return out
}
