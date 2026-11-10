// A `<R extends Bound>` parameter inside a type expression reads as the bound, so the body may read the bound's fields.
export interface Clock { readonly id: string; readonly at: number; readonly started: number }

//@ verify
//@ ensures \result == -1 || (0 <= \result && \result < runs.length && runs[\result].id == id)
//@ ensures \result == -1 ==> forall(j, 0 <= j && j < runs.length ==> runs[j].id != id)
export function indexOf<R extends Clock>(runs: ReadonlyArray<R>, id: string): number {
  let i = 0
  while (i < runs.length) {
    //@ invariant 0 <= i && i <= runs.length
    //@ invariant forall(j, 0 <= j && j < i ==> runs[j].id != id)
    //@ decreases runs.length - i
    if (runs[i]!.id === id) return i
    i++
  }
  return -1
}

//@ verify
//@ requires index == -1 || (0 <= index && index < current.length)
//@ ensures index == -1 ==> \result.length == current.length + 1 && \result[current.length] == next
//@ ensures index != -1 && next.at >= current[index].at ==> \result[index] == next
//@ ensures index != -1 && next.at < current[index].at ==> \result == current
export function placed<R extends Clock>(current: ReadonlyArray<R>, index: number, next: R): ReadonlyArray<R> {
  if (index < 0) return [...current, next]
  if (next.at >= current[index]!.at) return current.with(index, next)
  return current
}

//@ verify
//@ ensures \result.length == runs.length
//@ ensures forall(i, 0 < i && i < \result.length ==> \result[i - 1].started >= \result[i].started)
export function newestFirst<R extends Clock>(runs: readonly R[]): ReadonlyArray<R> {
  return [...runs].sort((a, b) => b.started - a.started)
}
