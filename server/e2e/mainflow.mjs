// 十阶段端到端串测：真实 HTTP 服务、真实 SQLite 文件、全程分岗，不用 admin 代办业务动作。
// 覆盖唯一项目编号、专业资格/指派、采样与报告退回重提、资格账号待办、精确归档和永久回执。
const B = `http://127.0.0.1:${process.env.E2E_PORT || 3997}/api`
const TOKENS = new Map()
const TEN_STAGE_LABELS = [
  '① 编制委托合同', '② 合同评审', '③ 编制监测方案', '④ 采样指派', '⑤ 现场采样',
  '⑥ 样品交接', '⑦ 质控', '⑧ 实验室分析', '⑨ 1–8 档案归档', '⑩ 出具报告',
]

function assert(condition, message) { if (!condition) throw new Error(message) }
function ok(message) { console.log('  ✔', message) }

async function request(who, method, path, body) {
  const token = TOKENS.get(who)
  const response = await fetch(B + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { response, payload: await response.json().catch(() => null) }
}

async function call(who, method, path, body) {
  const { response, payload } = await request(who, method, path, body)
  if (!response.ok) throw new Error(`[${who}] ${method} ${path} → ${response.status} ${payload?.error || ''} ${payload?.error_code || ''}`.trim())
  return payload
}

async function expectFailure(who, method, path, body, expected) {
  const { response, payload } = await request(who, method, path, body)
  const detail = `${response.status} ${payload?.error || ''} ${payload?.error_code || ''}`
  assert(!response.ok, `预期失败却成功：[${who}] ${method} ${path}`)
  assert(expected.test(detail), `失败信息不符合预期：${detail}`)
}

async function login(username, password) {
  const { response, payload } = await request('', 'POST', '/login', { username, password })
  if (!response.ok || !payload?.token) throw new Error(`登录 ${username} 失败：${response.status} ${payload?.error || ''}`)
  TOKENS.set(username, payload.token)
}

async function activateAccount(username) {
  await login(username, 'init1234')
  await call(username, 'POST', '/change-password', { oldPassword: 'init1234', newPassword: 'Pass1234' })
  await login(username, 'Pass1234')
}

async function projectCheckpoint(who, contractId, stageName) {
  const project = await call(who, 'GET', `/projects/${encodeURIComponent(contractId)}`)
  assert(project?.contract?.id === contractId && JSON.stringify(project).includes(contractId), `${stageName} 响应缺少唯一项目编号 ${contractId}`)
  assert(project.pipeline?.stages?.length === 10, `${stageName} 项目进度不是十阶段`)
  assert(JSON.stringify(project.pipeline.stages.map(stage => stage.label)) === JSON.stringify(TEN_STAGE_LABELS), `${stageName} 十阶段顺序不符合规范`)
  ok(`${stageName} · ${contractId} · ${project.pipeline.stages.filter(stage => stage.status === 'done').length}/10 阶段已就绪`)
  return project
}

async function decide(who, workflow, level, decision, comment = '') {
  return call(who, 'POST', `/workflows/${encodeURIComponent(workflow.id)}/decide`, {
    revision: workflow.current_revision, level, decision, comment,
  })
}

async function completeRoundEvidence(contractId, round, index) {
  await call('flow-planner', 'POST', `/rounds/${encodeURIComponent(round.id)}/assign`, {
    samplerIds: ['flow-sampler'], planDate: round.due_date,
  })
  await call('flow-sampler', 'POST', `/rounds/${encodeURIComponent(round.id)}/field`, {
    date: round.due_date, time: `1${index}:00`, weather: '晴', point: '隔离排口',
  })
  await call('flow-sampler', 'POST', `/rounds/${encodeURIComponent(round.id)}/confirm-field`)
  const sampling = await call('flow-sampler', 'POST', `/workflows/round_sampling/${encodeURIComponent(round.id)}/submit`, {})
  await decide('flow-sampling-review', sampling, 'review', 'approve')
  await decide('flow-sampling-approve', sampling, 'approve', 'approve')
  const samples = await call('flow-sampler', 'POST', `/rounds/${encodeURIComponent(round.id)}/sample`, {})
  const sample = samples.find(item => !item.qc_type)
  assert(sample?.contract_id === contractId, `隔离场景第 ${index} 期未生成普通项目样品`)

  const handoverSheets = await call('flow-sampler', 'GET', `/handover-sheets?roundId=${encodeURIComponent(round.id)}`)
  assert(handoverSheets.length === 1, `隔离场景第 ${index} 期交接单数量异常`)
  await call('flow-sampler', 'POST', `/handover-sheets/${encodeURIComponent(handoverSheets[0].id)}/send`, {})
  await call('flow-sample-manager', 'POST', `/handover-sheets/${encodeURIComponent(handoverSheets[0].id)}/confirm`, { rejects: [] })

  await call('flow-quality', 'POST', `/rounds/${encodeURIComponent(round.id)}/quality-plan`, { adjustments: [] })
  const quality = await call('flow-quality', 'POST', `/workflows/quality_plan/${encodeURIComponent(round.id)}/submit`, {})
  await decide('flow-quality-review', quality, 'review', 'approve')
  await decide('flow-quality-approve', quality, 'approve', 'approve')
  await call('flow-quality', 'POST', `/samples/${encodeURIComponent(sample.id)}/tasks`, {
    items: [{ analyte: 'COD', assignee: '孙分析', assigneeUsername: 'flow-analyst' }],
  })

  const record = await call('flow-analyst', 'POST', '/records', {
    sampleId: sample.id, code: `HJ-TC-WD-${index}`, name: `撤回隔离场景第${index}期记录`, analyte: 'COD', matrix: '废水',
    data: { rows: [{ sampleId: sample.id, value: 30 + index }], resultSummary: { analyte: 'COD', value: 30 + index, unit: 'mg/L' } },
    submit: true,
  })
  const laboratory = await call('flow-analyst', 'GET', `/workflows/lab_record/${encodeURIComponent(record.id)}`)
  await decide('flow-lab-review', laboratory, 'review', 'approve')
  await decide('flow-lab-approve', laboratory, 'approve', 'approve')
  return { record, laboratory }
}

// 0. 18 个互不重复的业务参与者。八个专业审核账号不挂基础岗位，用于验证资格专属路由。
await login('demo_admin', '123456')
await call('demo_admin', 'POST', '/change-password', { oldPassword: '123456', newPassword: 'Pass1234' })
await login('demo_admin', 'Pass1234')

const actors = [
  ['flow-sales', '苏业务', ['sales']], ['flow-tech', '田技术', ['tech']],
  ['flow-planner', '潘计划', ['planner']], ['flow-sampler', '赵采样', ['sampler']],
  ['flow-sample-manager', '王样管', ['sample_manager']], ['flow-quality', '吴质控', ['qc']],
  ['flow-sampling-review', '周采样复核', []], ['flow-sampling-approve', '吴采样审核', []],
  ['flow-quality-review', '郑质控复核', []], ['flow-quality-approve', '冯质控审核', []],
  ['flow-lab-review', '陈实验复核', []], ['flow-lab-approve', '褚实验审核', []],
  ['flow-report-review', '卫报告复核', []], ['flow-report-approve', '蒋报告审核', []],
  ['flow-analyst', '孙分析', ['analyst']], ['flow-report-editor', '沈报告', ['report_editor']],
  ['flow-archivist', '韩档案', ['archivist']], ['flow-signer', '杨签字', ['signer']],
]
for (const [username, name, roles] of actors) {
  await call('demo_admin', 'POST', '/users', { username, name, roles, password: 'init1234' })
  await activateAccount(username)
}
const qualificationByUser = {
  'flow-sampling-review': ['sampling_review'], 'flow-sampling-approve': ['sampling_approve'],
  'flow-quality-review': ['quality_review'], 'flow-quality-approve': ['quality_approve'],
  'flow-lab-review': ['laboratory_review'], 'flow-lab-approve': ['laboratory_approve'],
  'flow-report-review': ['report_review'], 'flow-report-approve': ['report_approve'],
}
for (const [username, qualifications] of Object.entries(qualificationByUser)) {
  await call('demo_admin', 'POST', `/users/${username}/qualifications`, { qualifications })
}
ok('18 个独立业务账号、8 项专业资格已就绪')

// 1. 编制委托合同。
const contract = await call('flow-sales', 'POST', '/contracts', {
  client: '十阶段串测环保有限公司', project: '废水例行监测',
  periodStart: '2026-08-22', periodEnd: '2026-08-22',
  plan: [{ matrix: '废水', items: ['COD'], qty: 1 }],
})
const CONTRACT_ID = contract.id
assert(/^WT\d{4}-\d{4}$/.test(CONTRACT_ID), `委托编号格式异常：${CONTRACT_ID}`)
await call('flow-sales', 'POST', `/contracts/${CONTRACT_ID}/accept`, { review: { conclusion: '资料齐全，提交技术评审' } })
await projectCheckpoint('flow-sales', CONTRACT_ID, '① 编制委托合同')

// 2. 合同评审。
const techReviewed = await call('flow-tech', 'POST', `/contracts/${CONTRACT_ID}/tech-review`, { decision: 'approve', note: '技术能力与资源满足' })
assert(techReviewed.id === CONTRACT_ID && techReviewed.tech_review_result === 'approve', '合同评审没有绑定正确项目')
await projectCheckpoint('flow-tech', CONTRACT_ID, '② 合同评审')

// 3. 编制并确认监测方案。
const scheme = await call('flow-planner', 'POST', `/contracts/${CONTRACT_ID}/scheme`, {
  cycleMonths: 0, periodStart: '2026-08-22', periodEnd: '2026-08-22',
  points: [{ element: '废水', point: '1#总排口', items: ['COD'], freq: '每天1次 · 单次', standard: 'GB 8978-1996' }],
})
assert(scheme.contract_id === CONTRACT_ID, '监测方案未贯穿项目编号')
const approvedScheme = await call('flow-tech', 'POST', `/contracts/${CONTRACT_ID}/scheme/review`, { op: 'approve', comment: '方案可执行' })
assert(approvedScheme.contract_id === CONTRACT_ID && approvedScheme.status === 'approved', '方案确认失败')
await projectCheckpoint('flow-planner', CONTRACT_ID, '③ 编制监测方案')

// 4. 指定四专业复核/审核人，再指派采样员。
const assignmentPairs = {
  sampling: ['flow-sampling-review', 'flow-sampling-approve'], quality: ['flow-quality-review', 'flow-quality-approve'],
  laboratory: ['flow-lab-review', 'flow-lab-approve'], report: ['flow-report-review', 'flow-report-approve'],
}
for (const [scope, [reviewerUsername, approverUsername]] of Object.entries(assignmentPairs)) {
  const assignment = await call('flow-planner', 'POST', `/contracts/${CONTRACT_ID}/workflow-assignments/${scope}`, { reviewerUsername, approverUsername })
  assert(assignment.contract_id === CONTRACT_ID && assignment.scope === scope, `${scope} 专业指派未贯穿项目编号`)
}
const rounds = await call('flow-planner', 'GET', `/contracts/${CONTRACT_ID}/rounds`)
assert(rounds.length === 1 && rounds[0].contract_id === CONTRACT_ID, '项目期次生成异常')
const ROUND_ID = rounds[0].id
const assignedRound = await call('flow-planner', 'POST', `/rounds/${ROUND_ID}/assign`, { samplerIds: ['flow-sampler'], planDate: '2026-08-22' })
assert(assignedRound.contract_id === CONTRACT_ID && assignedRound.sampler_ids.includes('flow-sampler'), '采样指派未绑定正确项目/账号')
const reportBatch = await call('flow-planner', 'POST', '/report-batches', { contractId: CONTRACT_ID, name: '唯一期次报告批次', roundIds: [ROUND_ID] })
assert(reportBatch.contract_id === CONTRACT_ID && JSON.stringify(reportBatch.round_ids) === JSON.stringify([ROUND_ID]), '报告批次范围异常')
await projectCheckpoint('flow-planner', CONTRACT_ID, '④ 采样指派')

// 5. 现场采样：复核退回，修改后生成第 2 版并通过。
await call('flow-sampler', 'POST', `/rounds/${ROUND_ID}/field`, { date: '2026-08-22', time: '09:30', weather: '阴', point: '1#总排口' })
await call('flow-sampler', 'POST', `/rounds/${ROUND_ID}/confirm-field`)
const samplingV1 = await call('flow-sampler', 'POST', `/workflows/round_sampling/${ROUND_ID}/submit`, {})
assert(samplingV1.contract_id === CONTRACT_ID && samplingV1.current_revision === 1 && samplingV1.status === 'pending_review', '采样第 1 版提交异常')
const samplingTasks = await call('flow-sampling-review', 'GET', '/workflow-tasks/sampling')
assert(samplingTasks.length === 1 && samplingTasks[0].contract_id === CONTRACT_ID && samplingTasks[0].subject_id === ROUND_ID, '资格专属采样待办范围不精确')
assert(samplingTasks[0].acting_capacity === '采样复核' && Object.keys(samplingTasks[0]).sort().join(',') === 'acting_capacity,contract_id,current_revision,decision_level,status,subject_id,subject_type,workflow_instance_id', '资格专属待办 DTO 不正确')
await decide('flow-sampling-review', samplingV1, 'review', 'reject', '天气记录需根据现场照片更正')
await call('flow-sampler', 'POST', `/rounds/${ROUND_ID}/field`, { date: '2026-08-22', time: '09:30', weather: '晴', point: '1#总排口' })
const samplingV2 = await call('flow-sampler', 'POST', `/workflows/round_sampling/${ROUND_ID}/submit`, {})
const samplingV2Detail = await call('flow-sampler', 'GET', `/workflows/round_sampling/${ROUND_ID}`)
assert(samplingV2.current_revision === 2 && samplingV2Detail.revisions.length === 2, '采样退回后未生成不可变第 2 版')
await decide('flow-sampling-review', samplingV2, 'review', 'approve')
const samplingApprovalTasks = await call('flow-sampling-approve', 'GET', '/workflow-tasks/sampling')
assert(samplingApprovalTasks.some(task => task.contract_id === CONTRACT_ID && task.decision_level === 'approve'), '采样审核人未收到精确待办')
const samplingApproved = await decide('flow-sampling-approve', samplingV2, 'approve', 'approve')
assert(samplingApproved.status === 'approved' && samplingApproved.current_revision === 2, '采样第 2 版未审核定稿')
const made = await call('flow-sampler', 'POST', `/rounds/${ROUND_ID}/sample`, {})
assert(made.length > 0 && made.every(sample => sample.contract_id === CONTRACT_ID), '入库样品未贯穿项目编号')
const normalSample = made.find(sample => !sample.qc_type)
assert(normalSample, '未生成普通样品')
await projectCheckpoint('flow-sampler', CONTRACT_ID, '⑤ 现场采样（退回→第2版定稿）')

// 6. 样品交接。
const sheets = await call('flow-sampler', 'GET', `/handover-sheets?roundId=${encodeURIComponent(ROUND_ID)}`)
assert(sheets.length === 1 && sheets[0].contract_id === CONTRACT_ID, '样品交接单未贯穿项目编号')
await call('flow-sampler', 'POST', `/handover-sheets/${encodeURIComponent(sheets[0].id)}/send`, {})
await expectFailure('flow-sampler', 'POST', `/handover-sheets/${encodeURIComponent(sheets[0].id)}/confirm`, { rejects: [] }, /403|样品管理员/)
const handover = await call('flow-sample-manager', 'POST', `/handover-sheets/${encodeURIComponent(sheets[0].id)}/confirm`, { rejects: [] })
assert(handover.contract_id === CONTRACT_ID && handover.status === 'confirmed', '样品交接未确认')
await projectCheckpoint('flow-sample-manager', CONTRACT_ID, '⑥ 样品交接')

// 7. 质控安排审核前不能派实验任务；审核后精确派给分析人员。
await call('flow-quality', 'POST', `/rounds/${ROUND_ID}/quality-plan`, {
  adjustments: [{ qcType: '加标回收', matrix: '废水', analyte: 'COD', qty: 1, basis: '每批1个' }],
})
await expectFailure('flow-quality', 'POST', `/samples/${encodeURIComponent(normalSample.id)}/tasks`, {
  items: [{ analyte: 'COD', assignee: '孙分析', assigneeUsername: 'flow-analyst' }],
}, /质量计划.*批准/)
const qualityWorkflow = await call('flow-quality', 'POST', `/workflows/quality_plan/${ROUND_ID}/submit`, {})
assert(qualityWorkflow.contract_id === CONTRACT_ID && qualityWorkflow.current_revision === 1, '质控工作流未贯穿项目编号')
await decide('flow-quality-review', qualityWorkflow, 'review', 'approve')
const qualityTasks = await call('flow-quality-approve', 'GET', '/workflow-tasks/quality')
assert(qualityTasks.some(task => task.contract_id === CONTRACT_ID && task.subject_id === ROUND_ID && task.acting_capacity === '质控审核'), '资格专属质控待办范围不精确')
assert((await decide('flow-quality-approve', qualityWorkflow, 'approve', 'approve')).status === 'approved', '质控安排未审核定稿')
const assignedTasks = await call('flow-quality', 'POST', `/samples/${encodeURIComponent(normalSample.id)}/tasks`, {
  items: [{ analyte: 'COD', assignee: '孙分析', assigneeUsername: 'flow-analyst' }],
})
assert(assignedTasks.some(task => task.assignee_username === 'flow-analyst'), '实验任务没有精确指派分析人员')
await projectCheckpoint('flow-quality', CONTRACT_ID, '⑦ 质控')

// 8. 实验室分析编制、复核、审核。
const record = await call('flow-analyst', 'POST', '/records', {
  sampleId: normalSample.id, code: 'HJ-TC-030', name: 'COD 分析原始记录', analyte: 'COD', matrix: '废水',
  data: { rows: [{ sampleId: normalSample.id, value: 22.5 }], resultSummary: { analyte: 'COD', value: 22.5, unit: 'mg/L' } }, submit: true,
})
assert(record.status === 'submitted', '实验室记录未提交复核')
const labWorkflow = await call('flow-analyst', 'GET', `/workflows/lab_record/${encodeURIComponent(record.id)}`)
assert(labWorkflow.contract_id === CONTRACT_ID && labWorkflow.current_revision === 1, '实验室工作流未贯穿项目编号')
await decide('flow-lab-review', labWorkflow, 'review', 'approve')
assert((await decide('flow-lab-approve', labWorkflow, 'approve', 'approve')).status === 'approved', '实验室记录未审核定稿')
await projectCheckpoint('flow-analyst', CONTRACT_ID, '⑧ 实验室分析')

// 9. 整项目与预设报告批次分别计算就绪并分别形成已确认归档，避免范围误匹配。
const projectReadiness = await call('flow-archivist', 'GET', `/archive-readiness?contractId=${encodeURIComponent(CONTRACT_ID)}`)
assert(projectReadiness.ready && projectReadiness.contractId === CONTRACT_ID && projectReadiness.reportBatchId === null, '整项目归档尚未就绪')
assert(JSON.stringify(projectReadiness.roundIds) === JSON.stringify([ROUND_ID]), '整项目归档期次范围不精确')
const batchReadiness = await call('flow-archivist', 'GET', `/archive-readiness?reportBatchId=${encodeURIComponent(reportBatch.id)}`)
assert(batchReadiness.ready && batchReadiness.contractId === CONTRACT_ID && batchReadiness.reportBatchId === reportBatch.id, '报告批次归档尚未就绪')
assert(JSON.stringify(batchReadiness.roundIds) === JSON.stringify([ROUND_ID]), '报告批次归档期次范围不精确')
const projectArchive = await call('flow-archivist', 'POST', '/archive-packages/build', { contractId: CONTRACT_ID })
const confirmedProjectArchive = await call('flow-archivist', 'POST', `/archive-packages/${encodeURIComponent(projectArchive.id)}/confirm`, {})
assert(confirmedProjectArchive.status === 'confirmed' && confirmedProjectArchive.report_batch_id === null, '整项目归档未确认')
const batchArchive = await call('flow-archivist', 'POST', '/archive-packages/build', { reportBatchId: reportBatch.id })
const confirmedBatchArchive = await call('flow-archivist', 'POST', `/archive-packages/${encodeURIComponent(batchArchive.id)}/confirm`, {})
assert(confirmedBatchArchive.status === 'confirmed' && confirmedBatchArchive.contract_id === CONTRACT_ID && confirmedBatchArchive.report_batch_id === reportBatch.id, '报告批次归档未确认')
const archiveList = await call('flow-report-editor', 'GET', `/archive-packages?contractId=${encodeURIComponent(CONTRACT_ID)}&status=confirmed`)
assert(archiveList.length === 2 && archiveList.some(item => item.report_batch_id === null) && archiveList.some(item => item.report_batch_id === reportBatch.id), '项目与报告批次归档未保持独立精确范围')
await projectCheckpoint('flow-archivist', CONTRACT_ID, '⑨ 1–8 档案归档（项目/批次精确匹配）')

// 10. 报告绑定批次归档；复核退回后第 2 版重提，再审核、授权签发并取得永久回执。
const report = await call('flow-report-editor', 'POST', '/reports/generate-round', { roundId: ROUND_ID, archivePackageId: confirmedBatchArchive.id })
assert(report.contract_id === CONTRACT_ID && report.archive_package_id === confirmedBatchArchive.id, '报告未绑定精确归档范围')
assert(report.data?.reportBatchId === reportBatch.id && report.data?.process?.contract?.id === CONTRACT_ID, '报告快照未贯穿项目编号/报告批次')
const reportV1 = await call('flow-report-editor', 'POST', `/workflows/report/${encodeURIComponent(report.id)}/submit`, {})
assert(reportV1.contract_id === CONTRACT_ID && reportV1.current_revision === 1, '报告第 1 版提交异常')
const reportTasks = await call('flow-report-review', 'GET', '/workflow-tasks/report')
assert(reportTasks.some(task => task.contract_id === CONTRACT_ID && task.subject_id === report.id && task.decision_level === 'review'), '报告复核人未收到精确待办')
await decide('flow-report-review', reportV1, 'review', 'reject', '报告结论依据需补充')
const updatedReport = await call('flow-report-editor', 'POST', `/reports/${encodeURIComponent(report.id)}/update`, { conclusion: '已补充监测结果与方法依据' })
assert(updatedReport.contract_id === CONTRACT_ID, '报告退回修改响应未贯穿项目编号')
const reportV2 = await call('flow-report-editor', 'POST', `/workflows/report/${encodeURIComponent(report.id)}/submit`, {})
const reportV2Detail = await call('flow-report-editor', 'GET', `/workflows/report/${encodeURIComponent(report.id)}`)
assert(reportV2.current_revision === 2 && reportV2Detail.revisions.length === 2, '报告退回后未生成不可变第 2 版')
await decide('flow-report-review', reportV2, 'review', 'approve')
const reportApproved = await decide('flow-report-approve', reportV2, 'approve', 'approve')
assert(reportApproved.status === 'approved' && reportApproved.current_revision === 2, '报告第 2 版未审核定稿')
const issued = await call('flow-signer', 'POST', `/reports/${encodeURIComponent(report.id)}/issue`, {})
assert(issued.status === 'issued' && issued.contract_id === CONTRACT_ID, '报告未正式签发')
assert(/^RPT-/.test(issued.receipt_id || '') && /^\d{4}-\d{2}-\d{2}T/.test(issued.issued_at || ''), '报告签发缺少永久回执号或服务端时间')
assert(issued.data?._issuance?.receiptId === issued.receipt_id && issued.data?._issuance?.archivePackageId === confirmedBatchArchive.id, '永久回执证据不完整')
const issuedAgain = await call('flow-signer', 'POST', `/reports/${encodeURIComponent(report.id)}/issue`, {})
assert(issuedAgain.receipt_id === issued.receipt_id && issuedAgain.issued_at === issued.issued_at, '重试签发改变了永久回执')
const finalProject = await projectCheckpoint('flow-signer', CONTRACT_ID, '⑩ 出具报告（退回→第2版→永久回执）')
assert(finalProject.pipeline.activeIndex === -1 && finalProject.pipeline.stages.every(stage => stage.status === 'done'), '十阶段主线未全部闭环')
const audit = await call('flow-report-editor', 'GET', `/audit/${CONTRACT_ID}`)
assert(audit.length > 0, '项目操作留痕为空')
ok(`永久回执 ${issued.receipt_id} · 服务端时间 ${issued.issued_at}`)

// 隔离回归：双期项目共用一份整项目归档，随后从真实 API 撤回其中一条已批准原始记录。
// 必须只失效包含该精确版本的归档；草稿/已审核报告被阻断，已签发报告仍可读但标记必须重出。
const withdrawalContract = await call('flow-sales', 'POST', '/contracts', {
  client: '归档失效隔离验证有限公司', project: '双期撤回影响验证',
  periodStart: '2026-08-22', periodEnd: '2026-09-22', cycleMonths: 1,
  plan: [{ matrix: '废水', items: ['COD'], qty: 1, cycleMonths: 1 }],
})
const WITHDRAWAL_CONTRACT_ID = withdrawalContract.id
await call('flow-sales', 'POST', `/contracts/${encodeURIComponent(WITHDRAWAL_CONTRACT_ID)}/accept`, { review: { conclusion: '隔离回归资料齐全' } })
await call('flow-tech', 'POST', `/contracts/${encodeURIComponent(WITHDRAWAL_CONTRACT_ID)}/tech-review`, { decision: 'approve', note: '隔离回归技术批准' })
await call('flow-planner', 'POST', `/contracts/${encodeURIComponent(WITHDRAWAL_CONTRACT_ID)}/scheme`, {
  cycleMonths: 1, periodStart: '2026-08-22', periodEnd: '2026-09-22',
  points: [{ element: '废水', point: '隔离排口', items: ['COD'], freq: '每天1次 · 每月', standard: 'GB 8978-1996' }],
})
await call('flow-tech', 'POST', `/contracts/${encodeURIComponent(WITHDRAWAL_CONTRACT_ID)}/scheme/review`, { op: 'approve', comment: '双期方案批准' })
for (const [scope, [reviewerUsername, approverUsername]] of Object.entries(assignmentPairs)) {
  await call('flow-planner', 'POST', `/contracts/${encodeURIComponent(WITHDRAWAL_CONTRACT_ID)}/workflow-assignments/${scope}`, {
    reviewerUsername, approverUsername,
  })
}
const withdrawalRounds = await call('flow-planner', 'GET', `/contracts/${encodeURIComponent(WITHDRAWAL_CONTRACT_ID)}/rounds`)
assert(withdrawalRounds.length === 2, `隔离场景应生成 2 个期次，实际为 ${withdrawalRounds.length}`)
const withdrawalEvidence = []
for (const [index, round] of withdrawalRounds.entries()) {
  withdrawalEvidence.push(await completeRoundEvidence(WITHDRAWAL_CONTRACT_ID, round, index + 1))
}
const withdrawalReadiness = await call('flow-archivist', 'GET', `/archive-readiness?contractId=${encodeURIComponent(WITHDRAWAL_CONTRACT_ID)}`)
assert(withdrawalReadiness.ready && withdrawalReadiness.roundIds.length === 2, '隔离场景整项目归档未就绪')
const withdrawalArchiveDraft = await call('flow-archivist', 'POST', '/archive-packages/build', { contractId: WITHDRAWAL_CONTRACT_ID })
const withdrawalArchive = await call('flow-archivist', 'POST', `/archive-packages/${encodeURIComponent(withdrawalArchiveDraft.id)}/confirm`, {})
assert(withdrawalArchive.status === 'confirmed', '隔离场景归档未确认')

const checkedReport = await call('flow-report-editor', 'POST', '/reports/generate-round', {
  roundId: withdrawalRounds[0].id, archivePackageId: withdrawalArchive.id,
})
const checkedWorkflow = await call('flow-report-editor', 'POST', `/workflows/report/${encodeURIComponent(checkedReport.id)}/submit`, {})
await decide('flow-report-review', checkedWorkflow, 'review', 'approve')
await decide('flow-report-approve', checkedWorkflow, 'approve', 'approve')

const issuedReportDraft = await call('flow-report-editor', 'POST', '/reports/generate-round', {
  roundId: withdrawalRounds[1].id, archivePackageId: withdrawalArchive.id,
})
const issuedWorkflow = await call('flow-report-editor', 'POST', `/workflows/report/${encodeURIComponent(issuedReportDraft.id)}/submit`, {})
await decide('flow-report-review', issuedWorkflow, 'review', 'approve')
await decide('flow-report-approve', issuedWorkflow, 'approve', 'approve')
const withdrawalIssuedReport = await call('flow-signer', 'POST', `/reports/${encodeURIComponent(issuedReportDraft.id)}/issue`, {})
const draftReport = await call('flow-report-editor', 'POST', '/reports/generate-contract', {
  contractId: WITHDRAWAL_CONTRACT_ID, archivePackageId: withdrawalArchive.id,
})
assert(withdrawalIssuedReport.status === 'issued' && draftReport.status === 'draft', '隔离场景三种报告状态准备失败')

const WITHDRAWAL_REASON = '隔离回归：复核原始谱图后发现需更正'
const withdrawn = await call('flow-analyst', 'POST', `/workflows/${encodeURIComponent(withdrawalEvidence[0].laboratory.id)}/withdraw`, {
  reason: WITHDRAWAL_REASON,
})
assert(withdrawn.workflow.status === 'withdrawn' && withdrawn.workflow.withdrawn_reason === WITHDRAWAL_REASON, '真实 API 未按显式原因撤回已批准证据')
assert(JSON.stringify(withdrawn.invalidation.invalidatedArchiveIds) === JSON.stringify([withdrawalArchive.id]), '撤回没有只失效包含精确批准版本的归档')
assert(JSON.stringify([...withdrawn.invalidation.blockedReportIds].sort()) === JSON.stringify([checkedReport.id, draftReport.id].sort()), '草稿/已审核报告阻断范围不精确')
assert(JSON.stringify(withdrawn.invalidation.reissueRequiredReportIds) === JSON.stringify([withdrawalIssuedReport.id]), '已签发报告重出范围不精确')

const invalidatedArchive = await call('flow-archivist', 'GET', `/archive-packages/${encodeURIComponent(withdrawalArchive.id)}`)
assert(invalidatedArchive.status === 'invalidated' && invalidatedArchive.invalidation_reason === WITHDRAWAL_REASON, '归档失效状态或原因未持久化')
const affectedReports = await call('flow-report-editor', 'GET', '/reports')
const checkedAfter = affectedReports.find(item => item.id === checkedReport.id)
const draftAfter = affectedReports.find(item => item.id === draftReport.id)
const issuedAfter = affectedReports.find(item => item.id === withdrawalIssuedReport.id)
assert(checkedAfter?.archive_blocked_at && draftAfter?.archive_blocked_at, '草稿/已审核报告没有持久化阻断标记')
assert(!issuedAfter?.archive_blocked_at && issuedAfter?.archive_requires_reissue === 1, '已签发报告应保持可读并标记必须重出')
await expectFailure('flow-signer', 'POST', `/reports/${encodeURIComponent(checkedReport.id)}/issue`, {}, /归档失效|阻断/)
await expectFailure('flow-report-editor', 'POST', `/reports/${encodeURIComponent(draftReport.id)}/update`, { conclusion: '不应允许修改推进' }, /归档失效|阻断/)
const readableIssued = await call('flow-signer', 'GET', `/reports/${encodeURIComponent(withdrawalIssuedReport.id)}`)
assert(readableIssued.status === 'issued' && readableIssued.archive_requires_reissue === 1 && readableIssued.receipt_id === withdrawalIssuedReport.receipt_id, '已签发报告失效后未保持永久回执可读')
ok(`隔离撤回 ${WITHDRAWAL_CONTRACT_ID} · 精确失效 1 个归档 · 阻断 2 份报告 · 1 份已签发报告需重出`)

console.log(`\n🎉 十阶段端到端串测通过：${CONTRACT_ID} 完成主线闭环；${WITHDRAWAL_CONTRACT_ID} 完成撤回/归档失效隔离验证。`)
