import { ROLE_CODES } from './handlers.ts'

const BUSINESS_ROLES = new Set(ROLE_CODES)
const TASK_ROUTE = /^\/api\/workflow-tasks\/(sampling|quality|laboratory|report)$/
const WORKFLOW_VIEW_ROUTE = /^\/api\/workflows\/(round_sampling|quality_plan|lab_record|report)\/[^/]+$/
const WORKFLOW_DECISION_ROUTE = /^\/api\/workflows\/[^/]+\/decide$/

/** Accounts without an authorised base job role are professional-decision actors. */
export function hasBaseBusinessRole(roles: readonly string[]): boolean {
  return roles.some(role => BUSINESS_ROLES.has(role))
}

/** Fail-closed allowlist; workflow services still enforce exact assignment and qualification. */
export function qualificationOnlyRouteAllowed(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  if (verb === 'POST' && ['/api/login', '/api/logout', '/api/change-password'].includes(path)) return true
  if (verb === 'GET' && path === '/api/me') return true
  if (verb === 'GET' && TASK_ROUTE.test(path)) return true
  if (verb === 'GET' && WORKFLOW_VIEW_ROUTE.test(path)) return true
  return verb === 'POST' && WORKFLOW_DECISION_ROUTE.test(path)
}
