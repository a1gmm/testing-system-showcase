// 前端权限矩阵：与 server/src/permissions.ts 严格同一份口径（由 web/test/permissions-parity.test.ts 钉住）。
// 页面/菜单/按钮统一用 can('动作')，不再各页手写角色清单。
import { hasRole } from './api'

export const PERM = {
  // —— 合同 ——
  contract_edit:   ['registrar', 'tech'],
  contract_accept: ['registrar', 'tech'],
  customer_edit:   ['registrar', 'tech'],
  // —— 监测方案 ——
  scheme_edit:     ['registrar', 'tech'],
  scheme_review:   ['tech'],
  // —— 期次 / 派工 / 现场 ——
  round_assign:    ['registrar', 'qc', 'tech'],
  round_field:     ['sampler', 'tech'],
  round_flow:      ['sampler', 'registrar', 'tech'],
  sample_create:   ['registrar', 'sampler', 'tester', 'tech'],
  // —— 设备 / 资源台账 ——
  resource_manage:      ['tech'],
  instrument_checkout:  ['sampler', 'tester', 'tech'],
  // —— 交接 ——
  handover_send:    ['sampler', 'registrar', 'tech'],
  handover_confirm: ['qc', 'tech'],
  task_assign:      ['qc', 'tech'],
  qc_add:           ['qc', 'tech'],
  pretreatment:     ['tester', 'tech'],
  // —— 检测记录 ——
  record_save:    ['tester', 'tech'],
  record_review:  ['reviewer', 'tech'],
  record_approve: ['approver', 'tech'],
  record_recheck: ['reviewer', 'approver', 'tester', 'tech'],
  // —— 报告 ——
  report_generate: ['registrar', 'tech'],
  report_update:   ['registrar', 'tech'],
  report_check:    ['reviewer', 'approver', 'tech'],
  report_issue:    ['signer', 'tech'],
  // —— 体系 / 分包 ——
  subcontract:    ['registrar', 'tech'],
  system_records: ['tech'],
  org_profile:    ['tech'],                          // 公司主数据（报告抬头/证书号），admin 恒通过
  contract_tech_review: ['tech'],                    // 合同评审签批（拍板7）：技术负责人人选未定，暂由 admin 代签（tech 仅全程兜底约定）
  // —— 留痕 / 附件 ——
  audit_view:    ['reviewer', 'approver', 'tech'],
  attach_upload: ['sampler', 'tester', 'tech', 'registrar', 'qc'],
  attach_delete: ['sampler', 'tester', 'tech', 'registrar', 'qc'],
} as const

export type PermAction = keyof typeof PERM

// admin 恒通过（hasRole 内已处理）
export function can(action: PermAction): boolean { return hasRole(...PERM[action]) }

// 页面准入：一页可能承载多个动作，取并集（菜单和路由守卫共用这一份）
export const PAGE_ROLES: Record<string, string[]> = {
  customers:  ['registrar', 'tech', 'signer'],
  contracts:  ['registrar', 'tech', 'signer'],
  plans:      ['sampler', 'registrar', 'qc', 'tech'],
  samples:    ['tester', 'qc', 'tech', 'sampler', 'registrar'],  // qc 指派/看样品；sampler 发交接单+补采（流程④的家）；registrar 自送样登记
  qc:         ['qc', 'tech'],                        // 质控交接（流程④⑤的家：签收交接单+发任务通知单）
  review:     ['reviewer', 'approver', 'tech'],
  reports:    ['registrar', 'reviewer', 'approver', 'signer', 'tech'],  // 编制/审核/签发全链人
  instruments: ['sampler', 'tester', 'tech'],        // 采样员领设备
  archive:    ['reviewer', 'approver', 'tech'],
  'system-records': ['tech'],
  subcontracts: ['registrar', 'tech'],
  users:      ['admin'],                             // 人员与权限（菜单与路由共用这一份，别再各写一份）
}
