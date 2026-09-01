import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  canonicalize,
  createOfflineStandardChangeTracer,
  evaluateMachineGateVector,
  hashCanonical,
  hashText,
  assertRunArtifactBinding,
  rejectTerminalEvent,
  stableId,
  verifyAuditChain,
} from '../src/ai/phase0/index.ts'

const FIXTURE_ROOT = fileURLToPath(new URL('./ai/fixtures/standards/v1/', import.meta.url))
const CONTRACT_VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL('../../ops/test/fixtures/ai-phase0-contract-vectors.json', import.meta.url)), 'utf8'))

function readCase(name: string) {
  return JSON.parse(readFileSync(`${FIXTURE_ROOT}${name}`, 'utf8'))
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const sourceContent = 'fixture basis locator: HJ 000-2026 replaces HJ 000-2020'
  const excerpt = 'HJ 000-2026 replaces HJ 000-2020'
  const contentSha256 = hashText(sourceContent)
  const excerptSha256 = hashText(excerpt)
  const envelope = {
    schemaVersion: 1,
    tenantId: 'tenant-synthetic-01',
    actor: { kind: 'service_principal', principalId: 'standards-fixture-runner', registrationVersion: 'registration-fixture-v1' },
    scope: {
      kind: 'standard_library',
      tenantId: 'tenant-synthetic-01',
      scopeId: 'standards-fixture-v1',
      repositoryId: 'repository-synthetic-01',
      sourceIds: ['mee-example'],
      targetTemplateIds: ['template-synthetic-01'],
    },
    purpose: 'offline_contract_test',
    dataClassification: 'S1',
    policyVersion: 'policy-offline-v1',
    workflowVersion: 'standard-change-tracer-v1',
    capabilityPackVersions: ['standards.evidence.v1', 'standards.independent-review.v1', 'standards.template-impact.v1'],
    promptVersion: 'prompt-fixture-v1',
    modelVersion: 'fake-provider-v1',
    toolVersions: ['advisory.check.v1', 'evidence.fixture.read.v1', 'fake.apply.v1', 'proposal.create.v1', 'proposal.machine_verify.v1', 'target.fixture.read.v1'],
    budget: { maxSteps: 8, maxToolCalls: 6, maxEvidenceItems: 20, maxInputBytes: 65536 },
    idempotencyKey: 'fixture-replacement-v1',
    targetVersion: 'templates-fixture-v1',
    killSwitchEpoch: 1,
    capabilityPolicyEpoch: 1,
  }
  const event = {
    schemaVersion: 1,
    tenantId: 'tenant-synthetic-01',
    scopeId: 'standards-fixture-v1',
    eventKind: 'replacement',
    standardCode: 'HJ 000-2026',
    oldVersion: 'HJ 000-2020',
    newVersion: 'HJ 000-2026',
    detectedBy: 'deterministic-standard-diff-v1',
    detectedAt: '2026-08-30T00:00:00Z',
    sourceSnapshotIds: ['source-snapshot-001'],
    sourceRefs: [{
      sourceId: 'mee-example',
      sourceUrl: 'https://www.mee.gov.cn/ywgz/fgbz/bz/',
      fetchedAt: '2026-08-30T00:00:00Z',
      contentSha256,
      status: 'current_fixture',
    }],
    changeHints: ['replacement'],
    targetSnapshotVersion: 'templates-fixture-v1',
  }
  const input = {
    envelope,
    event,
    sources: [{
      sourceId: 'mee-example',
      sourceUrl: 'https://www.mee.gov.cn/ywgz/fgbz/bz/',
      sourceTitle: 'MEE synthetic standards fixture',
      authorityKind: 'official_public_fixture',
      retrievedAt: '2026-08-30T00:00:00Z',
      content: sourceContent,
      contentSha256,
      locator: 'fixture basis locator',
      excerpt,
      excerptSha256,
      parserVersion: 'parser-fixture-v1',
      verificationState: 'fixture_pinned',
      status: 'current_fixture',
    }],
    targetSnapshot: {
      schemaVersion: 1,
      tenantId: 'tenant-synthetic-01',
      scopeId: 'standards-fixture-v1',
      repositoryId: 'repository-synthetic-01',
      snapshotVersion: 'templates-fixture-v1',
      templateIds: ['template-synthetic-01'],
      fields: [{ templateId: 'template-synthetic-01', fieldId: 'basis', value: 'HJ 000-2020' }],
    },
    proposedChanges: [{
      changeId: 'change-001',
      templateId: 'template-synthetic-01',
      fieldId: 'basis',
      before: 'HJ 000-2020',
      after: 'HJ 000-2026',
      reason: 'synthetic replacement fixture',
      riskClass: 'critical_basis',
    }],
    approval: {
      actor: { kind: 'human', userId: 'technical-owner-synthetic', roles: ['technical_owner'], qualificationSnapshotId: 'qualification-synthetic-01' },
      decision: 'approve',
      reason: 'synthetic approval fixture',
      decidedAt: '2026-08-30T00:10:00Z',
      expiresAt: '2026-08-30T01:10:00Z',
      qualificationSnapshot: {
        snapshotId: 'qualification-synthetic-01',
        userId: 'technical-owner-synthetic',
        role: 'technical_owner',
        scopeId: 'standards-fixture-v1',
        validFrom: '2026-08-29T00:00:00Z',
        validUntil: '2026-08-31T00:00:00Z',
        revokedAt: null,
      },
    },
    advisoryMode: 'advisory_clear',
    currentKillSwitchEpoch: 1,
    currentCapabilityPolicyEpoch: 1,
    capabilityEnabled: true,
    killSwitchActive: false,
    evalCaseId: 'T01',
  }
  return { ...input, ...overrides }
}

