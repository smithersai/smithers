// LemmaScript reads .ts only; its annotation parser does not accept JavaScript nullish coalescing.
//@ verify
//@ ensures \result == (value ?? 0)
export function present(value: number | undefined): number {
  return value ?? 0
}
