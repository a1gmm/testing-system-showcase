// 前端权限矩阵：与 server/src/permissions.ts 严格同一份口径（由 web/test/permissions-parity.test.ts 钉住）。
// 页面/菜单/按钮统一用 can('动作')，不再各页手写角色清单。
import { hasRole } from './api'

export const PERM = {
  // —— 合同 ——
  contract_edit:   ['sales', 'tech'],
  contract_accept: ['sales', 'tech'],
  customer_edit:   ['sales', 'tech'],
  // —— 监测方案 ——
  scheme_edit:     ['planner', 'tech'],
  scheme_review:   ['tech'],
  // —— 期次 / 派工 / 现场 ——
  round_assign:    ['planner', 'tech'],
  round_field:     ['sampler', 'tech'],
  round_flow:      ['sampler', 'planner', 'tech'],
  sample_create:   ['sales', 'sampler', 'analyst', 'tech'],
  // —— 设备 / 资源台账 ——
  resource_manage:      ['tech'],
  instrument_checkout:  ['sampler', 'analyst', 'tech'],
  // —— 交接 ——
  handover_send:    ['sampler', 'sales', 'tech'],
  handover_confirm: ['sample_manager', 'tech'],
  task_assign:      ['qc', 'tech'],
  qc_add:           ['qc', 'tech'],
  pretreatment:     ['analyst', 'tech'],
  // —— 检测记录 ——
  record_save:    ['analyst'],
  record_review:  ['analyst', 'tech'],
  record_approve: ['analyst', 'tech'],
  record_recheck: ['analyst', 'tech'],
  // —— 报告 ——
  report_generate: ['report_editor', 'tech'],
  report_update:   ['report_editor', 'tech'],
  report_check:    ['report_editor', 'tech'],
  report_issue:    ['signer', 'tech'],
  // —— 体系 / 分包 ——
  subcontract:    ['sales', 'tech'],
  system_records: ['tech'],
  org_profile:    ['tech'],                          // 公司主数据（报告抬头/证书号），admin 恒通过
  contract_tech_review: ['tech'],                    // 合同评审签批（拍板7）：技术负责人人选未定，暂由 admin 代签（tech 仅全程兜底约定）
  // —— 留痕 / 附件 ——
  audit_view:    ['report_editor', 'tech'],
  attach_upload: ['sampler', 'analyst', 'tech', 'sales', 'qc'],
  attach_delete: ['sampler', 'analyst', 'tech', 'sales', 'qc'],
} as const

export type PermAction = keyof typeof PERM

// admin 恒通过（hasRole 内已处理）
export function can(action: PermAction): boolean { return hasRole(...PERM[action]) }

// 页面准入：一页可能承载多个动作，取并集（菜单和路由守卫共用这一份）
export const PAGE_ROLES: Record<string, string[]> = {
  customers:  ['sales', 'tech', 'signer'],
  contracts:  ['sales', 'planner', 'tech', 'signer'],
  plans:      ['sampler', 'planner', 'qc', 'tech'],
  samples:    ['analyst', 'qc', 'tech', 'sampler', 'sales'],
  qc:         ['sampler', 'sample_manager', 'qc', 'tech'],
  reports:    ['report_editor', 'signer', 'tech'],
  instruments: ['sampler', 'analyst', 'tech'],
  archive:    ['archivist', 'tech'],
  'archive-packages': ['archivist', 'report_editor', 'tech'],
  'system-records': ['tech'],
  subcontracts: ['sales', 'tech'],
  users:      ['admin'],                             // 人员与权限（菜单与路由共用这一份，别再各写一份）
}
