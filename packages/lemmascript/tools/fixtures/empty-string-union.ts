// An empty string is a member of a string-literal union; its constructor must be a valid Dafny name.
export type Op = "go" | ""

//@ verify
//@ ensures active ==> \result == "go"
//@ ensures !active ==> \result == ""
export function op(active: boolean): Op {
  return active ? "go" : ""
}
