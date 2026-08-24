import { expect, test } from 'vitest'
import { confirmedArchiveScopesForRound, selectConfirmedArchive } from '../src/workflow/archiveSelection'

const archive = (id: string, version: number, reportBatchId: string | null, roundIds: string[], status = 'confirmed') => ({
  id, contract_id: 'WT-1', report_batch_id: reportBatchId, version, status,
  manifest_sha256: 'hash', readiness: { ready: true, contractId: 'WT-1', reportBatchId, roundIds, issues: [] }, items: [],
  created_by: 'archivist', created_at: `2026-08-2${version}T00:00:00.000Z`, confirmed_by: 'archivist',
  confirmed_at: '2026-08-22T01:00:00.000Z', invalidated_by: null, invalidated_at: null, invalidation_reason: null,
} as any)

test('按合同、批次和精确 roundIds 选择当前最高已确认归档版本', () => {
  const packages = [
    archive('project-v1', 1, null, ['R-1', 'R-2']),
    archive('project-v2', 2, null, ['R-1', 'R-2']),
    archive('batch-1', 1, 'BATCH-1', ['R-1']),
    archive('batch-2', 1, 'BATCH-2', ['R-2']),
    archive('invalid', 3, null, ['R-1', 'R-2'], 'invalidated'),
  ]

  expect(selectConfirmedArchive(packages, { contractId: 'WT-1', reportBatchId: null, roundIds: ['R-2', 'R-1'] })?.id).toBe('project-v2')
  expect(selectConfirmedArchive(packages, { contractId: 'WT-1', reportBatchId: 'BATCH-1', roundIds: ['R-1'] })?.id).toBe('batch-1')
  expect(selectConfirmedArchive(packages, { contractId: 'WT-1', reportBatchId: null, roundIds: ['R-1'] })).toBeNull()
  expect(selectConfirmedArchive(packages, { contractId: 'WT-1', reportBatchId: 'BATCH-1', roundIds: ['R-1', 'R-2'] })).toBeNull()
})

test('单期报告只能使用 roundIds 精确相等的已确认 scope', () => {
  const packages = [archive('whole-project', 2, null, ['R-1', 'R-2']), archive('single-round', 1, 'BATCH-R1', ['R-1'])]
  expect(selectConfirmedArchive(packages, { contractId: 'WT-1', reportBatchId: 'BATCH-R1', roundIds: ['R-1'] })?.id).toBe('single-round')
  expect(selectConfirmedArchive(packages, { contractId: 'WT-1', reportBatchId: null, roundIds: ['R-1'] })).toBeNull()
})

test('合同总报告不能把报告批次、少一期或多一期的归档误判为整项目 ready', () => {
  const packages = [
    archive('whole-project', 2, null, ['R-1', 'R-2']),
    archive('batch-total', 1, 'BATCH-1', ['R-1', 'R-2']),
  ]
  expect(selectConfirmedArchive(packages, { contractId: 'WT-1', reportBatchId: null, roundIds: ['R-1', 'R-2'] })?.id).toBe('whole-project')
  expect(selectConfirmedArchive(packages, { contractId: 'WT-1', reportBatchId: null, roundIds: ['R-1'] })).toBeNull()
  expect(selectConfirmedArchive(packages, { contractId: 'WT-1', reportBatchId: null, roundIds: ['R-1', 'R-2', 'R-3'] })).toBeNull()
  expect(selectConfirmedArchive(packages, { contractId: 'WT-1', reportBatchId: 'BATCH-1', roundIds: ['R-1', 'R-2'] })?.id).toBe('batch-total')
})

test('期次可用归档范围同时支持整项目和包含该期的报告批次并忽略已取消期次', () => {
  const packages = [
    archive('whole-project', 2, null, ['R-1', 'R-2']),
    archive('batch-r1', 1, 'BATCH-R1', ['R-1']),
    archive('wrong-batch-total', 2, 'BATCH-R1', ['R-1', 'R-2']),
  ]
  const rounds = [
    { id: 'R-1', contract_id: 'WT-1', status: 'done' },
    { id: 'R-2', contract_id: 'WT-1', status: 'done' },
    { id: 'R-CANCELLED', contract_id: 'WT-1', status: 'cancelled' },
  ] as any
  const batches = [{ id: 'BATCH-R1', contract_id: 'WT-1', name: '首批', created_by: 'planner', created_at: '', round_ids: ['R-1'] }] as any

  expect(confirmedArchiveScopesForRound(packages, batches, rounds, rounds[0]).map(scope => [scope.archive.id, scope.scopeLabel])).toEqual([
    ['whole-project', '整项目归档'],
    ['batch-r1', '报告批次：首批'],
  ])
  expect(confirmedArchiveScopesForRound(packages, batches, rounds, rounds[1]).map(scope => scope.archive.id)).toEqual(['whole-project'])
})
