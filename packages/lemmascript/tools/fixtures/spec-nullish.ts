// A contract may read an optional field with ??, as the code does.
export interface Box { readonly runs?: ReadonlyArray<number>; readonly seq: number }

//@ verify
//@ ensures \result == (box.runs ?? [])
export function runsOf(box: Box): ReadonlyArray<number> {
  return box.runs ?? []
}

//@ verify
//@ ensures \result == (box.runs ?? []).length
export function count(box: Box): number {
  return runsOf(box).length
}
