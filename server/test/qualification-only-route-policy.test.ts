import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasBaseBusinessRole,
  qualificationOnlyRouteAllowed,
} from '../src/qualificationOnlyRoutePolicy.ts'

test('资格专属账号只放行本人会话、四类最小待办和精确工作流办理接口', () => {
  assert.equal(hasBaseBusinessRole([]), false)
  assert.equal(hasBaseBusinessRole(['unknown-role']), false)
  assert.equal(hasBaseBusinessRole(['sampling_review']), false)
  assert.equal(hasBaseBusinessRole(['sales']), true)
  assert.equal(hasBaseBusinessRole(['unknown-role', 'planner']), true)

  const allowed: Array<[string, string]> = [
    ['POST', '/api/login'],
    ['POST', '/api/logout'],
    ['GET', '/api/me'],
    ['POST', '/api/change-password'],
    ['GET', '/api/workflow-tasks/sampling'],
    ['GET', '/api/workflow-tasks/quality'],
    ['GET', '/api/workflow-tasks/laboratory'],
    ['GET', '/api/workflow-tasks/report'],
    ['GET', '/api/workflows/round_sampling/ROUND-1'],
    ['GET', '/api/workflows/quality_plan/ROUND-1'],
    ['GET', '/api/workflows/lab_record/RECORD-1'],
    ['GET', '/api/workflows/report/REPORT-1'],
    ['POST', '/api/workflows/INSTANCE-1/decide'],
  ]
  for (const [method, path] of allowed) {
    assert.equal(qualificationOnlyRouteAllowed(method, path), true, `${method} ${path}`)
  }

  const deniedNearMisses: Array<[string, string]> = [
    ['GET', '/api/workflow-tasks'],
    ['GET', '/api/workflow-tasks/arbitrary'],
    ['POST', '/api/workflow-tasks/sampling'],
    ['GET', '/api/workflows/arbitrary/ROUND-1'],
    ['POST', '/api/workflows/round_sampling/ROUND-1/submit'],
    ['POST', '/api/workflows/INSTANCE-1/withdraw'],
    ['GET', '/api/workflows/INSTANCE-1/decide'],
    ['GET', '/api/projects'],
    ['GET', '/api/no-such-route'],
  ]
  for (const [method, path] of deniedNearMisses) {
    assert.equal(qualificationOnlyRouteAllowed(method, path), false, `${method} ${path}`)
  }
})
