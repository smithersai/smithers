import * as Effect from "effect/Effect"
import { AgentTurnJournalReplySchema, agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnJournalCommand, AgentTurnJournalReply } from "@smthrs/rpc/AgentTurnJournal"
import { namespaceCall } from "./DurableStorage"
import type { NativeNamespace } from "./DurableStorage"
import { StorageFailure } from "./Failures"
import { readJsonOrUndefined } from "./Http"
import { sha256Hex } from "./turnLimit"

export interface TurnJournalClient {
  readonly request: (runId: string, legId: string, command: AgentTurnJournalCommand) => Effect.Effect<{
    readonly status: number; readonly body: AgentTurnJournalReply
  }, StorageFailure>
}

/** One fixed head per object: journal scopes never share the legacy cancellation object. */
export const turnJournalObjectName = (runId: string, legId: string): Effect.Effect<string> =>
  Effect.map(sha256Hex(agentTurnJournalDigestInput("scope", [runId, legId])), hash => `turn-journal/v1/${hash}`)

/** The existing namespace binding hosts separate per-leg journal objects. */
export const createTurnJournalClient = (namespace: NativeNamespace): TurnJournalClient => ({
  request: (runId, legId, command) => Effect.gen(function* () {
    const name = yield* turnJournalObjectName(runId, legId)
    const response = yield* namespaceCall("turn journal", namespace, name, new Request("https://turn-cancel.internal/journal", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command)
    }))
    const parsed = AgentTurnJournalReplySchema.safeParse(yield* readJsonOrUndefined(response))
    if (!parsed.success || response.ok === (parsed.data.status === "error") || !replyHasScope(parsed.data, runId, legId)) return yield* Effect.fail(new StorageFailure({
      operation: "turn journal reply", cause: new Error("The durable turn reply could not be verified.")
    }))
    return { status: response.status, body: parsed.data }
  })
})

/** A namespace routing mistake must fail before any foreign output is published. */
const replyHasScope = (reply: AgentTurnJournalReply, runId: string, legId: string): boolean => {
  const scoped = (value: { readonly runId: string; readonly legId: string }) => value.runId === runId && value.legId === legId
  const batchScoped = (value: { readonly runId: string; readonly legId: string; readonly frames: ReadonlyArray<{ readonly runId: string }> }) =>
    scoped(value) && value.frames.every(frame => frame.runId === runId)
  switch (reply.status) {
    case "accepted": case "existing": return scoped(reply.cursor)
    case "committed": case "duplicate": return scoped(reply.cursor) && batchScoped(reply.batch)
    case "ok": return scoped(reply.after) && scoped(reply.next) && scoped(reply.head) && reply.batches.every(batchScoped)
    default: return true
  }
}
