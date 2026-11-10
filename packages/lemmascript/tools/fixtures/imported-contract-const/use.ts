// A contract copied from another module keeps the value of each constant it names there.
import { clamp } from "./lib"

//@ verify
//@ ensures \result <= 8
export function twice(n: number): number { return clamp(clamp(n)) }
