// LemmaScript reads TypeScript; this reproduces the production event-key conversion boundary.
//@ verify
//@ requires 0 <= seq && seq <= 9007199254740991
//@ ensures \result.length == 22
export function eventKey(seq: number): string { return "event/" + String(seq).padStart(16, "0") }
