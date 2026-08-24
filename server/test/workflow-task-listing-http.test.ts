import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { createContract, createUser, type User } from '../src/handlers.ts'
import { assignProjectReviewers, setUserQualifications } from '../src/qualifications.ts'
import { decideWorkflow, submitWorkflowRevision } from '../src/workflow.ts'

const actor = (username: string, roles: string[] = []): User => ({ username, name: username, roles, status: 'active', created_at: '', must_change_pw: false })

test('专业待办 HTTP 仅返回 Dashboard DTO 精确键且不跨 scope 或泄露工作流证据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-tasks-http-'))
  const dbPath = join(dir, 'test.db')
  const db = openDb(dbPath)
  const admin = actor('admin-task', ['admin']), planner = actor('planner-task', ['planner'])
  const qualified = actor('qualified-only'), outsider = actor('outsider-task', ['sales'])
  const samplingAuthor = actor('sampling-author', ['sampler']), samplingApprover = actor('sampling-approver', ['analyst'])
  const qualityAuthor = actor('quality-author', ['qc']), qualityReviewer = actor('quality-reviewer', ['report_editor'])
  for (const user of [admin, planner, qualified, outsider, samplingAuthor, samplingApprover, qualityAuthor, qualityReviewer]) {
    createUser(db, { username: user.username, name: user.name, roles: user.roles, password: 'secret1' })
  }
  setUserQualifications(db, qualified.username, ['sampling_review', 'quality_approve'], admin)
  setUserQualifications(db, samplingApprover.username, ['sampling_approve'], admin)
  setUserQualifications(db, qualityReviewer.username, ['quality_review', 'sampling_review'], admin)
  const samplingContract = createContract(db, { client: '采样客户' }, 2026)
  const qualityContract = createContract(db, { client: '质控客户' }, 2026)
  const unassignedContract = createContract(db, { client: '无关客户' }, 2026)
  assignProjectReviewers(db, samplingContract.id, 'sampling', qualified.username, samplingApprover.username, planner)
  assignProjectReviewers(db, qualityContract.id, 'quality', qualityReviewer.username, qualified.username, planner)
  assignProjectReviewers(db, unassignedContract.id, 'sampling', qualityReviewer.username, samplingApprover.username, planner)
  submitWorkflowRevision(db, {
    contractId: samplingContract.id, roundId: 'ROUND-S', scope: 'sampling', subjectType: 'round_sampling', subjectId: 'ROUND-S',
    snapshot: { secretEvidence: '不得出现在待办列表' },
  }, samplingAuthor)
  const quality = submitWorkflowRevision(db, {
    contractId: qualityContract.id, roundId: 'ROUND-Q', scope: 'quality', subjectType: 'quality_plan', subjectId: 'ROUND-Q',
    snapshot: { secretEvidence: '不得跨 scope 泄露' },
  }, qualityAuthor)
  const unassigned = submitWorkflowRevision(db, {
    contractId: unassignedContract.id, roundId: 'ROUND-OTHER', scope: 'sampling', subjectType: 'round_sampling', subjectId: 'ROUND-OTHER',
    snapshot: { secretEvidence: '无关项目证据' },
  }, samplingAuthor)
  decideWorkflow(db, quality.id, 1, 'review', 'approve', '通过', qualityReviewer)
  db.prepare(`UPDATE users SET must_change_pw=0`).run()
  db.close()

  const port = 24_000 + Math.floor(Math.random() * 10_000)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: join(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), DB_PATH: dbPath }, stdio: 'ignore',
  })
  async function login(username: string) {
    let response: Response | undefined
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        response = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'secret1' }) })
        if (response.ok) break
      } catch { /* server starting */ }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(response?.status, 200)
    return String((await response!.json() as any).token)
  }
  const request = (token: string, scope: string) => fetch(base + `/api/workflow-tasks/${scope}`, { headers: { authorization: `Bearer ${token}` } })
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  try {
    const token = await login(qualified.username), outsiderToken = await login(outsider.username)
    const me = await fetch(base + '/api/me', { headers: auth(token) })
    assert.equal(me.status, 200)
    assert.equal((await me.json() as any).username, qualified.username)
    const sampling = await request(token, 'sampling').then(response => response.json()) as any[]
    assert.equal(sampling.length, 1)
    assert.deepEqual(Object.keys(sampling[0]).sort(), [
      'acting_capacity', 'contract_id', 'current_revision', 'decision_level', 'status', 'subject_id', 'subject_type', 'workflow_instance_id',
    ])
    assert.deepEqual(sampling[0], {
      workflow_instance_id: sampling[0].workflow_instance_id, subject_type: 'round_sampling', subject_id: 'ROUND-S',
      contract_id: samplingContract.id, status: 'pending_review', current_revision: 1, decision_level: 'review', acting_capacity: '采样复核',
    })
    assert.equal(JSON.stringify(sampling).includes('secretEvidence'), false)
    const qualityTasks = await request(token, 'quality').then(response => response.json()) as any[]
    assert.deepEqual(qualityTasks.map(item => [item.subject_type, item.subject_id, item.decision_level, item.acting_capacity]), [
      ['quality_plan', 'ROUND-Q', 'approve', '质控审核'],
    ])
    assert.deepEqual(await request(outsiderToken, 'sampling').then(response => response.json()), [])
    const deniedOrdinaryReads = [
      '/api/users', `/api/users/${qualified.username}/qualifications`, '/api/users/samplers', '/api/users/testers',
      '/api/audit/arbitrary', '/api/mobile-operations/health',
      '/api/attachments/sample/arbitrary', '/api/attachments/file/arbitrary',
      '/api/samples', '/api/samples/arbitrary', '/api/samples/arbitrary/handovers',
      '/api/samples/arbitrary/retention', '/api/samples/arbitrary/reports', '/api/samples/arbitrary/pretreatments',
      '/api/handovers/pending', '/api/handover-sheets', '/api/handover-sheets/arbitrary',
      '/api/test-notices', '/api/test-notices/arbitrary', '/api/test-notices/arbitrary/decode',
      '/api/reports/arbitrary/deliveries', '/api/reports/arbitrary/archive-index',
      `/api/archive-readiness?contractId=${samplingContract.id}`, '/api/archive-packages', '/api/archive-packages/arbitrary',
      '/api/report-batches', '/api/report-batches/arbitrary',
      `/api/contracts/${samplingContract.id}/archive-readiness`,
      `/api/contracts/${samplingContract.id}/workflow-candidates?scope=sampling&level=review`,
      `/api/contracts/${samplingContract.id}/workflow-assignments`,
      '/api/org-profile', '/api/tasks', '/api/records', '/api/records/arbitrary',
      '/api/records/arbitrary/audit', '/api/records-list',
      '/api/contracts', `/api/contracts/${samplingContract.id}`, '/api/customers',
      `/api/customers/arbitrary/contracts`, `/api/contracts/${samplingContract.id}/points`,
      `/api/contracts/${samplingContract.id}/scheme`, `/api/contracts/${samplingContract.id}/rounds`,
      '/api/rounds', '/api/rounds/due', '/api/rounds/arbitrary/detail', '/api/rounds/arbitrary/offline-package',
      '/api/rounds/arbitrary/qc', '/api/rounds/arbitrary/qc-requirements', '/api/rounds/arbitrary/quality-plan',
      '/api/rounds/arbitrary/sheets', '/api/rounds/arbitrary/sheets/arbitrary', '/api/rounds/arbitrary/mobile-confirmation',
      '/api/mobile-submissions/arbitrary', '/api/mobile-confirmation-claims/arbitrary',
      '/api/projects', `/api/projects/${samplingContract.id}`, `/api/projects/${qualityContract.id}`,
      '/api/instruments', '/api/checkouts', '/api/ref-materials', '/api/reagents',
      '/api/resource-alerts', '/api/contract-alerts', '/api/reports', '/api/reports/arbitrary',
      '/api/stats/yearly?year=2026', '/api/stats/overview', '/api/subcontracts', '/api/system-records',
      `/api/contracts/${samplingContract.id}/doc`, '/api/no-such-route',
    ]
    for (const path of deniedOrdinaryReads) {
      const response = await fetch(base + path, { headers: auth(token) })
      assert.equal(response.status, 403, `qualification-only GET ${path}`)
      assert.equal((await response.json() as any).error_code, 'QUALIFICATION_ONLY_ROUTE_FORBIDDEN', path)
    }
    const exactWorkflow = await fetch(base + '/api/workflows/round_sampling/ROUND-S', { headers: auth(token) })
    assert.equal(exactWorkflow.status, 200)
    assert.equal((await exactWorkflow.json() as any).id, sampling[0].workflow_instance_id)
    const missingWorkflow = await fetch(base + '/api/workflows/round_sampling/ROUND-MISSING', { headers: auth(token) })
    assert.equal(missingWorkflow.status, 403, 'qualification-only valid subject must fail closed for a missing workflow')
    assert.equal((await missingWorkflow.json() as any).error_code, 'WORKFLOW_FORBIDDEN')
    const unsupportedSubject = await fetch(base + '/api/workflows/not_a_subject/ROUND-MISSING', { headers: auth(token) })
    assert.equal(unsupportedSubject.status, 403)
    assert.equal((await unsupportedSubject.json() as any).error_code, 'QUALIFICATION_ONLY_ROUTE_FORBIDDEN')
    const unsupportedBaseRole = await fetch(base + '/api/workflows/not_a_subject/ROUND-MISSING', { headers: auth(outsiderToken) })
    assert.equal(unsupportedBaseRole.status, 400)
    assert.equal((await unsupportedBaseRole.json() as any).error_code, 'WORKFLOW_SUBJECT_INVALID')
    const malformedWorkflowPath = await fetch(base + '/api/workflows/round_sampling', { headers: auth(token) })
    assert.equal(malformedWorkflowPath.status, 403)
    assert.equal((await malformedWorkflowPath.json() as any).error_code, 'QUALIFICATION_ONLY_ROUTE_FORBIDDEN')
    const arbitraryWorkflow = await fetch(base + '/api/workflows/round_sampling/ROUND-OTHER', { headers: auth(token) })
    assert.equal(arbitraryWorkflow.status, 403)
    assert.equal((await arbitraryWorkflow.json() as any).error_code, 'WORKFLOW_FORBIDDEN')
    const arbitraryDecision = await fetch(base + `/api/workflows/${encodeURIComponent(unassigned.id)}/decide`, {
      method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 1, level: 'review', decision: 'approve', comment: '不应允许' }),
    })
    assert.equal(arbitraryDecision.status, 403)
    assert.equal((await arbitraryDecision.json() as any).error_code, 'WORKFLOW_WRONG_ASSIGNEE')
    assert.equal((await fetch(base + '/api/projects', { headers: auth(outsiderToken) })).status, 200)
    assert.equal((await fetch(base + `/api/projects/${encodeURIComponent(samplingContract.id)}`, { headers: auth(outsiderToken) })).status, 200)
    assert.equal((await fetch(base + '/api/contracts', { headers: auth(outsiderToken) })).status, 200)
    assert.equal((await fetch(base + `/api/contracts/${encodeURIComponent(samplingContract.id)}`, { headers: auth(outsiderToken) })).status, 200)
    assert.equal((await fetch(base + '/api/stats/overview', { headers: auth(outsiderToken) })).status, 200)
    assert.equal((await fetch(base + '/api/instruments', { headers: auth(outsiderToken) })).status, 200)
    const decided = await fetch(base + `/api/workflows/${encodeURIComponent(sampling[0].workflow_instance_id)}/decide`, {
      method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 1, level: 'review', decision: 'approve', comment: '按资格专属待办完成复核' }),
    })
    assert.equal(decided.status, 200)
    assert.equal((await decided.json() as any).status, 'pending_approval')
    const completedReviewerDetail = await fetch(base + '/api/workflows/round_sampling/ROUND-S', { headers: auth(token) })
    assert.equal(completedReviewerDetail.status, 403, 'qualification-only detail closes when the exact current task is complete')
    assert.equal((await completedReviewerDetail.json() as any).error_code, 'WORKFLOW_FORBIDDEN')
    assert.equal((await fetch(base + '/api/workflow-tasks/sampling')).status, 401)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
