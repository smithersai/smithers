// LemmaScript reads TypeScript defect reproductions. ASCII is sufficient to exclude unpaired-surrogate exceptions.
//@ verify
//@ requires forall(i, 0 <= i && i < input.length ==> 32 <= input.charCodeAt(i) && input.charCodeAt(i) <= 126)
//@ ensures \result == input
export function roundtrip(input: string): string {
  return decodeURIComponent(encodeURIComponent(input))
}
