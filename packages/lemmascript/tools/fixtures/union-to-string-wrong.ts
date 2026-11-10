// The string a union member becomes is its own spelling: claiming another must fail.
export type Role = "owner" | "guest"

//@ verify
//@ ensures \result == (s == "owner")
export function isOwner(s: string): boolean { return s === "owner" }

//@ verify
//@ ensures \result == (r == "guest")
export function roleIsOwner(r: Role): boolean { return isOwner(r) }
