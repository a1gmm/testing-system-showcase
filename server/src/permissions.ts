// 权限矩阵：动作 → 允许角色。唯一权威来源 = docs/检测业务主流程-PRD-v2.md §2.2。
// admin 恒通过（hasRole 里放行），不用写进名单；tech 技术负责人按 PRD 全程兜底。
// ⚠️ 改这里必须同步 web/src/permissions.ts（前端菜单/按钮用同一份口径），两边由测试互相钉住。
export const REPORT_READ_ROLES = ['registrar', 'reviewer', 'approver', 'signer', 'tech'] as const

export const PERM = {
  // —— 合同 ——
  contract_edit:   ['registrar', 'tech'],            // 录/改合同、传原件、报价单、生成样品
  contract_accept: ['registrar', 'tech'],            // 确认受理（合同评审由 tech 在受理时做）
  customer_edit:   ['registrar', 'tech'],
  // —— 监测方案 ——
  scheme_edit:     ['registrar', 'tech'],            // 编制方案（PRD：registrar 编、tech 审，编审分离）
  scheme_review:   ['tech'],
  // —— 期次 / 派工 / 现场 ——
  round_assign:    ['registrar', 'qc', 'tech'],      // 生成期次、派工
  round_field:     ['sampler', 'tech'],              // 现场采样、填采样表、收样入库
  round_flow:      ['sampler', 'registrar', 'tech'], // 采不成 / 改期
  sample_create:   ['registrar', 'sampler', 'tester', 'tech'],
  // —— 设备 / 资源台账 ——
  resource_manage:      ['tech'],                    // 建/改仪器·标物·试剂（防伪造检定效期）
  instrument_checkout:  ['sampler', 'tester', 'tech'],
  // —— 交接（质控员核心职责） ——
  handover_send:    ['sampler', 'registrar', 'tech'],  // 采样员交样（registrar 兜自送样登记）
  handover_confirm: ['qc', 'tech'],                    // 只有质控员能签收——检测员不能自己收自己测
  task_assign:      ['qc', 'tech'],                    // 派检测任务（样品×项目→检测员）
  qc_add:           ['qc', 'tech'],
  pretreatment:     ['tester', 'tech'],
  // —— 检测记录（三级审核，「级」由角色保证，同人校验另有专门逻辑） ——
  record_save:    ['tester', 'tech'],
  record_review:  ['reviewer', 'tech'],
  record_approve: ['approver', 'tech'],
  record_recheck: ['reviewer', 'approver', 'tester', 'tech'],
  // —— 报告 ——
  report_generate: ['registrar', 'tech'],            // PRD：编制=registrar
  report_update:   ['registrar', 'tech'],            // 草稿阶段编制人可改
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
  attach_delete: ['sampler', 'tester', 'tech', 'registrar', 'qc'],  // 另有「只能删自己传的」归属校验
} as const

export type PermAction = keyof typeof PERM
