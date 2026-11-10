// A reveal must name an opaque function of this module; `sumTo` is not opaque, so generation refuses.
//@ verify
//@ requires n >= 0
//@ decreases n
export function sumTo(n: number): number {
  return n <= 0 ? 0 : sumTo(n - 1) + n
}

//@ verify
//@ reveal sumTo
//@ requires n >= 0
//@ ensures \result >= 0
export function total(n: number): number {
  return sumTo(n) >= 0 ? sumTo(n) : 0
}
