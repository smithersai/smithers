import * as WriteAuthority from "../WriteAuthority.ts"
import * as ProtectedAuthority from "../ProtectedAuthority.ts"
import { fold as foldWriteNotice } from "./WriteFeed.ts"
import { COMMITMENTS, commitmentOf } from "../../src/features/issues/lifecycle.ts"
import { GitHub } from "@smthrs/integrations"
import { Effect, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  commentId,
  itemId,
  TRIAGE_DECISIONS,
  triageOf,
  type WriteFailure,
  type WriteOp,
  type WriteStatus,
  type WriteVia,
} from "../../src/features/issues/contract.ts"
import { isRepository, repoId as repoIdOf } from "../../src/features/repo/contract.ts"
import { UPDATE_METHODS } from "../../src/features/branch/contract.ts"
import { MERGE_METHODS, type MergeFlow } from "../../src/features/pulls/contract.ts"
import { Sealed, sessionLive } from "../SessionStore.ts"
import * as Metrics from "./Metrics.ts"

// The git loop's rows in Postgres (docs/features/issues.md#postgres, migration 0016_github_issues). GitHub is the truth:
// only the server's GitHub flows write `items` and `comments`, and only under the newer-than guard, so a duplicate or
// reordered read changes nothing. Each function is one statement, or one transaction, on the `SqlClient` in context.

type Issue = GitHub.Issues.Issue
type IssueComment = GitHub.Issues.IssueComment

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The write id a body's hidden marker names, when it is one of ours (a UUID); else null. */
export const markedWrite = (body: string | null): string | null => {
  const id = GitHub.Issues.writeIdOf(body)
  return id !== undefined && UUID.test(id) ? id : null
}

/** A body as the projection keeps it: GitHub's text without our hidden marker. */
export const shownBody = (body: string | null): string => GitHub.Issues.withoutWriteMarker(body ?? "")

/**
 * The parent `parent_issue_url` names, as `issue_relations` keys it; undefined for one that names no issue this app could
 * read, which is skipped and counted, never guessed at.
 */
