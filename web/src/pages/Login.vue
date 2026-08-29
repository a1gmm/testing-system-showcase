<script setup lang="ts">
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api } from '../api'

const router = useRouter()
const route = useRoute()
const username = ref('')
const password = ref('')
const loading = ref(false)
const notice = ref<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null)
const changeOpen = ref(false)
const changePassword = ref('')
const changeError = ref('')
const changeSaving = ref(false)
let changeOldPassword = ''
let resolvePasswordChange: (() => void) | null = null
let rejectPasswordChange: ((error: Error) => void) | null = null

function showNotice(kind: 'error' | 'success' | 'info', text: string) {
  notice.value = { kind, text }
}

async function doLogin() {
  if (!username.value) return showNotice('info', '请输入用户名')
  if (!password.value) return showNotice('info', '请输入密码')
  notice.value = null
  loading.value = true
  try {
    const oldPw = password.value
    const u = await api.login(username.value, oldPw)
    // 初始/被重置密码：必须先改密才放进系统（后端也会拦，这里给顺滑的引导）
    if (u.must_change_pw) await forceChangePassword(oldPw)
    showNotice('success', `欢迎，${u.name}`)
    // 会话过期被踢回来的，登录后回原页面
    const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/dashboard'
    router.push(next)
  } catch (e: any) {
    // 网络层错误翻译成人话——用户不该看到 "Network Error" 英文原文
    const raw = e?.response?.data?.error
    const msg = raw ? raw
      : /network|timeout|ECONNREFUSED/i.test(String(e?.message)) ? '连不上服务器——请检查网络，或稍后再试'
      : (e?.message || '登录失败，请重试')
    showNotice('error', msg)
  }
  finally { loading.value = false }
}

// 强制改初始密码：不改就退回登录，改成功才继续
async function forceChangePassword(oldPassword: string) {
  changeOldPassword = oldPassword
  changePassword.value = ''
  changeError.value = ''
  changeOpen.value = true
  return new Promise<void>((resolve, reject) => {
    resolvePasswordChange = resolve
    rejectPasswordChange = reject
  })
}

async function submitPasswordChange() {
  if (changePassword.value.length < 6) {
    changeError.value = '密码至少 6 位'
    return
  }
  changeSaving.value = true
  changeError.value = ''
  try {
    await api.changePassword(changeOldPassword, changePassword.value)
    changeOpen.value = false
    resolvePasswordChange?.()
    showNotice('success', '新密码已生效')
  } catch (e: any) {
    changeError.value = e?.response?.data?.error || '改密失败，请重试'
  } finally {
    changeSaving.value = false
  }
}

async function cancelPasswordChange() {
  if (changeSaving.value) return
  await api.logout().catch(() => undefined)
  changeOpen.value = false
  rejectPasswordChange?.(new Error('未修改初始密码，请重新登录'))
}
</script>

<template>
  <div class="login-wrap">
    <div class="panel">
      <div class="brand">
        <div class="logo">天</div>
        <div class="bt">
          <b>环境检测 LIMS</b>
          <small>生态环境监测信息管理系统</small>
        </div>
      </div>

      <div class="form">
        <input v-model="username" autocomplete="username" placeholder="用户名" @keyup.enter="doLogin" />
        <input v-model="password" type="password" autocomplete="current-password" placeholder="密码" @keyup.enter="doLogin" />
        <button type="button" :disabled="loading" @click="doLogin" class="btn">{{ loading ? '登录中…' : '登 录' }}</button>
      </div>

      <p v-if="notice" class="notice" :class="notice.kind" role="alert" aria-live="polite">{{ notice.text }}</p>

      <div class="foot">操作留痕将记录到登录账号 · 满足《评审补充要求(2025)》人员授权要求</div>
    </div>

    <div v-if="changeOpen" class="modal-backdrop">
      <section class="change-dialog" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
        <h1 id="change-password-title">首次登录 · 修改密码</h1>
        <p>这是初始密码。请先设置你自己的新密码，再进入系统。</p>
        <label for="new-password">新密码（至少 6 位）</label>
        <input id="new-password" v-model="changePassword" type="password" autocomplete="new-password" autofocus @keyup.enter="submitPasswordChange" />
        <p v-if="changeError" class="change-error" role="alert">{{ changeError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="changeSaving" @click="cancelPasswordChange">退出登录</button>
          <button type="button" :disabled="changeSaving" @click="submitPasswordChange">{{ changeSaving ? '保存中…' : '设置新密码' }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.login-wrap{min-height:100vh;display:grid;place-items:center;background:var(--bg);padding:20px}
.panel{width:520px;max-width:94vw;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:32px 34px;box-shadow:0 20px 50px -28px rgba(26,26,30,.25)}

.brand{display:flex;align-items:center;gap:12px;padding-bottom:20px;margin-bottom:22px;border-bottom:1px solid var(--line)}
.logo{width:42px;height:42px;border-radius:10px;background:var(--accent);display:grid;place-items:center;color:#fff;font-weight:700;font-size:19px;flex:none}
.bt b{font-size:17px;display:block;font-weight:650;letter-spacing:-.01em}
.bt small{color:var(--faint);font-size:12px}

.form{display:flex;flex-direction:column;gap:10px}
.form input{border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:11px 13px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink);transition:border-color .13s ease}
.form input::placeholder{color:var(--faint)}
.form input:focus{outline:none;border-color:var(--accent)}
.btn{height:42px;font-size:15px;margin-top:4px}
.notice{margin:12px 0 0;padding:10px 12px;border-radius:var(--radius-sm);font-size:13px;line-height:1.45}
.notice.error{color:var(--crit);background:color-mix(in srgb,var(--crit) 8%,var(--surface))}
.notice.info{color:var(--info);background:color-mix(in srgb,var(--info) 8%,var(--surface))}
.notice.success{color:var(--good);background:color-mix(in srgb,var(--good) 8%,var(--surface))}
.foot{margin-top:20px;padding-top:16px;border-top:1px solid var(--line);font-size:11px;color:var(--faint);text-align:center;line-height:1.6}
.modal-backdrop{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:20px;background:rgba(30,35,41,.32)}
.change-dialog{width:min(420px,100%);padding:24px;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 24px 64px rgba(30,35,41,.2)}
.change-dialog h1{margin:0 0 10px;font-size:19px}.change-dialog>p{margin:0 0 18px;color:var(--muted);line-height:1.55}
.change-dialog label{display:block;margin-bottom:7px;font-size:13px;font-weight:600}
.change-dialog input{width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--ink)}
.change-error{margin:8px 0 0!important;color:var(--crit)!important;font-size:13px}
.dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.dialog-actions button{min-height:44px;padding:0 16px}.dialog-actions .secondary{background:var(--surface2);color:var(--ink)}

@media (max-width:560px){
  .panel{padding:24px 20px}
}
</style>
