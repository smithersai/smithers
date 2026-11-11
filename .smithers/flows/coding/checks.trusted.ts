// The foreign synchronous helpers checks.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import { contained as containedImpl } from "./immutable-source.vibe"
import { checkInputDigest as checkInputDigestImpl } from "./schema.ts"

export const contained = trusted(containedImpl, [])
export const checkInputDigest = trusted(checkInputDigestImpl, [])