test('AI-0002 fixed vectors catch canonical byte, hash, or stable ID drift', () => {
  for (const vector of CONTRACT_VECTORS.vectors) {
    assert.equal(canonicalize(vector.projection), vector.expectedCanonical)
    assert.equal(hashCanonical(vector.projection), vector.expectedHash)
    assert.equal(stableId(vector.prefix, vector.expectedHash), vector.expectedId)
  }
})

test('AI-0002 production machine gate composition matches every independent literal vector byte-for-byte', () => {
  for (const testCase of CONTRACT_VECTORS.machineGateCases) {
    assert.deepEqual(evaluateMachineGateVector(testCase.input), testCase.expectedOutput)
  }
})

test('AI-0002 discovers exactly sixteen versioned scenario fixtures with literal expected outcomes', () => {
  const files = readdirSync(FIXTURE_ROOT).filter(name => /^T\d{2}-.+\.json$/.test(name)).sort()
  assert.equal(files.length, 16)
  assert.deepEqual(files.map(name => JSON.parse(readFileSync(`${FIXTURE_ROOT}${name}`, 'utf8')).caseId), Array.from({ length: 16 }, (_, index) => `T${String(index + 1).padStart(2, '0')}`))
  for (const name of files) {
    const fixture = JSON.parse(readFileSync(`${FIXTURE_ROOT}${name}`, 'utf8'))
    assert.equal(fixture.schemaVersion, 1)
    assert.equal(typeof fixture.scenario, 'string')
    assert.equal(typeof fixture.expected, 'object')
  }
})

test('T01 legal replacement completes only after advisory, seven deterministic gates, synthetic human approval, and fake apply', () => {
  const fixture = readCase('T01-legal-replacement.json')
  const tracer = createOfflineStandardChangeTracer()
  const clear = tracer.run(baseInput({ advisoryMode: fixture.advisoryModes[0] }))
  const concerns = createOfflineStandardChangeTracer().run(baseInput({ advisoryMode: fixture.advisoryModes[1] }))

  assert.equal(clear.state, fixture.expected.state)
  assert.equal(clear.errorCode, fixture.expected.errorCode)
  assert.equal(clear.proposal?.state, 'draft')
  assert.equal(clear.machineVerification?.machineGateResults.length, 7)
  assert.ok(clear.machineVerification?.machineGateResults.every(gate => gate.outcome === 'pass'))
  assert.deepEqual(clear.machineVerification?.machineGateResults, concerns.machineVerification?.machineGateResults)
  assert.equal(clear.candidateSnapshot?.fields[0].value, fixture.expected.candidateBasis)
  assert.ok(clear.proposal?.changes.every(change => change.citationIds.length > 0))
  assert.deepEqual(clear.audit.map(event => event.eventType), fixture.expected.auditEventTypes)
  assert.equal(clear.metrics.networkCalls, 0)
  assert.equal(clear.metrics.modelCalls, 0)
  assert.equal(clear.metrics.databaseConnections, 0)
  assert.equal(clear.metrics.formalWrites, 0)
  assert.equal(clear.evalResult?.passed, true)
  assert.deepEqual(Object.keys(clear.roleInputs).sort(), ['complianceEval', 'control', 'draft', 'evidence', 'independentReview'])
  const roleBytes = JSON.stringify(clear.roleInputs)
  for (const forbidden of ['qualificationSnapshot', 'registrationVersion', 'cookie', 'token', 'database', 'shell', 'git']) {
    assert.equal(roleBytes.toLowerCase().includes(forbidden.toLowerCase()), false)
  }
  assert.deepEqual(Object.keys(clear.roleInputs.complianceEval).sort(), [
    'artifactHashProjection', 'auditHeadHash', 'budget', 'caseId', 'fixtureHash', 'runId', 'schemaVersion', 'scopeId', 'suiteVersion', 'tenantId',
  ].sort())
})

