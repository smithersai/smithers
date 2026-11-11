// The foreign synchronous helpers flow-load.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import * as Digest from "@smthrs/core/Digest"
import * as Registry from "@smthrs/registry/Registry"

export const digestOf = trusted(Digest.digest, [])
export const projectSource = trusted(Registry.projectSource, [])
