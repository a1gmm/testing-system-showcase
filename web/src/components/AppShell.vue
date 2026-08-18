<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import templates from '../data/templates.json'
import { api, currentUser, ROLE_LABEL, hasRole } from '../api'
import { PAGE_ROLES } from '../permissions'
import OfflineRecoveryCenter from '../offline/OfflineRecoveryCenter.vue'
import { recoveryIdentityHint, resolveRecoveryNamespace } from '../offline/recoveryIdentity'

const route = useRoute()
const router = useRouter()
const title = computed(() => (route.meta.title as string) || '环境检测 LIMS')
const roleText = computed(() => (currentUser.value?.roles || []).map(r => ROLE_LABEL[r] || r).join(' · '))
const recoveryNamespace = computed(() => resolveRecoveryNamespace(currentUser.value, recoveryIdentityHint.value))

// 小屏适配：窄屏时侧边栏改为抽屉（汉堡唤出），点导航或遮罩自动收起
const narrow = ref(window.innerWidth <= 980)
const sideOpen = ref(false)
function syncNarrow() { narrow.value = window.innerWidth <= 980; if (!narrow.value) sideOpen.value = false }
onMounted(() => { syncNarrow(); window.addEventListener('resize', syncNarrow) })
onBeforeUnmount(() => window.removeEventListener('resize', syncNarrow))
// 切换路由后在窄屏下收起抽屉
watch(() => route.fullPath, () => { if (narrow.value) sideOpen.value = false })

async function doLogout() { await api.logout(); router.push('/login') }

const top = { to: '/dashboard', label: '工作台', icon: 'Odometer' }
// 每项标注哪些岗位可见（不标 = 人人可见；admin 万能）——每个人只看自己岗位的菜单
// 菜单准入与路由守卫共用 PAGE_ROLES（permissions.ts），只此一份，不再各处手写
// 业务主线严格照 2026-07-31 确认的 7 步流程排：①合同（含方案）→②采样→③④质控交接→⑤检测→⑥审核→⑦报告
const allGroups = [
  { label: '业务主线 · 按流程', items: [
    { to: '/contracts', label: '① 合同与方案', icon: 'Folder', roles: PAGE_ROLES.contracts },
    { to: '/plans', label: '② 采样派工', icon: 'Calendar', roles: PAGE_ROLES.plans },
    { to: '/qc', label: '③ 质控交接', icon: 'Box', roles: PAGE_ROLES.qc },
    { to: '/samples', label: '④ 检测录入', icon: 'EditPen', roles: PAGE_ROLES.samples },
    { to: '/review', label: '⑤ 三级审核', icon: 'CircleCheck', roles: PAGE_ROLES.review },
    { to: '/reports', label: '⑥ 报告签发', icon: 'Files', roles: PAGE_ROLES.reports },
  ] },
  { label: '台账 · 基础', items: [
    { to: '/customers', label: '客户档案', icon: 'OfficeBuilding', roles: PAGE_ROLES.customers },
    { to: '/instruments', label: '资源台账', icon: 'Cpu', roles: PAGE_ROLES.instruments },
    { to: '/users', label: '人员与权限', icon: 'User', roles: PAGE_ROLES.users },
    { to: '/templates', label: '记录表模板库', icon: 'Grid', badge: String(templates.length) },
    { to: '/archive', label: '数据留痕归档', icon: 'Finished', roles: PAGE_ROLES.archive },
  ] },
  { label: '质量体系', items: [
    { to: '/system-records', label: '体系运行记录', icon: 'Postcard', roles: PAGE_ROLES['system-records'] },
    { to: '/subcontracts', label: '分包管理', icon: 'Share', roles: PAGE_ROLES.subcontracts },
  ] },
] as { label: string; items: { to: string; label: string; icon: string; badge?: string; roles?: string[] }[] }[]

const groups = computed(() =>
  allGroups
    .map(g => ({ ...g, items: g.items.filter(n => !n.roles || hasRole(...n.roles)) }))
    .filter(g => g.items.length),
)