test('T02 no-material-change terminates with empty evidence and cannot be rewritten by eval or a later event', () => {
  const fixture = readCase('T02-no-material-change.json')
  const noChangeEvent = { ...baseInput().event, eventKind: 'no_material_change', oldVersion: null, newVersion: null, changeHints: [] }
  const result = createOfflineStandardChangeTracer().run(baseInput({ event: noChangeEvent, proposedChanges: [], approval: null, evalCaseId: 'T02' }))

  assert.equal(result.state, fixture.expected.state)
  assert.equal(result.errorCode, fixture.expected.errorCode)
  assert.deepEqual(result.evidencePacket?.facts, [])
  assert.deepEqual(result.evidencePacket?.conflicts, [])
  assert.equal(result.proposal, null)
  assert.equal(result.fakeApplyResult, null)
  assert.deepEqual(result.audit.map(event => event.eventType), fixture.expected.auditEventTypes)
  const replay = rejectTerminalEvent(result, 'fake_apply')
  assert.equal(replay.state, 'no_change')
  assert.equal(replay.errorCode, 'AI_JOB_STALE')
  assert.equal(replay.audit.at(-1)?.eventType, 'terminal_event_rejected')
})

test('T03 stale event is rejected and post-approval target drift becomes superseded without a candidate', () => {
  const fixture = readCase('T03-stale-target.json')
  const staleEvent = { ...baseInput().event, targetSnapshotVersion: 'templates-stale-v0' }
  assert.throws(
    () => createOfflineStandardChangeTracer().run(baseInput({ event: staleEvent })),
    (error: any) => error.code === fixture.expected.staleEventCode,
  )
  const currentTargetSnapshot = structuredClone(baseInput().targetSnapshot)
  currentTargetSnapshot.fields[0].value = 'HJ 999-2099'
  const drift = createOfflineStandardChangeTracer().run(baseInput({ currentTargetSnapshot, evalCaseId: 'T03' }))
  assert.equal(drift.state, fixture.expected.driftState)
  assert.equal(drift.errorCode, fixture.expected.driftCode)
  assert.equal(drift.candidateSnapshot, null)
  assert.equal(drift.fakeApplyResult, null)
  assert.equal(drift.metrics.fakeApplySuccesses, 0)
})

test('T04 conflicting official fixtures remain explicit and fail closed for named human resolution', () => {
  const fixture = readCase('T04-source-conflict.json')
  const input = baseInput({ evalCaseId: 'T04' })
  input.sources[0].status = 'conflict_fixture'
  input.event.sourceRefs[0].status = 'conflict_fixture'
  const result = createOfflineStandardChangeTracer().run(input)
  assert.equal(result.state, fixture.expected.state)
  assert.equal(result.errorCode, fixture.expected.errorCode)
  assert.equal(result.evidencePacket?.conflicts[0].resolutionState, fixture.expected.resolutionState)
  assert.equal(result.proposal, null)

  const statusMismatchInput = baseInput({ evalCaseId: 'T04-status-mismatch' })
  statusMismatchInput.sources[0].status = 'historical_fixture'
  const statusMismatch = createOfflineStandardChangeTracer().run(statusMismatchInput)
  assert.equal(statusMismatch.state, fixture.expected.state)
  assert.equal(statusMismatch.errorCode, fixture.expected.errorCode)
  assert.equal(statusMismatch.evidencePacket?.conflicts[0].resolutionState, fixture.expected.resolutionState)
})

