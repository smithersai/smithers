// LemmaScript reads TypeScript only; conditional method calls must retain their branch guard.
type Input = { kind: "text"; text: string } | { kind: "empty" }
//@ verify
//@ ensures \result == text.length
function count(text: string): number {
  let i = 0
  while (i < text.length) {
    //@ invariant 0 <= i && i <= text.length
    //@ decreases text.length - i
    i++
  }
  return i
}
//@ verify
//@ ensures input.kind == "empty" ==> \result == 0
//@ ensures input.kind == "text" ==> \result == input.text.length
export function size(input: Input): number {
  return input.kind === "text" ? count(input.text) : 0
}
