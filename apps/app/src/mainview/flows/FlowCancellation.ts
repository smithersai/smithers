import { Context } from "effect"

/** Per-invocation cancellation for controller promises; absent for direct binding callers. */
export const FlowCancellation = Context.Reference<AbortSignal | undefined>("ui/flows/FlowCancellation", {
  defaultValue: () => undefined
})
