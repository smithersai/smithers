// The foreign synchronous helpers poc-source.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import { sourceDigest as sourceDigestImpl } from "./poc.vibe"
import { sameRevision as sameRevisionImpl } from "./schema.ts"

export const sameRevision = trusted(sameRevisionImpl, [])
export const sourceDigest = trusted(sourceDigestImpl, [])
/** Decodes one chunk of a stream, keeping a split multi-byte character for the next chunk. */
export const decodeStream = trusted((decoder: TextDecoder, chunk: Uint8Array): string => decoder.decode(chunk, { stream: true }), [])
/** Flushes a streaming decoder. */
export const decodeFinal = trusted((decoder: TextDecoder): string => decoder.decode(), [])
