// An opaque recursive measure: its contract lemma sees the body, and a loop that follows it step by step reveals it.
// A non-recursive opaque function carries its contract, so a caller reasons from the contract without its body.
//@ verify
//@ opaque
//@ requires n >= 0
//@ ensures n == 0 ==> \result == 0
//@ ensures n > 0 ==> \result == sumTo(n - 1) + n
//@ decreases n
export function sumTo(n: number): number {
  return n <= 0 ? 0 : sumTo(n - 1) + n
}

//@ verify
//@ reveal sumTo
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
//@ ensures n >= 0 ==> \result >= n
export function quadruple(n: number): number {
  return double(double(n))
}
