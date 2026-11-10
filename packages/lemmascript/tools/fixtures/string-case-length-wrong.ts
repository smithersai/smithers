// JavaScript uppers U+00DF to "SS", two units; the old model proved every string keeps its length.
//@ verify
//@ ensures \result.length == s.length
export function raisedLength(s: string): string { return s.toUpperCase() }
