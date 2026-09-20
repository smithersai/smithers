"use local"

import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

/**
 * The one step this flow's graph names.
 *
 * A flow carries a body and never code, so the host attaches the
 * implementation as a layer. The bridge resolves it by NAME at dispatch, which
 * is what lets the loader evaluate a verified copy of this file and still reach
 * the implementation a test registered from the original.
 */
export const Shout = Action.make("test/standalone/Shout", {
  payload: Schema.Struct({ name: Schema.String }),
  success: Schema.String
})

/**
 * A module flow that IS its own graph.
 *
 * It names no collaborator flow and no model, so nothing a host registers runs
 * it: the body below is the whole of what `smithers up standalone` executes.
 */
export default Flow.make("test/standalone", {
  description: "Shouts a name through its own graph, or says nothing.",
  payload: { name: Schema.String },
  success: Schema.String,
  body: (payload) =>
    Node.branch(Node.succeed(payload.name), {
      if: (name) => name.length > 0,
      then: (name) => Shout.call({ name }),
      else: () => Node.succeed("silence")
    })
})
