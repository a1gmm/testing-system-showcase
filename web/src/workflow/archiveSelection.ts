import type { ArchivePackage, ReportBatch } from '../api'

export type ArchiveSelectionScope = {
  contractId: string
  reportBatchId: string | null
  roundIds: string[]
}

function sameIds(left: string[], right: string[]) {
  const a = [...new Set(left)].sort()
  const b = [...new Set(right)].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function selectConfirmedArchive(packages: ArchivePackage[], scope: ArchiveSelectionScope): ArchivePackage | null {
  return packages
    .filter(item => item.status === 'confirmed'
      && item.contract_id === scope.contractId
      && item.report_batch_id === scope.reportBatchId
      && sameIds(item.readiness.roundIds, scope.roundIds))
    .sort((a, b) => b.version - a.version || b.created_at.localeCompare(a.created_at))[0] || null
}

type ArchiveRound = { id: string; contract_id: string; status: string }

export type ConfirmedArchiveScope = {
  archive: ArchivePackage
  reportBatchId: string | null
  roundIds: string[]
  scopeLabel: string
}

export function confirmedArchiveScopesForRound(
  packages: ArchivePackage[],
  batches: ReportBatch[],
  rounds: ArchiveRound[],
  round: ArchiveRound,
): ConfirmedArchiveScope[] {
  const scopes: ConfirmedArchiveScope[] = []
  const projectRoundIds = rounds
    .filter(item => item.contract_id === round.contract_id && item.status !== 'cancelled')
    .map(item => item.id)
  const projectArchive = selectConfirmedArchive(packages, {
    contractId: round.contract_id,
    reportBatchId: null,
    roundIds: projectRoundIds,
  })
  if (projectArchive) scopes.push({ archive: projectArchive, reportBatchId: null, roundIds: projectRoundIds, scopeLabel: '整项目归档' })

  for (const batch of batches.filter(item => item.contract_id === round.contract_id && item.round_ids.includes(round.id))) {
    const archive = selectConfirmedArchive(packages, {
      contractId: round.contract_id,
      reportBatchId: batch.id,
      roundIds: batch.round_ids,
    })
    if (archive) scopes.push({ archive, reportBatchId: batch.id, roundIds: batch.round_ids, scopeLabel: `报告批次：${batch.name}` })
  }
  return scopes
}
