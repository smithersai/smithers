// The foreign synchronous helpers wiki-policy.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"

/** Decodes a policy source as UTF-8; malformed bytes are a defect, as they were under `Effect.gen`. */
export const decodeStrict = trusted(
  (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  []
)
