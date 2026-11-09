// Imports only `clamp`; its contract still needs `positive` declared.
import { clamp } from "./helpers"

//@ verify
//@ ensures \result >= 0
export function atLeastZero(n: number): number {
  return clamp(n)
}
