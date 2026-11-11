// `lastIndexOf` on strings: the last match, -1 when there is none, |s| for an empty needle (JavaScript's answer).

//@ verify
//@ ensures \result == -1 || (0 <= \result && \result + sub.length <= s.length && s.slice(\result, \result + sub.length) == sub)
export function lastAt(s: string, sub: string): number {
  return s.lastIndexOf(sub)
}

//@ verify
//@ ensures \result == s.length
export function emptyAtEnd(s: string): number {
  return s.lastIndexOf("")
}

/** The name after its last `/`: no `/` follows the cut. */
//@ verify
//@ ensures \result == name.slice(name.lastIndexOf("/") + 1)
//@ ensures forall(i, name.lastIndexOf("/") < i && i < name.length ==> name.charCodeAt(i) != 47)
export function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1)
}
