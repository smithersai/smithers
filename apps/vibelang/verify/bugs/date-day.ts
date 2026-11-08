// LemmaScript reads .ts only; UTC day formatting uses the host Date implementation.
//@ verify
//@ requires 0 <= millis && millis < 253402300800000
//@ ensures \result.length == 10
export function day(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10)
}
