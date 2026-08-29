import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { getToken, currentUser, api, hasRole } from '../api'
import { PAGE_ROLES } from '../permissions'
import FieldTask from '../pages/FieldTask.vue'

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', meta: { public: true, title: '登录' }, component: () => import('../pages/Login.vue') },
  // 合同打印页：独立整页（不套导航壳），照纸质模板排版走浏览器打印
  { path: '/contracts/:id/print', name: 'contract-print', meta: { title: '打印合同', roles: PAGE_ROLES.contracts }, component: () => import('../pages/ContractPrint.vue') },
  // 交接单 / 检测任务通知单打印页：独立整页，照 HJ-TC 纸质表号排版
  { path: '/handover-sheets/:id/print', name: 'sheet-print', meta: { title: '打印交接单', roles: PAGE_ROLES.samples }, component: () => import('../pages/HandoverSheetPrint.vue') },
  { path: '/test-notices/:id/print', name: 'notice-print', meta: { title: '打印任务通知单', roles: PAGE_ROLES.samples }, component: () => import('../pages/NoticePrint.vue') },
  // 报告打印页（批次二）：0096"最新标准"制式，封面→委托信息→结果→方法表→双语声明
  { path: '/reports/:id/print', name: 'report-print', meta: { title: '打印报告', roles: PAGE_ROLES.reports }, component: () => import('../pages/ReportPrint.vue') },
  // 现场任务是独立、可离线冷启动的工作面。保持 eager，避免首次离线缺失动态 chunk。
  { path: '/field-tasks/:id', name: 'field-task', meta: { title: '样品工作台', roles: ['sampler'], offlinePackage: true }, component: FieldTask },
  {
    path: '/',
    component: () => import('../components/AppShell.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', meta: { title: '工作台' }, component: () => import('../pages/Dashboard.vue') },
      { path: 'customers', name: 'customers', meta: { title: '客户档案', roles: PAGE_ROLES.customers }, component: () => import('../pages/Customers.vue') },
      { path: 'contracts', name: 'contracts', meta: { title: '合同与方案', roles: PAGE_ROLES.contracts }, component: () => import('../pages/Contracts.vue') },
      { path: 'plans', name: 'plans', meta: { title: '采样派工', roles: PAGE_ROLES.plans }, component: () => import('../pages/Plans.vue') },
      { path: 'mobile-confirmation', name: 'mobile-confirmation', meta: { title: '第二设备确认', roles: ['sampler'] }, component: () => import('../pages/MobileConfirmation.vue') },
      { path: 'qc', name: 'qc', meta: { title: '质控交接', roles: PAGE_ROLES.qc }, component: () => import('../pages/Qc.vue') },
      { path: 'samples', name: 'samples', meta: { title: '检测录入', roles: PAGE_ROLES.samples }, component: () => import('../pages/Samples.vue') },
      { path: 'review', redirect: { path: '/samples', query: { stage: 'laboratory', queue: 'review' } } },
      { path: 'archive-packages', name: 'archive-packages', meta: { title: '1–8 档案归档', roles: PAGE_ROLES['archive-packages'] }, component: () => import('../pages/ArchivePackages.vue') },
      { path: 'reports', name: 'reports', meta: { title: '报告签发', roles: PAGE_ROLES.reports }, component: () => import('../pages/Reports.vue') },
      { path: 'instruments', name: 'instruments', meta: { title: '资源台账', roles: PAGE_ROLES.instruments }, component: () => import('../pages/Resources.vue') },
      { path: 'users', name: 'users', meta: { title: '人员与权限', roles: PAGE_ROLES.users }, component: () => import('../pages/Users.vue') },
      { path: 'archive', name: 'archive', meta: { title: '数据留痕查询', roles: PAGE_ROLES.archive }, component: () => import('../pages/Archive.vue') },
      // 模板库是纯只读的记录表原样预览，有意全员开放（显式列全所有角色，避免被当成漏配）
      { path: 'templates', name: 'templates', meta: { title: '记录表模板库', roles: ['admin', 'sales', 'tech', 'planner', 'sampler', 'sample_manager', 'qc', 'analyst', 'report_editor', 'archivist', 'signer'] }, component: () => import('../pages/TemplateLibrary.vue') },
      { path: 'system-records', name: 'system-records', meta: { title: '体系运行记录', roles: PAGE_ROLES['system-records'] }, component: () => import('../pages/SystemRecords.vue') },
      { path: 'subcontracts', name: 'subcontracts', meta: { title: '分包管理', roles: PAGE_ROLES.subcontracts }, component: () => import('../pages/SubContracts.vue') },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

const PROFESSIONAL_PAGE_CAPABILITY: Record<string, { stage: string; scope: 'sampling' | 'quality' }> = {
  plans: { stage: 'sampling', scope: 'sampling' },
  qc: { stage: 'quality', scope: 'quality' },
}

async function hasFocusedProfessionalCapability(to: Parameters<Parameters<typeof router.beforeEach>[0]>[0]) {
  const routeName = typeof to.name === 'string' ? to.name : ''
  const capability = PROFESSIONAL_PAGE_CAPABILITY[routeName]
  const queue = String(to.query.queue || '')
  if (!capability || to.query.stage !== capability.stage || (queue !== 'review' && queue !== 'approve')) return false
  try {
    const tasks = await api.listWorkflowTasks(capability.scope)
    return tasks.some(task => task.decision_level === queue)
  } catch { return false }
}

// 登录守卫：没 token 去登录页；按岗位拦页面（直接输网址也进不去别人的岗位页）
router.beforeEach(async (to) => {
  if (to.meta.public) return true
  // This route authenticates only against a signed, device-bound local package.
  // It must not call the session API: a stale token is common on an offline cold start.
  if (to.meta.offlinePackage) return true
  if (!getToken()) return '/login'
  if (!currentUser.value) { try { await api.me() } catch { /* 拦截器会踢回登录 */ } }
  const roles = to.meta.roles as string[] | undefined
  if (roles && !hasRole(...roles) && !(await hasFocusedProfessionalCapability(to))) return '/dashboard'
  return true
})

export default router
