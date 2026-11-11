// A false claim: the last match is not the first one ("aa".lastIndexOf("a") is 1). Dafny must reject it.

//@ verify
//@ ensures \result == s.indexOf(sub)
export function lastIsFirst(s: string, sub: string): number {
  return s.lastIndexOf(sub)
}
