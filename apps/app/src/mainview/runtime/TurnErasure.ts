import { TURN_ERASE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { AgentTurnErasureSchema, AgentTurnJournalReplySchema, type AgentTurnErasure } from "@smthrs/rpc/AgentTurnJournal"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"

export type EraseRemoteTurn = (entry: AgentTurnErasure, signal: AbortSignal) => Promise<void>
/** A separate delete-only route: 404 is not an acknowledgement of an absent producer. */
export const createTurnEraser = (http: FetchLike, baseUrl = ""): EraseRemoteTurn => async (entry, signal) => {
  const response = await http(`${baseUrl}${TURN_ERASE_PATH}`, { method: "POST", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify(AgentTurnErasureSchema.parse(entry)) })
  if (!response.ok) { await response.body?.cancel(); throw new Error("Remote turn cleanup is pending.") }
  const reply = AgentTurnJournalReplySchema.safeParse(await response.json().catch(() => undefined))
  if (!reply.success || reply.data.status !== "retired") throw new Error("Remote turn cleanup is pending.")
}
