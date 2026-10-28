import { Effect, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { routed } from "../Notifications.ts"

/** The writes whose receipts reach the person's feed (decision 0124): a branch's Publish and Update, and a new issue. */
const FOLDED = ["branch/publish", "branch/update", "issue/create"] as const
type Folded = (typeof FOLDED)[number]

const TITLES: Readonly<Record<Folded, string>> = {
  "branch/publish": "Publish",
  "branch/update": "Update branch",
  "issue/create": "Create issue",
}

/**
 * Fold a write's actual receipt into its person's notification in the same transaction as admission or settlement;
 * replays change nothing. A branch's write opens its branch; a new issue opens the issue once GitHub has it, else the
 * repository's issues.
 */
export const fold = (id: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [write] = yield* sql<{
    readonly actorId: string
    readonly repoId: string
    readonly op: Folded
    readonly status: string
    readonly name: string | null
    readonly itemNumber: number | null
  }>`
    SELECT w.actor_id AS "actorId", w.repo_id AS "repoId", w.op, w.status, b.name, w.item_number AS "itemNumber"
    FROM github_writes w LEFT JOIN branches b ON b.id = w.branch_id
    WHERE w.id = ${id}::uuid AND w.op IN ${sql.in(FOLDED)}`
  if (write === undefined || (write.op !== "issue/create" && write.name === null)) return 0
  const state = write.status === "pending" ? "working" : write.status === "done" ? "done" : "failed"
  const version = state === "working" ? 1 : 2
  const repo = write.repoId.slice("github/".length)
  const href = write.op === "issue/create"
    ? write.itemNumber === null ? `/${repo}/issues` : `/${repo}/issues/${write.itemNumber}`
    : `/${repo}/tree/${write.name!.split("/").map(encodeURIComponent).join("/")}`
  const rows = yield* sql`
    INSERT INTO notifications (recipient, subject, kind, state, mine, quiet, repo_id, title, href, version)
    VALUES (${write.actorId}, ${`write:${id}`}, 'write', ${state}, true, false, ${write.repoId}, ${TITLES[write.op]}, ${href}, ${version})
    ON CONFLICT (recipient, subject) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, href = EXCLUDED.href,
      occurred_at = now(), updated_at = now()
    WHERE notifications.state <> EXCLUDED.state
    RETURNING subject`
  if (rows.length > 0) {
    yield* Metric.update(Metric.withAttributes(routed, { kind: "write", state }), 1)
    yield* Effect.logInfo("github.write.notice").pipe(Effect.annotateLogs({ writeId: id, op: write.op, state }))
  }
  return rows.length
}).pipe(Effect.withSpan("github.write.notice", { attributes: { writeId: id } }))
