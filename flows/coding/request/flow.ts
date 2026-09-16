import { Flow } from "@smthrs/core"
import { RequestInput, RequestResult } from "../schema.ts"

export default Flow.make({
  description: "Plan from current repository source and native history, then implement Changes with required checks and bounded owner correction.",
  input: RequestInput,
  output: RequestResult,
  capabilities: ["*"],
  flows: ["coding/RunRequest"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})
