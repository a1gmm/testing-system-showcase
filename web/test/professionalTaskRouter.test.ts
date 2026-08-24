import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  tasks: vi.fn(),
  actor: { username: 'qualified-only', name: '资格专员', roles: ['sales'], status: 'active', created_at: '' },
}))

vi.mock('../src/api', () => ({
  currentUser: { value: mocks.actor },
  getToken: () => 'task-token',
  hasRole: (...roles: string[]) => roles.some(role => mocks.actor.roles.includes(role)),
  api: { me: vi.fn(), listWorkflowTasks: mocks.tasks },
}))

import router from '../src/router'

const task = (scope: 'sampling' | 'quality', level: 'review' | 'approve') => ({
  workflow_instance_id: `WF-${scope}`, subject_type: scope === 'sampling' ? 'round_sampling' : 'quality_plan',
  subject_id: `ROUND-${scope}`, contract_id: `WT-${scope}`, status: level === 'review' ? 'pending_review' : 'pending_approval',
  current_revision: 1, decision_level: level, acting_capacity: scope === 'sampling' ? (level === 'review' ? '采样复核' : '采样审核') : (level === 'review' ? '质控复核' : '质控审核'),
})

beforeEach(async () => {
  mocks.tasks.mockReset().mockResolvedValue([])
  await router.replace('/dashboard')
})

test('资格专属受派人只能凭精确 scope 和层级进入采样或质控聚焦队列', async () => {
  mocks.tasks.mockImplementation(async (scope: string) => scope === 'sampling' ? [task('sampling', 'review')] : [task('quality', 'approve')])
  await router.push('/plans?stage=sampling&queue=review')
  expect(router.currentRoute.value.fullPath).toBe('/plans?stage=sampling&queue=review')
  await router.push('/qc?stage=quality&queue=approve')
  expect(router.currentRoute.value.fullPath).toBe('/qc?stage=quality&queue=approve')
})

test('未指派账号和非精确专业队列不能借 capability 进入基础岗位页面', async () => {
  mocks.tasks.mockResolvedValue([task('sampling', 'review')])
  await router.push('/plans?stage=sampling&queue=approve')
  expect(router.currentRoute.value.fullPath).toBe('/dashboard')
  await router.push('/plans?stage=dispatch&queue=review')
  expect(router.currentRoute.value.fullPath).toBe('/dashboard')
  mocks.tasks.mockResolvedValue([])
  await router.push('/qc?stage=quality&queue=review')
  expect(router.currentRoute.value.fullPath).toBe('/dashboard')
})