test('T05 a material change without a resolvable citation cannot produce a proposal', () => {
  const fixture = readCase('T05-missing-citation.json')
  const result = createOfflineStandardChangeTracer().run(baseInput({ sources: [], evalCaseId: 'T05' }))
  assert.equal(result.state, fixture.expected.state)
  assert.equal(result.errorCode, fixture.expected.errorCode)
  assert.ok(result.evidencePacket?.missingEvidence.length > 0)
  assert.equal(result.proposal, null)
})

test('T06 source host, content hash, and locator tampering are rejected instead of being treated as verified', () => {
  const fixture = readCase('T06-source-tamper.json')
  const mutations = [
    (input: any) => { input.sources[0].sourceUrl = 'https://attacker.invalid/fixture' },
    (input: any) => { input.sources[0].contentSha256 = 'f'.repeat(64) },
    (input: any) => { input.sources[0].locator = 'missing locator' },
  ]
  assert.equal(mutations.length, fixture.variants.length)
  for (const mutate of mutations) {
    const input = baseInput({ evalCaseId: 'T06' })
    mutate(input)
    assert.throws(
      () => createOfflineStandardChangeTracer().run(input),
      (error: any) => error.code === fixture.expected.errorCode,
    )
  }

  const sourceBindingMismatch = baseInput({ evalCaseId: 'T06-source-binding' })
  sourceBindingMismatch.event.sourceRefs[0].contentSha256 = 'e'.repeat(64)
  assert.throws(
    () => createOfflineStandardChangeTracer().run(sourceBindingMismatch),
    (error: any) => error.code === fixture.expected.errorCode,
  )
})

test('T07 advisory, service, AI, missing, or rejected approval never becomes a successful fake apply', () => {
  const fixture = readCase('T07-approval-boundary.json')
  const missing = createOfflineStandardChangeTracer().run(baseInput({ approval: null, evalCaseId: 'T07-missing' }))
  assert.equal(missing.state, fixture.expected.pendingState)
  assert.equal(missing.errorCode, fixture.expected.errorCode)

  const serviceApproval = structuredClone(baseInput().approval)
  serviceApproval.actor = { kind: 'service_principal', principalId: 'fake-approver', registrationVersion: 'v1' }
  const service = createOfflineStandardChangeTracer().run(baseInput({ approval: serviceApproval, evalCaseId: 'T07-service' }))
  assert.equal(service.state, fixture.expected.pendingState)
  assert.equal(service.errorCode, fixture.expected.errorCode)

  const aiApproval = structuredClone(baseInput().approval)
  aiApproval.actor = { kind: 'ai_role', roleId: 'independent_review' }
  const ai = createOfflineStandardChangeTracer().run(baseInput({ approval: aiApproval, evalCaseId: 'T07-ai' }))
  assert.equal(ai.state, fixture.expected.pendingState)
  assert.equal(ai.errorCode, fixture.expected.errorCode)

  const wrongRevision = createOfflineStandardChangeTracer().run(baseInput({
    approvalBindingOverride: { proposalRevisionId: 'prv_000000000000000000000000' },
    evalCaseId: 'T07-wrong-revision',
  }))
  assert.equal(wrongRevision.state, fixture.expected.pendingState)
  assert.equal(wrongRevision.errorCode, fixture.expected.errorCode)

  const invalidQualificationDateApproval = structuredClone(baseInput().approval)
  invalidQualificationDateApproval.qualificationSnapshot.validUntil = 'not-a-date'
  const invalidQualificationDate = createOfflineStandardChangeTracer().run(baseInput({ approval: invalidQualificationDateApproval, evalCaseId: 'T07-invalid-date' }))
  assert.equal(invalidQualificationDate.state, fixture.expected.pendingState)
  assert.equal(invalidQualificationDate.errorCode, fixture.expected.errorCode)

  const rejectedApproval = structuredClone(baseInput().approval)
  rejectedApproval.decision = 'reject'
  const rejected = createOfflineStandardChangeTracer().run(baseInput({ approval: rejectedApproval, evalCaseId: 'T07-reject' }))
  assert.equal(rejected.state, fixture.expected.rejectedState)
  assert.equal(rejected.fakeApplyResult, null)
  const invalidResults = [missing, service, ai, wrongRevision]
  assert.equal(invalidResults.length, fixture.invalidActors.length)
  assert.equal(invalidResults.reduce((total, result) => total + result.metrics.fakeApplySuccesses, 0) + rejected.metrics.fakeApplySuccesses, fixture.expected.invalidApplySuccesses)
})

