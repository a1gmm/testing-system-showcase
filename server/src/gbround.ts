// GB/T 8170 数值修约（四舍六入五单双）：独立零依赖模块，服务端（判定引擎）与前端（记录表计算列/报告均值）共用。
// 规则：拟舍弃的首位 <5 舍、>5 进；恰为 5 时——5 后还有非零位则进，5 后全为零则看前一位（偶舍奇进）。
export function roundGB(value: number | string, decimals: number): number {
  const v = Number(value)
  if (!Number.isFinite(v)) return NaN
  if (decimals < 0) decimals = 0
  const sign = v < 0 ? -1 : 1
  // 用字符串定位待舍位，避开二进制浮点在 0.5 边界上的误差
  const s = Math.abs(v).toFixed(Math.min(15, decimals + 8))
  const dot = s.indexOf('.')
  const keep = dot + decimals   // 保留部分的最后一个字符下标（decimals=0 时为小数点前一位）
  const kept = decimals === 0 ? s.slice(0, dot) : s.slice(0, keep + 1)
  const restStr = decimals === 0 ? s.slice(dot + 1) : s.slice(keep + 1)
  const first = restStr[0] ?? '0'
  let base = Number(kept)
  const step = Math.pow(10, -decimals)
  if (first > '5') base = +(base + step).toFixed(decimals)
  else if (first === '5') {
    const hasMore = /[1-9]/.test(restStr.slice(1))
    if (hasMore) base = +(base + step).toFixed(decimals)
    else {
      // 5 后全零：前一位偶舍奇进
      const lastKept = decimals === 0 ? kept[kept.length - 1] : kept[kept.length - 1]
      if (Number(lastKept) % 2 === 1) base = +(base + step).toFixed(decimals)
    }
  }
  return sign * +base.toFixed(decimals)
}
// 一个数字的小数位数（'0.2'→1，'12'→0）；限值判定时把结果修约到与限值同位数再比
export function decimalsOf(n: number | string | null | undefined): number {
  if (n == null) return 0
  const s = String(n)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}
