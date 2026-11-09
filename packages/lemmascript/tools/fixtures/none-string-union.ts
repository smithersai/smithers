// A string-literal union may name a member "none"; its constructor is not Option's None.
export type Plan = "none" | "go"

//@ verify
//@ ensures active ==> \result == "go"
//@ ensures !active ==> \result == "none"
export function plan(active: boolean): Plan {
  return active ? "go" : "none"
}

export interface Step { readonly plan: Plan }

//@ verify
//@ ensures \result == { plan: "none" }
export function idle(): Step {
  return { plan: "none" }
}
