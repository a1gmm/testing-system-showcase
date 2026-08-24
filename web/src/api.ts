// 后端接口封装（/api 由 vite 代理到 localhost:3001）
import axios from 'axios'
import { ref } from 'vue'
import { clearRecoveryIdentity, issueAuthenticatedRecoveryCredential } from './offline/recoveryIdentity'
import { publishAuthLogout } from './offline/authLifecycle'

const http = axios.create({ baseURL: '/api', timeout: 8000 })

// ============ 登录态（全局唯一）============
export type User = { username: string; name: string; roles: string[]; status: string; created_at: string; must_change_pw?: boolean; cert_name?: string | null; cert_until?: string | null }
export const ROLE_LABEL: Record<string, string> = {
  admin: '系统管理员', sales: '业务员', tech: '技术负责人', planner: '计划员',
  sampler: '采样员', sample_manager: '样品管理员', qc: '质控员',
  analyst: '实验室分析人员', report_editor: '报告编制人员',
  archivist: '档案管理员', signer: '授权签字人',
}
export const PROFESSIONAL_SCOPES = ['sampling', 'quality', 'laboratory', 'report'] as const
export type ProfessionalScope = typeof PROFESSIONAL_SCOPES[number]
export const PROFESSIONAL_SCOPE_LABEL: Record<ProfessionalScope, string> = {
  sampling: '采样', quality: '质控', laboratory: '实验室', report: '报告',
}
export const QUALIFICATION_CODES = PROFESSIONAL_SCOPES.flatMap(scope => [`${scope}_review`, `${scope}_approve`] as const)
export type QualificationCode = typeof QUALIFICATION_CODES[number]
export const QUALIFICATION_LABEL: Record<QualificationCode, string> = {
  sampling_review: '采样复核', sampling_approve: '采样审核',
  quality_review: '质控复核', quality_approve: '质控审核',
  laboratory_review: '实验室复核', laboratory_approve: '实验室审核',
  report_review: '报告复核', report_approve: '报告审核',
}
export type UserQualification = {
  username: string; code: QualificationCode; valid_from: string | null; valid_until: string | null
  status: 'active' | 'inactive'; granted_by: string; granted_at: string
}
export type QualificationInput = {
  code: QualificationCode; validFrom?: string | null; validUntil?: string | null; status?: 'active' | 'inactive'
}
export type WorkflowSubjectType = 'round_sampling' | 'quality_plan' | 'lab_record' | 'report'
export type WorkflowStatus = 'draft' | 'pending_review' | 'pending_approval' | 'approved' | 'rejected' | 'withdrawn'
export type WorkflowDecisionLevel = 'review' | 'approve'
export type WorkflowDecision = 'approve' | 'reject'
export type WorkflowRevision = {
  revision: number; snapshot: Record<string, unknown>; snapshot_json: string; snapshot_sha256: string
  submitted_by: string; submitted_at: string
}
export type WorkflowDecisionEntry = {
  id: number; revision: number; level: WorkflowDecisionLevel; decision: WorkflowDecision
  comment: string; decided_by: string; decided_at: string
}
export type WorkflowInstance = {
  id: string; contract_id: string; round_id: string | null; scope: ProfessionalScope
  subject_type: WorkflowSubjectType; subject_id: string; status: WorkflowStatus; current_revision: number
  created_by: string; created_at: string; withdrawn_reason: string | null; withdrawn_by: string | null
  withdrawn_at: string | null
}
export type WorkflowView = WorkflowInstance & { revisions: WorkflowRevision[]; decisions: WorkflowDecisionEntry[] }
export type WorkflowTask = {
  workflow_instance_id: string; subject_type: WorkflowSubjectType; subject_id: string; contract_id: string
  status: 'pending_review' | 'pending_approval'; current_revision: number
  decision_level: WorkflowDecisionLevel; acting_capacity: string
}
export type WorkflowAssignment = {
  id: number; contract_id: string; scope: ProfessionalScope; reviewer_username: string; approver_username: string
  active: boolean; reason: string | null; assigned_by: string; assigned_at: string
}
export type WorkflowCandidate = { username: string; name: string }
export type ArchiveIssue = { code: string; message: string; roundId?: string; entityId?: string }
export type ArchiveReadiness = {
  ready: boolean; contractId: string; reportBatchId: string | null; roundIds: string[]; issues: ArchiveIssue[]
}
export type ArchiveItem = {
  id: number; archive_package_id: string; item_order: number; entity_type: string; entity_id: string
  workflow_instance_id: string | null; revision: number | null; content_hash: string; label: string
  metadata: Record<string, unknown>
}
export type ArchivePackage = {
  id: string; contract_id: string; report_batch_id: string | null; version: number
  status: 'draft' | 'ready' | 'confirmed' | 'invalidated'; manifest_sha256: string; readiness: ArchiveReadiness
  created_by: string; created_at: string; confirmed_by: string | null; confirmed_at: string | null
  invalidated_by: string | null; invalidated_at: string | null; invalidation_reason: string | null; items: ArchiveItem[]
}
export type ReportBatch = {
  id: string; contract_id: string; name: string; created_by: string; created_at: string; round_ids: string[]
}
export type QualityPlanRequirement = { qcType: string; matrix?: string; analyte?: string; qty: number; basis?: string; note?: string }
export type QualityPlan = {
  subject_id: string; round_id: string | null; batch_id: string | null; contract_id: string
  requirements: QualityPlanRequirement[]; adjustments: QualityPlanRequirement[]; author_username: string; updated_at: string
}
export const currentUser = ref<User | null>(null)
function refreshRecoveryIdentityBestEffort(username: string) {
  void issueAuthenticatedRecoveryCredential(username).catch(() => undefined)
}
export function getToken() { return localStorage.getItem('tc_token') || '' }
export function hasRole(...roles: string[]) {
  const u = currentUser.value
  if (!u) return false
  return u.roles.includes('admin') || roles.some(r => u.roles.includes(r))
}
http.interceptors.request.use(cfg => {
  const t = getToken()
  if (t) cfg.headers.Authorization = 'Bearer ' + t
  return cfg
})
// 未登录/会话失效(401) → 回登录页；
// 未改初始密码(403 must_change_pw，如刷新后 token 还在却被后端挡住) → 也回登录页，重登时会强制弹改密框
http.interceptors.response.use(r => r, err => {
  const st = err?.response?.status
  if (st === 401 || (st === 403 && err?.response?.data?.must_change_pw)) {
    localStorage.removeItem('tc_token'); currentUser.value = null
    // 记住来路：重新登录后回到原页面，不让人从头找
    if (location.pathname !== '/login') location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search)
  }
  // 网络错误别弹英文（Network Error / timeout of 8000ms exceeded 没人看得懂）——
  // 只改 err.message 成人话；后端业务报错走 response.data.error，各页 catch 原有展示逻辑不受影响
  if (!err?.response) err.message = '连不上服务器，检查网络或稍后再试'
  else if (err.response.status >= 500) err.message = '服务器出错了，请稍后再试或联系管理员'
  return Promise.reject(err)
})

