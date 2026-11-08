// The foreign synchronous helpers vibe-evidence.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import * as Digest from "@smthrs/core/Digest"
import { sameRevision as sameRevisionImpl } from "./schema.ts"
import { leafFeedback as leafFeedbackImpl } from "./todo-route.vibe"

export const canonical = trusted(Digest.canonical, [])
export const sameRevision = trusted(sameRevisionImpl, [])
export const leafFeedback = trusted(leafFeedbackImpl, [])
