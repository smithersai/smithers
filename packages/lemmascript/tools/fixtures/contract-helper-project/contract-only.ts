// Names the imported `clamp` only in its contract; its body never calls it.
import { clamp } from "./helpers"

//@ verify
//@ ensures \result == clamp(n)
export function sameAsClamp(n: number): number {
  return n > 0 ? n : 0
}
