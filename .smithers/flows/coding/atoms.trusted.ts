// The foreign synchronous helpers atoms.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import { requestIdFor as requestIdForImpl } from "./native.vibe"
import { stepMemory as stepMemoryImpl, withoutMemory as withoutMemoryImpl } from "./project-memory.ts"

export const requestIdFor = trusted(requestIdForImpl, [])
export const stepMemory = trusted(stepMemoryImpl, [])
/** The edit prompt: the payload without its memory block, as JSON. */
export const editPrompt = trusted((input: Parameters<typeof withoutMemoryImpl>[0]): string => JSON.stringify(withoutMemoryImpl(input)), [])
