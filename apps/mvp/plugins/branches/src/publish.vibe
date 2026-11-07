import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const Publish = Action.make("branches/github-publish", {
  payload: { title: Schema.String, body: Schema.String },
  success: Schema.Unknown,
})

export default Flow.make("branches/publish", {
  description: "Publish a Smithers-only branch to GitHub as one commit and a pull request.",
  capabilities: ["github:write"],
  payload: { title: Schema.String, body: Schema.String },
  success: Schema.Unknown,
  body: Node.capture({ publish: Publish.name }, ({ title, body }) => Publish.call({ title, body })),
})
