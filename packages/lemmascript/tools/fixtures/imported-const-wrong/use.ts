// The imported value is the one declared: proving a different bound must fail.
import { LIMIT } from "./base"

//@ verify
//@ ensures \result < LIMIT
export function clamp(n: number): number { return n > LIMIT ? LIMIT : n }
