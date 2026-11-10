import { left } from "./left"
import { right } from "./right"

// Different modules give LIMIT different meanings. They must never share one copied constant.
//@ verify
//@ ensures \result
export function equal(): boolean { return left() === right() }
