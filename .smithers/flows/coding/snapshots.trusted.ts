// The foreign synchronous helpers snapshots.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import { helperPath as helperPathImpl } from "./helper.ts"

export const helperPath = trusted(helperPathImpl, [])
/** Decodes one chunk of a stream, keeping a split multi-byte character for the next chunk. */
export const decodeStream = trusted((decoder: TextDecoder, chunk: Uint8Array): string => decoder.decode(chunk, { stream: true }), [])
/** Flushes a streaming decoder. */
export const decodeFinal = trusted((decoder: TextDecoder): string => decoder.decode(), [])
