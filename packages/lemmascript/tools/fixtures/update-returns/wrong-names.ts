// The copied constant's first step is the splash, and its duration is not its length.
import { STEPS } from "./steps";

//@ verify
//@ ensures \result == STEPS.length
export function firstDuration(): number {
  return STEPS[0]!.duration
}