// —— ⌘K 全局快捷跳转：页面 + 项目一把搜（方案C 交互） ——
const kOpen = ref(false)
const kQuery = ref('')
const kIndex = ref(0)
const kInput = ref<HTMLInputElement | null>(null)
const kProjects = ref<{ id: string; client: string; project: string; stage: string }[]>([])
let kLoaded = false
async function openK() {
  kOpen.value = true; kQuery.value = ''; kIndex.value = 0
  setTimeout(() => kInput.value?.focus(), 30)
  if (!kLoaded) {
    kLoaded = true
    try {
      const ps = await api.listProjects()
      kProjects.value = ps.map(p => {
        const st = p.pipeline.stages[p.pipeline.activeIndex]
        return { id: p.id, client: p.client, project: p.project || '', stage: st ? st.label : '已完成' }
      })
    } catch { /* 未登录或无权限时静默 */ }
  }
}
type KHit = { kind: 'page' | 'proj'; label: string; sub: string; to: string }
const kHits = computed<KHit[]>(() => {
  const q = kQuery.value.trim().toLowerCase()
  const pages: KHit[] = [{ to: top.to, label: top.label, sub: '页面', kind: 'page' as const },
    ...allGroups.flatMap(g => g.items.filter(n => !n.roles || hasRole(...n.roles)))
      .map(n => ({ to: n.to, label: n.label, sub: '页面', kind: 'page' as const }))]
  const projs: KHit[] = kProjects.value.map(p => ({
    kind: 'proj' as const, label: p.client, sub: `${p.id}${p.project ? ' · ' + p.project : ''} · ${p.stage}`,
    to: `/contracts?open=${encodeURIComponent(p.id)}`,
  }))
  if (!q) return [...projs.slice(0, 5), ...pages]
  const match = (t: string) => t.toLowerCase().includes(q)
  return [...projs.filter(p => match(p.label) || match(p.sub)), ...pages.filter(p => match(p.label))].slice(0, 12)
})
function kGo(h: KHit) { kOpen.value = false; router.push(h.to) }
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); kOpen.value ? (kOpen.value = false) : openK(); return }
  if (!kOpen.value) return
  if (e.key === 'Escape') { kOpen.value = false }
  else if (e.key === 'ArrowDown') { e.preventDefault(); kIndex.value = Math.min(kIndex.value + 1, kHits.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); kIndex.value = Math.max(kIndex.value - 1, 0) }
  else if (e.key === 'Enter') { const h = kHits.value[kIndex.value]; if (h) kGo(h) }
}
watch(kQuery, () => { kIndex.value = 0 })
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="shell" :class="{ narrow, open: sideOpen }">
    <div v-if="narrow && sideOpen" class="backdrop" @click="sideOpen = false"></div>
    <aside class="side">
      <div class="brand">
        <div class="logo">天</div>
        <div><b>环境检测 LIMS</b><small>ELSN · NEXT</small></div>
      </div>
      <router-link :to="top.to" class="nav" active-class="active">
        <el-icon><component :is="top.icon" /></el-icon>
        <span>{{ top.label }}</span>
      </router-link>
      <template v-for="g in groups" :key="g.label">
        <div class="navlabel">{{ g.label }}</div>
        <router-link v-for="n in g.items" :key="n.to" :to="n.to" class="nav" active-class="active">
          <el-icon><component :is="n.icon" /></el-icon>
          <span>{{ n.label }}</span>
          <span v-if="n.badge" class="badge">{{ n.badge }}</span>
        </router-link>
      </template>
      <div class="foot">依 2025 版《生态环境监测机构评审补充要求》建设</div>
    </aside>

    <div class="main">
      <header class="top">
        <button v-if="narrow" class="burger" title="菜单" @click="sideOpen = !sideOpen">
          <span></span><span></span><span></span>
        </button>
        <div class="crumb"><b>{{ title }}</b></div>
        <button class="ksearch" @click="openK">
          <span>搜项目 / 跳页面…</span>
          <kbd class="key">⌘K</kbd>
        </button>
        <div class="user">
          <OfflineRecoveryCenter :user-id="recoveryNamespace.userId" :recovery-only="recoveryNamespace.recoveryOnly" />
          <div class="avatar">{{ currentUser?.name?.[0] || '未' }}</div>
          <div class="uinfo">
            <div class="uname">{{ currentUser?.name || '未登录' }}</div>
            <div class="uorg">{{ roleText || '示例环境检测' }}</div>
          </div>
          <span class="logout" title="退出登录" @click="doLogout">退出</span>
        </div>
      </header>
      <main class="content">
        <router-view />
      </main>
    </div>

    <!-- ⌘K 快捷跳转面板 -->
    <div v-if="kOpen" class="kmask" @click.self="kOpen = false">
      <div class="kbox">
        <input ref="kInput" v-model="kQuery" class="kin" placeholder="搜客户名 / 委托号，或直接跳页面…" />
        <div class="klist">
          <div v-for="(h, i) in kHits" :key="h.to + h.label" class="khit" :class="{ on: i === kIndex }"
               @click="kGo(h)" @mousemove="kIndex = i">
            <span class="kl">{{ h.label }}</span>
            <span class="ks">{{ h.sub }}</span>
            <span v-if="i === kIndex" class="kgo">↵</span>
          </div>
          <div v-if="!kHits.length" class="kempty">没找到，换个词试试</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell{display:grid;grid-template-columns:230px 1fr;height:100vh}
