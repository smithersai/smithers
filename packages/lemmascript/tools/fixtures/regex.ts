// RegExp test on literal patterns (vl-proveall3): the proved matcher decides each test (regex.ts), and a contract names
// a pattern's answer with \matches("pattern", s).
const ENDED = /[.!?]["'`)\]]*$/
const TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*:/

/** A module constant and the literal it holds decide the same test. */
//@ verify
//@ ensures \result == \matches("[.!?][\"'`)\\]]*$", text)
export function endsSentence(text: string): boolean {
  return ENDED.test(text)
}

/** No substring of "" holds a sentence end. */
//@ verify
//@ ensures text == "" ==> !\result
export function emptyEndsNothing(text: string): boolean {
  return ENDED.test(text)
}

/** A decision over two tests: a `Key:` line, or one after the first that continues it. */
//@ verify
//@ ensures \result == (\matches("^[A-Za-z0-9][A-Za-z0-9-]*:", line) || (at > 0 && \matches("^[ \\t]", line)))
export function trailerLine(line: string, at: number): boolean {
  return TRAILER.test(line) || (at > 0 && /^[ \t]/.test(line))
}