test('T08 every artifact parent is rejected before cross-tenant or cross-scope data can be read', () => {
  const fixture = readCase('T08-scope-isolation.json')
  const result = createOfflineStandardChangeTracer().run(baseInput({ evalCaseId: 'T08' }))
  const artifacts = [result.evidencePacket.citations[0], result.advisoryCheck, result.machineVerification, result.decision, result.diff, result.candidateSnapshot, result.fakeApplyResult, result.evalResult]
  assert.equal(artifacts.length, fixture.artifactKinds.length)
  let successfulReads = 0
  for (let index = 0; index < artifacts.length; index += 1) {
    const mutated = structuredClone(artifacts[index])
    if (index % 2 === 0) mutated.tenantId = 'tenant-other'
    else mutated.scopeId = 'scope-other'
    try {
      assertRunArtifactBinding(result.run, mutated, fixture.artifactKinds[index])
      successfulReads += 1
    } catch (error: any) {
      assert.equal(error.code, fixture.expected.errorCode)
    }
  }
  assert.equal(successfulReads, fixture.expected.successfulReads)
})

test('T09 prompt injection remains untrusted content and cannot alter the fixed DAG or tool set', () => {
  const fixture = readCase('T09-prompt-injection.json')
  const input = baseInput({ evalCaseId: 'T09' })
  input.sources[0].content += ` ${fixture.payload}`
  input.sources[0].contentSha256 = hashText(input.sources[0].content)
  input.event.sourceRefs[0].contentSha256 = input.sources[0].contentSha256
  const result = createOfflineStandardChangeTracer().run(input)
  assert.equal(result.state, fixture.expected.state)
  assert.ok(result.audit.some((event: any) => event.eventType === fixture.expected.riskEvent))
  assert.deepEqual(result.run.toolVersions, baseInput().envelope.toolVersions)
  assert.equal(result.metrics.formalWrites, fixture.expected.formalWrites)
})

test('T10 an unregistered tool or enlarged budget fails before any formal write', () => {
  const fixture = readCase('T10-tool-budget.json')
  const toolEnvelope = structuredClone(baseInput().envelope)
  toolEnvelope.toolVersions = [...toolEnvelope.toolVersions, 'shell.exec.v1'].sort()
  assert.throws(
    () => createOfflineStandardChangeTracer().run(baseInput({ envelope: toolEnvelope })),
    (error: any) => error.code === fixture.expected.toolCode,
  )
  const budgetEnvelope = structuredClone(baseInput().envelope)
  budgetEnvelope.budget.maxSteps = 9
  assert.throws(
    () => createOfflineStandardChangeTracer().run(baseInput({ envelope: budgetEnvelope })),
    (error: any) => error.code === fixture.expected.budgetCode,
  )

  const duplicateTargetField = baseInput()
  duplicateTargetField.targetSnapshot.fields.push(structuredClone(duplicateTargetField.targetSnapshot.fields[0]))
  assert.throws(
    () => createOfflineStandardChangeTracer().run(duplicateTargetField),
    (error: any) => error.code === 'AI_INPUT_INVALID',
  )

  const unknownChangeField = baseInput()
  unknownChangeField.proposedChanges[0].script = 'noop'
  assert.throws(
    () => createOfflineStandardChangeTracer().run(unknownChangeField),
    (error: any) => error.code === 'AI_OUTPUT_SCHEMA_INVALID',
  )

  const duplicateChange = baseInput()
  duplicateChange.proposedChanges.push(structuredClone(duplicateChange.proposedChanges[0]))
  assert.throws(
    () => createOfflineStandardChangeTracer().run(duplicateChange),
    (error: any) => error.code === 'AI_OUTPUT_SCHEMA_INVALID',
  )

  assert.throws(
    () => createOfflineStandardChangeTracer().run(baseInput({ proposedChanges: [] })),
    (error: any) => error.code === 'AI_OUTPUT_SCHEMA_INVALID',
  )
})

