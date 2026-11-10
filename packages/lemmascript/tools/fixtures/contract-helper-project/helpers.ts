// A proved function whose contract names a helper from its own file.
//@ verify
//@ ensures \result == (n > 0)
export function positive(n: number): boolean {
  return n > 0
}

//@ verify
//@ ensures positive(n) ==> \result == n
//@ ensures !positive(n) ==> \result == 0
export function clamp(n: number): number {
  return positive(n) ? n : 0
}
