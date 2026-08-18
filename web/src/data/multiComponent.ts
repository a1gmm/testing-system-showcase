// 多组分表（如苯系物一张表 8 个组分各存一套曲线）的 meta.components 口径统一处
// 正规形态是字符串数组；顿号分隔的字符串按「、」切开兜底，防同类模板再混进来
// 形态不认识时给出 error 让调用方弹提示，不静默退化成单曲线

export type NormalizedComponents = { list: string[]; error: string | null }

const SEP = '、'

export function normalizeComponents(raw: unknown): NormalizedComponents {
  if (raw == null) return { list: [], error: null }

  const parts = Array.isArray(raw) ? raw
    : typeof raw === 'string' ? raw.split(SEP)
    : null
  if (parts === null) return { list: [], error: `components 形态无法识别（${typeof raw}），应为字符串数组或「${SEP}」分隔的字符串` }

  const list = parts.map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)
  if (list.length === 0) return { list: [], error: 'components 存在但未解析出任何组分' }
  return { list, error: null }
}
