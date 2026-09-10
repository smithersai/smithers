import { Flow } from "@smthrs/core"
import { Schema } from "effect"
import { Check, Implementation, Receipt } from "../../coding/schema.ts"

export default Flow.make({
  description: "Review the configured public wiki against the implemented immutable JJ revision and return ordinary owning-Change findings.",
  input: Schema.Struct({ implementation: Implementation, check: Check }), output: Receipt,
  capabilities: ["*"], flows: ["coding/WikiCheck"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