export type Sample = {
  id: string; client: string; matrix: string
  items: string[]; status: string; note: string; contract_id: string | null; round_id: string | null; source: string
  point_name: string | null
  replaced_by?: string | null   // 拒收样补采后指向新样
  storage?: string | null       // 保存条件（详情接口从交接单带出，盲样也可见）
  qc_type?: string | null   // S4：质控样类型（全程序空白/运输空白/现场平行），普通样为空
  created_at: string
}
export type ContractSample = { id: number; contract_id: string; matrix: string; items: string[]; qty: number; cycle_months: number; note: string; point?: string }
export type ContractUpdatePatch = { client?: string; contact?: string; phone?: string; project?: string; note?: string; periodStart?: string; periodEnd?: string; urgent?: boolean }
export type SchemePoint = { element: string; point: string; items: string[]; freq: string; standard: string }
export type LimitRule = { analyte: string; op: '≤' | '≥' | 'range'; value: number | null; value2?: number | null; unit: string; standard?: string }
export type Scheme = {
  id: string; contract_id: string; points: SchemePoint[]; limits: LimitRule[]
  cycle_months: number; period_start: string | null; period_end: string | null
  status: string; reviewer: string | null; reviewed_at: string | null; reject_reason: string | null; created_at: string
}
// S4 现场记录：通用字段 + 噪声专项(校准/风速) + 固废(吨位) + 按基质填的采样单 sheets
export type SamplingSheet = { code: string; name: string; point?: string; character?: string; method?: string; container?: string; note?: string }
export type FieldInfo = {
  date?: string; time?: string; weather?: string; temp?: string; blank?: boolean; parallel?: boolean; note?: string; points?: string
  confirmations?: Record<string, { name: string; at: string }> // 不可变用户 ID → 确认事实
  confirmation_users?: { user_id: string; name: string; confirmed_at: string | null }[] // 按派工顺序、同名不折叠
  confirms?: Record<string, string>   // 仅兼容旧客户端展示，不得用于身份判断
  calBefore?: number | string; calAfter?: number | string; wind?: number | string   // 噪声：测前/测后校准、风速m/s
  tons?: number | string                                                            // 固废：堆存量(t)，查最小份样数
  sheets?: Record<string, SamplingSheet>                                            // 基质 → 已填采样单
  sheetCodes?: Record<string, string[]>                                             // 基质 → 本期要填的多张采样单表号
  sheetDrafts?: Record<string, SamplingSheet>                                       // 无精确版式时按表号保存简化登记（兼容多表）
  instrumentIds?: string[]                                                          // 本期已领用且现场实际使用的设备
}
export type QcRequirement = { qcType: string; matrix: string; qty: number; basis: string }
export type Round = {
  id: string; contract_id: string; round_no: number; due_date: string; status: string
  plan_id: string | null; sampler: string | null; sampler_ids: string[]; assignment_status: string
  plan_date: string | null; sampled_at: string | null
  field_info?: FieldInfo | null; created_at: string; sample_count?: number; rollup?: string
  fail_reason?: string | null; orig_due_date?: string | null   // 采不成/改期留痕
}
export type { OfflineTaskPackage } from './offline/fieldTaskDraft'
import type { OfflineTaskPackage } from './offline/fieldTaskDraft'
import type { LocalSubmission, SubmissionReceipt } from './offline/submissionOutbox'
export type DueRound = Round & { client: string; project: string; bucket: 'overdue' | 'soon' | 'later' | 'done'; urgent?: number }
export type RoundDetail = { round: Round; contract: Contract | null; planItems: ContractSample[]; samples: (Sample & { rollup: string })[] }
export type ContractReview = {
  // 合同评审记录表 QTCYT/JL141 字段
  purpose?: string                                            // 监测目的
  manpower?: boolean; instruments?: boolean; environment?: boolean; method?: boolean  // 四项资源确认
  subcontract?: boolean; subFee?: string                      // 是否分包 + 分包费用
  conclusion?: string                                         // 评审结论
  // 兼容旧字段（详情条/老数据）
  demand?: boolean; ability?: boolean; risk?: boolean; note?: string
}
export type QuoteRow = {
  category: string; point: string; items: string[]; extraItems?: string
  price: number; points: number; perDay: number; perYear: number
  subtotal?: number; note?: string
}
// 甲方开票信息：打印合同「委托单位（盖章）」栏自动带出，全部选填
export type QuoteBuyer = { addr?: string; bank?: string; account?: string; taxNo?: string; bankNo?: string; legal?: string }
export type Quote = {
  extNo?: string; signDate?: string; invoice?: string; buyer?: QuoteBuyer
  rows: QuoteRow[]; total: number; discount: number; discountUpper: string
}
export type Contract = {
  id: string; client: string; contact: string; phone?: string | null; project: string; note: string
  status: string; doc_name: string | null; doc_path: string | null
  accepted_at: string | null; accepted_by: string | null; review_info?: ContractReview | null
  tech_approved_by?: string | null; tech_approved_at?: string | null; tech_approve_note?: string | null; tech_review_result?: 'approve' | 'reject' | null
  cycle_months: number; period_start: string | null; period_end: string | null; created_at: string; urgent?: number
  plan: ContractSample[]; samples: Sample[]; scheme: Scheme | null; quote?: Quote | null
}
export type Customer = { id: number; name: string; contact: string | null; phone?: string | null; address: string | null; note: string | null; created_at: string; contract_count: number }
export type PipeStage = { key: string; label: string; code: string; who: string; status: 'done' | 'active' | 'todo'; action: string }
export type Pipeline = { stages: PipeStage[]; activeIndex: number; blockers: string[]; round: { no: number | null; total: number; due?: string } | null }
export type RecordData = { rows: Record<string, any>[]; compRows?: Record<string, Record<string, any>[]>; meta: Record<string, any>; cells?: Record<string, any>; reg?: Record<string, any>; resultSummary?: { analyte: string; value: number | string; unit: string } | null }
export type RecordRow = {
  id: string; serial: string | null; sample_id: string; template_code: string; template_name: string
  sheet_type: string; method: string; analyte: string; matrix: string
  instrument_id: string | null; data: RecordData; status: string
  reviewer: string | null; reviewed_at: string | null
  approver: string | null; approved_at: string | null; reject_reason: string | null
  author?: string | null; author_username?: string | null
  recheck?: number; recheck_reason?: string | null   // 超标复检标记
  contract_id?: string | null; client?: string | null // 所属合同/单位（审核队列按合同分组；盲用户已在接口层脱敏）
  updated_at: string
}
export type Audit = { id: number; record_id: string; who: string; username?: string | null; action: string; detail: any; at: string }
export type Plan = { id: string; contract_id: string | null; client: string; sampler: string; plan_date: string; status: string; note: string; created_at: string }
export type Instrument = { id: string; name: string; model: string; status: string; cert_until: string | null; cert_no: string | null; note: string }
export type Checkout = { id: number; instrument_id: string; instrument_name?: string; round_id: string | null; taken_by: string; taken_at: string; cert_ok_at_checkout: number; returned_by: string | null; returned_at: string | null; status: string; warning?: string }
export type RefMaterial = { id: string; name: string; batch: string; spec: string; expiry: string | null; stock: string; supplier: string; cert_no: string; created_at: string }
export type Reagent = { id: string; name: string; spec: string; grade: string; batch: string; expiry: string | null; stock: string; supplier: string; created_at: string }
export type ResourceAlert = { type: string; typeLabel: string; id: string; name: string; date: string; bucket: 'overdue' | 'soon' }
export type Report = { id: string; sample_id: string | null; round_id: string | null; contract_id: string | null; client: string; title: string; conclusion: string; data: any; status: string; checker: string | null; checked_at: string | null; issuer: string | null; issued_at: string | null; created_at: string; author?: string | null; author_username?: string | null; archive_package_id?: string | null; voided?: number; void_reason?: string | null; voided_by?: string | null; voided_at?: string | null; reissue_of?: string | null }
export type ProjectStats = { samples: number; tested: number; approved: number; reports: number; issued: boolean; reportStatus: 'none' | 'draft' | 'checked' | 'issued' }
export type ProjectSummary = Contract & { stats: ProjectStats; plan: Plan | null; pipeline: Pipeline }
export type SampleWithRecords = Sample & { records: RecordRow[]; rollup: string }
export type Handover = { id: number; sample_id: string; action: string; from_person: string | null; to_person: string | null; condition: string | null; note: string | null; who: string; username: string | null; at: string; confirmed_by: string | null; confirmed_at: string | null }
export type TestTask = { id: number; sample_id: string; analyte: string; assignee: string; assignee_username: string | null; assigned_by: string; assigned_at: string; record_status: string; due_at?: string | null }
export type HandoverSheetRow = { sampleId: string; items: string[]; condition?: string; container?: string; rejected?: boolean; rejectReason?: string }
export type HandoverSheet = { id: string; round_id: string; contract_id: string; source: string; sample_ids: string[]; detail: HandoverSheetRow[]; from_person: string | null; from_at: string | null; to_person: string | null; to_at: string | null; storage: string | null; status: 'draft' | 'sent' | 'confirmed'; note: string | null; created_at: string; client?: string | null; project?: string | null }
export type TestNotice = { id: string; sheet_id: string; round_id: string | null; contract_id: string | null; category: string | null; nature: string | null; source: string | null; sample_desc: string | null; groups: { sampleId: string; analytes: string[] }[]; received_at: string | null; due_at: string | null; dept: string | null; issuer: string | null; issuer_username: string | null; status: 'draft' | 'issued'; issued_at: string | null; note: string | null; created_at: string; client?: string | null; project?: string | null }
export type NoticeDecodeRow = { sampleId: string; pointName: string | null; client: string; matrix: string; qcType: string | null }
export type OrgProfile = { id: number; name: string; name_en: string | null; address: string | null; postcode: string | null; phone: string | null; fax: string | null; cma_no: string | null; note: string | null }
export type MonitoringPoint = { id: number; contract_id: string; code: string; name: string; matrix: string | null; source: 'contract' | 'field'; planned_desc: string | null; actual_desc: string | null; coordinate: string | null; remark: string | null; created_at: string }
export type AttachEntityType = 'record' | 'handover' | 'pretreatment' | 'qc' | 'system_record' | 'round' | 'round_sheet' | 'report' | 'delivery'
export type Attachment = { id: string; entity_type: string; entity_id: string; orig_name: string; stored_name: string; mime: string | null; size: number | null; who: string; username: string | null; at: string; deleted_at: string | null; deleted_by: string | null }
export const HANDOVER_ACTIONS = ['采样交接', '接样入库', '流转领用', '归还', '留样', '处置']
export type QcRecord = { id: number; qc_type: string; round_id: string | null; sample_id: string | null; analyte: string | null; data: any; unit: string | null; result: number | null; verdict: string | null; criterion: string | null; note: string | null; who: string; username: string | null; at: string }
export const QC_TYPES = ['密码样', '平行样', '加标回收', '空白']
// 常用计量单位目录：³ ² μ 这些符号键盘打不出来，各处单位输入统一从这里选（可搜索、也可手打自定义）
export const UNIT_OPTS = [
  'mg/L', 'μg/L', 'g/L', 'ng/L',
  'mg/m³', 'μg/m³', 'g/m³', 'mg/Nm³',
  'mg/kg', 'μg/kg', 'g/kg',
  'dB(A)', '℃', '%', 'μS/cm', 'CFU/mL', 'MPN/L', '个/L', 'Bq/L', 'pH(无量纲)', '无量纲',
]
export type Pretreatment = { id: number; sample_id: string; method: string; reagent: string | null; condition: string | null; vol_final: string | null; note: string | null; who: string; username: string | null; at: string }
export const PRETREAT_METHODS = ['微波消解', '电热板消解', '萃取', '浓缩', '过滤', '定容', '其他']
export type SystemRecord = { id: number; category: string; title: string; rec_date: string | null; owner: string | null; status: string; content: string | null; result: string | null; note: string | null; who: string; username: string | null; at: string; updated_at: string | null }
export const SYSREC_CATEGORIES = ['内部审核', '管理评审', '人员培训', '文件受控', '监督检查', '期间核查', '检定校准计划', '能力验证', '供应商评价', '不符合与纠正', '其他']
export const SYSREC_STATUS = ['计划中', '进行中', '已完成']
export type Subcontract = { id: number; contract_id: string | null; items: string | null; subcontractor: string; qualification: string | null; reason: string | null; consent: number; status: string; result_note: string | null; note: string | null; who: string; username: string | null; at: string; updated_at: string | null }
export const SUBCONTRACT_STATUS = ['计划中', '已分包', '结果已核']
export type StatsOverview = {
  contracts: { total: number; accepted: number }
  samples: { total: number; pending: number; month: number }
  reports: { total: number; draft: number; checked: number; issued: number; monthIssued: number; exceed: number }
  qc: { total: number; pass: number; rate: number | null }
  system: { audit: boolean; review: boolean; train: boolean }
  resource: { alerts: number; overdue: number }
}
export type Project = { contract: Contract; plans: Plan[]; samples: SampleWithRecords[]; reports: Report[]; stats: ProjectStats; pipeline: Pipeline }

