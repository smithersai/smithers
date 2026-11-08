import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const Create = Action.make("branches/ephemeral", {
  payload: { ref: Schema.String },
  success: Schema.Unknown,
})

export default Flow.make("branches/create", {
  description: "Create a Smithers-only conversation branch.",
  capabilities: ["git:write"],
  payload: { ref: Schema.String },
  success: Schema.Unknown,
  body: Node.capture({ create: Create.name }, ({ ref }) => Create.call({ ref })),
})
