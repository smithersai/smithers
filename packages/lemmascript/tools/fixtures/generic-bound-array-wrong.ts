// The bound's fields keep their meaning: claiming oldest-first order must fail.
export interface Clock { readonly id: string; readonly started: number }

//@ verify
//@ ensures forall(i, 0 < i && i < \result.length ==> \result[i - 1].started <= \result[i].started)
export function newestFirst<R extends Clock>(runs: ReadonlyArray<R>): ReadonlyArray<R> {
  return [...runs].sort((a, b) => b.started - a.started)
}
