//@ verify
//@ ensures \result == [head, ...middle, last]
//@ ensures \result.length == middle.length + 2
//@ ensures \result[0] == head && \result[\result.length - 1] == last
//@ ensures forall(i, 0 <= i && i < middle.length ==> \result[i + 1] == middle[i])
export function surrounded(head: string, middle: ReadonlyArray<string>, last: string): ReadonlyArray<string> {
  return [head, ...middle]
}