export const parentNamed = (url: string): { readonly repoId: string; readonly number: number; readonly owner: string; readonly name: string; readonly id: string } | undefined => {
  const found = /\/repos\/([^/?#]+)\/([^/?#]+)\/issues\/([1-9][0-9]*)(?:[?#].*)?$/.exec(url)
  if (found === null || !isRepository(found[1]!, found[2]!)) return undefined
  const number = Number(found[3])
  if (!Number.isSafeInteger(number)) return undefined
  const parentRepo = repoIdOf(found[1]!, found[2]!)
  return { repoId: parentRepo, number, owner: found[1]!, name: found[2]!, id: itemId(parentRepo, number) }
}

/** The relation `issue` states: its parent's id or `null`; undefined when it states none (a pull request, an old server). */
export const statedParent = (child: string, issue: Issue) => {
  if (issue.sub_issues_summary === undefined || issue.sub_issues_summary === null) return undefined
  const url = issue.parent_issue_url ?? null
  if (url === null) return null
  const parent = parentNamed(url)
  return parent === undefined || parent.id === itemId(child, issue.number) ? undefined : parent
}

/**
 * Applies what `issue`, read at `at`, says of its parent and children, under the item's advisory lock, which the caller
 * holds in this transaction. The fence `issue_relation_seen.seen_at` orders reads by when they were made, for presence and
 * absence alike. An edge whose parent didn't change is left alone, so a re-read sends no shape message.
 */
const observeRelation = (owner: string, issue: Issue, at: string) =>
  Effect.gen(function* () {
    const summary = issue.sub_issues_summary
    if (summary === undefined || summary === null) return
    const sql = yield* SqlClient.SqlClient
    const id = itemId(owner, issue.number)
    yield* sql`
      INSERT INTO issue_child_counts (parent_id, repo_id, sub_total, sub_completed, observed_at)
      VALUES (${id}, ${owner}, ${summary.total}, ${summary.completed}, ${at}::timestamptz)
      ON CONFLICT (parent_id) DO UPDATE SET sub_total = EXCLUDED.sub_total, sub_completed = EXCLUDED.sub_completed,
        observed_at = EXCLUDED.observed_at
      WHERE issue_child_counts.observed_at < EXCLUDED.observed_at`
    const parent = statedParent(owner, issue)
    if (parent === undefined) {
      yield* Metric.update(Metrics.relationsUnreadable, 1)
      yield* Effect.logWarning("github.relation.unreadable").pipe(Effect.annotateLogs({ repoId: owner, number: issue.number }))
      return
    }
    if (parent === null) {
      yield* sql`
        WITH seen AS (
          INSERT INTO issue_relation_seen (item_id, seen_at) VALUES (${id}, ${at}::timestamptz)
          ON CONFLICT (item_id) DO UPDATE SET seen_at = EXCLUDED.seen_at
          WHERE issue_relation_seen.seen_at < EXCLUDED.seen_at
          RETURNING item_id
        )
        DELETE FROM issue_relations WHERE child_id IN (SELECT item_id FROM seen)`
      return
    }
    yield* sql`
      WITH seen AS (
        INSERT INTO issue_relation_seen (item_id, seen_at) VALUES (${id}, ${at}::timestamptz)
        ON CONFLICT (item_id) DO UPDATE SET seen_at = EXCLUDED.seen_at
        WHERE issue_relation_seen.seen_at < EXCLUDED.seen_at
        RETURNING item_id
      )
      INSERT INTO issue_relations (child_id, child_repo_id, parent_id, parent_repo_id, observed_at)
      SELECT item_id, ${owner}, ${parent.id}, ${parent.repoId}, ${at}::timestamptz FROM seen
      ON CONFLICT (child_id) DO UPDATE SET parent_id = EXCLUDED.parent_id, parent_repo_id = EXCLUDED.parent_repo_id,
        observed_at = EXCLUDED.observed_at
      WHERE issue_relations.parent_id <> EXCLUDED.parent_id`
  })

/**
 * What `github/Relations` writes of an issue it listed: its relation alone, under the same lock and fences as
 * `upsertIssue`, so a walk of every issue updates no item row.
 */
export const upsertRelation = (repoId: string, issue: Issue, fetchedAt: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(Effect.gen(function* () {
      const id = itemId(repoId, issue.number)
      const at = new Date(fetchedAt).toISOString()
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`
      const fence = yield* sql`SELECT item_id FROM github_projection_fences WHERE item_id = ${id} AND gone_at >= ${at}::timestamptz`
      if (fence.length === 0) yield* observeRelation(repoId, issue, at)
    }))
  })

/** The parent `repoId`'s issue `number` has now, and its state, as the projection holds them: none for one never read. */
export const relationBefore = (repoId: string, number: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const id = itemId(repoId, number)
    const [row] = yield* sql<{ readonly state: string | null; readonly parentId: string | null }>`
      SELECT (SELECT state FROM items WHERE id = ${id}) AS state,
        (SELECT parent_id FROM issue_relations WHERE child_id = ${id}) AS "parentId"`
    return { state: row?.state ?? null, parentId: row?.parentId ?? null }
  })

/** Parent memberships needing checks, including edges whose parent has no remaining count row. */
export const parentsToVerify = (repoId: string, limit: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ readonly parentId: string }>`
      WITH parents AS (
        SELECT parent_id FROM issue_child_counts WHERE repo_id = ${repoId} AND sub_total > 0
        UNION
        SELECT parent_id FROM issue_relations WHERE parent_repo_id = ${repoId}
      )
      SELECT p.parent_id AS "parentId" FROM parents p
      LEFT JOIN issue_parent_checks c ON c.parent_id = p.parent_id
      ORDER BY c.attempted_at ASC NULLS FIRST, p.parent_id
      LIMIT ${limit}`
  })

/** The children of `parentId` the projection holds. */
export const childrenOf = (parentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ readonly childId: string; readonly childRepoId: string }>`
      SELECT child_id AS "childId", child_repo_id AS "childRepoId" FROM issue_relations WHERE parent_id = ${parentId}`
  })

/** Records an attempt before its network call, even when the parent has no count row. */
export const markVerificationAttempt = (repoId: string, parentId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO issue_parent_checks (parent_id, repo_id, attempted_at)
    VALUES (${parentId}, ${repoId}, clock_timestamp())
    ON CONFLICT (parent_id) DO UPDATE SET attempted_at = EXCLUDED.attempted_at`)

/** Records that `github/Relations` successfully compared `parentId` now. */
export const markVerified = (parentId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE issue_parent_checks SET verified_at = clock_timestamp() WHERE parent_id = ${parentId}`)

/**
 * Upserts issue `issue` of repository `repoId`, read at `fetchedAt` (epoch ms): inserted, or updated only when GitHub's
 * `updated_at` and the read time are newer than the row's. Identical content advances only the observation fence,
 * without counting a content change. A row seen again is no longer deleted. Its triage state is what its labels say
 * (`triageOf`); whether a person pinned it is Smithers' own and never changes here. Returns whether the row changed.
 */
export const upsertIssue = (repoId: string, issue: Issue, fetchedAt: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const id = itemId(repoId, issue.number)
      const at = new Date(fetchedAt).toISOString()
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`
      const fence = yield* sql`SELECT item_id FROM github_projection_fences WHERE item_id = ${id} AND gone_at >= ${at}::timestamptz`
      if (fence.length > 0) return false
      yield* observeRelation(repoId, issue, at)
      const triage = triageOf(issue.labels.map((label) => label.name))
      const commitment = commitmentOf(issue.labels.map((label) => label.name))
      const rows = yield* sql`
        INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, state_reason, author_login, comments,
          created_at, updated_at, closed_at, deleted_at, write_id, triage, commitment, source_updated_at, fetched_at)
        VALUES (${itemId(repoId, issue.number)}, ${repoId}, ${issue.number},
          ${issue.pull_request === undefined ? "issue" : "pull"}, ${issue.id}, ${issue.title}, ${shownBody(issue.body)},
          ${issue.state}, ${issue.state_reason}, ${issue.user?.login ?? null}, ${issue.comments},
          ${issue.created_at}::timestamptz, ${issue.updated_at}::timestamptz, ${issue.closed_at}::timestamptz, NULL,
          ${markedWrite(issue.body)}::uuid, ${triage}, ${commitment}, ${issue.updated_at}::timestamptz,
          ${new Date(fetchedAt).toISOString()}::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          kind = EXCLUDED.kind, github_id = EXCLUDED.github_id, title = EXCLUDED.title, body = EXCLUDED.body,
          state = EXCLUDED.state, state_reason = EXCLUDED.state_reason, author_login = EXCLUDED.author_login,
          comments = EXCLUDED.comments, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
          closed_at = EXCLUDED.closed_at, deleted_at = NULL, write_id = COALESCE(EXCLUDED.write_id, items.write_id),
          commitment = EXCLUDED.commitment, triage = EXCLUDED.triage, source_updated_at = EXCLUDED.source_updated_at, fetched_at = EXCLUDED.fetched_at
        WHERE (items.source_updated_at, items.fetched_at) < (EXCLUDED.source_updated_at, EXCLUDED.fetched_at)
          AND (items.deleted_at IS NULL OR items.fetched_at < EXCLUDED.fetched_at)
          AND (items.kind, items.github_id, items.title, items.body, items.state, items.state_reason, items.author_login,
            items.comments, items.created_at, items.updated_at, items.closed_at, items.deleted_at,
            COALESCE(EXCLUDED.write_id, items.write_id), items.triage, items.commitment)
          IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.github_id, EXCLUDED.title, EXCLUDED.body, EXCLUDED.state,
            EXCLUDED.state_reason, EXCLUDED.author_login, EXCLUDED.comments, EXCLUDED.created_at, EXCLUDED.updated_at,
            EXCLUDED.closed_at, NULL::timestamptz, items.write_id, EXCLUDED.triage, EXCLUDED.commitment)
        RETURNING id`
      // Even identical content is an observation: keep its ordering fence.
      if (rows.length === 0) yield* sql`
        UPDATE items SET source_updated_at = ${issue.updated_at}::timestamptz,
          fetched_at = ${new Date(fetchedAt).toISOString()}::timestamptz
        WHERE id = ${itemId(repoId, issue.number)} AND deleted_at IS NULL
          AND (source_updated_at, fetched_at) < (${issue.updated_at}::timestamptz, ${new Date(fetchedAt).toISOString()}::timestamptz)`
      return rows.length > 0
    }))
  })

/** Upserts comment `comment` on issue `number` of `repoId`, under the same guard. Returns whether the row changed. */
export const upsertComment = (repoId: string, number: number, comment: IssueComment, fetchedAt: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const id = itemId(repoId, number)
      const at = new Date(fetchedAt).toISOString()
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`
      const fence = yield* sql`SELECT item_id FROM github_projection_fences WHERE item_id = ${id} AND (gone_at >= ${at}::timestamptz OR comments_listed_at > ${at}::timestamptz)`
      if (fence.length > 0) return false
      const rows = yield* sql`
        INSERT INTO comments (id, repo_id, item_id, github_id, author_login, body, created_at, updated_at, deleted_at,
          write_id, source_updated_at, fetched_at)
        VALUES (${commentId(repoId, comment.id)}, ${repoId}, ${itemId(repoId, number)}, ${comment.id},
          ${comment.user?.login ?? null}, ${shownBody(comment.body)}, ${comment.created_at}::timestamptz,
          ${comment.updated_at}::timestamptz, NULL, ${markedWrite(comment.body)}::uuid, ${comment.updated_at}::timestamptz,
          ${new Date(fetchedAt).toISOString()}::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          item_id = EXCLUDED.item_id, author_login = EXCLUDED.author_login, body = EXCLUDED.body,
          updated_at = EXCLUDED.updated_at, deleted_at = NULL, write_id = COALESCE(EXCLUDED.write_id, comments.write_id),
          source_updated_at = EXCLUDED.source_updated_at, fetched_at = EXCLUDED.fetched_at
        WHERE (comments.source_updated_at, comments.fetched_at) < (EXCLUDED.source_updated_at, EXCLUDED.fetched_at)
          AND (comments.deleted_at IS NULL OR comments.fetched_at < EXCLUDED.fetched_at)
          AND (comments.item_id, comments.author_login, comments.body, comments.updated_at, comments.deleted_at,
            COALESCE(EXCLUDED.write_id, comments.write_id))
          IS DISTINCT FROM (EXCLUDED.item_id, EXCLUDED.author_login, EXCLUDED.body, EXCLUDED.updated_at,
            NULL::timestamptz, comments.write_id)
        RETURNING id`
      // Even identical content is an observation: keep its ordering fence.
      if (rows.length === 0) yield* sql`
        UPDATE comments SET source_updated_at = ${comment.updated_at}::timestamptz,
          fetched_at = ${new Date(fetchedAt).toISOString()}::timestamptz
        WHERE id = ${commentId(repoId, comment.id)} AND deleted_at IS NULL
          AND (source_updated_at, fetched_at) < (${comment.updated_at}::timestamptz, ${new Date(fetchedAt).toISOString()}::timestamptz)`
      return rows.length > 0
    }))
  })

/** Tombstones an issue and comments, and removes its pull projections, only if no newer read supersedes the absence. */
export const tombstoneIssue = (repoId: string, number: number, fetchedAt: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const id = itemId(repoId, number)
    const at = new Date(fetchedAt).toISOString()
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`
      yield* sql`INSERT INTO github_projection_fences (item_id, gone_at) VALUES (${id}, ${at}::timestamptz)
        ON CONFLICT (item_id) DO UPDATE SET gone_at = GREATEST(github_projection_fences.gone_at, EXCLUDED.gone_at)`
      // Its edge goes, and the fence stays: an older read saying "parent A" changes nothing.
      yield* sql`
        WITH seen AS (
          INSERT INTO issue_relation_seen (item_id, seen_at) VALUES (${id}, ${at}::timestamptz)
          ON CONFLICT (item_id) DO UPDATE SET seen_at = EXCLUDED.seen_at
          WHERE issue_relation_seen.seen_at <= EXCLUDED.seen_at
          RETURNING item_id
        )
        DELETE FROM issue_relations WHERE child_id IN (SELECT item_id FROM seen)`
      yield* sql`DELETE FROM issue_child_counts WHERE parent_id = ${id} AND observed_at <= ${at}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM issue_relations WHERE parent_id = ${id})`
      const [before] = yield* sql<{ readonly live: boolean }>`
        SELECT deleted_at IS NULL AS live FROM items WHERE id = ${id} AND fetched_at <= ${at}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM pulls WHERE item_id = ${id} AND fetched_at > ${at}::timestamptz)
        FOR UPDATE`
      if (before === undefined) return false
      yield* sql`UPDATE items SET deleted_at = COALESCE(deleted_at, ${at}::timestamptz), fetched_at = ${at}::timestamptz WHERE id = ${id}`
      yield* sql`UPDATE comments SET deleted_at = COALESCE(deleted_at, ${at}::timestamptz), fetched_at = ${at}::timestamptz
        WHERE item_id = ${id} AND fetched_at <= ${at}::timestamptz`
      yield* sql`DELETE FROM pull_commits WHERE item_id = ${id}`
      yield* sql`DELETE FROM reviews WHERE item_id = ${id}`
      yield* sql`DELETE FROM pulls WHERE item_id = ${id}`
      return before.live
    }))
  })

