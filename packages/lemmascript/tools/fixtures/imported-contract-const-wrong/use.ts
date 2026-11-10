// The copied constant keeps its own value, so a tighter claim must fail as a proof obligation.
import { clamp } from "./lib"

//@ verify
//@ ensures \result <= 7
export function twice(n: number): number { return clamp(clamp(n)) }
