// The foreign synchronous helpers poc.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import * as Digest from "@smthrs/core/Digest"

export const digest = trusted(Digest.digest, [])
/** Decodes UTF-8 bytes, replacing malformed sequences. */
export const decodeLenient = trusted((bytes: Uint8Array): string => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), [])
/** Decodes UTF-8 bytes; malformed input is a defect, as the materialized prototype's text must be exact. */
export const decodeStrict = trusted(
  (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  []
)
