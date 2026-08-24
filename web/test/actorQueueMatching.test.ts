import { expect, test } from 'vitest'
import { matchesActorWorkflowQueue } from '../src/workflow/actorQueueMatching'

const assignment = { reviewer_username: 'review-me', approver_username: 'approve-me' } as any
const workflow = (status: string, createdBy = 'author-me') => ({ status, created_by: createdBy } as any)

test('待我填写和已退回只属于精确编制账号', () => {
  expect(matchesActorWorkflowQueue('write', workflow('draft'), assignment, 'author-me')).toBe(true)
  expect(matchesActorWorkflowQueue('write', workflow('draft'), assignment, 'someone-else')).toBe(false)
  expect(matchesActorWorkflowQueue('rejected', workflow('rejected'), assignment, 'author-me')).toBe(true)
  expect(matchesActorWorkflowQueue('rejected', workflow('rejected'), assignment, 'someone-else')).toBe(false)
  expect(matchesActorWorkflowQueue('write', null, assignment, 'author-me', ['author-me'])).toBe(true)
  expect(matchesActorWorkflowQueue('write', null, assignment, 'someone-else', ['author-me'])).toBe(false)
})

test('待我复核和待我审核按精确指派账号及决策层级过滤', () => {
  expect(matchesActorWorkflowQueue('review', workflow('pending_review'), assignment, 'review-me')).toBe(true)
  expect(matchesActorWorkflowQueue('review', workflow('pending_review'), assignment, 'approve-me')).toBe(false)
  expect(matchesActorWorkflowQueue('approve', workflow('pending_approval'), assignment, 'approve-me')).toBe(true)
  expect(matchesActorWorkflowQueue('approve', workflow('pending_approval'), assignment, 'review-me')).toBe(false)
  expect(matchesActorWorkflowQueue('review', workflow('pending_approval'), assignment, 'review-me')).toBe(false)
})
