// Stays .ts: a LemmaScript defect reproduction, in the TypeScript LemmaScript reads (verify/README.md).
export {}
type State = "a" | "b"
type Found = "a" | "b" | ""
//@ verify
//@ ensures \result != "" ==> \result == "a" || \result == "b"
function find(states: ReadonlyArray<State>, i: number): Found {
  if (0 <= i && i < states.length) return states[i]!
  return ""
}
