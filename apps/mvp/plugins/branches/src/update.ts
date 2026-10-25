import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const Update = Action.make("branches/github-update", {
  payload: { method: Schema.Literals(["merge", "rebase"]) },
  success: Schema.Unknown,
})

export default Flow.make("branches/update", {
  description: "Bring a published branch up to date with its base with a merge commit, as GitHub's Update branch does.",
  capabilities: ["github:write"],
  payload: {},
  success: Schema.Unknown,
  body: Node.capture({ update: Update.name }, () => Update.call({ method: "merge" })),
})
