// LIMIT reads base's STEP; a local STEP of another value must be refused, not merged.
import { LIMIT } from "./base"
const STEP = 3

//@ verify
//@ ensures \result <= LIMIT + STEP
export function clamp(n: number): number { return n > LIMIT ? LIMIT : n }
