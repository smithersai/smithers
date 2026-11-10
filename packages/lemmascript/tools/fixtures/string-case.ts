// JavaScript maps ASCII letters, and only them, unit for unit in an ASCII string.
//@ verify
//@ ensures \result == "hello, world 1"
export function lowered(): string { return "Hello, World 1".toLowerCase() }

//@ verify
//@ ensures \result == "ABC-Z"
export function raised(): string { return "abc-z".toUpperCase() }

//@ verify
//@ requires forall(i, 0 <= i && i < s.length ==> s.charCodeAt(i) < 128)
//@ ensures \result.length == s.length
export function asciiLength(s: string): string { return s.toLowerCase() }
