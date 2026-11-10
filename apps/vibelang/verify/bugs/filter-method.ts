// LemmaScript reads TypeScript; this isolates a verified loop-backed predicate inside Array.filter.
//@ verify
//@ ensures \result == exists(i, 0 <= i && i < values.length && values[i] == value)
export function contains(values: ReadonlyArray<string>, value: string): boolean {
  let i = 0
  while (i < values.length) {
    //@ invariant 0 <= i && i <= values.length
    //@ invariant forall(j, 0 <= j && j < i ==> values[j] != value)
    //@ decreases values.length - i
    if (values[i] === value) return true
    i++
  }
  return false
}
//@ verify
//@ ensures \result.length == values.length
export function selected(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return values.filter(value => contains(values, value))
}
