// The empty member is a distinct value: claiming the opposite must fail.
export type Op = "go" | ""

//@ verify
//@ ensures !active ==> \result == "go"
export function op(active: boolean): Op {
  return active ? "go" : ""
}
