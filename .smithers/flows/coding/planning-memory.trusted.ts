// The foreign synchronous helpers planning-memory.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import * as Memory from "@smthrs/agent/Memory"
import * as Digest from "@smthrs/core/Digest"
import {
  changedPaths as changedPathsImpl,
  driftOf as driftOfImpl,
  memoryRevision as memoryRevisionImpl,
  staleRevisionMessage as staleRevisionMessageImpl
} from "./planning.vibe"

export const canonical = trusted(Digest.canonical, [])
export const digest = trusted(Digest.digest, [])
export const extractPaths = trusted(Memory.extractPaths, [])
export const changedPaths = trusted(changedPathsImpl, [])
export const driftOf = trusted(driftOfImpl, [])
export const memoryRevision = trusted(memoryRevisionImpl, [])
export const staleRevisionMessage = trusted(staleRevisionMessageImpl, [])
