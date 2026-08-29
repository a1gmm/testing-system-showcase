import type { DB } from './db.ts'

let savepointSequence = 0

// SAVEPOINT keeps application services composable: nested multi-step writes
// still commit or roll back as one unit without requiring a global transaction.
export function inTx<T>(db: DB, operation: () => T): T {
  const savepoint = `sp_${++savepointSequence}`
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
    const result = operation()
    db.exec(`RELEASE ${savepoint}`)
    return result
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}`)
    db.exec(`RELEASE ${savepoint}`)
    throw error
  }
}
