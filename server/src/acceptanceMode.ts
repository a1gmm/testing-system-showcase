import type { DB } from './db.ts'

type ActorIdentity = { username?: string; name?: string }
type WorkflowAssignmentIdentity = { reviewer_username: string; approver_username: string } | null | undefined

function configuredUsername() {
  return String(process.env.ACCEPTANCE_SINGLE_ACTOR_USERNAME || '').trim()
}

function configuredUntil() {
  return String(process.env.ACCEPTANCE_SINGLE_ACTOR_UNTIL || '').trim()
}

export function isSingleActorAcceptance(db: DB, actor: ActorIdentity): boolean {
  const username = configuredUsername()
  const until = configuredUntil()
  const expiresAt = Date.parse(until)
  if (!username || actor.username !== username || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false
  const stored = db.prepare(`SELECT roles,status FROM users WHERE username=?`).get(username) as { roles: string; status: string } | undefined
  if (!stored || stored.status !== 'active') return false
  try {
    const roles = JSON.parse(stored.roles)
    return Array.isArray(roles) && roles.includes('admin')
  } catch {
    return false
  }
}

export function isSingleActorWorkflowAssignment(
  db: DB,
  actor: ActorIdentity,
  assignment: WorkflowAssignmentIdentity,
): boolean {
  return isSingleActorAcceptance(db, actor)
    && !!actor.username
    && assignment?.reviewer_username === actor.username
    && assignment.approver_username === actor.username
}

export function recordAcceptanceOverride(
  db: DB,
  actor: ActorIdentity,
  action: string,
  recordId: string,
  normalRule: string,
  detail: Record<string, unknown> = {},
) {
  if (!isSingleActorAcceptance(db, actor)) return false
  const stored = db.prepare(`SELECT name FROM users WHERE username=?`).get(actor.username!) as { name: string } | undefined
  db.prepare(`INSERT INTO audit_log (record_id,who,username,action,detail,at) VALUES (?,?,?,?,?,?)`).run(
    recordId,
    stored?.name || actor.name || actor.username,
    actor.username,
    `acceptance_override_${action}`,
    JSON.stringify({
      acceptanceMode: 'single_actor',
      configuredUsername: configuredUsername(),
      expiresAt: configuredUntil(),
      normalRule,
      ...detail,
    }),
    new Date().toISOString(),
  )
  return true
}
