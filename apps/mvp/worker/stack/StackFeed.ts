import { Effect, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { routed } from "../Notifications.ts"

/**
 * Fold a committed TODO into its person's notification in the transaction that commits it (decision 0124): Commit's
 * result, which opens the TODO. Only the stack's one writer (`Stack.apply`) calls it, once per op id; a replay of the
 * same op answers its first receipt and folds nothing again.
 */
export const foldCommit = (commit: { readonly opId: string; readonly repoId: string; readonly actorId: string; readonly number: number }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const href = `/${commit.repoId.slice("github/".length)}/stack/${commit.number}`
    const rows = yield* sql`
      INSERT INTO notifications (recipient, subject, kind, state, mine, quiet, repo_id, title, href, version)
      VALUES (${commit.actorId}, ${`write:${commit.opId}`}, 'write', 'done', true, false, ${commit.repoId}, 'Commit TODO', ${href}, 2)
      ON CONFLICT (recipient, subject) DO NOTHING
      RETURNING subject`
    if (rows.length > 0) {
      yield* Metric.update(Metric.withAttributes(routed, { kind: "write", state: "done" }), 1)
      yield* Effect.logInfo("stack.commit.notice").pipe(Effect.annotateLogs({ opId: commit.opId, state: "done" }))
    }
    return rows.length
  }).pipe(Effect.withSpan("stack.commit.notice", { attributes: { opId: commit.opId } }))
