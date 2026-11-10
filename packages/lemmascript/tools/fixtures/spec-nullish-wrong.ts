// The fallback in a contract's ?? is checked: this one claims the wrong default.
export interface Box { readonly runs?: ReadonlyArray<number>; readonly seq: number }

//@ verify
//@ ensures \result == (box.runs ?? [1])
export function runsOf(box: Box): ReadonlyArray<number> {
  return box.runs ?? []
}
