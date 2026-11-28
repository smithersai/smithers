import { Uphill } from "@smthrs/rpc"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Backfills lightweight visibility-partitioned Uphill index documents (`uphill-index` for `public`,
// `uphill-index-maintainers` for `maintainers`) for existing on-demand `uphill/untrusted-*`
// previews and `uphill/history` documents so browsers discover them via `core/feeds` and open
// `core/feed` subscriptions without relaxing the index's slash exclusion.
interface ExistingIndexedRow {
  readonly repo: string
  readonly name: string
  readonly visibility: "public" | "maintainers"
  readonly updated_at: string
}

export const backfillUphillFeedIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<ExistingIndexedRow>`
    SELECT repo, name, visibility,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM feed_documents
    WHERE name = ${Uphill.UPHILL_HISTORY_FEED_NAME}
      OR name LIKE ${`${Uphill.UPHILL_UNTRUSTED_FEED_PREFIX}%`}
    ORDER BY repo ASC, updated_at DESC, name ASC`

  const grouped = new Map<string, {
    readonly repo: string
    readonly visibility: "public" | "maintainers"
    readonly items: Array<{ readonly name: string; readonly updatedAt: string }>
  }>()

  for (const row of rows) {
    const key = `${row.repo}\0${row.visibility}`
    let group = grouped.get(key)
    if (group === undefined) {
      group = { repo: row.repo, visibility: row.visibility, items: [] }
      grouped.set(key, group)
    }
    group.items.push({ name: row.name, updatedAt: row.updated_at })
  }

  for (const group of grouped.values()) {
    const indexDoc = Uphill.buildFeedIndex(group.items)
    if (indexDoc === null) continue
    const indexName = Uphill.uphillIndexName(group.visibility)
    const indexId = `${group.repo}:${indexName}`
    const body = JSON.stringify(indexDoc)
    yield* sql`
      INSERT INTO feed_documents (id, repo, name, visibility, body, updated_at)
      VALUES (${indexId}, ${group.repo}, ${indexName}, ${group.visibility}, ${body}::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET
        visibility = EXCLUDED.visibility,
        body = EXCLUDED.body,
        updated_at = now()
      WHERE feed_documents.body IS DISTINCT FROM EXCLUDED.body
        OR feed_documents.visibility IS DISTINCT FROM EXCLUDED.visibility`
  }
})

export default backfillUphillFeedIndexes