/* 小屏：侧栏改抽屉 */
.shell.narrow{grid-template-columns:1fr}
.shell.narrow .side{position:fixed;top:0;left:0;bottom:0;width:248px;z-index:60;transform:translateX(-100%);transition:transform .22s ease}
.shell.narrow.open .side{transform:translateX(0);box-shadow:10px 0 34px -8px rgba(26,26,30,.22)}
.backdrop{position:fixed;inset:0;background:rgba(26,26,30,.28);z-index:55}
.burger{width:34px;height:34px;flex:none;display:grid;place-content:center;gap:4px;background:none;border:1px solid var(--line);border-radius:8px;cursor:pointer;padding:0}
.burger span{display:block;width:16px;height:2px;background:var(--ink);border-radius:2px}
.burger:hover{border-color:var(--accent)}
.side{background:var(--sidebar);color:var(--sidebar-ink);display:flex;flex-direction:column;padding:14px 12px;gap:2px;overflow-y:auto;border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;padding:6px 8px 16px;margin-bottom:2px;border-bottom:1px solid var(--line)}
.brand .logo{width:34px;height:34px;border-radius:9px;background:var(--accent);display:grid;place-items:center;color:#fff;font-weight:700;font-size:16px;flex:none}
.brand b{color:var(--ink);font-size:15px;font-weight:700}
.brand small{display:block;color:var(--sidebar-faint);font-size:10px;letter-spacing:2px;margin-top:1px}
.navlabel{font-size:10px;letter-spacing:1.5px;color:var(--sidebar-faint);text-transform:uppercase;padding:14px 10px 6px;font-weight:600}
.nav{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:8px;cursor:pointer;color:var(--sidebar-ink);font-size:13.5px;transition:background .13s,color .13s;text-decoration:none}
.nav:hover{background:var(--sidebar-2);color:var(--ink)}
.nav.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
.nav.disabled{color:var(--faint);cursor:not-allowed}
.nav .el-icon{color:inherit;opacity:.85}
.nav.active .el-icon{opacity:1}
.nav .badge{margin-left:auto;background:var(--surface-2);color:var(--muted);font-size:11px;padding:1px 7px;border-radius:20px;font-family:var(--font-mono)}
.nav.active .badge{background:#fff;color:var(--accent)}
.foot{margin-top:auto;padding:12px 10px 4px;border-top:1px solid var(--line);color:var(--sidebar-faint);font-size:10.5px;line-height:1.6}
.main{display:flex;flex-direction:column;overflow:hidden}
.top{height:58px;flex:none;background:var(--surface);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;padding:0 24px}
.crumb b{font-size:15px;font-weight:600}
.user{margin-left:auto;display:flex;align-items:center;gap:9px}
.avatar{width:32px;height:32px;border-radius:8px;background:var(--accent-soft);color:var(--accent-ink);display:grid;place-items:center;font-weight:600;font-size:14px}
.uname{font-size:13px;font-weight:600}
.uorg{font-size:11px;color:var(--faint)}
.logout{font-size:11.5px;color:var(--faint);cursor:pointer;margin-left:6px;padding:3px 9px;border:1px solid var(--line);border-radius:7px}
.logout:hover{color:var(--crit);border-color:var(--crit)}
.content{overflow:auto;flex:1;padding:28px 32px}
/* —— 顶栏搜索入口 + ⌘K 面板 —— */
.ksearch{display:flex;align-items:center;gap:22px;margin-left:18px;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:7px 12px;font-size:12.5px;color:var(--faint);cursor:pointer;font-family:inherit}
.ksearch:hover{border-color:var(--line-strong);color:var(--muted)}
.kmask{position:fixed;inset:0;background:rgba(26,26,30,.32);z-index:80;display:flex;justify-content:center;align-items:flex-start;padding-top:14vh}
.kbox{width:560px;max-width:92vw;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 24px 70px -20px rgba(26,26,30,.35);overflow:hidden}
.kin{width:100%;border:none;outline:none;padding:16px 18px;font-size:15px;font-family:inherit;background:transparent;color:var(--ink);border-bottom:1px solid var(--line)}
.klist{max-height:46vh;overflow-y:auto;padding:6px}
.khit{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;font-size:13.5px}
.khit.on{background:var(--accent-soft)}
.khit .kl{font-weight:600;flex:none}
.khit.on .kl{color:var(--accent-ink)}
.khit .ks{color:var(--faint);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.khit .kgo{margin-left:auto;color:var(--accent);font-weight:700}
.kempty{padding:22px;text-align:center;color:var(--faint);font-size:13px}
@media (max-width:980px){
  .top{padding:0 14px;gap:10px}
  .content{padding:16px 14px}
  .uinfo{display:none}
}
</style>