test('T11 S4-like input is denied before any provider cutover and its value is absent from the error', () => {
  const fixture = readCase('T11-s4-rejection.json')
  const envelope = structuredClone(baseInput().envelope)
  envelope.dataClassification = 'S4'
  assert.throws(
    () => createOfflineStandardChangeTracer().run(baseInput({ envelope, syntheticSecret: fixture.secret })),
    (error: any) => error.code === fixture.expected.errorCode && !String(error).includes(fixture.secret),
  )
})

test('T12 an exact replay returns identical IDs and result without a second fake apply execution', () => {
  const fixture = readCase('T12-idempotent-replay.json')
  const tracer = createOfflineStandardChangeTracer()
  const first = tracer.run(baseInput({ evalCaseId: 'T12' }))
  const beforeReplay = tracer.getMetrics()
  const second = tracer.run(baseInput({ evalCaseId: 'T12' }))
  const afterReplay = tracer.getMetrics()
  assert.equal(first.state, fixture.expected.state)
  assert.equal(first.run.id, second.run.id)
  assert.equal(first.proposal.id, second.proposal.id)
  assert.equal(first.fakeApplyResult.id, second.fakeApplyResult.id)
  assert.deepEqual(first.audit, second.audit)
  assert.equal(afterReplay.fakeApplyExecutions, fixture.expected.fakeApplyExecutions)
  assert.equal(afterReplay.fakeApplyExecutions - beforeReplay.fakeApplyExecutions, fixture.expected.newReplaySideEffects)
})

test('T13 the same scoped key with a different canonical request is rejected without changing the original result', () => {
  const fixture = readCase('T13-key-conflict.json')
  const tracer = createOfflineStandardChangeTracer()
  const original = tracer.run(baseInput({ evalCaseId: 'T13' }))
  const changedEnvelope = structuredClone(baseInput().envelope)
  changedEnvelope.purpose = 'different_offline_contract_test'
  assert.throws(
    () => tracer.run(baseInput({ envelope: changedEnvelope, evalCaseId: 'T13-conflict' })),
    (error: any) => error.code === fixture.expected.errorCode,
  )
  const changedEvent = structuredClone(baseInput().event)
  changedEvent.standardCode = 'HJ 999-2099'
  assert.throws(
    () => tracer.run(baseInput({ event: changedEvent, evalCaseId: 'T13-event-conflict' })),
    (error: any) => error.code === fixture.expected.errorCode,
  )
  assert.equal(original.state, fixture.expected.originalState)
  assert.equal(tracer.getMetrics().fakeApplyExecutions, 1)
})

test('T14 a disabled capability, active kill switch, or stale fencing epoch starts no execution', () => {
  const fixture = readCase('T14-kill-switch.json')
  const variants = [
    { overrides: { killSwitchActive: true }, code: fixture.expected.killCode },
    { overrides: { currentKillSwitchEpoch: 2 }, code: fixture.expected.killCode },
    { overrides: { capabilityEnabled: false }, code: fixture.expected.disabledCode },
    { overrides: { currentCapabilityPolicyEpoch: 2 }, code: fixture.expected.disabledCode },
  ]
  for (const variant of variants) {
    const tracer = createOfflineStandardChangeTracer()
    assert.throws(
      () => tracer.run(baseInput(variant.overrides)),
      (error: any) => error.code === variant.code,
    )
    assert.equal(tracer.getMetrics().runExecutions, fixture.expected.executions)
    assert.equal(tracer.getMetrics().fakeApplyExecutions, fixture.expected.executions)
  }
})

