//@ safe-slice
// A suffix past the end is empty in JavaScript; claiming it keeps an element must fail.

//@ verify
//@ requires xs.length > 0
//@ ensures \result.length > 0
export function pastEnd(xs: ReadonlyArray<number>): ReadonlyArray<number> {
  return xs.slice(xs.length)
}
