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

// A checked loop method consuming a bounded suffix retains its input character relation.
/** Text that is a positive decimal integer with no leading zero. */
//@ verify
//@ ensures \result == (text.length > 0 && 49 <= text.charCodeAt(0) && text.charCodeAt(0) <= 57 && forall(i, 1 <= i && i < text.length ==> 48 <= text.charCodeAt(i) && text.charCodeAt(i) <= 57))
export function positiveDecimal(text: string): boolean {
  if (text.length === 0) return false
  if (text.charCodeAt(0) < 49 || text.charCodeAt(0) > 57) return false
  let i = 1
  while (i < text.length) {
    //@ invariant 1 <= i && i <= text.length
    //@ invariant forall(j, 1 <= j && j < i ==> 48 <= text.charCodeAt(j) && text.charCodeAt(j) <= 57)
    //@ decreases text.length - i
    if (text.charCodeAt(i) < 48 || text.charCodeAt(i) > 57) return false
    i++
  }
  return true
}

/** Names on the wire stay neutral; this tab's own posts carry its session and a serial. */
//@ verify
//@ ensures \result == (clientId.startsWith(session + "-") && clientId.length > session.length + 1 && 49 <= clientId.charCodeAt(session.length + 1) && clientId.charCodeAt(session.length + 1) <= 57 && forall(i, session.length + 2 <= i && i < clientId.length ==> 48 <= clientId.charCodeAt(i) && clientId.charCodeAt(i) <= 57))
export function ownPost(clientId: string, session: string): boolean {
  if (false) return false
  const serial = positiveDecimal(clientId.slice(session.length + 1))
  return serial
}

