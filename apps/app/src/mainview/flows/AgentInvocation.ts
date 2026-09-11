import type { Authorize, Catalog } from "@smthrs/chain"

/** Host-owned authority for one chain call; never serialized into a card payload. */
export interface AgentInvocation {
  readonly signal?: AbortSignal
  readonly lineage?: string
  readonly slot: Catalog.CallSlot
  readonly authorize: Authorize.Service
  /** Declaration digest checked by gate 4. Continuations must drop this receipt. */
  readonly authorized?: string
  /** Preserve typed refusals across the controller's string-result boundary. */
  readonly refused: (error: Authorize.AuthorizeError) => void
}
