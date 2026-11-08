// The foreign synchronous helpers stack.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import { requestIdFor as requestIdForImpl } from "./native.vibe"

export const requestIdFor = trusted(requestIdForImpl, [])
