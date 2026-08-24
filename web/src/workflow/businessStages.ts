export const STAGE_QUEUES = [
  { key: 'write', label: '待我填写' },
  { key: 'review', label: '待我复核' },
  { key: 'approve', label: '待我审核' },
  { key: 'rejected', label: '已退回' },
  { key: 'final', label: '已定稿' },
] as const

export type StageQueueKey = typeof STAGE_QUEUES[number]['key']

export const BUSINESS_STAGES = [
  { key: 'contract', label: '① 编制委托合同', shortLabel: '合同', to: { path: '/contracts', query: { stage: 'contract' } }, roles: ['sales', 'tech', 'signer'] },
  { key: 'contract-review', label: '② 合同评审', shortLabel: '合同评审', to: { path: '/contracts', query: { stage: 'review' } }, roles: ['sales', 'tech', 'signer'] },
  { key: 'scheme', label: '③ 编制监测方案', shortLabel: '监测方案', to: { path: '/contracts', query: { stage: 'scheme' } }, roles: ['planner', 'tech'] },
  { key: 'dispatch', label: '④ 采样指派', shortLabel: '采样指派', to: { path: '/plans', query: { stage: 'dispatch' } }, roles: ['planner', 'tech', 'sampler', 'qc'] },
  { key: 'sampling', label: '⑤ 现场采样', shortLabel: '现场采样', to: { path: '/plans', query: { stage: 'sampling' } }, roles: ['sampler', 'planner', 'tech'] },
  { key: 'handover', label: '⑥ 样品交接', shortLabel: '样品交接', to: { path: '/qc', query: { stage: 'handover' } }, roles: ['sampler', 'sample_manager', 'qc', 'tech'] },
  { key: 'quality', label: '⑦ 质控', shortLabel: '质控', to: { path: '/qc', query: { stage: 'quality' } }, roles: ['qc', 'tech'] },
  { key: 'laboratory', label: '⑧ 实验室分析', shortLabel: '实验室分析', to: { path: '/samples', query: { stage: 'laboratory' } }, roles: ['analyst', 'qc', 'tech', 'sampler', 'sales'] },
  { key: 'archive', label: '⑨ 1–8 档案归档', shortLabel: '档案归档', to: { path: '/archive-packages' }, roles: ['archivist', 'tech', 'report_editor'] },
  { key: 'report', label: '⑩ 出具报告', shortLabel: '出具报告', to: { path: '/reports' }, roles: ['report_editor', 'signer', 'tech'] },
] as const

export type BusinessStageKey = typeof BUSINESS_STAGES[number]['key']

export function businessStage(key: BusinessStageKey) {
  return BUSINESS_STAGES.find(stage => stage.key === key)!
}
