/**
 * The one constructor for a refusal a cell observes as a resolved envelope.
 *
 * A failed call **resolves** with a `failure` `Cell.CallResult`; it does not
 * throw, and `Cell.callFailure` renders it as `{ ok: false, error }`. The shape
 * is fixed — `value` is `null`, because a refusal has no value to hand back,
 * except a timeout's, which records the limit it ran past and what the flow
 * produced before it (see {@link timedOut}) — so every boundary that refuses a
 * call builds it here rather than repeating the literal. Of a failure's
 * `value`, the cell sees only that output. An absent `code` is left absent rather than written as
 * `undefined`: the encoded result is the durable wire contract used in sealed
 * keys, and it means {@link Cell.defaultCallFailureCode}.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import * as Schema from "effect/Schema"
import { type CallFailureCode, CallResult } from "../Cell.ts"

/**
 * A refusal the cell observes as a resolved `{ ok: false, error }` envelope.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const refusal = (code: CallFailureCode | undefined, message: string): CallResult =>
  code === undefined
    ? CallResult.new({ outcome: "failure", value: null, message })
    : CallResult.new({ outcome: "failure", value: null, code, message })

/**
 * A timeout refusal: the `timeout` code, with the limit the call ran past
 * recorded as `{ limitMillis }` in `value`, so a host that guards timeouts
 * parks the run on the exact limit whichever clock enforced it.
 *
 * `output` is what the flow produced before the limit stopped it, recorded
 * beside the limit; the cell reads it as `error.output` (see
 * `Cell.callFailure`). A timeout that records neither has `value` `null`.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const timedOut = (message: string, limitMillis: number | undefined, output?: Schema.Json): CallResult => {
  const recorded = {
    ...(limitMillis === undefined ? {} : { limitMillis }),
    ...(output === undefined ? {} : { output })
  }
  return CallResult.new({
    outcome: "failure",
    value: Object.keys(recorded).length === 0 ? null : recorded,
    code: "timeout",
    message
  })
}

/**
 * The limit a {@link timedOut} refusal recorded, when it recorded one.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const limitOf = (result: CallResult): number | undefined => {
  const recorded = decodeLimit(result.value)
  return recorded._tag === "Success" ? recorded.success.limitMillis : undefined
}

const decodeLimit = Schema.decodeUnknownResult(Schema.Struct({ limitMillis: Schema.Number }))
