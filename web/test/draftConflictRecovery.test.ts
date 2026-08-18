import { expect, test } from 'vitest'
import { rebuildConflictedDraft } from '../src/offline/draftConflictRecovery'

const oldDraft:any={id:'r:HJ-TC-136',ownerId:'sampler-a',schemaVersion:1,updatedAt:'2026-08-17T00:00:00.000Z',payload:{kind:'field-task',draftRevision:4,global:{org:'机构',orgSign:'张三',samplingDate:'2026-08-17'},rows:[{sampleSlotId:'old-slot',sampleNo:'临1',point:'旧点',time:'09:00',item:'COD',volume:'500',preserve:'冷藏',waterColor:'',smell:'',oil:'',floating:'',anomaly:'',note:'备注'}]}}
const pkg:any={signedPayload:{roundId:'r',assigneeId:'sampler-a',formCode:'HJ-TC-136',samplingDate:'2026-08-18',sampleSlots:[{sampleSlotId:'new-slot',items:['COD']}],authorization:{serverTime:'2026-08-17T01:00:00.000Z'}}}

test('conflict recovery seals the original and creates a clean new draft with explicit copy candidates',()=>{
  const result=rebuildConflictedDraft(oldDraft,pkg,Date.parse('2026-08-17T01:00:00.000Z'))
  expect(result.archived.id).toContain(':conflict:4:')
  expect(result.archived.payload.control.terminal).toBe('conflict')
  expect(result.replacement.payload.draftRevision).toBe(0)
  expect(result.replacement.payload.rows[0].sampleSlotId).toBe('new-slot')
  expect(result.replacement.payload.rows[0].point).toBe('')
  expect(result.copyCandidates.global.org).toBe('机构')
  expect(result.copyCandidates.rows[0].values.point).toBe('旧点')
})
