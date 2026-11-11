// Wrong twins: each contract misstates a test, so each must fail.
//@ verify
//@ ensures \result
export function alwaysEnds(text: string): boolean {
  return /[.!?]["'`)\]]*$/.test(text)
}

//@ verify
//@ ensures \result == \matches("[.!?]$", text)
export function otherPattern(text: string): boolean {
  return /[.!?]["'`)\]]*$/.test(text)
}

//@ verify
//@ ensures \result == \matches("^[A-Za-z0-9][A-Za-z0-9-]*:", line)
export function continuationIgnored(line: string, at: number): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*:/.test(line) || (at > 0 && /^[ \t]/.test(line))
}
