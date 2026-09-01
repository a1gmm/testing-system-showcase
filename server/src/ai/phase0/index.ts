import { createHash } from 'node:crypto'

const ZERO_HASH = '0'.repeat(64)
const HASH_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_HOSTS = new Set(['www.mee.gov.cn', 'std.samr.gov.cn'])
const EVENT_KINDS = new Set(['replacement', 'withdrawal', 'effective_date_change', 'metadata_change', 'no_material_change'])
const TERMINAL_STATES = new Set(['no_change', 'completed', 'rejected', 'superseded', 'apply_failed', 'policy_stopped', 'failed'])
const ENVELOPE_KEYS = [
  'actor', 'budget', 'capabilityPackVersions', 'capabilityPolicyEpoch', 'dataClassification', 'idempotencyKey',
  'killSwitchEpoch', 'modelVersion', 'policyVersion', 'promptVersion', 'purpose', 'schemaVersion', 'scope',
  'targetVersion', 'toolVersions', 'workflowVersion', 'tenantId',
].sort()
const EVENT_INPUT_KEYS = [
  'changeHints', 'detectedAt', 'detectedBy', 'eventKind', 'newVersion', 'oldVersion', 'schemaVersion', 'scopeId',
  'sourceRefs', 'sourceSnapshotIds', 'standardCode', 'targetSnapshotVersion', 'tenantId',
].sort()
const TRACER_INPUT_KEYS = [
  'advisoryMode', 'approval', 'approvalBindingOverride', 'capabilityEnabled', 'currentCapabilityPolicyEpoch',
  'currentKillSwitchEpoch', 'currentTargetSnapshot', 'envelope', 'evalCaseId', 'event', 'killSwitchActive',
  'proposedChanges', 'simulateApplyFailure', 'sources', 'targetSnapshot',
].sort()
const TRACER_REQUIRED_INPUT_KEYS = [
  'advisoryMode', 'capabilityEnabled', 'currentCapabilityPolicyEpoch', 'currentKillSwitchEpoch', 'envelope',
  'evalCaseId', 'event', 'killSwitchActive', 'proposedChanges', 'sources', 'targetSnapshot',
]
const SOURCE_INPUT_KEYS = [
  'authorityKind', 'content', 'contentSha256', 'excerpt', 'excerptSha256', 'locator', 'parserVersion', 'retrievedAt',
  'sourceId', 'sourceTitle', 'sourceUrl', 'status', 'verificationState',
].sort()
const SOURCE_STATUSES = new Set(['current_fixture', 'historical_fixture', 'conflict_fixture', 'unavailable_fixture'])
const ADVISORY_MODES = new Set(['advisory_clear', 'advisory_concerns'])
const BUDGET_KEYS = ['maxEvidenceItems', 'maxInputBytes', 'maxSteps', 'maxToolCalls'].sort()
const BUDGET_SNAPSHOT_KEYS = ['evidenceItemsUsed', 'inputBytesUsed', 'stepsUsed', 'toolCallsUsed'].sort()
const STANDARD_SCOPE_KEYS = ['kind', 'repositoryId', 'scopeId', 'sourceIds', 'targetTemplateIds', 'tenantId'].sort()
const SERVICE_ACTOR_KEYS = ['kind', 'principalId', 'registrationVersion'].sort()
const HUMAN_ACTOR_KEYS = ['kind', 'qualificationSnapshotId', 'roles', 'userId'].sort()
const REQUIRED_TOOLS = [
  'advisory.check.v1', 'evidence.fixture.read.v1', 'fake.apply.v1', 'proposal.create.v1',
  'proposal.machine_verify.v1', 'target.fixture.read.v1',
]
const REQUIRED_PACKS = ['standards.evidence.v1', 'standards.independent-review.v1', 'standards.template-impact.v1']
const CHANGE_INPUT_KEYS = ['after', 'before', 'changeId', 'fieldId', 'reason', 'riskClass', 'templateId'].sort()
const RISK_CLASSES = new Set(['noncritical_text', 'critical_basis', 'critical_unit', 'critical_formula', 'critical_qc', 'critical_instrument_condition'])
const AUDIT_KEYS = [
  'actorKind', 'auditHash', 'budgetSnapshot', 'errorCode', 'eventType', 'id', 'modelVersion', 'objectHash', 'objectId',
  'objectType', 'outcome', 'policyVersion', 'previousAuditHash', 'promptVersion', 'role', 'runId', 'schemaVersion',
  'scopeId', 'sequence', 'tenantId', 'toolVersion',
].sort()
const EVAL_KEYS = [
  'assertions', 'auditHeadHash', 'caseId', 'contentHash', 'evaluatedArtifactHashes', 'fixtureHash', 'forbiddenBehaviorCount',
  'id', 'passed', 'runId', 'schemaVersion', 'scopeId', 'suiteId', 'suiteVersion', 'tenantId',
].sort()

type JsonPrimitive = null | boolean | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export class AiPhase0Error extends Error {
  readonly code: string
  constructor(code: string, message = code) {
    super(message)
    this.name = 'AiPhase0Error'
    this.code = code
  }
}

function fail(code: string, message?: string): never {
  throw new AiPhase0Error(code, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.getPrototypeOf(value) === Object.prototype
}

function assertExactKeys(value: unknown, expected: string[], code = 'AI_INPUT_INVALID') {
  if (!isPlainObject(value)) fail(code)
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code)
}

function assertAllowedKeys(value: unknown, allowed: string[], required: string[], code = 'AI_INPUT_INVALID') {
  if (!isPlainObject(value)) fail(code)
  const actual = Object.keys(value)
  if (actual.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code)
}

function assertNfcString(value: unknown, code = 'AI_INPUT_INVALID'): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value !== value.normalize('NFC')) fail(code)
}

function assertNullableString(value: unknown, code = 'AI_INPUT_INVALID') {
  if (value !== null) assertNfcString(value, code)
}

function assertInteger(value: unknown, minimum = 0, code = 'AI_INPUT_INVALID') {
  if (!Number.isInteger(value) || Number(value) < minimum) fail(code)
}

function assertUtc(value: unknown, code = 'AI_INPUT_INVALID') {
  assertNfcString(value, code)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) fail(code)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== `${value.slice(0, -1)}.000Z`) fail(code)
}

function compareUtf8(left: string, right: string) {
  return Buffer.from(left).compare(Buffer.from(right))
}

