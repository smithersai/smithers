import { Clock, Effect } from "effect"
import { AttentionStore } from "./store"

/** A local launch occupies the shared stack until the server's matching receipt takes over. */
export const requestWriteNotice = (request: { readonly writeId: string; readonly repoId: string; readonly branch: string; readonly operation: "publish" | "update" }) =>
  Effect.gen(function* () {
    const { launches } = yield* AttentionStore
    const at = new Date(yield* Clock.currentTimeMillis).toISOString()
    yield* launches.insert({
      subject: `write:${request.writeId}`, recipient: "", kind: "write", state: "waiting", mine: true, quiet: true,
      runId: null, repoId: request.repoId, conversationId: null, actor: null,
      title: request.operation === "publish" ? "Publish" : "Update branch", ref: "launch",
      href: `/${request.repoId.slice("github/".length)}/tree/${request.branch.split("/").map(encodeURIComponent).join("/")}`,
      version: 1, readVersion: 0, dismissedVersion: 0, hiddenVersion: 0, occurredAt: at, createdAt: at, updatedAt: at,
    }).pipe(Effect.orDie)
  })

/** Failed admission remains a failure; a launch acknowledgment never supplies a completion toast. */
export const failWriteNotice = (writeId: string) => Effect.gen(function* () {
  const { launches } = yield* AttentionStore
  const at = new Date(yield* Clock.currentTimeMillis).toISOString()
  yield* Effect.ignore(launches.update(`write:${writeId}`, (row) => { row.state = "failed"; row.updatedAt = at }))
})
