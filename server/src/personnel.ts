import type { DB } from './db.ts'
import {
  hasRole, httpError, inTx, logAction, updateUser, validateRoles, type User,
} from './handlers.ts'
import {
  replaceValidatedUserQualifications, validateQualificationInputs, type UserQualification,
} from './qualifications.ts'

export type PersonnelUpdate = {
  name: unknown
  roles: unknown
  qualifications: unknown
}

export function updateUserPersonnel(
  db: DB, username: string, input: PersonnelUpdate, actor: User,
): { user: User; qualifications: UserQualification[] } {
  if (!hasRole(actor, 'admin')) {
    throw httpError(403, '只有系统管理员可以管理人员岗位和专业审核资格', 'ADMIN_REQUIRED')
  }
  if (typeof input?.name !== 'string' || !input.name.trim()) {
    throw httpError(400, '姓名必填', 'PERSONNEL_NAME_INVALID')
  }

  // All payload validation happens before the first write. The transaction below
  // still protects role, qualification and audit writes from storage failures.
  const roles = validateRoles(input.roles)
  const qualifications = validateQualificationInputs(input.qualifications)
  return inTx(db, () => {
    const user = updateUser(db, username, { name: input.name.trim(), roles })
    const savedQualifications = replaceValidatedUserQualifications(db, username, qualifications, actor)
    logAction(db, username, actor, 'user_personnel_update', {
      name: user.name,
      roles: user.roles,
      qualificationCodes: savedQualifications.map(item => item.code),
    })
    return { user, qualifications: savedQualifications }
  })
}