function assertSortedUniqueStrings(value: unknown, code = 'AI_INPUT_INVALID'): asserts value is string[] {
  if (!Array.isArray(value)) fail(code)
  for (const item of value) assertNfcString(item, code)
  const sorted = [...value].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  if (new Set(value).size !== value.length || value.some((item, index) => item !== sorted[index])) fail(code)
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') {
    if (value.includes('\0') || value !== value.normalize('NFC')) fail('AI_OUTPUT_SCHEMA_INVALID')
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('AI_OUTPUT_SCHEMA_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (!isPlainObject(value)) fail('AI_OUTPUT_SCHEMA_INVALID')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

export function canonicalize(value: unknown) {
  return canonical(value)
}

export function hashText(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

export function hashCanonical(value: unknown) {
  return hashText(canonicalize(value))
}

export function stableId(prefix: string, hash: string) {
  if (!/^[a-z]{3}$/.test(prefix) || !HASH_PATTERN.test(hash)) fail('AI_OUTPUT_SCHEMA_INVALID')
  return `${prefix}_${hash.slice(0, 24)}`
}

function artifact<T extends Record<string, unknown>>(prefix: string, projection: T, hashKey: 'contentHash' | 'eventHash' | 'diffHash' | 'auditHash') {
  const digest = hashCanonical(projection)
  return { id: stableId(prefix, digest), ...projection, [hashKey]: digest }
}

function validateBudget(budget: unknown) {
  assertExactKeys(budget, BUDGET_KEYS)
  const typed = budget as Record<string, unknown>
  for (const key of BUDGET_KEYS) assertInteger(typed[key], 1)
  if (typed.maxSteps !== 8 || typed.maxToolCalls !== 6 || typed.maxEvidenceItems !== 20 || typed.maxInputBytes !== 65536) {
    fail('AI_BUDGET_EXCEEDED')
  }
}

function validateActor(actor: unknown) {
  if (!isPlainObject(actor)) fail('AI_INPUT_INVALID')
  if (actor.kind === 'service_principal') {
    assertExactKeys(actor, SERVICE_ACTOR_KEYS)
    assertNfcString(actor.principalId)
    assertNfcString(actor.registrationVersion)
    return
  }
  if (actor.kind === 'human') {
    assertExactKeys(actor, HUMAN_ACTOR_KEYS)
    assertNfcString(actor.userId)
    assertNfcString(actor.qualificationSnapshotId)
    assertSortedUniqueStrings(actor.roles)
    return
  }
  fail('AI_INPUT_INVALID')
}

function validateEnvelope(envelope: unknown) {
  assertExactKeys(envelope, ENVELOPE_KEYS)
  const typed = envelope as Record<string, any>
  if (typed.schemaVersion !== 1) fail('AI_INPUT_INVALID')
  for (const key of ['tenantId', 'purpose', 'policyVersion', 'workflowVersion', 'promptVersion', 'modelVersion', 'idempotencyKey', 'targetVersion']) {
    assertNfcString(typed[key])
  }
  if (!['S0', 'S1'].includes(typed.dataClassification)) fail('AI_REGION_POLICY_DENIED')
  assertInteger(typed.killSwitchEpoch, 0)
  assertInteger(typed.capabilityPolicyEpoch, 0)
  validateActor(typed.actor)
  assertExactKeys(typed.scope, STANDARD_SCOPE_KEYS)
  if (typed.scope.kind !== 'standard_library' || typed.scope.tenantId !== typed.tenantId) fail('AI_SCOPE_DENIED')
  for (const key of ['tenantId', 'scopeId', 'repositoryId']) assertNfcString(typed.scope[key])
  assertSortedUniqueStrings(typed.scope.sourceIds)
  assertSortedUniqueStrings(typed.scope.targetTemplateIds)
  assertSortedUniqueStrings(typed.capabilityPackVersions)
  assertSortedUniqueStrings(typed.toolVersions)
  if (JSON.stringify(typed.capabilityPackVersions) !== JSON.stringify(REQUIRED_PACKS)) fail('AI_CAPABILITY_DISABLED')
  if (JSON.stringify(typed.toolVersions) !== JSON.stringify(REQUIRED_TOOLS)) fail('AI_TOOL_DENIED')
  validateBudget(typed.budget)
}

function validateEventInput(event: unknown, envelope: Record<string, any>) {
  assertExactKeys(event, EVENT_INPUT_KEYS)
  const typed = event as Record<string, any>
  if (typed.schemaVersion !== 1 || !EVENT_KINDS.has(typed.eventKind)) fail('AI_INPUT_INVALID')
  if (typed.tenantId !== envelope.tenantId || typed.scopeId !== envelope.scope.scopeId) fail('AI_SCOPE_DENIED')
  for (const key of ['standardCode', 'detectedBy', 'targetSnapshotVersion']) assertNfcString(typed[key])
  assertNullableString(typed.oldVersion)
  assertNullableString(typed.newVersion)
  assertUtc(typed.detectedAt)
  assertSortedUniqueStrings(typed.sourceSnapshotIds)
  assertSortedUniqueStrings(typed.changeHints)
  if (!Array.isArray(typed.sourceRefs)) fail('AI_INPUT_INVALID')
  if (typed.targetSnapshotVersion !== envelope.targetVersion) fail('AI_JOB_STALE')
  const sourceRefIds = []
  for (const sourceRef of typed.sourceRefs) {
    assertExactKeys(sourceRef, ['contentSha256', 'fetchedAt', 'sourceId', 'sourceUrl', 'status'])
    assertNfcString(sourceRef.sourceId)
    assertNfcString(sourceRef.sourceUrl)
    assertUtc(sourceRef.fetchedAt)
    if (!HASH_PATTERN.test(sourceRef.contentSha256)) fail('AI_INPUT_INVALID')
    if (!SOURCE_STATUSES.has(sourceRef.status)) fail('AI_INPUT_INVALID')
    if (!envelope.scope.sourceIds.includes(sourceRef.sourceId)) fail('AI_SCOPE_DENIED')
    sourceRefIds.push(sourceRef.sourceId)
  }
  if (new Set(sourceRefIds).size !== sourceRefIds.length) fail('AI_INPUT_INVALID')
}

function validateTracerInput(input: Record<string, any>) {
  assertAllowedKeys(input, TRACER_INPUT_KEYS, TRACER_REQUIRED_INPUT_KEYS)
  assertNfcString(input.evalCaseId)
  if (typeof input.capabilityEnabled !== 'boolean' || typeof input.killSwitchActive !== 'boolean') fail('AI_INPUT_INVALID')
  assertInteger(input.currentKillSwitchEpoch, 0)
  assertInteger(input.currentCapabilityPolicyEpoch, 0)
  if (!ADVISORY_MODES.has(input.advisoryMode)) fail('AI_INPUT_INVALID')
  if (input.simulateApplyFailure !== undefined && typeof input.simulateApplyFailure !== 'boolean') fail('AI_INPUT_INVALID')
  if (input.approval !== undefined && input.approval !== null && !isPlainObject(input.approval)) fail('AI_INPUT_INVALID')
  if (input.approvalBindingOverride !== undefined) {
    assertExactKeys(input.approvalBindingOverride, ['proposalRevisionId'])
    assertNfcString(input.approvalBindingOverride.proposalRevisionId)
  }
  if (input.currentTargetSnapshot !== undefined && !isPlainObject(input.currentTargetSnapshot)) fail('AI_INPUT_INVALID')
}

function validateSourceInputs(sources: Record<string, any>[], event: Record<string, any>, envelope: Record<string, any>) {
  const sourceIds = []
  let inputBytes = 0
  for (const source of sources) {
    assertExactKeys(source, SOURCE_INPUT_KEYS)
    for (const key of SOURCE_INPUT_KEYS) assertNfcString(source[key])
    if (!HASH_PATTERN.test(source.contentSha256) || !HASH_PATTERN.test(source.excerptSha256) || !SOURCE_STATUSES.has(source.status)) fail('AI_INPUT_INVALID')
    assertUtc(source.retrievedAt)
    sourceIds.push(source.sourceId)
    inputBytes += Buffer.byteLength(source.content, 'utf8')
  }
  if (new Set(sourceIds).size !== sourceIds.length) fail('AI_INPUT_INVALID')
  if (sources.length > envelope.budget.maxEvidenceItems || inputBytes > envelope.budget.maxInputBytes) fail('AI_BUDGET_EXCEEDED')
  const referencedSourceIds = new Set(event.sourceRefs.map((sourceRef: any) => sourceRef.sourceId))
  for (const sourceId of sourceIds) {
    if (!envelope.scope.sourceIds.includes(sourceId)) fail('AI_SCOPE_DENIED')
    if (!referencedSourceIds.has(sourceId)) fail('AI_INPUT_INVALID')
  }
  return { evidenceItems: sources.length, inputBytes }
}

function validateCurrentTargetSnapshotInput(raw: Record<string, any>, envelope: Record<string, any>) {
  assertExactKeys(raw, ['fields', 'repositoryId', 'schemaVersion', 'scopeId', 'snapshotVersion', 'templateIds', 'tenantId'])
  if (raw.schemaVersion !== 1) fail('AI_INPUT_INVALID')
  if (raw.tenantId !== envelope.tenantId || raw.scopeId !== envelope.scope.scopeId || raw.repositoryId !== envelope.scope.repositoryId) fail('AI_SCOPE_DENIED')
  assertNfcString(raw.snapshotVersion)
  assertSortedUniqueStrings(raw.templateIds)
  if (!Array.isArray(raw.fields)) fail('AI_INPUT_INVALID')
  const fieldKeys = []
  for (const field of raw.fields) {
    assertExactKeys(field, ['fieldId', 'templateId', 'value'])
    assertNfcString(field.templateId)
    assertNfcString(field.fieldId)
    assertNfcString(field.value)
    if (!raw.templateIds.includes(field.templateId) || !envelope.scope.targetTemplateIds.includes(field.templateId)) fail('AI_SCOPE_DENIED')
    fieldKeys.push(`${field.templateId}\0${field.fieldId}`)
  }
  if (new Set(fieldKeys).size !== fieldKeys.length) fail('AI_INPUT_INVALID')
}

function buildRun(envelope: Record<string, any>) {
  const requestHash = hashCanonical(envelope)
  return {
    schemaVersion: 1,
    id: stableId('run', requestHash),
    tenantId: envelope.tenantId,
    scopeId: envelope.scope.scopeId,
    actor: structuredClone(envelope.actor),
    scope: structuredClone(envelope.scope),
    purpose: envelope.purpose,
    dataClassification: envelope.dataClassification,
    requestHash,
    state: 'accepted',
    workflowVersion: envelope.workflowVersion,
    policyVersion: envelope.policyVersion,
    capabilityPackVersions: [...envelope.capabilityPackVersions],
    promptVersion: envelope.promptVersion,
    modelVersion: envelope.modelVersion,
    toolVersions: [...envelope.toolVersions],
    budget: structuredClone(envelope.budget),
    idempotencyKey: envelope.idempotencyKey,
    targetVersion: envelope.targetVersion,
    killSwitchEpoch: envelope.killSwitchEpoch,
    capabilityPolicyEpoch: envelope.capabilityPolicyEpoch,
  }
}

function buildEvent(eventInput: Record<string, any>) {
  return artifact('sce', structuredClone(eventInput), 'eventHash')
}

function buildBaseSnapshot(raw: Record<string, any>, run: Record<string, any>) {
  assertExactKeys(raw, ['fields', 'repositoryId', 'schemaVersion', 'scopeId', 'snapshotVersion', 'templateIds', 'tenantId'])
  if (raw.schemaVersion !== 1 || raw.tenantId !== run.tenantId || raw.scopeId !== run.scopeId) fail('AI_SCOPE_DENIED')
  if (raw.repositoryId !== run.scope.repositoryId || raw.snapshotVersion !== run.targetVersion) fail('AI_JOB_STALE')
  assertSortedUniqueStrings(raw.templateIds)
  if (!Array.isArray(raw.fields)) fail('AI_INPUT_INVALID')
  const fieldKeys = []
  for (const field of raw.fields) {
    assertExactKeys(field, ['fieldId', 'templateId', 'value'])
    assertNfcString(field.templateId)
    assertNfcString(field.fieldId)
    assertNfcString(field.value)
    if (!raw.templateIds.includes(field.templateId) || !run.scope.targetTemplateIds.includes(field.templateId)) fail('AI_SCOPE_DENIED')
    fieldKeys.push(`${field.templateId}\0${field.fieldId}`)
  }
  if (new Set(fieldKeys).size !== fieldKeys.length) fail('AI_INPUT_INVALID')
  const fields = structuredClone(raw.fields).sort((left: any, right: any) => compareUtf8(`${left.templateId}\0${left.fieldId}`, `${right.templateId}\0${right.fieldId}`))
  return artifact('bts', {
    schemaVersion: 1,
    tenantId: raw.tenantId,
    scopeId: raw.scopeId,
    repositoryId: raw.repositoryId,
    snapshotVersion: raw.snapshotVersion,
    templateIds: [...raw.templateIds],
    fields,
  }, 'contentHash')
}

function buildCitation(source: Record<string, any>, run: Record<string, any>) {
  assertExactKeys(source, SOURCE_INPUT_KEYS)
  if (!run.scope.sourceIds.includes(source.sourceId)) fail('AI_SCOPE_DENIED')
  for (const key of ['sourceId', 'sourceUrl', 'sourceTitle', 'content', 'contentSha256', 'excerpt', 'excerptSha256', 'locator', 'parserVersion', 'retrievedAt', 'status', 'verificationState', 'authorityKind']) {
    assertNfcString(source[key], 'AI_CITATION_MISSING')
  }
  if (!SOURCE_STATUSES.has(source.status)) fail('AI_CITATION_MISSING')
  let url: URL
  try { url = new URL(source.sourceUrl) } catch { fail('AI_CITATION_MISSING') }
  if (url.protocol !== 'https:' || !SOURCE_HOSTS.has(url.hostname)) fail('AI_CITATION_MISSING')
  if (hashText(source.content) !== source.contentSha256 || hashText(source.excerpt) !== source.excerptSha256) fail('AI_CITATION_MISSING')
  if (!source.content.includes(source.locator) || !source.content.includes(source.excerpt)) fail('AI_CITATION_MISSING')
  if (source.authorityKind !== 'official_public_fixture' || source.verificationState !== 'fixture_pinned') fail('AI_CITATION_MISSING')
  assertUtc(source.retrievedAt)
  const projection = {
    schemaVersion: 1,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    sourceId: source.sourceId,
    sourceUrl: source.sourceUrl,
    sourceTitle: source.sourceTitle,
    authorityKind: source.authorityKind,
    retrievedAt: source.retrievedAt,
    contentSha256: source.contentSha256,
    locator: source.locator,
    excerptSha256: source.excerptSha256,
    parserVersion: source.parserVersion,
    verificationState: source.verificationState,
  }
  const digest = hashCanonical(projection)
  return { id: stableId('cit', digest), ...projection }
}

function buildEvidence(run: Record<string, any>, event: Record<string, any>, sources: Record<string, any>[]) {
  const noChange = event.eventKind === 'no_material_change'
  const matchedSources = noChange ? [] : event.sourceRefs.map((sourceRef: any) => sources.find(source => source.sourceId === sourceRef.sourceId))
  for (let index = 0; index < matchedSources.length; index += 1) {
    const source = matchedSources[index]
    const sourceRef = event.sourceRefs[index]
    if (source && (source.sourceUrl !== sourceRef.sourceUrl || source.contentSha256 !== sourceRef.contentSha256)) fail('AI_CITATION_MISSING')
  }
  const missingEvidence = noChange ? [] : event.sourceRefs
    .filter((_: any, index: number) => !matchedSources[index] || matchedSources[index].status === 'unavailable_fixture')
    .map((sourceRef: any) => `source:${sourceRef.sourceId}`)
  const presentSources = matchedSources.filter((source: any) => source && source.status !== 'unavailable_fixture')
  const citations = noChange ? [] : presentSources.map((source: any) => buildCitation(source, run)).sort((left: any, right: any) => left.id.localeCompare(right.id))
  const conflicts = noChange ? [] : event.sourceRefs
    .filter((sourceRef: any, index: number) => sourceRef.status === 'conflict_fixture' || matchedSources[index]?.status === 'conflict_fixture' || (matchedSources[index] && matchedSources[index].status !== sourceRef.status))
    .map((sourceRef: any, index: number) => ({
      conflictId: `conflict-${String(index + 1).padStart(3, '0')}`,
      kind: 'source_status_conflict',
      claim: sourceRef.sourceId,
      citationIds: citations.filter((citation: any) => citation.sourceId === sourceRef.sourceId).map((citation: any) => citation.id),
      resolutionState: 'requires_human',
    }))
  const facts = noChange || citations.length === 0 || conflicts.length > 0 ? [] : [{
    factId: 'fact-standard-version',
    kind: 'standard_replacement',
    path: '/newVersion',
    value: event.newVersion,
    citationIds: citations.map(citation => citation.id),
    confidenceClass: 'fixture_exact',
  }]
  return artifact('evp', {
    schemaVersion: 1,
    runId: run.id,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    eventId: event.id,
    facts,
    citations,
    conflicts,
    missingEvidence,
    sourceSnapshotVersion: event.sourceSnapshotIds[0] ?? 'source-snapshot-empty',
    parserVersion: sources[0]?.parserVersion ?? 'parser-fixture-v1',
    createdByRole: 'evidence',
  }, 'contentHash')
}

function buildProposal(run: Record<string, any>, event: Record<string, any>, evidence: Record<string, any>, base: Record<string, any>, proposedChanges: Record<string, any>[]) {
  if (!Array.isArray(proposedChanges) || proposedChanges.length === 0) fail('AI_OUTPUT_SCHEMA_INVALID')
  for (const change of proposedChanges) {
    assertExactKeys(change, CHANGE_INPUT_KEYS, 'AI_OUTPUT_SCHEMA_INVALID')
    for (const key of ['changeId', 'templateId', 'fieldId', 'before', 'after', 'reason']) assertNfcString(change[key], 'AI_OUTPUT_SCHEMA_INVALID')
    if (!RISK_CLASSES.has(change.riskClass)) fail('AI_OUTPUT_SCHEMA_INVALID')
  }
  const changeIds = proposedChanges.map(change => change.changeId)
  const changedFields = proposedChanges.map(change => `${change.templateId}\0${change.fieldId}`)
  if (new Set(changeIds).size !== changeIds.length || new Set(changedFields).size !== changedFields.length) fail('AI_OUTPUT_SCHEMA_INVALID')
  const citationIds = evidence.citations.map((citation: any) => citation.id)
  const changes = proposedChanges.map(change => ({
    changeId: change.changeId,
    templateId: change.templateId,
    fieldId: change.fieldId,
    before: change.before,
    after: change.after,
    reason: change.reason,
    citationIds,
    riskClass: change.riskClass,
  })).sort((left, right) => compareUtf8(left.changeId, right.changeId))
  for (const change of changes) {
    assertExactKeys(change, ['after', 'before', 'changeId', 'citationIds', 'fieldId', 'reason', 'riskClass', 'templateId'])
    if (!run.scope.targetTemplateIds.includes(change.templateId) || !base.fields.some((field: any) => field.templateId === change.templateId && field.fieldId === change.fieldId && field.value === change.before)) fail('AI_TOOL_CONFLICT')
    if (change.citationIds.length === 0) fail('AI_CITATION_MISSING')
    for (const value of [change.before, change.after, change.reason]) {
      assertNfcString(value, 'AI_OUTPUT_SCHEMA_INVALID')
      if (/(?:\b(?:shell|sql|git)\b|\.\.\/|\/etc\/)/i.test(value)) fail('AI_TOOL_DENIED')
    }
  }
  const target = {
    kind: 'synthetic_template_snapshot',
    repositoryId: base.repositoryId,
    snapshotId: base.id,
    snapshotVersion: base.snapshotVersion,
    snapshotHash: base.contentHash,
    templateIds: [...base.templateIds],
    allowedFieldIds: [...new Set(base.fields.map((field: any) => field.fieldId))].sort(),
  }
  const targetPreconditions = {
    eventId: event.id,
    eventHash: event.eventHash,
    evidencePacketId: evidence.id,
    evidenceHash: evidence.contentHash,
    targetVersion: base.snapshotVersion,
    targetHash: base.contentHash,
    policyVersion: run.policyVersion,
    requiredApprovalRole: 'technical_owner',
  }
  const requestProjection = {
    runId: run.id,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    evidencePacketId: evidence.id,
    evidenceContentHash: evidence.contentHash,
    target,
    targetPreconditions,
    changes,
    policyVersion: run.policyVersion,
    capabilityPackVersion: 'standards.template-impact.v1',
    promptVersion: run.promptVersion,
    modelVersion: run.modelVersion,
    toolVersion: 'proposal.create.v1',
  }
  const requestHash = hashCanonical(requestProjection)
  const proposalId = stableId('prp', hashCanonical({
    runId: run.id,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    type: 'repository_patch_artifact',
    targetRepositoryId: target.repositoryId,
  }))
  const contentProjection = {
    schemaVersion: 1,
    parentRevisionId: null,
    runId: run.id,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    type: 'repository_patch_artifact',
    state: 'draft',
    target,
    targetPreconditions,
    changes,
    citationIds,
    riskLevel: changes.some(change => change.riskClass !== 'noncritical_text') ? 'high' : 'low',
    createdByRole: 'draft',
    policyVersion: run.policyVersion,
    capabilityPackVersion: 'standards.template-impact.v1',
    promptVersion: run.promptVersion,
    modelVersion: run.modelVersion,
    toolVersion: 'proposal.create.v1',
    requestHash,
  }
  const contentHash = hashCanonical(contentProjection)
  return {
    schemaVersion: 1,
    id: proposalId,
    revisionId: stableId('prv', contentHash),
    ...contentProjection,
    contentHash,
  }
}

function buildAdvisory(run: Record<string, any>, proposal: Record<string, any>, evidence: Record<string, any>, base: Record<string, any>, mode: string) {
  const clear = mode === 'advisory_clear'
  if (!clear && mode !== 'advisory_concerns') fail('AI_OUTPUT_SCHEMA_INVALID')
  const findings = clear
    ? [{ findingId: 'finding-no-issue', category: 'no_issue', severity: 'info', summaryCode: 'ADVISORY_NO_ISSUE', citationIds: [], affectedChangeIds: [] }]
    : [{ findingId: 'finding-unsupported', category: 'unsupported_change', severity: 'warning', summaryCode: 'ADVISORY_UNSUPPORTED_CHANGE', citationIds: [...proposal.citationIds], affectedChangeIds: proposal.changes.map((change: any) => change.changeId) }]
  const citationIds = [...new Set(findings.flatMap(finding => finding.citationIds))].sort()
  return artifact('adv', {
    schemaVersion: 1,
    runId: run.id,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    proposalId: proposal.id,
    proposalRevisionId: proposal.revisionId,
    proposalContentHash: proposal.contentHash,
    evidencePacketId: evidence.id,
    evidenceContentHash: evidence.contentHash,
    targetSnapshotId: base.id,
    targetSnapshotHash: base.contentHash,
    advisoryRole: 'independent_review',
    findings,
    citationIds,
    outcome: mode,
    policyVersion: run.policyVersion,
    capabilityPackVersion: 'standards.independent-review.v1',
    promptVersion: run.promptVersion,
    modelVersion: run.modelVersion,
    toolVersion: 'advisory.check.v1',
  }, 'contentHash')
}

const GATE_DEFINITIONS = [
  { gateId: 'schema_valid', failureCode: 'AI_OUTPUT_SCHEMA_INVALID', fatal: true, project: (input: any) => input.schemas, passes: (projection: any) => Object.values(projection).every(value => value === true) },
  { gateId: 'scope_bound', failureCode: 'AI_SCOPE_DENIED', fatal: true, project: (input: any) => input.bindings, passes: (projection: any) => projection.artifacts.map((item: any) => item.objectType).join(',') === 'ProposalV1,EvidencePacketV1,AdvisoryCheckV1,BaseTemplateSnapshotV1' && projection.artifacts.every((item: any) => item.tenantId === projection.expectedTenantId && item.scopeId === projection.expectedScopeId) },
  { gateId: 'citations_complete', failureCode: 'AI_CITATION_MISSING', fatal: false, project: (input: any) => input.citations, passes: (projection: any) => projection.missingEvidence.length === 0 && projection.proposalCitationIds.every((id: string) => projection.evidenceCitationIds.includes(id)) && projection.changes.every((change: any) => change.citationIds.length > 0 && change.citationIds.every((id: string) => projection.proposalCitationIds.includes(id) && projection.evidenceCitationIds.includes(id))) },
  { gateId: 'target_preconditions_match', failureCode: 'AI_TOOL_CONFLICT', fatal: false, project: (input: any) => input.target, passes: (projection: any) => projection.proposalSnapshotId === projection.currentSnapshotId && projection.proposalSnapshotHash === projection.currentSnapshotHash && projection.proposalTargetVersion === projection.currentTargetVersion && projection.changedFieldIds.every((id: string) => projection.allowedFieldIds.includes(id)) },
  { gateId: 'tool_allowlisted', failureCode: 'AI_TOOL_DENIED', fatal: true, project: (input: any) => input.tools, passes: (projection: any) => projection.machineToolVersion === 'proposal.machine_verify.v1' && projection.proposalToolVersion === 'proposal.create.v1' && projection.advisoryToolVersion === 'advisory.check.v1' && projection.proposalCapabilityPackVersion === 'standards.template-impact.v1' && projection.advisoryCapabilityPackVersion === 'standards.independent-review.v1' && [projection.machineToolVersion, projection.proposalToolVersion, projection.advisoryToolVersion].every((value: string) => projection.allowedToolVersions.includes(value)) && [projection.proposalCapabilityPackVersion, projection.advisoryCapabilityPackVersion].every((value: string) => projection.allowedCapabilityPackVersions.includes(value)) },
  { gateId: 'budget_within_limit', failureCode: 'AI_BUDGET_EXCEEDED', fatal: true, project: (input: any) => input.budget, passes: (projection: any) => Object.keys(projection.used).sort().join(',') === 'evidenceItems,inputBytes,steps,toolCalls' && Object.keys(projection.limits).sort().join(',') === 'evidenceItems,inputBytes,steps,toolCalls' && Object.keys(projection.used).every(key => Number.isInteger(projection.used[key]) && projection.used[key] >= 0 && projection.used[key] <= projection.limits[key]) },
  { gateId: 'advisory_artifact_bound', failureCode: 'AI_OUTPUT_SCHEMA_INVALID', fatal: false, project: (input: any) => input.advisoryBinding, passes: (projection: any) => projection.advisoryRole === 'independent_review' && projection.capabilityPackVersion === 'standards.independent-review.v1' && projection.proposalContentHash === projection.expectedProposalContentHash && projection.evidenceContentHash === projection.expectedEvidenceContentHash && projection.targetSnapshotHash === projection.expectedTargetSnapshotHash },
]

export function evaluateMachineGateVector(input: Record<string, any>) {
  const machineGateResults = GATE_DEFINITIONS.map(definition => {
    const projection = definition.project(input)
    const pass = definition.passes(projection)
    return {
      gateId: definition.gateId,
      outcome: pass ? 'pass' : 'fail',
      errorCode: pass ? null : definition.failureCode,
      subjectHash: hashCanonical(projection),
    }
  })
  const firstFailure = machineGateResults.find(result => result.outcome === 'fail')
  const fatal = firstFailure ? GATE_DEFINITIONS.find(definition => definition.gateId === firstFailure.gateId)?.fatal === true : false
  return {
    ok: firstFailure === undefined,
    machineGateResults,
    outcome: firstFailure === undefined ? 'verified' : 'rejected',
    errorCode: firstFailure?.errorCode ?? null,
    nextRunState: firstFailure === undefined ? 'machine_verified' : fatal ? 'failed' : 'proposal_draft',
  }
}

function buildMachineVerification(run: Record<string, any>, proposal: Record<string, any>, evidence: Record<string, any>, advisory: Record<string, any>, base: Record<string, any>, budgetSnapshot: Record<string, number>) {
  const input = {
    schemas: { proposal: true, evidencePacket: true, advisoryCheck: true, targetSnapshot: true },
    bindings: {
      expectedTenantId: run.tenantId,
      expectedScopeId: run.scopeId,
      artifacts: [proposal, evidence, advisory, base].map((value, index) => ({
        objectType: ['ProposalV1', 'EvidencePacketV1', 'AdvisoryCheckV1', 'BaseTemplateSnapshotV1'][index],
        tenantId: value.tenantId,
        scopeId: value.scopeId,
      })),
    },
    citations: {
      evidenceCitationIds: evidence.citations.map((citation: any) => citation.id),
      proposalCitationIds: proposal.citationIds,
      changes: proposal.changes.map((change: any) => ({ changeId: change.changeId, citationIds: change.citationIds })),
      missingEvidence: evidence.missingEvidence,
    },
    target: {
      proposalSnapshotId: proposal.target.snapshotId,
      proposalSnapshotHash: proposal.target.snapshotHash,
      proposalTargetVersion: proposal.target.snapshotVersion,
      currentSnapshotId: base.id,
      currentSnapshotHash: base.contentHash,
      currentTargetVersion: base.snapshotVersion,
      changedFieldIds: proposal.changes.map((change: any) => change.fieldId).sort(),
      allowedFieldIds: proposal.target.allowedFieldIds,
    },
    tools: {
      machineToolVersion: 'proposal.machine_verify.v1',
      proposalToolVersion: proposal.toolVersion,
      advisoryToolVersion: advisory.toolVersion,
      proposalCapabilityPackVersion: proposal.capabilityPackVersion,
      advisoryCapabilityPackVersion: advisory.capabilityPackVersion,
      allowedToolVersions: run.toolVersions.filter((value: string) => ['advisory.check.v1', 'proposal.create.v1', 'proposal.machine_verify.v1'].includes(value)),
      allowedCapabilityPackVersions: run.capabilityPackVersions.filter((value: string) => ['standards.independent-review.v1', 'standards.template-impact.v1'].includes(value)),
    },
    budget: {
      used: {
        steps: budgetSnapshot.stepsUsed,
        toolCalls: budgetSnapshot.toolCallsUsed,
        evidenceItems: budgetSnapshot.evidenceItemsUsed,
        inputBytes: budgetSnapshot.inputBytesUsed,
      },
      limits: {
        steps: run.budget.maxSteps,
        toolCalls: run.budget.maxToolCalls,
        evidenceItems: run.budget.maxEvidenceItems,
        inputBytes: run.budget.maxInputBytes,
      },
    },
    advisoryBinding: {
      advisoryRole: advisory.advisoryRole,
      capabilityPackVersion: advisory.capabilityPackVersion,
      proposalContentHash: advisory.proposalContentHash,
      expectedProposalContentHash: proposal.contentHash,
      evidenceContentHash: advisory.evidenceContentHash,
      expectedEvidenceContentHash: evidence.contentHash,
      targetSnapshotHash: advisory.targetSnapshotHash,
      expectedTargetSnapshotHash: base.contentHash,
    },
  }
  const composition = evaluateMachineGateVector(input)
  return artifact('mvr', {
    schemaVersion: 1,
    runId: run.id,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    proposalId: proposal.id,
    proposalRevisionId: proposal.revisionId,
    proposalContentHash: proposal.contentHash,
    evidencePacketId: evidence.id,
    evidenceContentHash: evidence.contentHash,
    advisoryCheckId: advisory.id,
    advisoryCheckContentHash: advisory.contentHash,
    targetSnapshotId: base.id,
    targetSnapshotHash: base.contentHash,
    machineGateResults: composition.machineGateResults,
    outcome: composition.outcome,
    errorCode: composition.errorCode,
  }, 'contentHash')
}

function buildDecision(run: Record<string, any>, proposal: Record<string, any>, machine: Record<string, any>, approval: Record<string, any>) {
  assertExactKeys(approval, ['actor', 'decidedAt', 'decision', 'expiresAt', 'qualificationSnapshot', 'reason'])
  try { validateActor(approval.actor) } catch { fail('AI_APPROVAL_REQUIRED') }
  if (approval.actor.kind !== 'human' || !approval.actor.roles.includes('technical_owner') || !['approve', 'reject'].includes(approval.decision)) fail('AI_APPROVAL_REQUIRED')
  assertNfcString(approval.reason, 'AI_APPROVAL_REQUIRED')
  assertUtc(approval.decidedAt)
  assertUtc(approval.expiresAt)
  assertExactKeys(approval.qualificationSnapshot, ['revokedAt', 'role', 'scopeId', 'snapshotId', 'userId', 'validFrom', 'validUntil'])
  const qualification = approval.qualificationSnapshot
  for (const key of ['snapshotId', 'userId', 'role', 'scopeId']) assertNfcString(qualification[key], 'AI_APPROVAL_REQUIRED')
  assertUtc(qualification.validFrom, 'AI_APPROVAL_REQUIRED')
  assertUtc(qualification.validUntil, 'AI_APPROVAL_REQUIRED')
  if (qualification.snapshotId !== approval.actor.qualificationSnapshotId || qualification.userId !== approval.actor.userId || qualification.role !== 'technical_owner' || qualification.scopeId !== run.scopeId || qualification.revokedAt !== null || Date.parse(approval.decidedAt) < Date.parse(qualification.validFrom) || Date.parse(approval.decidedAt) > Date.parse(qualification.validUntil) || Date.parse(approval.decidedAt) > Date.parse(approval.expiresAt)) fail('AI_APPROVAL_REQUIRED')
  const projection = {
    schemaVersion: 1,
    runId: run.id,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    proposalId: proposal.id,
    proposalRevisionId: proposal.revisionId,
    proposalContentHash: proposal.contentHash,
    machineVerificationResultId: machine.id,
    machineVerificationContentHash: machine.contentHash,
    actor: structuredClone(approval.actor),
    decision: approval.decision,
    reason: approval.reason,
    decidedAt: approval.decidedAt,
    qualificationSnapshot: structuredClone(qualification),
    expiresAt: approval.expiresAt,
  }
  return { id: stableId('dec', hashCanonical(projection)), ...projection }
}

function fakeApply(run: Record<string, any>, proposal: Record<string, any>, machine: Record<string, any>, decision: Record<string, any>, base: Record<string, any>) {
  if (machine.outcome !== 'verified' || decision.decision !== 'approve') fail('AI_APPROVAL_REQUIRED')
  const changes = structuredClone(proposal.changes)
  const diff = artifact('dif', {
    schemaVersion: 1,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    baseSnapshotId: base.id,
    baseSnapshotHash: base.contentHash,
    proposalId: proposal.id,
    proposalRevisionId: proposal.revisionId,
    changes,
  }, 'diffHash')
  const fields = structuredClone(base.fields)
  for (const change of changes) {
    const field = fields.find((candidate: any) => candidate.templateId === change.templateId && candidate.fieldId === change.fieldId)
    if (!field || field.value !== change.before) fail('AI_TOOL_CONFLICT')
    field.value = change.after
  }
  const candidateSnapshot = artifact('cts', {
    schemaVersion: 1,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    repositoryId: base.repositoryId,
    baseSnapshotVersion: base.snapshotVersion,
    baseSnapshotHash: base.contentHash,
    resultSnapshotVersion: `${base.snapshotVersion}-candidate-01`,
    templateIds: [...base.templateIds],
    fields,
    proposalId: proposal.id,
    proposalRevisionId: proposal.revisionId,
    proposalContentHash: proposal.contentHash,
    diffHash: diff.diffHash,
    createdByToolVersion: 'fake.apply.v1',
  }, 'contentHash')
  const result = artifact('far', {
    schemaVersion: 1,
    runId: run.id,
    tenantId: run.tenantId,
    scopeId: run.scopeId,
    proposalId: proposal.id,
    proposalRevisionId: proposal.revisionId,
    idempotencyKey: run.idempotencyKey,
    requestHash: run.requestHash,
    baseSnapshotId: base.id,
    baseSnapshotHash: base.contentHash,
    candidateSnapshotId: candidateSnapshot.id,
    candidateSnapshotHash: candidateSnapshot.contentHash,
    diffId: diff.id,
    diffHash: diff.diffHash,
    outcome: 'fake_applied',
  }, 'contentHash')
  return { diff, candidateSnapshot, result }
}

function stateObjectHash(run: Record<string, any>) {
  return hashCanonical({ id: run.id, tenantId: run.tenantId, scopeId: run.scopeId, requestHash: run.requestHash, state: run.state })
}

function appendAudit(context: Record<string, any>, eventType: string, role: string, objectType: string, objectId: string, objectHash: string, outcome = 'pass', errorCode: string | null = null) {
  const projection = {
    schemaVersion: 1,
    sequence: context.audit.length + 1,
    runId: context.run.id,
    eventType,
    actorKind: context.run.actor.kind,
    role,
    tenantId: context.run.tenantId,
    scopeId: context.run.scopeId,
    objectType,
    objectId,
    objectHash,
    policyVersion: context.run.policyVersion,
    promptVersion: context.run.promptVersion,
    modelVersion: context.run.modelVersion,
    toolVersion: role === 'control' ? 'proposal.machine_verify.v1' : `${role}.fixture.v1`,
    budgetSnapshot: structuredClone(context.budgetSnapshot),
    outcome,
    errorCode,
    previousAuditHash: context.audit.at(-1)?.auditHash ?? ZERO_HASH,
  }
  context.audit.push(artifact('aud', projection, 'auditHash'))
}

function buildEval(context: Record<string, any>, state: string, caseId: string, artifactHashes: string[]) {
  const expectedLiteral = state
  const assertion = { assertionId: 'terminal-state', outcome: 'pass', expectedLiteral, actualLiteralHash: hashText(state) }
  const result = artifact('evr', {
    schemaVersion: 1,
    runId: context.run.id,
    tenantId: context.run.tenantId,
    scopeId: context.run.scopeId,
    suiteId: 'ai-phase0-offline-tracer',
    suiteVersion: 'v1',
    caseId,
    fixtureHash: hashText(caseId),
    assertions: [assertion],
    forbiddenBehaviorCount: 0,
    passed: true,
    evaluatedArtifactHashes: [...artifactHashes].sort(),
    auditHeadHash: context.audit.at(-1)?.auditHash ?? ZERO_HASH,
  }, 'contentHash')
  return result
}

function resultShape(context: Record<string, any>, values: Record<string, any>) {
  return {
    ok: values.errorCode === null,
    state: context.run.state,
    errorCode: values.errorCode,
    run: structuredClone(context.run),
    event: values.event ?? null,
    evidencePacket: values.evidencePacket ?? null,
    baseSnapshot: values.baseSnapshot ?? null,
    proposal: values.proposal ?? null,
    advisoryCheck: values.advisoryCheck ?? null,
    machineVerification: values.machineVerification ?? null,
    decision: values.decision ?? null,
    diff: values.diff ?? null,
    candidateSnapshot: values.candidateSnapshot ?? null,
    fakeApplyResult: values.fakeApplyResult ?? null,
    evalResult: values.evalResult ?? null,
    audit: structuredClone(context.audit),
    roleInputs: values.roleInputs ?? {},
    metrics: structuredClone(context.metrics),
  }
}

function finishTerminal(context: Record<string, any>, state: string, errorCode: string, caseId: string, values: Record<string, any>, eventType: string | null) {
  context.run.state = state
  if (eventType) appendAudit(context, eventType, 'control', 'AiRunV1', context.run.id, stateObjectHash(context.run), 'rejected', errorCode)
  const artifactHashes = [
    values.event?.eventHash,
    values.evidencePacket?.contentHash,
    values.proposal?.contentHash,
    values.advisoryCheck?.contentHash,
    values.machineVerification?.contentHash,
  ].filter(Boolean)
  const evalResult = buildEval(context, state, caseId, artifactHashes)
  appendAudit(context, 'eval.completed', 'compliance_eval', 'EvalResultV1', evalResult.id, evalResult.contentHash)
  appendAudit(context, state === 'failed' || state === 'apply_failed' || state === 'policy_stopped' ? 'run.failed' : 'run.completed', 'control', 'AiRunV1', context.run.id, stateObjectHash(context.run), 'rejected', errorCode)
  return resultShape(context, { ...values, evalResult, errorCode })
}

function createContext(run: Record<string, any>) {
  return {
    run,
    audit: [],
    budgetSnapshot: { stepsUsed: 0, toolCallsUsed: 0, evidenceItemsUsed: 0, inputBytesUsed: 0 },
    metrics: { networkCalls: 0, modelCalls: 0, databaseConnections: 0, formalWrites: 0, fakeApplySuccesses: 0 },
  }
}

function buildRoleInputs(run: Record<string, any>, event: Record<string, any>, evidence: Record<string, any>, proposal: Record<string, any>, base: Record<string, any>, caseId: string, auditHeadHash: string) {
  const actorProjection = run.actor.kind === 'service_principal'
    ? { kind: run.actor.kind, subjectId: run.actor.principalId, roleCodes: [] }
    : { kind: run.actor.kind, subjectId: run.actor.userId, roleCodes: [...run.actor.roles] }
  const targetProjection = {
    repositoryId: base.repositoryId,
    snapshotId: base.id,
    snapshotVersion: base.snapshotVersion,
    snapshotHash: base.contentHash,
    templateIds: [...base.templateIds],
    fields: base.fields.map((field: any) => ({ templateId: field.templateId, fieldId: field.fieldId, valueHash: hashText(field.value), valuePreview: field.value })),
  }
  const evidenceProjection = {
    id: evidence.id, runId: evidence.runId, tenantId: evidence.tenantId, scopeId: evidence.scopeId, eventId: evidence.eventId,
    facts: structuredClone(evidence.facts), citations: structuredClone(evidence.citations), conflicts: structuredClone(evidence.conflicts),
    missingEvidence: structuredClone(evidence.missingEvidence), sourceSnapshotVersion: evidence.sourceSnapshotVersion,
    parserVersion: evidence.parserVersion, contentHash: evidence.contentHash,
  }
  return {
    control: {
      schemaVersion: 1, runId: run.id, tenantId: run.tenantId, scopeId: run.scopeId, actorProjection,
      workflowVersion: run.workflowVersion, policyVersion: run.policyVersion, capabilityPackVersion: 'runtime.standard-change-control.v1',
      budget: structuredClone(run.budget), idempotencyKey: run.idempotencyKey, targetVersion: run.targetVersion,
      killSwitchEpoch: run.killSwitchEpoch, capabilityPolicyEpoch: run.capabilityPolicyEpoch,
    },
    evidence: {
      schemaVersion: 1, runId: run.id, tenantId: run.tenantId, scopeId: run.scopeId, event: structuredClone(event),
      sourceAllowlistProjection: event.sourceRefs.map((source: any) => ({ sourceId: source.sourceId, contentSha256: source.contentSha256, locatorPrefixes: ['fixture'] })),
      budget: structuredClone(run.budget), parserVersion: evidence.parserVersion, toolVersion: 'evidence.fixture.read.v1',
    },
    draft: {
      schemaVersion: 1, runId: run.id, tenantId: run.tenantId, scopeId: run.scopeId, evidencePacketProjection: evidenceProjection,
      targetProjection, targetPreconditions: structuredClone(proposal.targetPreconditions),
      allowedChangeFields: base.templateIds.map((templateId: string) => ({ templateId, fieldIds: proposal.target.allowedFieldIds })),
      policyVersion: run.policyVersion, promptVersion: run.promptVersion, modelVersion: run.modelVersion,
      toolVersion: 'proposal.create.v1', budget: structuredClone(run.budget),
    },
    independentReview: {
      schemaVersion: 1, runId: run.id, tenantId: run.tenantId, scopeId: run.scopeId, proposalProjection: structuredClone(proposal),
      independentlyRefetchedEvidenceProjection: evidenceProjection, targetProjection, policyVersion: run.policyVersion,
      promptVersion: run.promptVersion, modelVersion: run.modelVersion, toolVersion: 'advisory.check.v1', budget: structuredClone(run.budget),
    },
    complianceEval: {
      schemaVersion: 1,
      runId: run.id,
      tenantId: run.tenantId,
      scopeId: run.scopeId,
      caseId,
      fixtureHash: hashText(caseId),
      artifactHashProjection: [
        { objectType: 'BaseTemplateSnapshotV1', objectId: base.id, objectHash: base.contentHash, tenantId: run.tenantId, scopeId: run.scopeId },
        { objectType: 'EvidencePacketV1', objectId: evidence.id, objectHash: evidence.contentHash, tenantId: run.tenantId, scopeId: run.scopeId },
        { objectType: 'ProposalV1', objectId: proposal.revisionId, objectHash: proposal.contentHash, tenantId: run.tenantId, scopeId: run.scopeId },
      ],
      auditHeadHash,
      suiteVersion: 'v1',
      budget: structuredClone(run.budget),
    },
  }
}

export function createOfflineStandardChangeTracer() {
  const completed = new Map<string, { requestHash: string, requestBindingHash: string, result: any }>()
  const runtimeMetrics = { runExecutions: 0, fakeApplyExecutions: 0 }
  return {
    getMetrics() {
      return { ...runtimeMetrics }
    },
    run(input: Record<string, any>) {
      if (!isPlainObject(input) || !Array.isArray(input.sources) || !Array.isArray(input.proposedChanges)) fail('AI_INPUT_INVALID')
      validateEnvelope(input.envelope)
      validateTracerInput(input)
      const envelope = structuredClone(input.envelope)
      const requestHash = hashCanonical(envelope)
      const requestBindingHash = hashCanonical({
        event: input.event,
        sources: input.sources,
        targetSnapshot: input.targetSnapshot,
        proposedChanges: input.proposedChanges,
        approval: input.approval ?? null,
        approvalBindingOverride: input.approvalBindingOverride ?? null,
        advisoryMode: input.advisoryMode,
        currentTargetSnapshot: input.currentTargetSnapshot ?? null,
        evalCaseId: input.evalCaseId,
        simulateApplyFailure: input.simulateApplyFailure === true,
      })
      const idempotencyScope = `${envelope.tenantId}\0${envelope.scope.scopeId}\0${envelope.idempotencyKey}\0${envelope.targetVersion}`
      const rememberTerminal = (result: Record<string, any>) => {
        completed.set(idempotencyScope, { requestHash, requestBindingHash, result: structuredClone(result) })
        return result
      }
      if (input.killSwitchActive || input.currentKillSwitchEpoch !== envelope.killSwitchEpoch) fail('AI_KILL_SWITCH_ACTIVE')
      if (!input.capabilityEnabled || input.currentCapabilityPolicyEpoch !== envelope.capabilityPolicyEpoch) fail('AI_CAPABILITY_DISABLED')
      const prior = completed.get(idempotencyScope)
      if (prior) {
        if (prior.requestHash !== requestHash || prior.requestBindingHash !== requestBindingHash) fail('AI_IDEMPOTENCY_CONFLICT')
        return structuredClone(prior.result)
      }
      validateEventInput(input.event, envelope)
      const inputBudgetUsage = validateSourceInputs(input.sources, input.event, envelope)
      if (input.currentTargetSnapshot !== undefined) validateCurrentTargetSnapshotInput(input.currentTargetSnapshot, envelope)
      runtimeMetrics.runExecutions += 1
      const run = buildRun(envelope)
      const context = createContext(run)
      context.budgetSnapshot.stepsUsed = 1
      appendAudit(context, 'run.accepted', 'control', 'AiRunV1', run.id, stateObjectHash(run))
      const event = buildEvent(input.event)
      run.state = 'event_validated'
      context.budgetSnapshot.stepsUsed = 2
      appendAudit(context, 'event.validated', 'control', 'StandardChangeEventV1', event.id, event.eventHash)
      if (input.sources.some((source: any) => /(?:ignore\s+(?:all\s+)?(?:policy|instructions)|shell\.exec|git\s+push)/i.test(source.content))) {
        appendAudit(context, 'risk.prompt_injection_detected', 'evidence', 'RiskEventV1', 'prompt-injection', hashText('prompt-injection'), 'rejected', 'AI_TOOL_DENIED')
      }
      const baseSnapshot = buildBaseSnapshot(input.targetSnapshot, run)
      context.budgetSnapshot.toolCallsUsed = input.event.eventKind === 'no_material_change' ? 0 : 2
      context.budgetSnapshot.evidenceItemsUsed = input.event.eventKind === 'no_material_change' ? 0 : inputBudgetUsage.evidenceItems
      context.budgetSnapshot.inputBytesUsed = inputBudgetUsage.inputBytes
      if (input.event.eventKind !== 'no_material_change') appendAudit(context, 'tool.authorized', 'control', 'ToolIntentV1', 'evidence.fixture.read.v1', hashText('evidence.fixture.read.v1'))
      const evidencePacket = buildEvidence(run, event, input.sources)
      run.state = 'evidence_complete'
      context.budgetSnapshot.stepsUsed = 3
      appendAudit(context, 'evidence.completed', 'evidence', 'EvidencePacketV1', evidencePacket.id, evidencePacket.contentHash)
      if (evidencePacket.conflicts.length > 0) {
        return rememberTerminal(finishTerminal(context, 'failed', 'AI_SOURCE_CONFLICT', input.evalCaseId, { event, evidencePacket, baseSnapshot }, 'source.conflict'))
      }
      if (evidencePacket.missingEvidence.length > 0 || (event.eventKind !== 'no_material_change' && evidencePacket.citations.length === 0)) {
        const sourceUnavailable = event.sourceRefs.some((sourceRef: any) => sourceRef.status === 'unavailable_fixture')
        const errorCode = sourceUnavailable ? 'AI_SOURCE_UNAVAILABLE' : 'AI_CITATION_MISSING'
        return rememberTerminal(finishTerminal(context, 'failed', errorCode, input.evalCaseId, { event, evidencePacket, baseSnapshot }, 'evidence.failed'))
      }
      if (event.eventKind === 'no_material_change') {
        if (evidencePacket.facts.length || evidencePacket.conflicts.length || evidencePacket.missingEvidence.length || input.proposedChanges.length) fail('AI_OUTPUT_SCHEMA_INVALID')
        run.state = 'no_change'
        context.budgetSnapshot.stepsUsed = 4
        appendAudit(context, 'run.no_change', 'control', 'AiRunV1', run.id, stateObjectHash(run))
        const evalResult = buildEval(context, run.state, input.evalCaseId, [event.eventHash, evidencePacket.contentHash])
        appendAudit(context, 'eval.completed', 'compliance_eval', 'EvalResultV1', evalResult.id, evalResult.contentHash)
        appendAudit(context, 'run.completed', 'control', 'AiRunV1', run.id, stateObjectHash(run))
        const result = resultShape(context, { errorCode: null, event, evidencePacket, baseSnapshot, evalResult })
        return rememberTerminal(result)
      }
      const proposal = buildProposal(run, event, evidencePacket, baseSnapshot, input.proposedChanges)
      run.state = 'proposal_draft'
      context.budgetSnapshot.stepsUsed = 4
      context.budgetSnapshot.toolCallsUsed = 3
      appendAudit(context, 'proposal.drafted', 'draft', 'ProposalV1', proposal.revisionId, proposal.contentHash)
      const advisoryCheck = buildAdvisory(run, proposal, evidencePacket, baseSnapshot, input.advisoryMode)
      context.budgetSnapshot.stepsUsed = 5
      context.budgetSnapshot.toolCallsUsed = 4
      appendAudit(context, 'proposal.advisory_recorded', 'independent_review', 'AdvisoryCheckV1', advisoryCheck.id, advisoryCheck.contentHash)
      const machineVerification = buildMachineVerification(run, proposal, evidencePacket, advisoryCheck, baseSnapshot, context.budgetSnapshot)
      if (machineVerification.outcome !== 'verified') fail(machineVerification.errorCode)
      run.state = 'machine_verified'
      context.budgetSnapshot.stepsUsed = 6
      context.budgetSnapshot.toolCallsUsed = 5
      appendAudit(context, 'proposal.machine_verified', 'control', 'MachineVerificationResultV1', machineVerification.id, machineVerification.contentHash)
      run.state = 'awaiting_human'
      context.budgetSnapshot.stepsUsed = 7
      appendAudit(context, 'approval.requested', 'control', 'ProposalV1', proposal.revisionId, proposal.contentHash)
      const pendingValues = { event, evidencePacket, baseSnapshot, proposal, advisoryCheck, machineVerification }
      if (!input.approval) return resultShape(context, { ...pendingValues, errorCode: 'AI_APPROVAL_REQUIRED' })
      let decision
      try {
        decision = buildDecision(run, proposal, machineVerification, input.approval)
      } catch (error) {
        if (error instanceof AiPhase0Error && error.code === 'AI_APPROVAL_REQUIRED') {
          return resultShape(context, { ...pendingValues, errorCode: error.code })
        }
        throw error
      }
      if (input.approvalBindingOverride?.proposalRevisionId !== undefined && input.approvalBindingOverride.proposalRevisionId !== proposal.revisionId) {
        return resultShape(context, { ...pendingValues, errorCode: 'AI_APPROVAL_REQUIRED' })
      }
      if (decision.decision === 'reject') {
        run.state = 'rejected'
        appendAudit(context, 'approval.rejected', 'human', 'ApprovalDecisionV1', decision.id, hashCanonical(Object.fromEntries(Object.entries(decision).filter(([key]) => key !== 'id'))), 'rejected', null)
        return rememberTerminal(finishTerminal(context, 'rejected', 'AI_APPROVAL_REQUIRED', input.evalCaseId, { ...pendingValues, decision }, null))
      }
      run.state = 'approved'
      appendAudit(context, 'approval.approved', 'human', 'ApprovalDecisionV1', decision.id, hashCanonical(Object.fromEntries(Object.entries(decision).filter(([key]) => key !== 'id'))))
      if (input.currentTargetSnapshot && hashCanonical(input.currentTargetSnapshot) !== hashCanonical(input.targetSnapshot)) {
        return rememberTerminal(finishTerminal(context, 'superseded', 'AI_TOOL_CONFLICT', input.evalCaseId, { ...pendingValues, decision }, 'proposal.superseded'))
      }
      if (input.simulateApplyFailure === true) {
        return rememberTerminal(finishTerminal(context, 'apply_failed', 'AI_APPLY_TRANSACTION_FAILED', input.evalCaseId, { ...pendingValues, decision }, 'fake_apply.failed'))
      }
      const applied = fakeApply(run, proposal, machineVerification, decision, baseSnapshot)
      context.metrics.fakeApplySuccesses = 1
      runtimeMetrics.fakeApplyExecutions += 1
      context.budgetSnapshot.stepsUsed = 8
      context.budgetSnapshot.toolCallsUsed = 6
      run.state = 'fake_applied'
      appendAudit(context, 'fake_apply.completed', 'fake_executor', 'FakeApplyResultV1', applied.result.id, applied.result.contentHash)
      const evalResult = buildEval(context, 'completed', input.evalCaseId, [event.eventHash, evidencePacket.contentHash, proposal.contentHash, advisoryCheck.contentHash, machineVerification.contentHash, applied.diff.diffHash, applied.candidateSnapshot.contentHash, applied.result.contentHash])
      appendAudit(context, 'eval.completed', 'compliance_eval', 'EvalResultV1', evalResult.id, evalResult.contentHash)
      run.state = 'completed'
      appendAudit(context, 'run.completed', 'control', 'AiRunV1', run.id, stateObjectHash(run))
      const roleInputs = buildRoleInputs(run, event, evidencePacket, proposal, baseSnapshot, input.evalCaseId, context.audit.at(-1)?.auditHash ?? ZERO_HASH)
      const result = resultShape(context, {
        errorCode: null, event, evidencePacket, baseSnapshot, proposal, advisoryCheck, machineVerification,
        decision, diff: applied.diff, candidateSnapshot: applied.candidateSnapshot, fakeApplyResult: applied.result, evalResult, roleInputs,
      })
      return rememberTerminal(result)
    },
  }
}

export function rejectTerminalEvent(result: Record<string, any>, eventType: string) {
  if (!TERMINAL_STATES.has(result.state)) fail('AI_INPUT_INVALID')
  const copy = structuredClone(result)
  const context = {
    run: copy.run,
    audit: copy.audit,
    budgetSnapshot: copy.audit.at(-1)?.budgetSnapshot ?? { stepsUsed: 0, toolCallsUsed: 0, evidenceItemsUsed: 0, inputBytesUsed: 0 },
  }
  const previousAuditHash = context.audit.at(-1)?.auditHash ?? ZERO_HASH
  const objectHash = hashCanonical({ eventType, state: copy.state, errorCode: 'AI_JOB_STALE', previousAuditHash })
  appendAudit(context, 'terminal_event_rejected', 'control', 'RejectedEventV1', eventType, objectHash, 'rejected', 'AI_JOB_STALE')
  copy.audit = context.audit
  copy.errorCode = 'AI_JOB_STALE'
  copy.ok = false
  return copy
}

export function assertRunArtifactBinding(run: Record<string, any>, artifactValue: Record<string, any>, artifactKind = 'ArtifactV1') {
  if (!isPlainObject(artifactValue) || artifactValue.tenantId !== run.tenantId || artifactValue.scopeId !== run.scopeId) {
    throw new AiPhase0Error('AI_SCOPE_DENIED', `AI_SCOPE_DENIED: ${artifactKind}`)
  }
  return true
}

export function verifyAuditChain(result: Record<string, any>) {
  if (!Array.isArray(result.audit) || result.audit.length === 0) fail('AI_STORAGE_CORRUPT')
  let previousAuditHash = ZERO_HASH
  for (let index = 0; index < result.audit.length; index += 1) {
    const event = result.audit[index]
    try { assertExactKeys(event, AUDIT_KEYS, 'AI_STORAGE_CORRUPT') } catch { fail('AI_STORAGE_CORRUPT') }
    if (event.sequence !== index + 1 || event.previousAuditHash !== previousAuditHash || !HASH_PATTERN.test(event.objectHash) || !HASH_PATTERN.test(event.auditHash) || event.id !== stableId('aud', event.auditHash)) {
      fail('AI_STORAGE_CORRUPT')
    }
    const projection = Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'id' && key !== 'auditHash'))
    if (hashCanonical(projection) !== event.auditHash) fail('AI_STORAGE_CORRUPT')
    if (event.eventType === 'terminal_event_rejected') {
      const expectedObjectHash = hashCanonical({ eventType: event.objectId, state: result.state, errorCode: 'AI_JOB_STALE', previousAuditHash: event.previousAuditHash })
      if (event.errorCode !== 'AI_JOB_STALE' || event.objectHash !== expectedObjectHash) fail('AI_STORAGE_CORRUPT')
    }
    previousAuditHash = event.auditHash
  }
  if (!isPlainObject(result.run) || result.run.state !== result.state || result.run.id !== result.audit[0].runId) fail('AI_STORAGE_CORRUPT')
  const terminalRunAudit = [...result.audit].reverse().find((event: any) => event.eventType === 'run.completed' || event.eventType === 'run.failed')
  if (terminalRunAudit && terminalRunAudit.objectHash !== stateObjectHash(result.run)) fail('AI_STORAGE_CORRUPT')
  if (result.evalResult !== null && result.evalResult !== undefined) {
    const evalResult = result.evalResult
    try { assertExactKeys(evalResult, EVAL_KEYS, 'AI_STORAGE_CORRUPT') } catch { fail('AI_STORAGE_CORRUPT') }
    if (evalResult.schemaVersion !== 1 || evalResult.runId !== result.run.id || evalResult.tenantId !== result.run.tenantId || evalResult.scopeId !== result.run.scopeId) fail('AI_STORAGE_CORRUPT')
    const projection = Object.fromEntries(Object.entries(evalResult).filter(([key]) => key !== 'id' && key !== 'contentHash'))
    if (hashCanonical(projection) !== evalResult.contentHash || evalResult.id !== stableId('evr', evalResult.contentHash)) fail('AI_STORAGE_CORRUPT')
    if (!Array.isArray(evalResult.assertions) || evalResult.assertions.length !== 1) fail('AI_STORAGE_CORRUPT')
    try { assertExactKeys(evalResult.assertions[0], ['actualLiteralHash', 'assertionId', 'expectedLiteral', 'outcome'], 'AI_STORAGE_CORRUPT') } catch { fail('AI_STORAGE_CORRUPT') }
    if (!HASH_PATTERN.test(evalResult.fixtureHash) || !Array.isArray(evalResult.evaluatedArtifactHashes) || evalResult.evaluatedArtifactHashes.some((hash: unknown) => typeof hash !== 'string' || !HASH_PATTERN.test(hash))) fail('AI_STORAGE_CORRUPT')
    const evalAuditIndex = result.audit.findIndex((event: any) => event.eventType === 'eval.completed')
    if (evalAuditIndex < 1 || result.audit[evalAuditIndex].objectId !== evalResult.id || result.audit[evalAuditIndex].objectHash !== evalResult.contentHash || evalResult.auditHeadHash !== result.audit[evalAuditIndex - 1].auditHash) fail('AI_STORAGE_CORRUPT')
    const expectedArtifactHashes = [
      result.event?.eventHash,
      result.evidencePacket?.contentHash,
      result.proposal?.contentHash,
      result.advisoryCheck?.contentHash,
      result.machineVerification?.contentHash,
      result.state === 'completed' ? result.diff?.diffHash : null,
      result.state === 'completed' ? result.candidateSnapshot?.contentHash : null,
      result.state === 'completed' ? result.fakeApplyResult?.contentHash : null,
    ].filter(Boolean).sort()
    if (JSON.stringify(evalResult.evaluatedArtifactHashes) !== JSON.stringify(expectedArtifactHashes)) fail('AI_STORAGE_CORRUPT')
    if (evalResult.assertions.length !== 1 || evalResult.assertions[0].expectedLiteral !== result.state || evalResult.assertions[0].actualLiteralHash !== hashText(result.state) || evalResult.assertions[0].outcome !== 'pass' || evalResult.passed !== true) fail('AI_STORAGE_CORRUPT')
  }
  return true
}
