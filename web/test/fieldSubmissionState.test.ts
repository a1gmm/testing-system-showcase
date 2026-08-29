import { describe, expect, test } from 'vitest'
import { submissionLocksEditing, submissionStatusText } from '../src/offline/fieldSubmissionState'

describe('field submission UI state', () => {
  test('only an idle or rejected revision without a confirmation remains editable', () => {
    expect(submissionLocksEditing('idle')).toBe(false)
    expect(submissionLocksEditing('invalid')).toBe(false)
    expect(submissionLocksEditing('rejected')).toBe(false)
    for (const status of ['queued', 'submitting', 'unknown_commit', 'pending', 'finalizing', 'complete'] as const) {
      expect(submissionLocksEditing(status)).toBe(true)
    }
    expect(submissionLocksEditing('idle', true)).toBe(true)
  })

  test('idle and queued use truthful, distinct language', () => {
    expect(submissionStatusText('idle')).toContain('尚未创建')
    expect(submissionStatusText('queued')).toContain('已冻结在本机')
    expect(submissionStatusText('queued')).not.toContain('尚未创建')
  })
})
