import { createFieldTaskDraft, type FieldTaskDraft, type OfflineTaskPackage } from './fieldTaskDraft'

export type ConflictCopyCandidates={global:Record<string,unknown>;rows:{sampleSlotId:string;values:Record<string,unknown>}[]}

export function rebuildConflictedDraft(draft:FieldTaskDraft,pkg:OfflineTaskPackage,receivedWallTime:number){
  const suffix=`${draft.payload.draftRevision}:${receivedWallTime}`
  const archived=structuredClone(draft)
  archived.id=`${draft.id}:conflict:${suffix}`
  archived.updatedAt=new Date(receivedWallTime).toISOString()
  archived.payload.control={...(archived.payload.control??{version:1,roundId:pkg.signedPayload.roundId,ownerId:draft.ownerId,packageSignature:draft.payload.package?.signature??'',taskVersion:draft.payload.package?.signedPayload?.taskVersion??'',ruleVersion:draft.payload.package?.signedPayload?.ruleVersion??''}),terminal:'conflict'} as any
  const replacement=createFieldTaskDraft(pkg,receivedWallTime)
  const copyCandidates:ConflictCopyCandidates={global:structuredClone(draft.payload.global),rows:draft.payload.rows.map(row=>({sampleSlotId:row.sampleSlotId,values:structuredClone(row)}))}
  return{archived,replacement,copyCandidates}
}
