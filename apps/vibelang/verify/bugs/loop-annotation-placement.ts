// LemmaScript reads TypeScript. Loop annotations written before `while` are dropped without a diagnostic, so the loop
// is checked with no invariant and the correct postcondition fails. Inside the loop body they are kept.

//@ verify
//@ requires step > 0
//@ ensures \result.length > 0
export function starts(step: number): ReadonlyArray<number> {
  const out: number[] = []
  let at = 0
  //@ invariant at == out.length * step
  //@ decreases 1 - at
  while (at < 1) {
    out.push(at)
    at += step
  }
  return out
}
