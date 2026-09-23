import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

export default Flow.make("wide", {
  description: "Wide",
  capabilities: ["*"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("wide")
})
