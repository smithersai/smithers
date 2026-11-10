// A string-literal union value passes to a `string` parameter, as TypeScript allows.
export type Role = "owner" | "guest" | ""

//@ verify
//@ ensures \result == (s == "owner")
export function isOwner(s: string): boolean { return s === "owner" }

//@ verify
//@ ensures \result == (r == "owner")
export function roleIsOwner(r: Role): boolean { return isOwner(r) }

//@ verify
//@ ensures \result == (r != "")
export function named(r: Role): boolean {
  const s: string = r
  return s.length > 0
}

//@ verify
//@ ensures \result == (s == "guest")
export function sameAsGuest(s: string): boolean {
  const g: Role = "guest"
  return s === g
}
