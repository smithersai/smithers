import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

export default Flow.make("consequential", {
  description: "Consequential",
  modelInvocable: true,
  capabilities: ["fs:write:/**", "proc:spawn:**", "net:post:https://example.test"],
  effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("Authorized")
})
