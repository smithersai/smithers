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

/** Pure calls inside a method condition must keep their guarded index reads. */
//@ verify
//@ ensures \result == (n == 57)
export function nine(n: number): boolean { return n === 57 }

//@ verify
//@ ensures \result == (text.length > 0 && nine(text.charCodeAt(0)))
export function guardedIndex(text: string): boolean {
  let found = false
  if (text.length > 0 && nine(text.charCodeAt(0))) found = true
  return found
}

//@ verify
//@ ensures \result == (text.length == 0 || nine(text.charCodeAt(0)))
export function guardedOr(text: string): boolean {
  let found = false
  if (text.length === 0 || nine(text.charCodeAt(0))) found = true
  return found
}

//@ verify
//@ ensures \result == text
export function walk(text: string): string {
  let i = 0
  while (i < text.length) {
    //@ invariant 0 <= i && i <= text.length
    //@ decreases text.length - i
    i++
  }
  return text
}

//@ verify
//@ ensures \result == (0 <= at && at < lines.length ? lines[at] : "")
export function selected(lines: ReadonlyArray<string>, at: number): string {
  return 0 <= at && at < lines.length ? walk(lines[at]!) : ""
}

//@ verify
//@ ensures \result == (lines.length == 0 ? "" : lines[0])
export function first(lines: ReadonlyArray<string>): string {
  return lines.length === 0 ? "" : walk(lines[0]!)
}

//@ verify
//@ ensures \result == n
export function numberWalk(n: number): number {
  let i = 0
  while (i < 1) {
    //@ invariant 0 <= i && i <= 1
    //@ decreases 1 - i
    i++
  }
  return n
}

//@ verify
//@ ensures \result == (flag ? 1 : -1)
export function naturalFirst(flag: boolean): number {
  return flag ? 1 : numberWalk(-1)
}

//@ verify
//@ ensures \result == (flag ? -1 : 1)
export function negativeFirst(flag: boolean): number {
  return flag ? -1 : numberWalk(1)
}
