<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import OfflineFoundationStatus from './offline/OfflineFoundationStatus.vue'

const online = ref(navigator.onLine)
const updateConnectivity = () => { online.value = navigator.onLine }
onMounted(() => {
  window.addEventListener('online', updateConnectivity)
  window.addEventListener('offline', updateConnectivity)
})
onBeforeUnmount(() => {
  window.removeEventListener('online', updateConnectivity)
  window.removeEventListener('offline', updateConnectivity)
})
</script>

<template>
  <OfflineFoundationStatus :online="online" />
  <router-view />
</template>