export const api = {
  // 登录 / 人员
  login: async (username: string, password: string) => {
    const { data } = await http.post<{ token: string; user: User }>('/login', { username, password })
    localStorage.setItem('tc_token', data.token); currentUser.value = data.user; refreshRecoveryIdentityBestEffort(data.user.username)
    return data.user
  },
  logout: async () => { try { await http.post('/logout') } catch { /* */ } finally { try { localStorage.removeItem('tc_token') } catch { /* */ }; currentUser.value = null; publishAuthLogout(); await Promise.resolve(clearRecoveryIdentity()).catch(() => undefined) } },
  me: async () => { const { data } = await http.get<User | null>('/me'); currentUser.value = data; if (data) refreshRecoveryIdentityBestEffort(data.username); return data },
  listUsers: () => http.get<User[]>('/users').then(r => r.data),
  listUserQualifications: (username: string) => http.get<UserQualification[]>(`/users/${encodeURIComponent(username)}/qualifications`).then(r => r.data),
  setUserQualifications: (username: string, qualifications: QualificationInput[]) =>
    http.post<UserQualification[]>(`/users/${encodeURIComponent(username)}/qualifications`, { qualifications }).then(r => r.data),
  updateUserPersonnel: (username: string, body: { name: string; roles: string[]; qualifications: QualificationInput[] }) =>
    http.post<{ user: User; qualifications: UserQualification[] }>(`/users/${encodeURIComponent(username)}/personnel`, body).then(r => r.data),
  createUser: (b: { username: string; name: string; roles: string[]; password: string }) => http.post<User>('/users', b).then(r => r.data),
  updateUser: (username: string, b: { name?: string; roles?: string[]; status?: string; certName?: string; certUntil?: string }) => http.post<User>(`/users/${encodeURIComponent(username)}/update`, b).then(r => r.data),
  resetPassword: (username: string, password: string) => http.post(`/users/${encodeURIComponent(username)}/reset-pw`, { password }).then(r => r.data),
  changePassword: (oldPassword: string, newPassword: string) => http.post('/change-password', { oldPassword, newPassword }).then(r => r.data),
  getWorkflow: (subjectType: WorkflowSubjectType, subjectId: string) =>
    http.get<WorkflowView | null>(`/workflows/${subjectType}/${encodeURIComponent(subjectId)}`).then(r => r.data),
  listWorkflowTasks: (scope: ProfessionalScope) =>
    http.get<WorkflowTask[]>(`/workflow-tasks/${scope}`).then(r => r.data),
  submitWorkflow: (subjectType: WorkflowSubjectType, subjectId: string) =>
    http.post<WorkflowInstance>(`/workflows/${subjectType}/${encodeURIComponent(subjectId)}/submit`, {}).then(r => r.data),
  decideWorkflow: (instanceId: string, input: { revision: number; level: WorkflowDecisionLevel; decision: WorkflowDecision; comment?: string }) =>
    http.post<WorkflowInstance>(`/workflows/${encodeURIComponent(instanceId)}/decide`, input).then(r => r.data),
  withdrawWorkflow: (instanceId: string, reason: string) =>
    http.post<{ workflow: WorkflowInstance; invalidation: { invalidatedArchiveIds: string[]; blockedReportIds: string[]; reissueRequiredReportIds: string[] } }>(`/workflows/${encodeURIComponent(instanceId)}/withdraw`, { reason }).then(r => r.data),
  listWorkflowAssignments: (contractId: string) =>
    http.get<WorkflowAssignment[]>(`/contracts/${encodeURIComponent(contractId)}/workflow-assignments`).then(r => r.data),
  listWorkflowCandidates: (contractId: string, scope: ProfessionalScope, level: WorkflowDecisionLevel, at: string) =>
    http.get<WorkflowCandidate[]>(`/contracts/${encodeURIComponent(contractId)}/workflow-candidates`, { params: { scope, level, at } }).then(r => r.data),
  setWorkflowAssignment: (contractId: string, scope: ProfessionalScope, input: { reviewerUsername: string; approverUsername: string; reason?: string }) =>
    http.post<WorkflowAssignment>(`/contracts/${encodeURIComponent(contractId)}/workflow-assignments/${scope}`, input).then(r => r.data),
  getArchiveReadiness: (contractId: string, reportBatchId?: string) =>
    http.get<ArchiveReadiness>(`/contracts/${encodeURIComponent(contractId)}/archive-readiness`, { params: reportBatchId ? { reportBatchId } : {} }).then(r => r.data),
  buildArchivePackage: (contractId: string, reportBatchId?: string) =>
    http.post<ArchivePackage>(`/contracts/${encodeURIComponent(contractId)}/archive-packages`, { reportBatchId }).then(r => r.data),
  getArchivePackage: (id: string) => http.get<ArchivePackage>(`/archive-packages/${encodeURIComponent(id)}`).then(r => r.data),
  listArchivePackages: (filter: { contractId?: string; status?: ArchivePackage['status'] } = {}) =>
    http.get<ArchivePackage[]>('/archive-packages', { params: filter }).then(r => r.data),
  confirmArchivePackage: (id: string) => http.post<ArchivePackage>(`/archive-packages/${encodeURIComponent(id)}/confirm`, {}).then(r => r.data),
  createReportBatch: (input: { contractId: string; name: string; roundIds: string[] }) =>
    http.post<ReportBatch>('/report-batches', input).then(r => r.data),
  listReportBatches: (contractId?: string) =>
    http.get<ReportBatch[]>('/report-batches', { params: contractId ? { contractId } : {} }).then(r => r.data),
  getQualityPlan: (roundId: string) => http.get<QualityPlan | null>(`/rounds/${encodeURIComponent(roundId)}/quality-plan`).then(r => r.data),
  saveQualityPlan: (roundId: string, adjustments: QualityPlanRequirement[]) =>
    http.post<QualityPlan>(`/rounds/${encodeURIComponent(roundId)}/quality-plan`, { adjustments }).then(r => r.data),

  createSample: (b: { client?: string; matrix: string; items?: string[]; note?: string }) =>
    http.post<Sample>('/samples', b).then(r => r.data),
  listSamples: (status?: string) =>
    http.get<Sample[]>('/samples', { params: status ? { status } : {} }).then(r => r.data),
  getSample: (id: string) => http.get<Sample>(`/samples/${id}`).then(r => r.data),
  listHandovers: (id: string) => http.get<Handover[]>(`/samples/${encodeURIComponent(id)}/handovers`).then(r => r.data),
  listPendingHandovers: () => http.get<(Handover & { client: string | null })[]>('/handovers/pending').then(r => r.data),
  // 检测任务派工（qc 派 → tester 干）
  listTasks: (f: { sampleId?: string; assignee?: string } = {}) => {
    const q = new URLSearchParams()
    if (f.sampleId) q.set('sampleId', f.sampleId)
    if (f.assignee) q.set('assignee', f.assignee)
    return http.get<TestTask[]>('/tasks?' + q.toString()).then(r => r.data)
  },
  assignTasks: (sampleId: string, items: { analyte: string; assignee: string; assigneeUsername?: string }[]) =>
    http.post<TestTask[]>(`/samples/${encodeURIComponent(sampleId)}/tasks`, { items }).then(r => r.data),
  listTesters: () => http.get<{ username: string; name: string }[]>('/users/testers').then(r => r.data),
  // 合同修改（决策8：可改+字段级留痕）
  updateContract: (id: string, patch: ContractUpdatePatch) =>
    http.post<{ contract: any; changes: any[]; reschedule?: { rescheduled: number; manual: number } }>(`/contracts/${id}/update`, patch).then(r => r.data),
  // 点位档案（决策1）
  listContractPoints: (cid: string) => http.get<MonitoringPoint[]>(`/contracts/${cid}/points`).then(r => r.data),
  addFieldPoint: (cid: string, b: { name: string; matrix?: string; actualDesc?: string; remark?: string }) =>
    http.post<MonitoringPoint>(`/contracts/${cid}/points`, b).then(r => r.data),
  setPointActual: (pid: number, actualDesc: string) => http.post<MonitoringPoint>(`/points/${pid}/actual`, { actualDesc }).then(r => r.data),
  // 两人采样双确认（§8.3）
  confirmRoundField: (roundId: string) => http.post(`/rounds/${roundId}/confirm-field`, {}).then(r => r.data),
  // 采样日期人工微调（不用谎报采不成）
  adjustRoundDue: (roundId: string, dueDate: string) => http.post(`/rounds/${roundId}/adjust-due`, { dueDate }).then(r => r.data),
  // 报告退回编制（§8.1：审核后不许静默改，要改先退回）
  rejectReport: (id: string, reason: string) => http.post<Report>(`/reports/${id}/reject`, { reason }).then(r => r.data),
  // 合同到期提醒（§9）
  contractAlerts: () => http.get<{ id: string; client: string; project: string; period_end: string; bucket: string }[]>('/contract-alerts').then(r => r.data),
  // 报告作废重出 + 合同总报告（决策17）
  voidReport: (id: string, reason: string) => http.post<Report>(`/reports/${id}/void`, { reason }).then(r => r.data),
  // 删除报告草稿（仅 draft/checked，签发过的走作废）
  deleteReport: (id: string) => http.post(`/reports/${id}/delete`, {}).then(r => r.data),
  generateContractReport: (contractId: string, archivePackageId: string) => http.post<Report>('/reports/generate-contract', { contractId, archivePackageId }).then(r => r.data),
  // 阶段 8：跨合同同表批量录入
  saveRecordsBatch: (b: { code: string; name?: string; sheetType?: string; method?: string; analyte?: string; matrix?: string; instrumentId?: string; sharedMeta?: Record<string, any>; reg?: Record<string, any>; entries: { sampleId: string; row: Record<string, any>; resultSummary?: any }[]; submit?: boolean }) =>
    http.post<RecordRow[]>('/records/batch', b).then(r => r.data),
  addHandover: (id: string, b: { action: string; fromPerson?: string; toPerson?: string; condition?: string; note?: string }) => http.post<Handover>(`/samples/${encodeURIComponent(id)}/handover`, b).then(r => r.data),
  confirmHandover: (handoverId: number) => http.post<Handover>(`/handovers/${handoverId}/confirm`, {}).then(r => r.data),
  // 交接单（批次一）：收样自动草稿→采样员改/发出→样品管理员整单签收（可拒收个别样品）
  listHandoverSheets: (f: { roundId?: string; status?: string } = {}) => http.get<HandoverSheet[]>('/handover-sheets', { params: f }).then(r => r.data),
  updateHandoverSheet: (id: string, b: { detail?: HandoverSheetRow[]; storage?: string; note?: string; fromPerson?: string }) => http.post<HandoverSheet>(`/handover-sheets/${encodeURIComponent(id)}/update`, b).then(r => r.data),
  sendHandoverSheet: (id: string) => http.post<HandoverSheet>(`/handover-sheets/${encodeURIComponent(id)}/send`, {}).then(r => r.data),
  confirmHandoverSheet: (id: string, rejects: { sampleId: string; reason: string }[] = []) => http.post<HandoverSheet>(`/handover-sheets/${encodeURIComponent(id)}/confirm`, { rejects }).then(r => r.data),
  getHandoverSheet: (id: string) => http.get<HandoverSheet>(`/handover-sheets/${encodeURIComponent(id)}`).then(r => r.data),
  // 检测任务通知单 HJ-TC-137 + 解密单 149
  listTestNotices: (f: { status?: string; roundId?: string } = {}) => http.get<TestNotice[]>('/test-notices', { params: f }).then(r => r.data),
  getTestNotice: (id: string) => http.get<TestNotice>(`/test-notices/${encodeURIComponent(id)}`).then(r => r.data),
  createNoticeFromSheet: (sheetId: string) => http.post<TestNotice>(`/handover-sheets/${encodeURIComponent(sheetId)}/notice`, {}).then(r => r.data),
  updateTestNotice: (id: string, b: { dueAt?: string; note?: string; nature?: string; source?: string; dept?: string; category?: string }) => http.post<TestNotice>(`/test-notices/${encodeURIComponent(id)}/update`, b).then(r => r.data),
  issueTestNotice: (id: string) => http.post<TestNotice>(`/test-notices/${encodeURIComponent(id)}/issue`, {}).then(r => r.data),
  decodeNotice: (id: string) => http.get<NoticeDecodeRow[]>(`/test-notices/${encodeURIComponent(id)}/decode`).then(r => r.data),
  claimTask: (taskId: number) => http.post<TestTask>(`/tasks/${taskId}/claim`, {}).then(r => r.data),
  cancelTask: (taskId: number, reason: string) => http.post(`/tasks/${taskId}/cancel`, { reason }).then(r => r.data),
  withdrawRecord: (id: string) => http.post<RecordRow>(`/records/${encodeURIComponent(id)}/withdraw`, {}).then(r => r.data),
  unclaimTask: (taskId: number) => http.post(`/tasks/${taskId}/unclaim`, {}).then(r => r.data),
  revokeNotice: (id: string, reason: string) => http.post(`/test-notices/${encodeURIComponent(id)}/revoke`, { reason }).then(r => r.data),
  statsYearly: (year?: number) => http.get(`/stats/yearly`, { params: { year } }).then(r => r.data),
  resampleSample: (id: string) => http.post<{ sample: Sample; sheet: HandoverSheet }>(`/samples/${encodeURIComponent(id)}/resample`, {}).then(r => r.data),
  // 批次三：发放登记 / 归档清单 / 留样处置
  addReportDelivery: (id: string, b: { copies?: number; method?: string; receiver?: string; note?: string }) => http.post(`/reports/${id}/deliver`, b).then(r => r.data),
  listReportDeliveries: (id: string) => http.get<any[]>(`/reports/${id}/deliveries`).then(r => r.data),
  archiveIndex: (id: string) => http.get<{ section: string; items: { type: string; id: string; label: string }[] }[]>(`/reports/${id}/archive-index`).then(r => r.data),
  setRetention: (sampleId: string, b: { location: string; until?: string; note?: string }) => http.post(`/samples/${encodeURIComponent(sampleId)}/retention`, b).then(r => r.data),
  disposeRetention: (sampleId: string, b: { method: string; note?: string }) => http.post(`/samples/${encodeURIComponent(sampleId)}/retention/dispose`, b).then(r => r.data),
  getRetention: (sampleId: string) => http.get<any>(`/samples/${encodeURIComponent(sampleId)}/retention`).then(r => r.data),
  techReviewContract: (id: string, decision: 'approve' | 'reject', note = '') => http.post<Contract>(`/contracts/${encodeURIComponent(id)}/tech-review`, { decision, note }).then(r => r.data),
  findReportsBySample: (sampleId: string) => http.get<Report[]>(`/samples/${encodeURIComponent(sampleId)}/reports`).then(r => r.data),
  getReport: (id: string) => http.get<Report>(`/reports/${encodeURIComponent(id)}`).then(r => r.data),
  getOrgProfile: () => http.get<OrgProfile>('/org-profile').then(r => r.data),
  updateOrgProfile: (b: Partial<Omit<OrgProfile, 'id'>>) => http.post<OrgProfile>('/org-profile', b).then(r => r.data),
  listUnclaimedTasks: () => http.get<TestTask[]>('/tasks', { params: { unclaimed: '1' } }).then(r => r.data),
  listPretreatments: (id: string) => http.get<Pretreatment[]>(`/samples/${encodeURIComponent(id)}/pretreatments`).then(r => r.data),
  addPretreatment: (id: string, b: { method: string; reagent?: string; condition?: string; volFinal?: string; note?: string }) => http.post<Pretreatment>(`/samples/${encodeURIComponent(id)}/pretreatment`, b).then(r => r.data),

  getRecord: (sampleId: string, code: string) =>
    http.get<RecordRow | null>('/records', { params: { sampleId, code } }).then(r => r.data),
  saveRecord: (b: {
    sampleId: string; code: string; name?: string; sheetType?: string
    method?: string; analyte?: string; matrix?: string; instrumentId?: string
    data: RecordData; submit?: boolean
    baseUpdatedAt?: string   // 乐观锁基线：打开时的 updated_at
  }) => http.post<RecordRow>('/records', b).then(r => r.data),
  getAudit: (recordId: string) => http.get<Audit[]>(`/records/${recordId}/audit`).then(r => r.data),
  // 任意实体的操作留痕（合同/期次/报告/样品/点位…）——记录以外的留痕以前没界面能查
  listAudit: (entityId: string) => http.get<Audit[]>(`/audit/${encodeURIComponent(entityId)}`).then(r => r.data),

  createContract: (b: {
    client: string; contact?: string; phone?: string; project?: string; note?: string
    cycleMonths?: number; periodStart?: string; periodEnd?: string
    plan?: { matrix: string; items?: string[]; qty?: number; cycleMonths?: number; note?: string }[]
    quote?: { extNo?: string; signDate?: string; invoice?: string; discount?: number; buyer?: QuoteBuyer; rows: QuoteRow[] }
    review?: ContractReview
  }) => http.post<Contract>('/contracts', b).then(r => r.data),
  saveContractQuote: (id: string, b: { extNo?: string; signDate?: string; invoice?: string; discount?: number; buyer?: QuoteBuyer; rows: QuoteRow[] }) =>
    http.post<Contract>(`/contracts/${id}/quote`, b).then(r => r.data),
  listContracts: () => http.get<Contract[]>('/contracts').then(r => r.data),
  getContract: (id: string) => http.get<Contract>(`/contracts/${id}`).then(r => r.data),
  // 合同终止（只对已确认的合同）：中途不做了，留原因、留痕
  terminateContract: (id: string, reason: string) => http.post<Contract>(`/contracts/${id}/terminate`, { reason }).then(r => r.data),
  // 后端新版返回 { samples, hint }（hint=生成后的下一步指引）；老版直接返回数组，两种都兼容
  generateSamples: (id: string) => http.post<Sample[] | { samples: Sample[]; hint?: string }>(`/contracts/${id}/generate`).then(r => r.data),
  acceptContract: (id: string, review?: ContractReview) => http.post<Contract>(`/contracts/${id}/accept`, { review }).then(r => r.data),
  getScheme: (id: string) => http.get<Scheme | null>(`/contracts/${id}/scheme`).then(r => r.data),
  saveScheme: (id: string, b: { points: SchemePoint[]; limits?: LimitRule[]; cycleMonths?: number; periodStart?: string; periodEnd?: string; urgent?: boolean }) =>
    http.post<Scheme>(`/contracts/${id}/scheme`, b).then(r => r.data),
  reviewScheme: (id: string, op: 'approve' | 'reject', who?: string, comment?: string) =>
    http.post<Scheme>(`/contracts/${id}/scheme/review`, { op, who, comment }).then(r => r.data),
  listRounds: (id: string) => http.get<Round[]>(`/contracts/${id}/rounds`).then(r => r.data),
  dueRounds: () => http.get<DueRound[]>('/rounds/due').then(r => r.data),
  listAllRounds: () => http.get<DueRound[]>('/rounds').then(r => r.data),
  getRoundDetail: (roundId: string) => http.get<RoundDetail>(`/rounds/${roundId}/detail`).then(r => r.data),
  getOfflineTaskPackage: (roundId: string) => http.get<OfflineTaskPackage>(`/rounds/${encodeURIComponent(roundId)}/offline-package`).then(r => r.data),
  stageRoundAttachment: (roundId: string, sampleSlotId: string, metadata: { attachmentId: string; hash: string; size: number; revision: number }, file: Blob, proof: { nonce:string; issuedAt:string; signature:string;taskVersion:string;ruleVersion:string }) =>
    http.post<{ receiptId: string; status: string; leaseExpiresAt: string; hash: string }>(`/rounds/${encodeURIComponent(roundId)}/staged-attachments`, file, { headers: {
      'Content-Type': file.type || 'application/octet-stream', 'X-Client-Attachment-Id': metadata.attachmentId,
      'X-Sample-Slot-Id': encodeURIComponent(sampleSlotId), 'X-Content-Sha256': metadata.hash,
      'X-Content-Size': String(metadata.size), 'X-Content-Revision': String(metadata.revision),
      'X-Device-Nonce': proof.nonce, 'X-Device-Issued-At': proof.issuedAt, 'X-Device-Signature': proof.signature,
      'X-Task-Version':proof.taskVersion,'X-Rule-Version':proof.ruleVersion,
    }, timeout: 120_000 }).then(r => r.data),
  getStagedRoundAttachment: (roundId: string, attachmentId: string, proof: { nonce:string; issuedAt:string; signature:string;taskVersion:string;ruleVersion:string }) => http.get(`/rounds/${encodeURIComponent(roundId)}/staged-attachments/${encodeURIComponent(attachmentId)}`, { headers: { 'X-Device-Nonce':proof.nonce,'X-Device-Issued-At':proof.issuedAt,'X-Device-Signature':proof.signature,'X-Task-Version':proof.taskVersion,'X-Rule-Version':proof.ruleVersion } }).then(r => r.data),
  cancelStagedRoundAttachment: (roundId: string, attachmentId: string, proof: { nonce:string; issuedAt:string; signature:string;taskVersion:string;ruleVersion:string }) => http.post(`/rounds/${encodeURIComponent(roundId)}/staged-attachments/${encodeURIComponent(attachmentId)}?action=cancel`, undefined, { headers: { 'X-Device-Nonce':proof.nonce,'X-Device-Issued-At':proof.issuedAt,'X-Device-Signature':proof.signature,'X-Task-Version':proof.taskVersion,'X-Rule-Version':proof.ruleVersion } }).then(r => r.data),
  createMobileSubmission: (roundId:string, body:Pick<LocalSubmission,'clientSubmissionId'|'taskVersion'|'ruleVersion'|'draftRevision'|'canonicalPayload'|'payloadHash'|'attachmentReceipts'>, proof:{nonce:string;issuedAt:string;signature:string;taskVersion:string;ruleVersion:string}) => http.post<SubmissionReceipt>(`/rounds/${encodeURIComponent(roundId)}/mobile-submissions`,body,{headers:{'X-Device-Nonce':proof.nonce,'X-Device-Issued-At':proof.issuedAt,'X-Device-Signature':proof.signature,'X-Task-Version':proof.taskVersion,'X-Rule-Version':proof.ruleVersion,'X-Content-Revision':String(body.draftRevision)}}).then(r=>r.data),
  getMobileSubmission: (clientSubmissionId:string) => http.get<SubmissionReceipt>(`/mobile-submissions/${encodeURIComponent(clientSubmissionId)}`).then(r=>r.data),
  getMobileConfirmation: (roundId:string) => http.get<any>(`/rounds/${encodeURIComponent(roundId)}/mobile-confirmation`).then(r=>r.data),
  confirmMobileSubmission: (clientSubmissionId:string,password:string,draftRevision:number,proof:{nonce:string;issuedAt:string;signature:string;taskVersion:string;ruleVersion:string}) => http.post<any>(`/mobile-submissions/${encodeURIComponent(clientSubmissionId)}/confirm`,{password},{headers:{'X-Device-Nonce':proof.nonce,'X-Device-Issued-At':proof.issuedAt,'X-Device-Signature':proof.signature,'X-Task-Version':proof.taskVersion,'X-Rule-Version':proof.ruleVersion,'X-Content-Revision':String(draftRevision)}}).then(r=>r.data),
  issueMobileConfirmationInvite: (clientSubmissionId:string,intendedConfirmerId:string,draftRevision:number,proof:{nonce:string;issuedAt:string;signature:string;taskVersion:string;ruleVersion:string}) => http.post<any>(`/mobile-submissions/${encodeURIComponent(clientSubmissionId)}/confirmation-invites`,{intendedConfirmerId},{headers:{'X-Device-Nonce':proof.nonce,'X-Device-Issued-At':proof.issuedAt,'X-Device-Signature':proof.signature,'X-Task-Version':proof.taskVersion,'X-Rule-Version':proof.ruleVersion,'X-Content-Revision':String(draftRevision)}}).then(r=>r.data),
  claimMobileConfirmationInvite:(qrPayload:string)=>http.post<any>('/mobile-confirmation-invites/claim',{qrPayload}).then(r=>r.data),
  getMobileConfirmationClaim:(claimId:string)=>http.get<any>(`/mobile-confirmation-claims/${encodeURIComponent(claimId)}`).then(r=>r.data),
  confirmMobileConfirmationClaim:(claimId:string,password:string,draftRevision:number,proof:{nonce:string;issuedAt:string;signature:string;taskVersion:string;ruleVersion:string})=>http.post<any>(`/mobile-confirmation-claims/${encodeURIComponent(claimId)}/confirm`,{password},{headers:{'X-Device-Nonce':proof.nonce,'X-Device-Issued-At':proof.issuedAt,'X-Device-Signature':proof.signature,'X-Task-Version':proof.taskVersion,'X-Rule-Version':proof.ruleVersion,'X-Content-Revision':String(draftRevision)}}).then(r=>r.data),
  assignRound: (roundId: string, samplerIds: string[], planDate?: string) => http.post<Round>(`/rounds/${roundId}/assign`, { samplerIds, planDate }).then(r => r.data),
  roundQcReqs: (roundId: string) => http.get<QcRequirement[]>(`/rounds/${roundId}/qc-requirements`).then(r => r.data),
  saveRoundField: (roundId: string, info: FieldInfo) => http.post<Round>(`/rounds/${roundId}/field`, info).then(r => r.data),
  // 期次现场表单：采样员现场按精确版式填的采样原始记录（一期一表号一份）
  getRoundSheet: (roundId: string, code: string) => http.get<{ data: any; who: string; updated_at: string } | null>(`/rounds/${roundId}/sheets/${encodeURIComponent(code)}`).then(r => r.data),
  // 新协议 {data, baseUpdatedAt}：乐观锁，两人同填一张采样单后存的会被拦而不是覆盖
  saveRoundSheet: (roundId: string, code: string, data: any, baseUpdatedAt = '') =>
    http.post(`/rounds/${roundId}/sheets/${encodeURIComponent(code)}`, { data, baseUpdatedAt }).then(r => r.data),
  failRound: (roundId: string, reason: string) => http.post<Round>(`/rounds/${roundId}/fail`, { reason }).then(r => r.data),
  rescheduleRound: (roundId: string, dueDate: string) => http.post<Round>(`/rounds/${roundId}/reschedule`, { dueDate }).then(r => r.data),
  // 期次终止（只对未采成的期次）：客户不做了/整改停产等，不再补采，留原因
  cancelRound: (roundId: string, reason: string) => http.post<Round>(`/rounds/${roundId}/cancel`, { reason }).then(r => r.data),
  listRoundQc: (roundId: string) => http.get<QcRecord[]>(`/rounds/${roundId}/qc`).then(r => r.data),
  addRoundQc: (roundId: string, b: Record<string, any>) => http.post<QcRecord>(`/rounds/${roundId}/qc`, b).then(r => r.data),
  sampleRound: (roundId: string) => http.post<Sample[]>(`/rounds/${roundId}/sample`).then(r => r.data),
  generateRoundReport: (roundId: string, archivePackageId: string) => http.post<Report>('/reports/generate-round', { roundId, archivePackageId }).then(r => r.data),
  listProjects: () => http.get<ProjectSummary[]>('/projects').then(r => r.data),
  getProject: (id: string) => http.get<Project>(`/projects/${id}`).then(r => r.data),
  uploadContractDoc: (id: string, file: File) =>
    // 上传超时单独放宽：现场手机流量传文件 8 秒根本不够
    http.post(`/contracts/${id}/doc?name=${encodeURIComponent(file.name)}`, file, { headers: { 'Content-Type': file.type || 'application/octet-stream' }, timeout: 120_000 }).then(r => r.data),
  // 合同原件直链：iframe/新标签带不了鉴权头，和附件一样走后端白名单放行的 ?token=
  contractDocUrl: (id: string) => `/api/contracts/${id}/doc?token=${getToken()}&t=${Date.now()}`,

  listRecordsByStatus: (status?: string) => http.get<RecordRow[]>('/records-list', { params: status ? { status } : {} }).then(r => r.data),
  reviewRecord: (id: string, op: string, who?: string, comment?: string) =>
    http.post<RecordRow>(`/records/${id}/review`, { op, who, comment }).then(r => r.data),
  // 已定稿记录打回重录（按实验室专业权限；进了已签发报告的后端会拦）
  revokeRecord: (id: string, reason: string) =>
    http.post<RecordRow>(`/records/${id}/review`, { action: 'revoke', reason }).then(r => r.data),
  flagRecheck: (id: string, reason: string, flag = true) =>
    http.post<RecordRow>(`/records/${id}/recheck`, { reason, flag }).then(r => r.data),
  listCustomers: () => http.get<Customer[]>('/customers').then(r => r.data),
  upsertCustomer: (b: { name: string; contact?: string; phone?: string; address?: string; note?: string }) => http.post<Customer>('/customers', b).then(r => r.data),
  customerContracts: (name: string) => http.get<Contract[]>(`/customers/${encodeURIComponent(name)}/contracts`).then(r => r.data),

  // 派工下拉选人：在职采样员/技术负责人
  listSamplers: () => http.get<{ username: string; name: string }[]>('/users/samplers').then(r => r.data),

  listInstruments: () => http.get<Instrument[]>('/instruments').then(r => r.data),
  createInstrument: (b: { id: string; name: string; model?: string; note?: string; certUntil?: string; certNo?: string; status?: string }) => http.post<Instrument>('/instruments', b).then(r => r.data),
  listCheckouts: (open = false) => http.get<Checkout[]>('/checkouts', { params: open ? { open: '1' } : {} }).then(r => r.data),
  checkoutInstrument: (id: string, takenBy?: string, roundId?: string) => http.post<Checkout>(`/instruments/${encodeURIComponent(id)}/checkout`, { takenBy, roundId }).then(r => r.data),
  returnInstrument: (checkoutId: number) => http.post<Checkout>(`/checkouts/${checkoutId}/return`, {}).then(r => r.data),
  listRefMaterials: () => http.get<RefMaterial[]>('/ref-materials').then(r => r.data),
  createRefMaterial: (b: Partial<RefMaterial> & { id: string; name: string }) => http.post<RefMaterial>('/ref-materials', b).then(r => r.data),
  deleteRefMaterial: (id: string) => http.post(`/ref-materials/${encodeURIComponent(id)}/delete`).then(r => r.data),
  listReagents: () => http.get<Reagent[]>('/reagents').then(r => r.data),
  createReagent: (b: Partial<Reagent> & { id: string; name: string }) => http.post<Reagent>('/reagents', b).then(r => r.data),
  deleteReagent: (id: string) => http.post(`/reagents/${encodeURIComponent(id)}/delete`).then(r => r.data),
  resourceAlerts: () => http.get<ResourceAlert[]>('/resource-alerts').then(r => r.data),

  listReports: () => http.get<Report[]>('/reports').then(r => r.data),
  generateReport: (sampleId: string, archivePackageId: string) => http.post<Report>('/reports/generate', { sampleId, archivePackageId }).then(r => r.data),
  checkReport: (id: string) => http.post<Report>(`/reports/${id}/check`).then(r => r.data),
  issueReport: (id: string, issuer?: string) => http.post<Report>(`/reports/${id}/issue`, { issuer }).then(r => r.data),
  updateReport: (id: string, b: { title?: string; conclusion?: string }) => http.post<Report>(`/reports/${id}/update`, b).then(r => r.data),

  statsOverview: () => http.get<StatsOverview>('/stats/overview').then(r => r.data),
  listSubcontracts: (contractId?: string) => http.get<Subcontract[]>('/subcontracts', { params: contractId ? { contractId } : {} }).then(r => r.data),
  addSubcontract: (b: { contractId?: string; items?: string; subcontractor: string; qualification?: string; reason?: string; consent?: boolean; status?: string; note?: string }) => http.post<Subcontract>('/subcontracts', b).then(r => r.data),
  updateSubcontract: (id: number, b: { items?: string; subcontractor?: string; qualification?: string; reason?: string; consent?: boolean; status?: string; resultNote?: string; note?: string }) => http.post<Subcontract>(`/subcontracts/${id}/update`, b).then(r => r.data),
  listSystemRecords: (category?: string) => http.get<SystemRecord[]>('/system-records', { params: category ? { category } : {} }).then(r => r.data),
  addSystemRecord: (b: { category: string; title: string; recDate?: string; owner?: string; status?: string; content?: string; result?: string; note?: string }) => http.post<SystemRecord>('/system-records', b).then(r => r.data),
  updateSystemRecord: (id: number, b: { title?: string; recDate?: string; owner?: string; status?: string; content?: string; result?: string; note?: string }) => http.post<SystemRecord>(`/system-records/${id}/update`, b).then(r => r.data),

  // —— 记录附件（照片/小票，选传不强制）——
  listAttachments: (type: AttachEntityType, id: string | number) => http.get<Attachment[]>(`/attachments/${type}/${id}`).then(r => r.data),
  uploadAttachment: (type: AttachEntityType, id: string | number, file: File) =>
    http.post<{ ok: boolean; id: string; orig_name: string }>(`/attachments/${type}/${id}?name=${encodeURIComponent(file.name)}`, file, { headers: { 'Content-Type': file.type || 'application/octet-stream' }, timeout: 120_000 }).then(r => r.data),
  deleteAttachment: (aid: string) => http.post(`/attachments/${encodeURIComponent(aid)}/delete`).then(r => r.data),
  // 图片/PDF 直链：img/iframe 带不了鉴权头，用后端支持的 ?token=
  attachmentUrl: (aid: string) => `/api/attachments/file/${aid}?token=${getToken()}`,
}
