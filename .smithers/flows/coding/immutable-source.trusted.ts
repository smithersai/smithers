// The foreign synchronous helpers immutable-source.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import * as Digest from "@smthrs/core/Digest"
import { requestIdFor as requestIdForImpl } from "./native.vibe"

export const digest = trusted(Digest.digest, [])
export const requestIdFor = trusted(requestIdForImpl, [])
/** Decodes one chunk of a stream, keeping a split multi-byte character for the next chunk. */
export const decodeStream = trusted((decoder: TextDecoder, chunk: Uint8Array): string => decoder.decode(chunk, { stream: true }), [])
/** Flushes a streaming decoder. */
export const decodeFinal = trusted((decoder: TextDecoder): string => decoder.decode(), [])
/** Decodes whole bytes. */
export const decodeBytes = trusted((bytes: Uint8Array): string => new TextDecoder().decode(bytes), [])
