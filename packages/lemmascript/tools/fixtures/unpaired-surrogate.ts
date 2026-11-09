// Under the default "unicode-scalar" profile a lone surrogate has no Dafny
// value; extraction refuses it with the source line (DESIGN_STRINGS.md §3).
export function lone(): number {
  //@ verify
  //@ ensures \result === 1
  return "\uD83D".length;
}
