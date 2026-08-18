// 台账日期、效期、到期天数用的都是本地日历日（北京日），不是 UTC 日。
// 用 toISOString() 取「今天」会在东八区凌晨 0–8 点退回昨天，导致天数多算一天、过期漏报。
// 后端 handlers.ts 的 todayLocal 与此保持同一语义。
export function todayLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 从今天到 d 还有几天：负数=已过去。d 为 YYYY-MM-DD。
export function daysTo(d: string): number {
  const target = new Date(d + 'T00:00:00').getTime()
  const today = new Date(todayLocal() + 'T00:00:00').getTime()
  return Math.round((target - today) / 864e5)
}
