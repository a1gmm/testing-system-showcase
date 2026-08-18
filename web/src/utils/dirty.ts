// 全站脏数据登记处：表单有未保存改动时登记，切走/关页前统一拦一道
// 用法：组件内 markDirty(key) / clearDirty(key)；切换动作前 await confirmIfDirty()
import { ref } from 'vue'
import { ElMessageBox } from 'element-plus'

const dirtyKeys = ref(new Set<string>())

export function markDirty(key: string) {
  if (!dirtyKeys.value.has(key)) { const s = new Set(dirtyKeys.value); s.add(key); dirtyKeys.value = s }
}
export function clearDirty(key: string) {
  if (dirtyKeys.value.has(key)) { const s = new Set(dirtyKeys.value); s.delete(key); dirtyKeys.value = s }
}
export function hasDirty(): boolean { return dirtyKeys.value.size > 0 }

// 有未保存内容时弹确认；用户选「离开」则清空登记并放行
export async function confirmIfDirty(): Promise<boolean> {
  if (!hasDirty()) return true
  const ok = await ElMessageBox.confirm(
    '当前表单有未保存的内容，切走后就找不回来了。确定不保存直接离开吗？',
    '有未保存的内容', { confirmButtonText: '不保存，离开', cancelButtonText: '留在本页', type: 'warning' },
  ).catch(() => null)
  if (ok) dirtyKeys.value = new Set()
  return !!ok
}

// 关标签页/刷新前的原生拦截（浏览器只允许通用提示文案）
window.addEventListener('beforeunload', (e) => {
  if (hasDirty()) { e.preventDefault(); e.returnValue = '' }
})
