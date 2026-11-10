// LemmaScript reads TypeScript proof fixtures; this probes the native safe-integer boundary.
type real = number
//@ verify
//@ ensures \result ==> 0 <= input && input <= 9007199254740991
export function safeUsage(input: real): boolean {
  return Number.isSafeInteger(input) && input >= 0
}
