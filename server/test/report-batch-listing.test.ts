import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { listReportBatches } from '../src/archivePackages.ts'

test('报告批次列表保留合同和精确期次范围', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO contracts(id,client,status,cycle_months,created_at) VALUES (?,?,?,?,?)`)
    .run('WT-BATCH', '批次测试厂', 'draft', 0, '2026-08-22T00:00:00.000Z')
  for (const [id, no] of [['R-1', 1], ['R-2', 2]] as const) {
    db.prepare(`INSERT INTO rounds(id,contract_id,round_no,due_date,items,status,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, 'WT-BATCH', no, `2026-0${no}-01`, '[]', 'pending', '2026-08-22T00:00:00.000Z')
  }
  db.prepare(`INSERT INTO report_batches(id,contract_id,name,created_by,created_at) VALUES (?,?,?,?,?)`)
    .run('BATCH-1', 'WT-BATCH', '第一批', 'editor', '2026-08-22T01:00:00.000Z')
  db.prepare(`INSERT INTO report_batch_rounds(batch_id,round_id,attached_by,attached_at) VALUES (?,?,?,?),(?,?,?,?)`)
    .run('BATCH-1', 'R-1', 'editor', '2026-08-22T01:00:00.000Z', 'BATCH-1', 'R-2', 'editor', '2026-08-22T01:00:00.000Z')

  assert.deepEqual(listReportBatches(db), [{
    id: 'BATCH-1', contract_id: 'WT-BATCH', name: '第一批', created_by: 'editor',
    created_at: '2026-08-22T01:00:00.000Z', round_ids: ['R-1', 'R-2'],
  }])
})
