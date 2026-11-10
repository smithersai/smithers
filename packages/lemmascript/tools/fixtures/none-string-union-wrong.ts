// The none-named member keeps its meaning: this contract is false and must be rejected.
export type Plan = "none" | "go"

//@ verify
//@ ensures \result == "go"
export function plan(active: boolean): Plan {
  return active ? "go" : "none"
}