/**
 * Tombstones issue `number`'s comments that a complete listing didn't contain (`kept`, GitHub's comment ids), when
 * nothing newer than `fetchedAt` touched them since. Returns how many it tombstoned.
 */
export const tombstoneCommentsExcept = (repoId: string, number: number, kept: ReadonlyArray<number>, fetchedAt: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const at = new Date(fetchedAt).toISOString()
    return yield* sql.withTransaction(Effect.gen(function* () {
      const id = itemId(repoId, number)
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`
      yield* sql`INSERT INTO github_projection_fences (item_id, comments_listed_at) VALUES (${id}, ${at}::timestamptz)
        ON CONFLICT (item_id) DO UPDATE SET comments_listed_at = GREATEST(github_projection_fences.comments_listed_at, EXCLUDED.comments_listed_at)`
      const rows = yield* sql<{ readonly id: string; readonly live: boolean }>`
        SELECT id, deleted_at IS NULL AS live FROM comments
        WHERE item_id = ${itemId(repoId, number)}
          AND NOT (github_id = ANY(${kept.map(String)}::bigint[]))
          AND fetched_at <= ${at}::timestamptz
        FOR UPDATE`
      if (rows.length === 0) return 0
      // Repeated absence advances the fence too, while preserving the original deletion time.
      yield* sql`UPDATE comments SET deleted_at = COALESCE(deleted_at, ${at}::timestamptz), fetched_at = ${at}::timestamptz
        WHERE id = ANY(${rows.map((row) => row.id)}::text[])`
      return rows.filter((row) => row.live).length
    }))
  })

/** Records webhook delivery `deliveryId` once. Returns whether this was its first time. */
export const recordDelivery = (delivery: {
  readonly deliveryId: string
  readonly event: string
  readonly action: string | null
  readonly repoId: string | null
  readonly subject: number | null
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`
      INSERT INTO github_deliveries (delivery_id, event, action, repo_id, subject)
      VALUES (${delivery.deliveryId}, ${delivery.event}, ${delivery.action}, ${delivery.repoId}, ${delivery.subject})
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING delivery_id`
    return rows.length > 0
  })

/** When delivery `deliveryId` arrived (epoch ms), once the route recorded it. */
export const receivedAt = (deliveryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly at: string }>`
      SELECT (extract(epoch FROM received_at) * 1000)::bigint::text AS at
      FROM github_deliveries WHERE delivery_id = ${deliveryId}`
    return Option.map(Option.fromNullishOr(row), (found) => Number(found.at))
  })

/** A write's payload as the route admitted it, by operation. */
export const WritePayload = Schema.Union([
  Schema.Struct({ op: Schema.Literal("issue/commitment"), number: Schema.Int, commitment: Schema.Literals(COMMITMENTS) }),
  Schema.Struct({ op: Schema.Literal("issue/create"), title: Schema.String, body: Schema.String }),
  Schema.Struct({ op: Schema.Literal("issue/comment"), number: Schema.Int, body: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("issue/triage"),
    number: Schema.Int,
    decision: Schema.Literals(TRIAGE_DECISIONS),
    reason: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ op: Schema.Literal("triage/run"), number: Schema.Int }),
  Schema.Struct({ op: Schema.Literal("triage/enable"), authority: WriteAuthority.Admission, dailyTokens: Schema.Int }),
  Schema.Struct({ op: Schema.Literal("triage/pause"), authority: WriteAuthority.Admission }),
  Schema.Struct({
    op: Schema.Literal("pr/merge"),
    number: Schema.Int,
    headSha: Schema.String,
    baseSha: Schema.String,
    method: Schema.Literals(MERGE_METHODS),
  }),
  Schema.Struct({ op: Schema.Literal("branch/publish"), branchId: Schema.String, title: Schema.String, body: Schema.String }),
  Schema.Struct({ op: Schema.Literal("branch/update"), branchId: Schema.String, method: Schema.Literals(UPDATE_METHODS) }),
  Schema.Struct({ op: Schema.Literal("branch/resync"), branchId: Schema.String }),
])
export type WritePayload = typeof WritePayload.Type
const decodePayload = Schema.decodeUnknownSync(WritePayload)

/**
 * What `insertWrite` did: inserted it in transaction `txid`, found the write id already taken, or found the role the
 * route decided with no longer held (decision 0079 §6), and recorded nothing.
 */
export type Inserted =
  | { readonly kind: "inserted"; readonly txid: number }
  | { readonly kind: "existing"; readonly status: WriteStatus; readonly payloadHash: string; readonly reauthorized?: boolean }
  | { readonly kind: "stale" }
  /** The write id is another repository's or another person's write: a resend names the same of both. */
  | { readonly kind: "taken" }

/** The branch a write acts on: Publish's, Update branch's and Resync's (docs/features/branch-publish.md), else none. */
const branchOf = (payload: WritePayload): string | null =>
  payload.op === "branch/publish" || payload.op === "branch/update" || payload.op === "branch/resync"
    ? payload.branchId
    : null

/**
 * Records a write the route admitted, once per write id. A new write is recorded only while `holds` answers true in
 * the same transaction: on a repository other than the deployment's own, that the person still has the role the route
 * decided with (`RepoRoles.holds`, decision 0079 §6). A write already recorded answers as it stands, to its own
 * person on its own repository only.
 */
export const insertWrite = <E = never, R = never>(write: {
  readonly id: string
  readonly repoId: string
  readonly actorId: string
  readonly sessionId: string | null
  readonly via: WriteVia
  readonly payload: WritePayload
  readonly payloadHash: string
  /** The authenticated writes route explicitly renews a pending triage write's authority on resubmission. */
  readonly reauthorize?: boolean
}, holds: Effect.Effect<boolean, E, R> = Effect.succeed(true) as Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const triage = write.payload.op === "triage/enable" || write.payload.op === "triage/pause" ? write.payload : undefined
    const plain = triage?.op === "triage/enable" ? { op: triage.op, dailyTokens: triage.dailyTokens }
      : triage === undefined ? null : { op: triage.op }
    const existing = Effect.gen(function* () {
      const [found] = yield* sql<{ readonly status: WriteStatus; readonly payloadHash: string; readonly repoId: string;
        readonly actorId: string; readonly via: WriteVia; readonly samePayload: boolean; readonly sameAdmission: boolean }>`
        SELECT status, payload_hash AS "payloadHash", repo_id AS "repoId", actor_id AS "actorId", via,
          payload - 'authority' = ${JSON.stringify(plain)}::jsonb AS "samePayload",
          payload = ${JSON.stringify(write.payload)}::jsonb AS "sameAdmission"
        FROM github_writes WHERE id = ${write.id}::uuid ${write.reauthorize === true && triage !== undefined ? sql`FOR UPDATE` : sql``}`
      if (found === undefined) return undefined
      if (found.repoId !== write.repoId || found.actorId !== write.actorId) return { kind: "taken" } as const
      const answer = { kind: "existing" as const, status: found.status, payloadHash: found.payloadHash }
      if (write.reauthorize !== true || found.status !== "pending" || found.payloadHash !== write.payloadHash || triage === undefined) return answer
      if (!found.samePayload || found.via !== "person" || write.via !== "person") return { kind: "taken" } as const
      if (found.sameAdmission) return answer
      const authority = triage.authority
      // Sessionless resends cannot erase captured authority. Only this freshly authenticated owner may replace it.
      if (authority == null) return yield* new WriteAuthority.Expired()
      if (authority.personId !== write.actorId || authority.sessionId !== write.sessionId ||
        (authority.scope?._tag === "Repo" && authority.scope.held.repoId !== write.repoId)) return { kind: "taken" } as const
      if (!(yield* holds)) return { kind: "stale" } as const
      const access = yield* ProtectedAuthority.check(authority, ["admin", "maintainer"])
      if (access === "unavailable") return yield* new WriteAuthority.Expired()
      if (access === "denied") return { kind: "stale" } as const
      yield* sql`UPDATE github_writes SET payload = ${JSON.stringify(write.payload)}::jsonb, session_id = ${write.sessionId}::uuid
        WHERE id = ${write.id}::uuid`
      return { ...answer, reauthorized: true }
    })
    const finishExisting = (found: Inserted) => Effect.gen(function* () {
      if (found.kind === "existing") {
        yield* foldWriteNotice(write.id)
        if (found.reauthorized === true && triage?.authority != null) yield* ProtectedAuthority.requireAtCommit(triage.authority)
      }
      return found
    })
    return yield* sql.withTransaction(Effect.gen(function* () {
      if (write.reauthorize === true && triage !== undefined) yield* WriteAuthority.bound
      const found = yield* existing
      if (found !== undefined) return yield* finishExisting(found)
      if (!(yield* holds)) return { kind: "stale" } satisfies Inserted
      const [inserted] = yield* sql<{ readonly txid: string }>`
        INSERT INTO github_writes (id, repo_id, actor_id, session_id, via, op, payload, payload_hash, branch_id)
        VALUES (${write.id}::uuid, ${write.repoId}, ${write.actorId}, ${write.sessionId}::uuid, ${write.via},
          ${write.payload.op}, ${JSON.stringify(write.payload)}::jsonb, ${write.payloadHash}, ${branchOf(write.payload)}::uuid)
        ON CONFLICT (id) DO NOTHING
        RETURNING pg_current_xact_id()::xid::text AS txid`
      if (inserted !== undefined) {
        yield* foldWriteNotice(write.id)
        return { kind: "inserted", txid: Number(inserted.txid) } satisfies Inserted
      }
      return yield* finishExisting((yield* existing)!)
    }))
  })

/** A write as its flow reads it. */
export interface Write {
  readonly id: string
  readonly repoId: string
  readonly actorId: string
  /** The person's GitHub login, for the agent's attribution line; null when no person row has it. */
  readonly login: string | null
  /** The person's GitHub account id, which an agent's write checks the person's role by; null with no person row. */
  readonly accountId: number | null
  readonly sessionId: string | null
  readonly via: WriteVia
  readonly op: WriteOp
  readonly payload: WritePayload
  readonly status: WriteStatus
  readonly attempts: number
  readonly itemNumber: number | null
  readonly githubId: number | null
  /** Epoch milliseconds. */
  readonly createdAt: number
}

/** Write `id`, or `None`. */
export const writeOf = (id: string, lock = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly id: string
      readonly repoId: string
      readonly actorId: string
      readonly login: string | null
      readonly accountId: string | null
      readonly sessionId: string | null
      readonly via: WriteVia
      readonly op: WriteOp
      readonly payload: unknown
      readonly status: WriteStatus
      readonly attempts: number
      readonly itemNumber: number | null
      readonly githubId: string | null
      readonly createdAt: string
    }>`
      SELECT w.id::text, w.repo_id AS "repoId", w.actor_id AS "actorId", p.github_login AS login,
        p.github_id::text AS "accountId", w.session_id::text AS "sessionId", w.via, w.op, w.payload, w.status, w.attempts, w.item_number AS "itemNumber",
        w.github_id::text AS "githubId", (extract(epoch FROM w.created_at) * 1000)::bigint::text AS "createdAt"
      FROM github_writes w LEFT JOIN people p ON p.id::text = w.actor_id
      WHERE w.id = ${id}::uuid ${lock ? sql`FOR UPDATE OF w` : sql``}`
    return Option.map(Option.fromNullishOr(row), (found): Write => ({
      ...found,
      accountId: found.accountId === null ? null : Number(found.accountId),
      payload: decodePayload(found.payload),
      githubId: found.githubId === null ? null : Number(found.githubId),
      createdAt: Number(found.createdAt),
    }))
  })

/** Counts one call to GitHub for write `id`, before it is made. Returns how many were made before it. */
export const beginAttempt = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly before: number }>`
      UPDATE github_writes SET attempts = attempts + 1 WHERE id = ${id}::uuid RETURNING attempts - 1 AS before`
    // The route recorded the write before its flow started, so the row is there.
    return row!.before
  })

/**
 * How a write ended: done, with the issue it wrote and what GitHub gave it (none for a write that made nothing on
 * GitHub, such as enabling triage); or failed or refused, with why.
 */
export type Settlement =
  | {
    readonly status: "done"
    readonly itemNumber: number | null
    readonly githubId: number | null
    /** A merge's: how it landed its pull request (decision 0134). */
    readonly mergeFlow?: MergeFlow
  }
  | { readonly status: "failed" | "refused"; readonly failure: WriteFailure }

/**
 * Settles write `id` while it is still pending, and, for a write GitHub took, upserts what GitHub answered in the same
 * transaction (`project`). Returns whether this settled it.
 */
export const settleWrite = <E = never, R = never, E2 = never, R2 = never>(
  id: string,
  settlement: Settlement,
  project: Effect.Effect<unknown, E, R> = Effect.void,
  beforeCommit: Effect.Effect<unknown, E2, R2> = Effect.void,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const rows = settlement.status === "done"
        ? yield* sql`
          UPDATE github_writes SET status = 'done', item_number = ${settlement.itemNumber},
            github_id = ${settlement.githubId}, merge_flow = ${settlement.mergeFlow ?? null}, settled_at = now()
          WHERE id = ${id}::uuid AND status = 'pending' RETURNING id`
        : yield* sql`
          UPDATE github_writes SET status = ${settlement.status}, failure = ${settlement.failure}, settled_at = now()
          WHERE id = ${id}::uuid AND status = 'pending' RETURNING id`
      const settled = rows.length > 0
      yield* settled && settlement.status === "done" ? project : Effect.void
      if (settled) {
        yield* foldWriteNotice(id)
        yield* beforeCommit
      }
      return settled
    }))
  })

/** A repository's sync stream: its cursor and when a walk last finished (epoch ms), if ever. */
export interface SyncState {
  readonly cursor: string | null
  readonly syncedAt: number | null
  /** Whether the last walk reached the end. */
  readonly complete: boolean
}

/** Sync stream `stream` of `repoId`; a stream never synced has neither. */
export const syncState = (repoId: string, stream: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly cursor: string | null; readonly syncedAt: string | null; readonly complete: boolean }>`
      SELECT cursor, (extract(epoch FROM synced_at) * 1000)::bigint::text AS "syncedAt", complete
      FROM github_sync WHERE repo_id = ${repoId} AND stream = ${stream}`
    return {
      cursor: row?.cursor ?? null,
      syncedAt: row?.syncedAt === null || row === undefined ? null : Number(row.syncedAt),
      complete: row?.complete === true,
    } satisfies SyncState
  })

/** Commits one page's cursor of `repoId`'s `stream`. */
export const commitCursor = (repoId: string, stream: string, cursor: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO github_sync (repo_id, stream, cursor) VALUES (${repoId}, ${stream}, ${cursor})
      ON CONFLICT (repo_id, stream) DO UPDATE SET cursor = EXCLUDED.cursor`
  })

/** Records the end of a walk of `repoId`'s `stream`: complete, or stopped early (`partial`), or failed with a code. */
export const finishSync = (
  repoId: string,
  stream: string,
  outcome: { readonly complete: boolean; readonly failure: string | null },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO github_sync (repo_id, stream, synced_at, complete, failure)
      VALUES (${repoId}, ${stream}, now(), ${outcome.complete}, ${outcome.failure})
      ON CONFLICT (repo_id, stream) DO UPDATE SET synced_at = now(), complete = EXCLUDED.complete,
        failure = EXCLUDED.failure`
  })

/** The App's installation on `repoId`, if a step found it before. */
export const installationOf = (repoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly installationId: string }>`
      SELECT installation_id::text AS "installationId" FROM github_repositories
      WHERE repo_id = ${repoId} AND installation_id IS NOT NULL`
    return Option.map(Option.fromNullishOr(row), (found) => Number(found.installationId))
  })

/**
 * Whether the App is absent from `repoId` as far as Smithers knows: an About read found it so within its recheck
 * window (`repo_about.app_absent_until`, worker/RepoAbout.ts), and no step since found an installation there.
 */
export const appAbsent = (repoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly absent: boolean }>`
      SELECT EXISTS (SELECT 1 FROM repo_about WHERE repo_id = ${repoId} AND app_absent_until > now())
        AND NOT EXISTS (SELECT 1 FROM github_repositories WHERE repo_id = ${repoId} AND installation_id IS NOT NULL)
        AS absent`
    return row!.absent
  })

/** Remembers the App's installation on `repoId`. */
export const rememberInstallation = (repoId: string, installationId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO github_repositories (repo_id, installation_id) VALUES (${repoId}, ${installationId})
      ON CONFLICT (repo_id) DO UPDATE SET installation_id = EXCLUDED.installation_id, checked_at = now()`
  })

/** Forgets the App's installation on `repoId`: GitHub said it is gone. */
export const forgetInstallation = (repoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE github_repositories SET installation_id = NULL, checked_at = now() WHERE repo_id = ${repoId}`
  })

export { recordRepository, repositoryObservation } from "./VisibilityReceipt.ts"

/** Whether GitHub said `repoId` is public: `None` until a step has read it. */
export const isPublic = (repoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly private: boolean }>`
      SELECT private FROM github_repositories WHERE repo_id = ${repoId} AND private IS NOT NULL`
    return Option.map(Option.fromNullishOr(row), (found) => !found.private)
  })

/** What a person's write reads of their session: whether it is live, its sealed GitHub token, and when it expires. */
export interface SessionToken {
  readonly live: boolean
  readonly access: Sealed | null
  /** Epoch milliseconds; null for a token that doesn't expire. */
  readonly accessExpiresAt: number | null
  /** The role check the session's next check replaces (epoch ms): it names `auth/RecheckRole`'s execution. */
  readonly roleCheckedAt: number
}

const decodeSealed = Schema.decodeUnknownSync(Sealed)

/** Session `id`'s GitHub token, or `None` when there is no such session. */
export const sessionToken = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly live: boolean
      readonly access: unknown
      readonly accessExpiresAt: string | null
      readonly roleCheckedAt: string
    }>`
      SELECT ${yield* sessionLive(sql, sql`s`)} AS live, github_access AS access,
        (extract(epoch FROM github_access_expires_at) * 1000)::bigint::text AS "accessExpiresAt",
        (extract(epoch FROM role_checked_at) * 1000)::bigint::text AS "roleCheckedAt"
      FROM sessions s WHERE id = ${id}::uuid`
    return Option.map(Option.fromNullishOr(row), (found): SessionToken => ({
      live: found.live,
      access: found.access === null ? null : decodeSealed(found.access),
      accessExpiresAt: found.accessExpiresAt === null ? null : Number(found.accessExpiresAt),
      roleCheckedAt: Number(found.roleCheckedAt),
    }))
  })
