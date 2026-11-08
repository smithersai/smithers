// LemmaScript reads .ts only; exact ordered-filter equality needs a lambda in the specification.
//@ verify
//@ ensures \result == values.filter((value) => value != removed)
export function remaining(values: ReadonlyArray<string>, removed: string): ReadonlyArray<string> {
  return values.filter((value) => value !== removed)
}
