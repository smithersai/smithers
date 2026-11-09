//@ safe-slice
// JavaScript clamps every slice bound: a suffix past the end is empty, a negative start counts from the end.

//@ verify
//@ ensures \result.length == (from >= xs.length ? 0 : from < 0 ? (xs.length + from < 0 ? xs.length : -from) : xs.length - from)
export function suffix(xs: ReadonlyArray<number>, from: number): ReadonlyArray<number> {
  return xs.slice(from)
}

//@ verify
//@ ensures \result == (text == "" ? "r" : "r" + text.slice(1))
//@ ensures text != "" ==> \result.length == text.length
export function replyId(text: string): string {
  return "r" + text.slice(1)
}

//@ verify
//@ ensures \result == ""
export function pastEnd(text: string): string {
  return text.slice(text.length + 1, text.length + 2)
}

//@ verify
//@ ensures \result.length == 0
export function emptyTail(xs: ReadonlyArray<number>): ReadonlyArray<number> {
  return xs.slice(xs.length + 5)
}
