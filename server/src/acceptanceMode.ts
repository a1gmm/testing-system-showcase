import type { DB } from './db.ts'

type ActorIdentity = { username?: string; name?: string }
type WorkflowAssignmentIdentity = { reviewer_username: string; approver_username: string } | null | undefined
export type AcceptanceGrant = {
  username: string
  name: string
  configuredUsername: string
  expiresAt: string
  capturedAt: string
}

function configuredUsername() {
  return String(process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME || '').trim()
}

function configuredUntil() {
  return String(process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL || '').trim()
}

export function captureSingleActorAcceptance(
  db: DB,
  actor: ActorIdentity,
  nowMs = Date.now(),
): AcceptanceGrant | null {
  const username = configuredUsername()
  const until = configuredUntil()
  const expiresAt = Date.parse(until)
  if (!username || actor.username !== username || !Number.isFinite(expiresAt) || expiresAt <= nowMs) return null
  const stored = db.prepare(`SELECT name,roles,status FROM users WHERE username=?`).get(username) as { name: string; roles: string; status: string } | undefined
  if (!stored || stored.status !== 'active') return null
  try {
    const roles = JSON.parse(stored.roles)
    if (!Array.isArray(roles) || !roles.includes('admin')) return null
    return {
      username,
      name: stored.name || actor.name || username,
      configuredUsername: username,
      expiresAt: until,
      capturedAt: new Date(nowMs).toISOString(),
    }
  } catch {
    return null
  }
}

export function isSingleActorAcceptance(db: DB, actor: ActorIdentity): boolean {
  return captureSingleActorAcceptance(db, actor) !== null
}

export function captureSingleActorWorkflowAcceptance(
  db: DB,
  actor: ActorIdentity,
  assignment: WorkflowAssignmentIdentity,
  nowMs = Date.now(),
): AcceptanceGrant | null {
  const grant = captureSingleActorAcceptance(db, actor, nowMs)
  return grant
    && assignment?.reviewer_username === grant.username
    && assignment.approver_username === grant.username
    ? grant
    : null
}

export function isSingleActorWorkflowAssignment(
  db: DB,
  actor: ActorIdentity,
  assignment: WorkflowAssignmentIdentity,
): boolean {
  return captureSingleActorWorkflowAcceptance(db, actor, assignment) !== null
}

export function recordAcceptanceOverride(
  db: DB,
  grant: AcceptanceGrant,
  action: string,
  recordId: string,
  normalRule: string,
  detail: Record<string, unknown> = {},
) {
  db.prepare(`INSERT INTO audit_log (record_id,who,username,action,detail,at) VALUES (?,?,?,?,?,?)`).run(
    recordId,
    grant.name,
    grant.username,
    `acceptance_override_${action}`,
    JSON.stringify({
      acceptanceMode: 'single_actor',
      configuredUsername: grant.configuredUsername,
      expiresAt: grant.expiresAt,
      grantCapturedAt: grant.capturedAt,
      normalRule,
      ...detail,
    }),
    grant.capturedAt,
  )
}