test('T15 audit sequence, previous hash, and payload tampering fail closed while terminal replay preserves state', () => {
  const fixture = readCase('T15-audit-terminal-tamper.json')
  const result = createOfflineStandardChangeTracer().run(baseInput({ evalCaseId: 'T15' }))
  assert.equal(verifyAuditChain(result), true)
  const mutations = [
    (copy: any) => { copy.audit[1].sequence = 99 },
    (copy: any) => { copy.audit[1].previousAuditHash = 'f'.repeat(64) },
    (copy: any) => { copy.audit[1].objectHash = 'e'.repeat(64) },
    (copy: any) => { copy.evalResult.auditHeadHash = 'd'.repeat(64) },
    (copy: any) => { copy.evalResult.evaluatedArtifactHashes[0] = 'c'.repeat(64) },
    (copy: any) => { copy.evalResult.assertions[0].unknown = true },
    (copy: any) => { copy.run.state = 'rejected' },
  ]
  for (const mutate of mutations) {
    const copy = structuredClone(result)
    mutate(copy)
    assert.throws(() => verifyAuditChain(copy), (error: any) => error.code === fixture.expected.storageCode)
  }
  const replay = rejectTerminalEvent(result, 'eval_pass')
  assert.equal(replay.state, result.state)
  assert.equal(replay.errorCode, fixture.expected.terminalCode)
  assert.equal(verifyAuditChain(replay), true)
  const terminalTamper = structuredClone(replay)
  terminalTamper.audit.at(-1).objectHash = hashCanonical({ eventType: 'different-event', state: terminalTamper.state })
  terminalTamper.audit.at(-1).auditHash = hashCanonical(Object.fromEntries(Object.entries(terminalTamper.audit.at(-1)).filter(([key]) => key !== 'id' && key !== 'auditHash')))
  terminalTamper.audit.at(-1).id = stableId('aud', terminalTamper.audit.at(-1).auditHash)
  assert.throws(() => verifyAuditChain(terminalTamper), (error: any) => error.code === fixture.expected.storageCode)
})

test('closed RFC3339 input rejects impossible calendar dates before a run is created', () => {
  const input = baseInput()
  input.event.detectedAt = '2026-02-31T00:00:00Z'
  assert.throws(
    () => createOfflineStandardChangeTracer().run(input),
    (error: any) => error.code === 'AI_INPUT_INVALID',
  )
  assert.throws(
    () => createOfflineStandardChangeTracer().run(baseInput({ sources: null })),
    (error: any) => error.code === 'AI_INPUT_INVALID',
  )
})

test('closed tracer input rejects unknown fields, malformed controls, and unreferenced or duplicate sources', () => {
  assert.throws(
    () => createOfflineStandardChangeTracer().run(baseInput({ unexpectedTopLevelField: true })),
    (error: any) => error.code === 'AI_INPUT_INVALID',
  )

  for (const overrides of [
    { capabilityEnabled: 'true' },
    { killSwitchActive: 0 },
    { currentKillSwitchEpoch: 1.5 },
    { currentCapabilityPolicyEpoch: -1 },
    { advisoryMode: 'unknown-mode' },
    { simulateApplyFailure: 'false' },
  ]) {
    assert.throws(
      () => createOfflineStandardChangeTracer().run(baseInput(overrides)),
      (error: any) => error.code === 'AI_INPUT_INVALID',
    )
  }

  const unreferencedSource = baseInput()
  unreferencedSource.envelope.scope.sourceIds = ['extra-source', 'mee-example']
  unreferencedSource.sources.push({ ...structuredClone(unreferencedSource.sources[0]), sourceId: 'extra-source' })
  assert.throws(
    () => createOfflineStandardChangeTracer().run(unreferencedSource),
    (error: any) => error.code === 'AI_INPUT_INVALID',
  )

  const duplicateSource = baseInput()
  duplicateSource.sources.push(structuredClone(duplicateSource.sources[0]))
  assert.throws(
    () => createOfflineStandardChangeTracer().run(duplicateSource),
    (error: any) => error.code === 'AI_INPUT_INVALID',
  )

  const malformedNoChangeSource = baseInput()
  malformedNoChangeSource.event = { ...malformedNoChangeSource.event, eventKind: 'no_material_change', oldVersion: null, newVersion: null, changeHints: [] }
  malformedNoChangeSource.proposedChanges = []
  malformedNoChangeSource.approval = null
  malformedNoChangeSource.sources[0].unknown = true
  assert.throws(
    () => createOfflineStandardChangeTracer().run(malformedNoChangeSource),
    (error: any) => error.code === 'AI_INPUT_INVALID',
  )
})

