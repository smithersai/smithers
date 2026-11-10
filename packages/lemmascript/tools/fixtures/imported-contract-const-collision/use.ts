// A local constant with the name a copied contract reads would change that contract's meaning, so it is refused.
import { clamp } from "./lib"

const LIMIT = 3

//@ verify
//@ ensures \result <= LIMIT || \result > LIMIT
export function twice(n: number): number { return clamp(clamp(n)) }
