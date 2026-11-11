// The foreign synchronous helpers security-review-check.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import * as ModelRequest from "@smthrs/model/ModelRequest"

export const makeModelRequest = trusted(ModelRequest.ModelRequest.make, [])
export const makeGenerationParams = trusted(ModelRequest.GenerationParams.make, [])
