import type { StageQueueKey } from './businessStages'
import type { WorkflowAssignment, WorkflowView } from '../api'

export function matchesActorWorkflowQueue(
  queue: StageQueueKey,
  workflow: Pick<WorkflowView, 'status' | 'created_by'> | null | undefined,
  assignment: Pick<WorkflowAssignment, 'reviewer_username' | 'approver_username'> | null | undefined,
  actorUsername: string | undefined,
  authorUsernames: string[] = [],
) {
  if (!actorUsername) return false
  if (queue === 'write') {
    const editable = !workflow || ['draft', 'rejected', 'withdrawn'].includes(workflow.status)
    const author = workflow ? workflow.created_by === actorUsername : authorUsernames.includes(actorUsername)
    return editable && author
  }
  if (queue === 'review') return workflow?.status === 'pending_review' && assignment?.reviewer_username === actorUsername
  if (queue === 'approve') return workflow?.status === 'pending_approval' && assignment?.approver_username === actorUsername
  if (queue === 'rejected') return workflow?.status === 'rejected' && workflow.created_by === actorUsername
  return workflow?.status === 'approved'
}
