// Opacity is real: without `//@ reveal` the loop cannot follow the measure, and a caller cannot see past a contract.
//@ verify
//@ opaque
//@ requires n >= 0
//@ ensures n == 0 ==> \result == 0
//@ decreases n
export function sumTo(n: number): number {
  return n <= 0 ? 0 : sumTo(n - 1) + n
}

//@ verify
//@ requires n >= 0
//@ ensures \result == sumTo(n)
export function total(n: number): number {
  let sum = 0
  let i = 0
  while (i < n) {
    //@ invariant 0 <= i && i <= n && sum == sumTo(i)
    //@ decreases n - i
    i++
    sum += i
  }
  return sum
}

//@ verify
//@ opaque
//@ ensures n >= 0 ==> \result >= n
export function double(n: number): number {
  return n + n
}

//@ verify
//@ ensures \result == n + n + n + n
export function quadruple(n: number): number {
  return double(double(n))
}
