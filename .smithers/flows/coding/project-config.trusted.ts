// The foreign synchronous helpers project-config.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import { checkCommands as checkCommandsImpl } from "./check-detection.ts"

export const checkCommands = trusted(checkCommandsImpl, [])
