import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.ts'
import { loginToTestServer } from './support/http-test-server.ts'
import {
  addAttachment,
  assignRound,
  createContract,
  createScheme,
  createUser,
  confirmRoundField,
  listRounds,
  reviewScheme,
  sampleRound,
  saveRoundField,
  saveRoundSheet,
  submitSamplingWorkflow,
  type User,
} from '../src/handlers.ts'
import { assignProjectReviewers, setUserQualifications } from '../src/qualifications.ts'
import { decideWorkflow, getWorkflowView } from '../src/workflow.ts'

function actor(username: string, roles: string[] = []): User {
  return { username, name: username, roles, status: 'active', created_at: '', must_change_pw: false }
}

function fixture(db = openDb(':memory:')) {
  const contract = createContract(db, { client: '甲厂', plan: [{ matrix: '废水', items: ['COD'], qty: 1 }] }, 2026)
  createScheme(db, { contractId: contract.id, cycleMonths: 0, periodStart: '2026-08-17', periodEnd: '2026-08-17' }, 2026)
  reviewScheme(db, contract.id, 'approve', '许技术')
  const author = actor('sampler', ['sampler'])
  const reviewer = actor('sampling-reviewer')
  const approver = actor('sampling-approver')
  const planner = actor('planner', ['planner'])
  const admin = actor('admin', ['admin'])
  for (const user of [author, reviewer, approver]) createUser(db, { username: user.username, name: user.name, roles: user.roles, password: 'secret1' })
  setUserQualifications(db, reviewer.username, ['sampling_review'], admin)
  setUserQualifications(db, approver.username, ['sampling_approve'], admin)
  assignProjectReviewers(db, contract.id, 'sampling', reviewer.username, approver.username, planner)
  const round = listRounds(db, contract.id)[0]
  assignRound(db, round.id, [author.username])
  saveRoundField(db, round.id, { weather: '晴', samplingDate: '2026-08-17' }, author, { supervisor: false })
  saveRoundSheet(db, round.id, 'HJ-TC-136', { rows: [{ point: '1#排口' }] }, author, undefined, { supervisor: false })
  confirmRoundField(db, round.id, author)
  const attachment = addAttachment(db, { entityType: 'round_sheet', entityId: `${round.id}::HJ-TC-136`, origName: '现场.jpg', storedName: 'field.jpg', contentHash: 'a'.repeat(64) }, author)
  return { db, contract, round, author, reviewer, approver, attachment }
}

