/**
 * Array sum — simplest verification example.
 * No break, no early return. Pure accumulator.
 */

export function arraySum(arr: number[]): number {
  //@ ensures \result === sumTo(arr, arr.length)
  //@ type i nat

  let sum = 0;
  let i = 0;
  while (i < arr.length) {
    //@ invariant 0 <= i && i <= arr.length
    //@ invariant sum === sumTo(arr, i)
    //@ decreases arr.length - i
    sum = sum + arr[i];
    i = i + 1;
  }
  return sum;
}
