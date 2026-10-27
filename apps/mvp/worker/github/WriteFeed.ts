import { Effect, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { routed } from "../Notifications.ts"

/** Fold a branch write's actual receipt in the same transaction as admission or settlement; replays change nothing. */
export const fold = (id: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [write] = yield* sql<{ readonly actorId: string; readonly repoId: string; readonly op: "branch/publish" | "branch/update"; readonly status: string; readonly name: string }>`
    SELECT w.actor_id AS "actorId", w.repo_id AS "repoId", w.op, w.status, b.name
    FROM github_writes w JOIN branches b ON b.id = w.branch_id
    WHERE w.id = ${id}::uuid AND w.op IN ('branch/publish', 'branch/update')`
  if (write === undefined) return 0
  const state = write.status === "pending" ? "working" : write.status === "done" ? "done" : "failed"
  const version = state === "working" ? 1 : 2
  const title = write.op === "branch/publish" ? "Publish" : "Update branch"
  const href = `/${write.repoId.slice("github/".length)}/tree/${write.name.split("/").map(encodeURIComponent).join("/")}`
  const rows = yield* sql`
    INSERT INTO notifications (recipient, subject, kind, state, mine, quiet, repo_id, title, href, version)
    VALUES (${write.actorId}, ${`write:${id}`}, 'write', ${state}, true, false, ${write.repoId}, ${title}, ${href}, ${version})
    ON CONFLICT (recipient, subject) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version,
      occurred_at = now(), updated_at = now()
    WHERE notifications.state <> EXCLUDED.state
    RETURNING subject`
  if (rows.length > 0) {
    yield* Metric.update(Metric.withAttributes(routed, { kind: "write", state }), 1)
    yield* Effect.logInfo("github.write.notice").pipe(Effect.annotateLogs({ writeId: id, op: write.op, state }))
  }
  return rows.length
}).pipe(Effect.withSpan("github.write.notice", { attributes: { writeId: id } }))
