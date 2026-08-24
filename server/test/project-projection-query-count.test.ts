import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DB } from '../src/db.ts'
import { openDb } from '../src/db.ts'
import { createContract, listProjects } from '../src/handlers.ts'

function countingDb(db: DB) {
  let count = 0
  let statements: string[] = []
  const proxy = new Proxy(db as any, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => { count += 1; statements.push(sql); return target.prepare(sql) }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as DB
  return { proxy, reset: () => { count = 0; statements = [] }, count: () => count, statements: () => statements }
}

function addProjectedProject(db: DB, suffix: number) {
  const contract = createContract(db, { client: `投影客户${suffix}` }, 2026 + suffix)
  const sampleId = `PROJECT-SAMPLE-${suffix}`
  const recordId = `PROJECT-RECORD-${suffix}`
  db.prepare(`INSERT INTO samples(id,client,matrix,items,status,note,contract_id,source,created_at)
    VALUES (?,?,'废水','["COD"]','testing','',?,'self','2026-08-22T00:00:00.000Z')`).run(sampleId, contract.client, contract.id)
  db.prepare(`INSERT INTO records(id,serial,sample_id,template_code,template_name,sheet_type,method,analyte,matrix,data,status,author,author_username,updated_at)
    VALUES (?,? ,?,'HJ-TC-030','COD','test','HJ 828','COD','废水','{}','approved','分析员','analyst','2026-08-22T00:00:00.000Z')`)
    .run(recordId, `JL-${suffix}`, sampleId)
  db.prepare(`INSERT INTO workflow_instances(id,contract_id,scope,subject_type,subject_id,status,current_revision,created_by,created_at)
    VALUES (?,?,'laboratory','lab_record',?,'approved',1,'analyst','2026-08-22T00:00:00.000Z')`).run(`WF-${suffix}`, contract.id, recordId)
  db.prepare(`INSERT INTO workflow_revisions(instance_id,revision,snapshot_json,snapshot_sha256,submitted_by,submitted_at)
    VALUES (?,1,'{}',?,'analyst','2026-08-22T00:00:00.000Z')`).run(`WF-${suffix}`, 'a'.repeat(64))
  db.prepare(`INSERT INTO workflow_decisions(instance_id,revision,level,decision,comment,decided_by,decided_at)
    VALUES (?,1,'review','approve','','reviewer','2026-08-22T01:00:00.000Z'),
           (?,1,'approve','approve','','approver','2026-08-22T02:00:00.000Z')`).run(`WF-${suffix}`, `WF-${suffix}`)
  return contract.id
}

test('project list projection keeps query count bounded as projects and records scale without loading workflow history', () => {
  const db = openDb(':memory:')
  const firstId = addProjectedProject(db, 1)
  const counted = countingDb(db)
  counted.reset()
  const one = listProjects(counted.proxy)
  const oneCount = counted.count()
  assert.equal(one.find(project => project.id === firstId)?.stats.approved, 1)
  assert.ok(counted.statements().every(sql => !/workflow_(?:revisions|decisions)/.test(sql)), 'project projection must not load workflow history')

  for (let index = 2; index <= 12; index += 1) addProjectedProject(db, index)
  counted.reset()
  const many = listProjects(counted.proxy)
  const manyCount = counted.count()
  assert.equal(many.length, 12)
  assert.ok(many.every(project => project.stats.approved === 1))
  assert.ok(manyCount <= oneCount + 2, `project projection queries grew from ${oneCount} to ${manyCount}`)
  assert.ok(counted.statements().every(sql => !/workflow_(?:revisions|decisions)/.test(sql)), 'scaled projection must not load workflow history')
})
