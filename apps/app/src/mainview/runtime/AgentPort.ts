import type { AgentTurnFrame, StartAgentTurnRequest, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"

/**
 * The agent contract every host implements: the HTTP agent against the app
 * origin (native/WebAgent.ts), the in-page chain (chain/ChainRuntime.ts) and
 * the unavailable adapter a runtime without an agent capability binds. It is
 * host-neutral, so it lives beside the runtime composition rather than in the
 * Electrobun bridge.
 */
export interface AgentPort {
  readonly available: boolean
  readonly startTurn: (request: StartAgentTurnRequest) => Promise<StartAgentTurnResult>
  readonly cancelTurn: (runId: string) => Promise<void>
  /**
   * Mid-turn input (DESIGN.md §14): admit a message into the running turn's
   * steering queue, drained at the next link boundary. Absent on backends
   * without steering; callers treat undefined as "not steerable".
   */
  readonly steer?: (runId: string, text: string) => Promise<boolean>
  /**
   * Resolve a chain approval park (DESIGN.md §14): record the human's
   * decision against the pending ask so a fresh startTurn on the same
   * lineage converges under it. Absent on backends without the seam.
   */
  readonly resolveApproval?: (
    runId: string,
    decision: "approved" | "denied",
    ask?: { readonly name: string; readonly claim: string }
  ) => Promise<boolean>
  /** Drop every session grant and pending denial (admin /debug.grants.reset). */
  readonly revokeGrants?: () => Promise<void>
  readonly subscribe: (listener: (frame: AgentTurnFrame) => void) => () => void
}
