// The foreign synchronous helpers correction.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import * as Digest from "@smthrs/core/Digest"
import { stepMemory as stepMemoryImpl, withoutMemory as withoutMemoryImpl } from "./project-memory.ts"

export const digest = trusted(Digest.digest, [])
export const stepMemory = trusted(stepMemoryImpl, [])
export const withoutMemory = trusted(withoutMemoryImpl, [])
