<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { createIndexedDbOfflineDatabase } from './indexedDb'
import { openOfflineVault, openOfflineVaultReadonly, type OfflineDatabase, type OfflineVault } from './offlineVault'
import { buildSafeDiagnostic, probeStorageCapability, type StorageCapabilityApi, type StorageHealth } from './storageHealth'

const props = defineProps<{
  userId: string | null
  recoveryOnly?: boolean
  databaseFactory?: (userId: string) => OfflineDatabase | null
  storageApi?: StorageCapabilityApi
}>()

const open = ref(false)
const loading = ref(false)
const vault = ref<OfflineVault | null>(null)
const storage = ref<StorageHealth>({ persistence: 'unavailable', quotaState: 'unknown', usage: null, quota: null })
const error = ref('')
const supportedSchemaVersion = 1
let generation = 0

watch(() => props.userId, () => {
  generation += 1
  open.value = false
  vault.value = null
  error.value = ''
})

const modeText = computed(() => {
  if (!vault.value) return ''
  if (vault.value.reason === 'owner_mismatch') return '账号与本机数据不匹配，已进入只读恢复'
  if (vault.value.reason === 'newer_schema') return '应用版本较旧，已进入只读恢复'
  if (vault.value.reason === 'migration_failed') return '升级失败，原草稿保留并进入只读恢复'
  if (vault.value.reason === 'storage_unavailable') return '浏览器本机存储不可用，未删除现有数据'
  return '本机恢复底座可读；离线写入仍未开放'
})

async function showRecovery() {
  if (!props.userId) return
  const requestedUserId = props.userId
  const requestGeneration = ++generation
  open.value = true
  loading.value = true
  error.value = ''
  try {
    const database = props.databaseFactory
      ? props.databaseFactory(requestedUserId)
      : createIndexedDbOfflineDatabase(requestedUserId)
    const nextStorage = await probeStorageCapability(props.storageApi ?? globalThis.navigator?.storage)
    const nextVault: OfflineVault = database
      ? await (props.recoveryOnly ? openOfflineVaultReadonly : openOfflineVault)({ database, userId: requestedUserId, supportedSchemaVersion })
      : { mode: 'readonly_recovery', reason: 'storage_unavailable', drafts: [] }
    if (requestGeneration !== generation || props.userId !== requestedUserId) return
    storage.value = nextStorage
    vault.value = nextVault
  } catch {
    if (requestGeneration !== generation || props.userId !== requestedUserId) return
    vault.value = { mode: 'readonly_recovery', reason: 'storage_unavailable', drafts: [] }
    error.value = '无法读取本机恢复信息，可导出脱敏诊断交给管理员。'
  } finally {
    if (requestGeneration === generation && props.userId === requestedUserId) loading.value = false
  }
}

function exportDiagnostic() {
  if (!props.userId || !vault.value) return
  const diagnostic = buildSafeDiagnostic({
    userId: props.userId,
    mode: vault.value.mode,
    reason: vault.value.reason,
    schemaVersion: vault.value.schemaVersion ?? 0,
    supportedSchemaVersion,
    drafts: vault.value.drafts,
    storage: storage.value,
  })
  const blob = new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `offline-diagnostic-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div v-if="userId" class="recovery-center">
    <button data-testid="offline-recovery-entry" class="recovery-entry" type="button" @click="showRecovery">本机恢复</button>
    <section v-if="open" class="recovery-panel" aria-label="本机只读恢复">
      <div class="panel-head"><strong>本机只读恢复</strong><button type="button" aria-label="关闭" @click="open = false">×</button></div>
      <p v-if="recoveryOnly" class="capacity">这不是有效登录，不授予业务接口或写入权限；仅用于查看该账号的本机脱敏恢复信息。</p>
      <p v-if="loading">正在检查本机数据…</p>
      <template v-else-if="vault">
        <p class="state" :class="{ warning: vault.mode === 'readonly_recovery' }">{{ modeText }}</p>
        <dl>
          <div><dt>本机草稿</dt><dd data-testid="draft-count">{{ vault.drafts.length }} 份</dd></div>
          <div><dt>持久存储</dt><dd>{{ storage.persistence === 'granted' ? '已授权' : storage.persistence === 'denied' ? '未授权' : '无法确认' }}</dd></div>
          <div data-testid="schema-versions"><dt>版本</dt><dd>本机数据版本 {{ vault.schemaVersion ?? '未知' }} · 应用支持版本 {{ supportedSchemaVersion }}</dd></div>
        </dl>
        <p v-if="storage.quotaState === 'warning'" class="capacity">容量即将用尽，请联系管理员安全处理；浏览器仍可能逐出数据。</p>
        <p v-if="error" class="capacity">{{ error }}</p>
        <button data-testid="diagnostic-export" class="diagnostic" type="button" @click="exportDiagnostic">导出脱敏诊断</button>
      </template>
    </section>
  </div>
</template>

<style scoped>
.recovery-center{position:relative}.recovery-entry,.diagnostic{min-height:44px;border:1px solid #CBC5BA;border-radius:7px;background:#FFFEFC;color:#1E2329;padding:8px 12px;font:600 14px inherit;cursor:pointer}.recovery-entry:hover,.diagnostic:hover{border-color:#4F46E5}.recovery-panel{position:absolute;z-index:90;top:50px;right:0;width:min(360px,calc(100vw - 24px));padding:16px;border:1px solid #CBC5BA;border-radius:14px;background:#FFFEFC;color:#1E2329;box-shadow:0 18px 45px -25px rgba(30,35,41,.35)}.panel-head{display:flex;align-items:center;justify-content:space-between;font-size:18px}.panel-head button{width:44px;height:44px;border:0;background:transparent;color:#62676E;font-size:24px;cursor:pointer}.state{padding:10px;border-left:4px solid #176B5B;background:#E8F4F0;line-height:1.5}.state.warning,.capacity{border-left-color:#B05C00;background:#FFF1DF}.recovery-panel dl{margin:12px 0}.recovery-panel dl div{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #CBC5BA}.recovery-panel dt{color:#62676E}.recovery-panel dd{margin:0;font-family:ui-monospace,monospace;font-weight:600}.capacity{padding:10px;line-height:1.5}.diagnostic{width:100%;margin-top:4px}@media(max-width:560px){.recovery-panel{position:fixed;top:64px;right:12px;left:12px;width:auto}}
</style>
