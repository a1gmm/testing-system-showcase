export type User = {
  username: string
  name: string
  roles: string[]
  status: string
  created_at: string
  must_change_pw: boolean
}

// Dirty role payloads are normalised before they become User values. Keep this
// check exact so a string such as "xadminx" can never gain administrator power.
export function hasRole(user: User | null, ...roles: string[]): boolean {
  if (!user) return false
  if (user.roles.includes('admin')) return true
  return roles.some(role => user.roles.includes(role))
}
