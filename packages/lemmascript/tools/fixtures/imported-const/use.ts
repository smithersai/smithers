// A constant imported from another module keeps its value in the proof.
import { LIMIT, STEP as BY } from "./base"

//@ verify
//@ ensures \result <= LIMIT
//@ ensures \result == (n > 8 ? 8 : n)
export function clamp(n: number): number { return n > LIMIT ? LIMIT : n }

//@ verify
//@ ensures \result == n + 2
export function next(n: number): number { return n + BY }
