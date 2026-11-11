// A pure function's contract reaches its callers: a function body, a companion lemma and a method each reason from
// the callee's `ensures`, which Dafny holds on the callee's companion lemma, not from its body alone.

//@ verify
//@ requires 0 <= end && end <= xs.length
//@ decreases end
//@ ensures 0 <= \result && \result <= end
//@ ensures \result == 0 || xs[\result - 1] != 0
//@ ensures forall(i, \result <= i && i < end ==> xs[i] == 0)
export function zerosStart(xs: ReadonlyArray<number>, end: number): number {
  if (end === 0 || xs[end - 1] !== 0) return end
  return zerosStart(xs, end - 1)
}

/** The last nonzero value, 0 when every value is 0. Indexing needs the callee's bound. */
//@ verify
//@ ensures forall(i, 0 <= i && i < xs.length && xs[i] != 0 ==> \result != 0)
export function lastNonzero(xs: ReadonlyArray<number>): number {
  const end = zerosStart(xs, xs.length)
  return end === 0 ? 0 : xs[end - 1]!
}

/** How many zeros end the values, counted by a loop whose invariant starts from the callee's bound. */
//@ verify
//@ ensures \result >= 0 && \result <= xs.length
export function trailingZeros(xs: ReadonlyArray<number>): number {
  let count = 0
  const end = zerosStart(xs, xs.length)
  while (count < xs.length - end) {
    //@ invariant 0 <= count && count <= xs.length - end
    //@ decreases xs.length - end - count
    count++
  }
  return count
}
