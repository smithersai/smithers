// The index is not the element: claiming the callback returns the element must fail.

//@ verify
//@ ensures forall(i, 0 <= i && i < xs.length ==> \result[i] == xs[i])
export function indexes(xs: ReadonlyArray<number>): ReadonlyArray<number> {
  return xs.map((x, i) => i)
}
