// LemmaScript: a dense array callback returns arrays, in source order.
//@ verify
//@ requires -100 <= a && a <= 100 && -100 <= b && b <= 100
//@ ensures \result.length == 4
//@ ensures \result[0] == a && \result[1] == a + 1 && \result[2] == b && \result[3] == b + 1
export function paired(a: number, b: number): ReadonlyArray<number> {
  const values: ReadonlyArray<number> = [a, b]
  return values.flatMap(value => [value, value + 1])
}

//@ verify
//@ requires -100 <= base && base <= 100
//@ ensures \result.length == 2 && \result[0] == base && \result[1] == base + 1
export function indexed(base: number): ReadonlyArray<number> {
  const values: ReadonlyArray<number> = [base, base]
  return values.flatMap((value, index) => [value + index])
}
