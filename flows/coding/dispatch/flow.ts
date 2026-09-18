import { Flow } from "@smthrs/core"
import { DispatchInput, DispatchResult } from "../dispatch.ts"

export default Flow.make({
  description: "Run one dispatched agent turn in this workspace and answer with the assistant messages it produced.",
  input: DispatchInput,
  output: DispatchResult,
  capabilities: ["*"],
  flows: ["coding/RunDispatch"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})
