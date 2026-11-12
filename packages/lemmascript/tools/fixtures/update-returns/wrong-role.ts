// A string-union value's slice drops its first character.
export type Role = "owner" | "viewer"

//@ verify
//@ ensures \result.length == role.length
export function tail(role: Role): string {
  return role.slice(1)
}
