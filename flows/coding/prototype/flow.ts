import { Flow } from "@smthrs/core"
import { RequestInput } from "../schema.ts"
import { PocResult } from "../poc-schema.ts"

export default Flow.make({
  description: "Create and retain a disposable source prototype without implementing or landing it.",
  input: RequestInput,
  output: PocResult,
  capabilities: ["*"],
  flows: ["coding/RunPrototype"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
