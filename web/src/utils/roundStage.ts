// 采样派工页三段式：按期次状态决定默认展开哪一段
export type StageKey = 'dispatch' | 'field' | 'stock'

export function defaultStage(r: { status?: string; sampler?: string | null }): StageKey {
  if (r.status === 'done') return 'stock'          // 已入库 → 看样品与质控
  if (r.sampler) return 'field'                    // 已派工 → 现场采样填表
  return 'dispatch'                                // 其余（待派工/未采成改期）→ 派工段
}