test('sampling submission snapshots saved field evidence and requires assigned professional approval before handover', () => {
  const { db, round, author, reviewer, approver, attachment } = fixture()
  const submitted = submitSamplingWorkflow(db, round.id, author)
  assert.equal(submitted.current_revision, 1)
  assert.equal(submitted.status, 'pending_review')
  const snapshot = getWorkflowView(db, 'round_sampling', round.id)!.revisions[0].snapshot as any
  assert.equal(snapshot.fieldInfo.weather, '晴')
  assert.equal(snapshot.fieldInfo.samplingDate, '2026-08-17')
  assert.equal(snapshot.fieldInfo.confirmations.sampler.name, 'sampler')
  assert.equal(snapshot.roundSheets[0].templateCode, 'HJ-TC-136')
  assert.deepEqual(snapshot.roundSheets[0].data, { rows: [{ point: '1#排口' }] })
  assert.deepEqual(snapshot.attachments, [{ id: attachment.id, hash: 'a'.repeat(64) }])
  assert.throws(() => sampleRound(db, round.id, author, undefined, { supervisor: false }), /采样审核通过后允许发起交接\/入库/)
  assert.throws(() => decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', approver), /项目指定的复核人/)
  decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', reviewer)
  decideWorkflow(db, submitted.id, 1, 'approve', 'approve', '', approver)
  assert.ok(sampleRound(db, round.id, author, undefined, { supervisor: false }).length >= 1)
})

test('approved sampling freezes field sheets and round attachments for every actor', () => {
  const { db, round, author, reviewer, approver, attachment } = fixture()
  const submitted = submitSamplingWorkflow(db, round.id, author)
  decideWorkflow(db, submitted.id, 1, 'review', 'approve', '', reviewer)
  decideWorkflow(db, submitted.id, 1, 'approve', 'approve', '', approver)
  const tech = actor('tech', ['tech'])
  assert.throws(() => saveRoundField(db, round.id, { weather: '雨' }, tech, { supervisor: true }), /已批准内容已冻结/)
  assert.throws(() => saveRoundSheet(db, round.id, 'HJ-TC-136', { rows: [] }, tech, undefined, { supervisor: true }), /已批准内容已冻结/)
  assert.throws(() => confirmRoundField(db, round.id, author), /已批准内容已冻结/)
  assert.throws(() => addAttachment(db, { entityType: 'round_sheet', entityId: `${round.id}::HJ-TC-136`, origName: '补传.jpg', storedName: 'late.jpg' }, tech), /已批准内容已冻结/)
  assert.ok(attachment.id)
})

test('submitted sampling evidence cannot drift before professional approval', () => {
  const { db, round, author, reviewer } = fixture()
  const submitted = submitSamplingWorkflow(db, round.id, author)
  assert.throws(() => saveRoundField(db, round.id, { weather: '雨' }, author, { supervisor: false }), /冻结/)
  assert.throws(() => saveRoundSheet(db, round.id, 'HJ-TC-136', { rows: [] }, author, undefined, { supervisor: false }), /冻结/)
  decideWorkflow(db, submitted.id, 1, 'review', 'reject', '补充证据', reviewer)
  assert.doesNotThrow(() => saveRoundField(db, round.id, { weather: '雨' }, author, { supervisor: false }))
})

test('only the exact active assigned sampler can submit evidence', () => {
  const { db, round, author } = fixture()
  for (const denied of [actor('tech', ['tech']), actor('admin', ['admin']), actor('planner', ['planner']), actor('other', ['sampler'])]) {
    assert.throws(() => submitSamplingWorkflow(db, round.id, denied), /当前有效派工的采样员/)
  }
  assert.doesNotThrow(() => submitSamplingWorkflow(db, round.id, author))
})

test('handover fails closed when sampling assignment, submission, or approval is absent', () => {
  const first = fixture()
  first.db.prepare(`UPDATE project_stage_assignments SET active=0 WHERE contract_id=? AND scope='sampling'`).run(first.contract.id)
  assert.throws(() => sampleRound(first.db, first.round.id, first.author, undefined, { supervisor: false }), /尚未指定采样复核人/)
  const second = fixture()
  assert.throws(() => sampleRound(second.db, second.round.id, second.author, undefined, { supervisor: false }), /尚未提交审核/)
  const third = fixture()
  submitSamplingWorkflow(third.db, third.round.id, third.author)
  assert.throws(() => sampleRound(third.db, third.round.id, third.author, undefined, { supervisor: false }), /审核通过后/)
})

test('done rounds reject missing assignment, missing workflow, pending workflow, and rejected workflow', () => {
  const markDone = (db: any, roundId: string) => {
    db.prepare(`UPDATE rounds SET status='done' WHERE id=?`).run(roundId)
    db.prepare(`INSERT INTO samples(id,client,matrix,items,status,round_id,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(`legacy-${roundId}`, '甲厂', '废水', '[]', 'pending', roundId, '2026-08-17')
  }

  const missingAssignment = fixture()
  markDone(missingAssignment.db, missingAssignment.round.id)
  missingAssignment.db.prepare(`UPDATE project_stage_assignments SET active=0 WHERE contract_id=? AND scope='sampling'`).run(missingAssignment.round.contract_id)
  assert.throws(() => sampleRound(missingAssignment.db, missingAssignment.round.id, 2026), /尚未指定采样复核人/)

  const missingWorkflow = fixture()
  markDone(missingWorkflow.db, missingWorkflow.round.id)
  assert.throws(() => sampleRound(missingWorkflow.db, missingWorkflow.round.id, 2026), /尚未提交审核/)

  const pendingReview = fixture()
  submitSamplingWorkflow(pendingReview.db, pendingReview.round.id, pendingReview.author)
  markDone(pendingReview.db, pendingReview.round.id)
  assert.throws(() => sampleRound(pendingReview.db, pendingReview.round.id, 2026), /审核通过后/)

  const pendingApproval = fixture()
  const approvalWorkflow = submitSamplingWorkflow(pendingApproval.db, pendingApproval.round.id, pendingApproval.author)
  decideWorkflow(pendingApproval.db, approvalWorkflow.id, 1, 'review', 'approve', '', pendingApproval.reviewer)
  markDone(pendingApproval.db, pendingApproval.round.id)
  assert.throws(() => sampleRound(pendingApproval.db, pendingApproval.round.id, 2026), /审核通过后/)

  const rejected = fixture()
  const rejectedWorkflow = submitSamplingWorkflow(rejected.db, rejected.round.id, rejected.author)
  decideWorkflow(rejected.db, rejectedWorkflow.id, 1, 'review', 'reject', '证据不足', rejected.reviewer)
  markDone(rejected.db, rejected.round.id)
  assert.throws(() => sampleRound(rejected.db, rejected.round.id, 2026), /审核通过后/)
})

test('sampling submission rejects missing or malformed direct attachment hashes', () => {
  for (const contentHash of [null, 'not-a-sha256']) {
    const { db, round, author, attachment } = fixture()
    db.prepare(`UPDATE attachments SET content_hash=? WHERE id=?`).run(contentHash, attachment.id)
    assert.throws(() => submitSamplingWorkflow(db, round.id, author), /现场附件哈希不可验证/)
    assert.equal(getWorkflowView(db, 'round_sampling', round.id), null)
  }
})

test('sampling submission rejects completed mobile receipts with missing or malformed staged hashes', () => {
  for (const mode of ['missing', 'malformed'] as const) {
    const { db, round, author } = fixture()
    const receiptId = `mobile-${mode}`
    if (mode === 'malformed') {
      db.prepare(`INSERT INTO staged_attachments
        (receipt_id,round_id,sample_slot_id,client_attachment_id,owner_id,device_id,content_hash,mime,size,revision,generation,status,lease_expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          receiptId, round.id, `${round.id}:废水:1`, `local-${mode}`, author.username, 'device', 'invalid-hash', 'image/jpeg', 3, 1, 1,
          'uploaded_staged', '2099-01-01T00:00:00.000Z', '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z',
        )
    }
    db.prepare(`INSERT INTO mobile_submissions
      (client_submission_id,receipt_id,round_id,owner_id,device_id,task_version,rule_version,draft_revision,payload_hash,canonical_payload,attachment_receipts,status,created_at,updated_at,completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `submission-${mode}`, `submission-receipt-${mode}`, round.id, author.username, 'device', 'task', 'rule', 1, 'f'.repeat(64),
        '{"global":{"samplingDate":"2026-08-17"}}', JSON.stringify([receiptId]), 'complete', '2026-08-17', '2026-08-17', '2026-08-17',
      )
    assert.throws(() => submitSamplingWorkflow(db, round.id, author), /移动提交引用的附件哈希不可验证/)
    assert.equal(getWorkflowView(db, 'round_sampling', round.id), null)
  }
})

test('a completed mobile receipt remains evidence until approval releases its labelled slot into handover', () => {
  const { db, round, author, reviewer, approver } = fixture()
  // The mobile receipt has its own two-person confirmation chain; it must not
  // be collapsed into the desktop field-confirmation state.
  db.prepare(`UPDATE rounds SET field_info='{"weather":"晴","samplingDate":"2026-08-17"}' WHERE id=?`).run(round.id)
  db.prepare(`INSERT INTO mobile_sample_slots(sample_slot_id,temporary_id,round_id,matrix,items,sequence,state,created_at)
    VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101',?,'废水','["COD"]',1,'active','2026-08-17')`).run(round.id)
  db.prepare(`INSERT INTO mobile_submissions(client_submission_id,receipt_id,round_id,owner_id,device_id,task_version,rule_version,draft_revision,payload_hash,canonical_payload,attachment_receipts,status,created_at,updated_at,completed_at)
    VALUES('submission-complete-0001','receipt-complete-0001',?,'sampler','device','task','rule',1,'hash','{"global":{"samplingDate":"2026-08-17"}}','[]','complete','2026-08-17','2026-08-17','2026-08-17')`).run(round.id)
  const workflow = submitSamplingWorkflow(db, round.id, author)
  decideWorkflow(db, workflow.id, 1, 'review', 'approve', '', reviewer)
  decideWorkflow(db, workflow.id, 1, 'approve', 'approve', '', approver)
  const samples = sampleRound(db, round.id, author, undefined, { supervisor: false })
  assert.deepEqual(samples.map(sample => sample.id), ['W260817-1'])
  assert.equal((db.prepare(`SELECT official_sample_id FROM mobile_sample_slots WHERE round_id=?`).get(round.id) as any).official_sample_id, 'W260817-1')
})

test('real HTTP sampling submit rejects broad roles and accepts only the exact active assigned sampler', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sampling-submit-http-'))
  const dbPath = join(dir, 'db.sqlite')
  const uploadDir = join(dir, 'uploads')
  const port = 45200 + Math.floor(Math.random() * 300)
  let child: ReturnType<typeof spawn> | undefined
  try {
    const db = openDb(dbPath)
    const { round } = fixture(db)
    const deniedUsers = [
      { username: 'http-tech', name: 'HTTP技术', roles: ['tech'], password: 'secret-t' },
      { username: 'http-admin', name: 'HTTP管理员', roles: ['admin'], password: 'secret-a' },
      { username: 'http-planner', name: 'HTTP计划', roles: ['planner'], password: 'secret-p' },
      { username: 'http-other-sampler', name: 'HTTP未派工采样', roles: ['sampler'], password: 'secret-s' },
    ]
    for (const user of deniedUsers) createUser(db, user)
    db.prepare(`UPDATE users SET must_change_pw=0`).run()
    db.close()

    child = spawn(process.execPath, ['src/server.ts'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, PORT: String(port), DB_PATH: dbPath, UPLOAD_DIR: uploadDir },
      stdio: 'ignore',
    })
    const base = `http://127.0.0.1:${port}`
    const login = (username: string, password: string) => loginToTestServer(base, username, password)
    await login('sampler', 'secret1')
    const route = `/api/workflows/round_sampling/${encodeURIComponent(round.id)}/submit`
    for (const user of deniedUsers) {
      const token = await login(user.username, user.password)
      const response = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
      assert.equal(response.status, 403, `${user.username} 不得提交采样工作流`)
      assert.equal((await response.json() as any).error_code, 'ROUND_SAMPLING_AUTHOR_REQUIRED')
    }
    const authorToken = await login('sampler', 'secret1')
    const accepted = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${authorToken}` } })
    assert.equal(accepted.status, 200)
    assert.equal((await accepted.json() as any).status, 'pending_review')
  } finally {
    child?.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
