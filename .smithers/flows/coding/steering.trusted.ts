// The foreign synchronous helpers steering.vibe calls.
// A wrapper keeps the callee's failure contract in its value (vibelang-runtime `trusted`): a `.vibe` call needs no
// `Effect.try`, and with no listed classes every exception is a defect, as a throw inside `Effect.gen` was before.
import { trusted } from "vibelang-runtime"
import * as NotificationEvent from "../../../packages/smithers/notifications/src/NotificationEvent.vibe"

export const fromEntry = trusted(NotificationEvent.fromEntry, [])
export const isPromoted = trusted(NotificationEvent.isPromoted, [])
export const encodeComponent = trusted(encodeURIComponent, [])
