// 权限矩阵：动作 → 允许角色。唯一权威来源 = docs/检测业务主流程-PRD-v2.md §2.2。
// admin 恒通过（hasRole 里放行），不用写进名单；tech 技术负责人按 PRD 全程兜底。
// ⚠️ 改这里必须同步 web/src/permissions.ts（前端菜单/按钮用同一份口径），两边由测试互相钉住。
export const REPORT_READ_ROLES = ['sales', 'report_editor', 'signer', 'tech'] as const

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
  round_field:     ['sampler', 'tech'],              // 现场采样、填采样表、收样入库
  round_flow:      ['sampler', 'planner', 'tech'],
  sample_create:   ['sales', 'sampler', 'analyst', 'tech'],
  // —— 设备 / 资源台账 ——
  resource_manage:      ['tech'],                    // 建/改仪器·标物·试剂（防伪造检定效期）
  instrument_checkout:  ['sampler', 'analyst', 'tech'],
  // —— 交接 / 质控分工 ——
  handover_send:    ['sampler', 'sales', 'tech'],
  handover_confirm: ['sample_manager', 'tech'],
  task_assign:      ['qc', 'tech'],                    // 派检测任务（样品×项目→检测员）
  qc_add:           ['qc', 'tech'],
  pretreatment:     ['analyst', 'tech'],
  // —— 检测记录（录入先卡 analyst；复核/审核由工作流资格与项目指派最终收口） ——
  record_save:    ['analyst'],
  record_review:  ['analyst', 'tech'],
  record_approve: ['analyst', 'tech'],
  record_recheck: ['analyst', 'tech'],
  // —— 报告 ——
  // 这些只是路由/菜单的粗粒度角色门禁；项目报告仍须在 handlers 中校验原编制人、精确指派、资格和三人分离。
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
