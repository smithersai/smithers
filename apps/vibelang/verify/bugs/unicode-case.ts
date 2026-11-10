// LemmaScript reads TypeScript; this reproduces an ASCII-only lowering of JavaScript Unicode casing.
//@ verify
//@ ensures \result == "k"
export function kelvin(): string { return "K".toLowerCase() }
