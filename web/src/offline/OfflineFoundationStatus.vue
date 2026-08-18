<script setup lang="ts">
defineProps<{ online: boolean }>()
const recoveryAvailable = typeof navigator !== 'undefined' && Boolean(navigator.locks)
</script>

<template>
  <div v-if="!online" class="offline-foundation-status" role="status" aria-live="polite">
    <strong>已离线</strong>
    <span v-if="recoveryAvailable">当前仅可查看本机恢复信息，不能新增或正式提交。</span>
    <span v-else>当前浏览器缺少跨标签安全锁，本机恢复不可用；不能新增或正式提交。</span>
  </div>
</template>

<style scoped>
.offline-foundation-status {
  position: sticky;
  inset-block-start: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  min-height: 44px;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid #B05C00;
  background: #FFF1DF;
  color: #1E2329;
  font-size: 14px;
  line-height: 1.4;
}

.offline-foundation-status strong { color: #B05C00; white-space: nowrap; }

@media (max-width: 560px) {
  .offline-foundation-status { align-items: flex-start; }
}
</style>
