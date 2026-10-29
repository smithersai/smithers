import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"

const Fail = Action.make("fixture/Fail", {
  implementationVersion: "failure/v1",
  payload: { error: Schema.Unknown, unencodable: Schema.optional(Schema.Boolean) },
  success: Schema.String,
  // The action can persist and revive an Error; the containing flow's JSON-only
  // error channel deliberately cannot, exercising the terminal-result fallback.
  error: Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("fixture/Unencodable"), cause: Schema.Defect() }),
    Schema.Unknown
  ])
})

export const layer = Fail.toLayer(({ error, unencodable }) =>
  Effect.fail(unencodable ? { _tag: "fixture/Unencodable", cause: new Error(String(error)) } : error),
  { implementationVersion: "failure/v1" })

/** Real local failures: the engine must encode these and the control watch must relay them. */
export default Flow.make("failure", {
  description: "Failure fixture",
  capabilities: [],
  payload: { error: Schema.Unknown, unencodable: Schema.optional(Schema.Boolean) },
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture({ action: Fail.name, implementationVersion: "failure/v1" }, (payload) => Fail.call(payload))
})
