<script setup lang="ts">
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'

const router = useRouter()
const route = useRoute()
const username = ref('')
const password = ref('')
const loading = ref(false)

async function doLogin() {
  if (!username.value) return ElMessage.warning('请输入用户名')
  if (!password.value) return ElMessage.warning('请输入密码')   // 不再默认拿 123456 去试（演示时代的残留）
  loading.value = true
  try {
    const oldPw = password.value
    const u = await api.login(username.value, oldPw)
    // 初始/被重置密码：必须先改密才放进系统（后端也会拦，这里给顺滑的引导）
    if (u.must_change_pw) await forceChangePassword(oldPw)
    ElMessage.success(`欢迎，${u.name}`)
    // 会话过期被踢回来的，登录后回原页面
    const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/dashboard'
    router.push(next)
  } catch (e: any) {
    // 网络层错误翻译成人话——用户不该看到 "Network Error" 英文原文
    const raw = e?.response?.data?.error
    const msg = raw ? raw
      : /network|timeout|ECONNREFUSED/i.test(String(e?.message)) ? '连不上服务器——请检查网络，或稍后再试'
      : (e?.message || '登录失败，请重试')
    ElMessage.error(msg)
  }
  finally { loading.value = false }
}

// 强制改初始密码：不改就退回登录，改成功才继续
async function forceChangePassword(oldPassword: string) {
  for (;;) {
    let np: string
    try {
      const r = await ElMessageBox.prompt('这是初始密码，为安全起见请先设置你自己的新密码（至少 6 位）', '首次登录 · 修改密码', {
        confirmButtonText: '设置新密码', cancelButtonText: '退出登录', inputType: 'password',
        inputValidator: v => (!!v && v.length >= 6) || '密码至少 6 位',
        closeOnClickModal: false, closeOnPressEscape: false, showClose: false,
      })
      np = r.value
    } catch {
      await api.logout()
      throw new Error('未修改初始密码，请重新登录')
    }
    try { await api.changePassword(oldPassword, np); ElMessage.success('新密码已生效'); return }
    catch (e: any) { ElMessage.error(e?.response?.data?.error || '改密失败，请重试') }
  }
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
        <el-button type="primary" :loading="loading" @click="doLogin" class="btn">登 录</el-button>
      </div>

      <div class="foot">操作留痕将记录到登录账号 · 满足《评审补充要求(2025)》人员授权要求</div>
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
.foot{margin-top:20px;padding-top:16px;border-top:1px solid var(--line);font-size:11px;color:var(--faint);text-align:center;line-height:1.6}

@media (max-width:560px){
  .panel{padding:24px 20px}
}
</style>