test('runtime evidence and byte budgets stop before a run is created', () => {
  const tracer = createOfflineStandardChangeTracer()
  const oversized = baseInput()
  oversized.sources[0].content = 'x'.repeat(65537)
  oversized.sources[0].contentSha256 = hashText(oversized.sources[0].content)
  oversized.event.sourceRefs[0].contentSha256 = oversized.sources[0].contentSha256
  assert.throws(
    () => tracer.run(oversized),
    (error: any) => error.code === 'AI_BUDGET_EXCEEDED',
  )
  assert.equal(tracer.getMetrics().runExecutions, 0)

  const tooManySources = baseInput()
  tooManySources.envelope.scope.sourceIds = Array.from({ length: 21 }, (_, index) => `source-${String(index + 1).padStart(2, '0')}`)
  tooManySources.event.sourceRefs = []
  tooManySources.sources = Array.from({ length: 21 }, (_, index) => ({
    ...structuredClone(baseInput().sources[0]),
    sourceId: `source-${String(index + 1).padStart(2, '0')}`,
  }))
  assert.throws(
    () => createOfflineStandardChangeTracer().run(tooManySources),
    (error: any) => error.code === 'AI_BUDGET_EXCEEDED',
  )
})

test('eval case identity participates in the scoped idempotency binding', () => {
  const tracer = createOfflineStandardChangeTracer()
  tracer.run(baseInput({ evalCaseId: 'T13-eval-a' }))
  assert.throws(
    () => tracer.run(baseInput({ evalCaseId: 'T13-eval-b' })),
    (error: any) => error.code === 'AI_IDEMPOTENCY_CONFLICT',
  )
  assert.throws(
    () => tracer.run(baseInput({ evalCaseId: 'T13-eval-a', approvalBindingOverride: { proposalRevisionId: 'prv_changed' } })),
    (error: any) => error.code === 'AI_IDEMPOTENCY_CONFLICT',
  )
  assert.equal(tracer.getMetrics().fakeApplyExecutions, 1)
})

test('kill switch and capability fencing apply before a terminal idempotent replay is returned', () => {
  const tracer = createOfflineStandardChangeTracer()
  tracer.run(baseInput({ evalCaseId: 'T14-replay-fence' }))
  assert.throws(
    () => tracer.run(baseInput({ evalCaseId: 'T14-replay-fence', killSwitchActive: true })),
    (error: any) => error.code === 'AI_KILL_SWITCH_ACTIVE',
  )
  assert.throws(
    () => tracer.run(baseInput({ evalCaseId: 'T14-replay-fence', capabilityEnabled: false })),
    (error: any) => error.code === 'AI_CAPABILITY_DISABLED',
  )
  assert.deepEqual(tracer.getMetrics(), { runExecutions: 1, fakeApplyExecutions: 1 })
})

test('T16 unavailable upstream and fake executor failure preserve the base and commit no partial candidate', () => {
  const fixture = readCase('T16-upstream-apply-failure.json')
  const unavailableInput = baseInput({ evalCaseId: 'T16-source' })
  unavailableInput.sources[0].status = 'unavailable_fixture'
  unavailableInput.event.sourceRefs[0].status = 'unavailable_fixture'
  const unavailable = createOfflineStandardChangeTracer().run(unavailableInput)
  assert.equal(unavailable.state, fixture.expected.sourceState)
  assert.equal(unavailable.errorCode, fixture.expected.sourceCode)
  assert.equal(unavailable.proposal, null)

  const failureTracer = createOfflineStandardChangeTracer()
  const failedInput = baseInput({ simulateApplyFailure: true, evalCaseId: 'T16-apply' })
  const applyFailure = failureTracer.run(failedInput)
  assert.equal(applyFailure.state, fixture.expected.applyState)
  assert.equal(applyFailure.errorCode, fixture.expected.applyCode)
  assert.equal(applyFailure.diff, null)
  assert.equal(applyFailure.candidateSnapshot, null)
  assert.equal(applyFailure.fakeApplyResult, null)
  assert.equal(applyFailure.metrics.fakeApplySuccesses, 0)
  assert.deepEqual(applyFailure.baseSnapshot.fields, baseInput().targetSnapshot.fields.map((field: any) => ({ ...field })))
  const replay = failureTracer.run(failedInput)
  assert.deepEqual(replay, applyFailure)
  assert.equal(failureTracer.getMetrics().runExecutions, 1)
  assert.throws(
    () => failureTracer.run(baseInput({ simulateApplyFailure: false, evalCaseId: 'T16-apply' })),
    (error: any) => error.code === 'AI_IDEMPOTENCY_CONFLICT',
  )
})
