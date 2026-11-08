// LemmaScript reads .ts only; a loop-backed verified method cannot be used as a specification expression.
//@ verify
//@ requires n >= 0
//@ ensures \result == n
export function counted(n: number): number {
  let i = 0
  while (i < n) {
    //@ invariant 0 <= i && i <= n
    //@ decreases n - i
    i++
  }
  return i
}
//@ verify
//@ requires n >= 0
//@ ensures \result == counted(n)
export function copied(n: number): number {
  return counted(n)
}
