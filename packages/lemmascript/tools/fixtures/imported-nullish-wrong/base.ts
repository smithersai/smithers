export interface Box { readonly runs?: ReadonlyArray<number>; readonly seq: number }

//@ verify
//@ ensures \result == (box.runs ?? [])
export function runsOf(box: Box): ReadonlyArray<number> {
  return box.runs ?? []
}
