// The foreign synchronous helpers feedback.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import * as Digest from "@smthrs/core/Digest"
import * as RunLifecycle from "../../../packages/smithers/flows/engine-store/src/internal/RunLifecycle.ts"
import { receiptMatches as receiptMatchesImpl } from "./schema.ts"
import { recalled as recalledImpl } from "./workflow.vibe"

export const canonical = trusted(Digest.canonical, [])
export const digest = trusted(Digest.digest, [])
export const receiptMatches = trusted(receiptMatchesImpl, [])
export const recalled = trusted(recalledImpl, [])
export const runLifecycle = trusted(RunLifecycle.make, [])
