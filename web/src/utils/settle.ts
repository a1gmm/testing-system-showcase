// 并发拉多个接口时的降级工具。
//
// 为什么不用 Promise.all：它是"一个挂全挂"——工作台并发拉 7 个接口，
// 任意一个超时/断网，整个 await 抛出，一屏数据全空。
//
// 为什么不静默降级就完事：合规系统里，把加载失败显示成「0 待办」
// 会让检测员以为没活儿干。所以失败必须能被调用方感知（failed / ok），
// 由页面明确告诉用户"数据不全"，而不是给一个骗人的 0。

/** 单个 promise 失败时退回兜底值，永不抛。 */
export async function settled<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p
  } catch {
    return fallback
  }
}

export type SettleTask<T> = { p: Promise<T>; fallback: T }

export type SettleResult<T extends readonly SettleTask<any>[]> = {
  /** 按传入顺序取值；失败的位置是其 fallback */
  values: { [K in keyof T]: T[K] extends SettleTask<infer V> ? V : never }
  /** 失败个数 */
  failed: number
  /** 是否全部成功——false 时页面应提示数据可能不完整 */
  ok: boolean
}

/** 一组接口整体降级：挂掉的用兜底值，好的照常返回，整体永不抛。 */
export async function settleAll<const T extends readonly SettleTask<any>[]>(
  tasks: T,
): Promise<SettleResult<T>> {
  const outcomes = await Promise.allSettled(tasks.map(t => t.p))
  let failed = 0
  const values = outcomes.map((o, i) => {
    if (o.status === 'fulfilled') return o.value
    failed++
    return tasks[i].fallback
  })
  return { values: values as SettleResult<T>['values'], failed, ok: failed === 0 }
}
