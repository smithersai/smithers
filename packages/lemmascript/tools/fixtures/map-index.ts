// Array.prototype.map passes each element's index as the callback's second argument.

//@ verify
//@ ensures \result.length == xs.length
//@ ensures forall(i, 0 <= i && i < xs.length && i != at ==> \result[i] == xs[i])
//@ ensures 0 <= at && at < xs.length ==> \result[at] == value
export function replaceAt(xs: ReadonlyArray<string>, at: number, value: string): ReadonlyArray<string> {
  return xs.map((each, i) => i === at ? value : each)
}

//@ verify
//@ ensures forall(i, 0 <= i && i < xs.length ==> \result[i] == xs[i] + i)
export function offsets(xs: ReadonlyArray<number>): ReadonlyArray<number> {
  return xs.map((x, i) => x + i)
}
