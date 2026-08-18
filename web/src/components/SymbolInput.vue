<script setup lang="ts">
// 带符号小键盘的输入框：℃ μ ³ ² 这些符号普通键盘打不出来，
// 点旁边的小按钮直接插到光标处。前处理「条件」、标物「规格/标准值」等处共用，风格一致。
import { ref } from 'vue'

const props = defineProps<{ modelValue?: string; placeholder?: string; disabled?: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const SYMS = ['℃', 'μ', '³', '²']
const inp = ref<HTMLInputElement | null>(null)

function onInput(e: Event) { emit('update:modelValue', (e.target as HTMLInputElement).value) }
function ins(sym: string) {
  const el = inp.value
  const v = props.modelValue || ''
  const start = el?.selectionStart ?? v.length
  const end = el?.selectionEnd ?? v.length
  emit('update:modelValue', v.slice(0, start) + sym + v.slice(end))
  // 插完把光标放回符号后面，方便继续打字
  requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + sym.length, start + sym.length) })
}
</script>

<template>
  <span class="syminput">
    <input ref="inp" :value="modelValue" :placeholder="placeholder" :disabled="disabled" @input="onInput" />
    <span class="sympad">
      <button v-for="s in SYMS" :key="s" type="button" class="symbtn" tabindex="-1" :disabled="disabled"
        :title="'插入 ' + s" @mousedown.prevent @click="ins(s)">{{ s }}</button>
    </span>
  </span>
</template>

<style scoped>
.syminput{display:inline-flex;align-items:center;gap:4px;min-width:0}
.syminput input{flex:1;min-width:90px;border:1px solid var(--line-strong);border-radius:6px;padding:6px 8px;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--ink)}
.syminput input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.syminput input:disabled{background:var(--surface-2);color:var(--muted);cursor:not-allowed}
.sympad{display:inline-flex;gap:2px;flex:none}
.symbtn{border:1px solid var(--line);background:var(--surface-2);color:var(--muted);border-radius:5px;font-size:12px;line-height:1;padding:5px 6px;cursor:pointer;font-family:inherit;transition:border-color .12s ease,color .12s ease}
.symbtn:hover{border-color:var(--accent);color:var(--accent-ink)}
.symbtn:disabled{opacity:.5;cursor:not-allowed}
</style>
