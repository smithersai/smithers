import { ShapeProxy } from "@smthrs/effect-electric"
import { Inbox } from "@smthrs/notifications"
import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import {
  HOME_HREF,
  MAX_ATTENTION_BODY_BYTES,
  MAX_TITLE_LENGTH,
  NOTIFICATIONS_TABLE,
} from "../src/features/attention/contract.ts"
import { AckRequest, WatchRequest } from "../src/features/attention/schema.ts"
import { LOCAL_ELECTRIC_URL } from "../src/features/chat/contract.ts"
import { type Actor, memberOrAbove, refusesPersonOnly, Sessions } from "./Actor.vibe"
import { branchAccess, branchAccessAs, BranchRoles, canView, isMember, policyOf, underPolicy, roleOn as workRoleOn } from "./branch/Access.ts"
import * as Conversations from "./branch/Conversations.ts"
import { readBounded } from "./Body.vibe"
import { codeOf } from "./ErrorCode.vibe"
import * as FeedLocks from "./FeedLocks.ts"
import * as SessionStore from "./SessionStore.ts"
import * as ShapeAccess from "./ShapeAccess.vibe"
import { FRESH_SECONDS } from "./github/RoleAge.ts"
import { TTL_MS } from "./github/Visibility.ts"
import * as FleetAudience from "./runners/FleetAudience.ts"
import { pruned as repositoryPruned } from "./github/RepoRoles.ts"

// The personal feed on the server (decision 0009, docs/features/notifications.md): one `notifications` row per person
// per subject, written in the same transaction as the fact it comes from, so a replay writes nothing twice.
//
// - `foldRun`: a run's report (worker/Runs.ts) routes its state to its launcher and to everyone watching its branch
//   (`Inbox.route`), in the report's transaction.
// - `recordRepoEvent`: GitHub's delivery of `main` moving or a new release (worker/github/Api.ts) reaches everyone
//   watching the repository.
// - `POST /api/watches`: the person follows the branch and the repository of a conversation their tab shows.
// - `POST /api/notifications/ack`: Read, Dismiss or Hide at a version, merged with `greatest()`.
// - `GET /api/shapes/notifications`: the signed-in Member's own rows; anyone else signed in, the rows of their own
//   acts (`mine`), ruling AUTH-8. Signed out gets none.

/** Feed route requests, by `route` (`watch`, `ack`) and `status`. */
export const requests = Metric.counter("smithers_notification_requests", {
  description: "Requests to the feed's routes, by route and status",
  incremental: true,
})

/** `GET /api/shapes/notifications` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_notification_shape_requests", {
  description: "GET /api/shapes/notifications requests, by status and live",
  incremental: true,
})

/** Repository checks made for a feed read, by authorization outcome, never by private repository name. */
export const repositoryChecks = Metric.counter("smithers_notification_repository_checks", {
  description: "Repository access checks for a feed read, by outcome",
  incremental: true,
})

/** Notification rows written, by `kind` (`run`, `main`, `release`) and `state`. */
export const routed = Metric.counter("smithers_notifications_routed", {
  description: "Notification rows written for their recipients, by kind and state",
  incremental: true,
})

/** The `notifications` columns a device syncs: every one, the recipient's own id included (Electric needs the key). */
export const SYNCED_NOTIFICATION_COLUMNS = [
  "recipient",
  "subject",
  "kind",
  "state",
  "mine",
  "quiet",
  "run_id",
  "repo_id",
  "conversation_id",
  "actor",
  "title",
  "ref",
  "href",
  "version",
  "read_version",
  "dismissed_version",
  "hidden_version",
  "occurred_at",
  "created_at",
  "updated_at",
]

/** No person's id: what the shape filters on for someone who may not read a feed, so it holds no rows. */
const NOBODY = ""

/** The first line of `text`, trimmed and cut to `MAX_TITLE_LENGTH` characters; `null` when empty. */
export const titleOf = (text: string | null | undefined): string | null => {
  const line = (text ?? "").split("\n", 1)[0]!.trim()
  if (line === "") return null
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH - 1)}…` : line
}

/** A repository's path in the app from its id (`github/<owner>/<name>`): `/<owner>/<name>`. */
const repoPath = (repoId: string) => `/${repoId.split("/").slice(1).join("/")}`

/** The run's own notice subject. */
export const runSubject = (runId: string) => `run:${runId}`

/**
 * The state a run's row shows its recipients. The answer's own settled status wins over the run's row, as in the
 * conversation (docs/features/agent-status.md), so an answer the server settled reads settled; a question someone
 * already answered reads as working again.
 */
const runState = (status: Inbox.RunState, answered: boolean, answer: string | null): Inbox.RunState =>
  answer === "done" || answer === "failed" ? answer : status === "needs_you" && answered ? "working" : status

/** What the fold reads of a run: its state, who launched it, where it works, and what it is about. */
interface RunFacts {
  readonly status: Inbox.RunState
  readonly answered: boolean
  /** The answer's own status: `streaming`, `done` or `failed`; none for a run that isn't an answer. */
  readonly answer: string | null
  readonly launchedBy: string
  readonly conversationId: string | null
  readonly branchId: string | null
  readonly repoId: string | null
  readonly branchName: string | null
  readonly prompt: string | null
  readonly question: string | null
}

/** One existing row of the run's subject: whose, what it showed, at which version. */
interface Existing {
  readonly recipient: string
  readonly state: Inbox.RunState
  readonly mine: boolean
  readonly quiet: boolean
  readonly title: string | null
  readonly version: number
}

/** Repair only existing live notices when the run index is gone, from a terminal answer or its missing record.
 * A streaming answer is still live. No recipient or scope is invented, and settled notices never change again. */
const foldMissingRun = (runId: string, held: ReadonlySet<string>) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const locked = yield* sql<{
    readonly recipient: string
    readonly mine: boolean
    readonly conversationId: string | null
    readonly repoId: string | null
    readonly denied: boolean
  }>`
    SELECT recipient, mine, conversation_id AS "conversationId", repo_id AS "repoId",
      EXISTS (SELECT 1 FROM github_repo_roles r WHERE r.repo_id = n.repo_id AND r.person_id = n.recipient
        AND r.checked_at <> '-infinity' AND (r.role IS NULL OR r.role NOT IN ('member', 'maintainer', 'admin'))) AS denied
    FROM notifications n
    WHERE run_id = ${runId} AND state IN ('working', 'waiting', 'needs_you') FOR UPDATE`
  // Only the rows of people whose feed locks this transaction holds (`lockRuns`).
  const existing = locked.filter((row) => !row.denied && FeedLocks.holds(held, { repoId: row.repoId, personId: row.recipient }))
  const allowed = yield* Effect.filter(existing, (row) => row.conversationId === null
    ? Effect.succeed(row.mine)
    : branchAccessAs(Option.some({ subject: { kind: "person", id: row.recipient }, role: "member" }), row.conversationId, "conversation").pipe(
      Effect.map((branch) => branch !== undefined && canView(branch.access)),
    ))
  yield* Effect.annotateCurrentSpan({ "smithers.run.id": runId, "smithers.run.missing": true,
    "smithers.notifications.eligible": allowed.length, "smithers.notifications.written": 0 })
  if (allowed.length === 0) return 0
  const rows = yield* sql<{ readonly state: "done" | "failed" }>`
    WITH outcome AS (
      SELECT CASE WHEN a.status = 'done' THEN 'done' ELSE 'failed' END AS state
      FROM (SELECT 1) seed LEFT JOIN messages a ON a.id = ${runId}
      WHERE a.id IS NULL OR a.status IN ('done', 'failed')
    )
    UPDATE notifications n SET state = o.state, version = n.version + 1, occurred_at = now(), updated_at = now()
    FROM outcome o WHERE n.run_id = ${runId} AND ${sql.in("n.recipient", allowed.map((row) => row.recipient))}
      AND n.state IN ('working', 'waiting', 'needs_you')
    RETURNING n.state`
  for (const row of rows) yield* Metric.update(Metric.withAttributes(routed, { kind: "run", state: row.state }), 1)
  yield* Effect.annotateCurrentSpan({ "smithers.run.missing": true, "smithers.notifications.written": rows.length })
  if (rows.length > 0) yield* Effect.logWarning("notifications.run_missing").pipe(
    Effect.annotateLogs({ runId, written: rows.length }),
  )
  return rows.length
})

/**
 * The (repository, person) pairs folding `runIds` may touch: each run's launcher, its branch's watchers and everyone
 * holding a row of it, on the run's repository; for a run whose row is gone, its rows' recipients on theirs. Read
 * without locking anything, before the locks.
 */
const pairsOf = (runIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (runIds.length === 0) return []
    const sql = yield* SqlClient.SqlClient
    return yield* sql<FeedLocks.Pair>`
      WITH run AS (SELECT id, repo_id, launched_by, branch_id FROM runs WHERE ${sql.in("id", runIds)})
      SELECT repo_id AS "repoId", launched_by AS "personId" FROM run
      UNION SELECT run.repo_id, w.principal_id FROM run JOIN watches w ON w.subject = 'branch:' || run.branch_id
      UNION SELECT run.repo_id, n.recipient FROM run JOIN notifications n ON n.run_id = run.id
      UNION SELECT n.repo_id, n.recipient FROM notifications n
        WHERE ${sql.in("n.run_id", runIds)} AND NOT EXISTS (SELECT 1 FROM run WHERE run.id = n.run_id)`
  })

/**
 * Takes, for the rest of the caller's transaction, the feed lock (worker/FeedLocks.ts) of everyone folding `runIds`
 * may touch, sorted and all at once, before any notification row: what a transaction that folds several runs takes
 * first, then passes to each `foldRun`. A role read that denies one of them takes the same lock before it deletes
 * their rows, so neither waits on the other in a cycle. Answers the keys it holds.
 */
export const lockRuns = (runIds: ReadonlyArray<string>) =>
  Effect.flatMap(pairsOf(runIds), (pairs) => Effect.flatMap(SqlClient.SqlClient, (sql) => FeedLocks.lock(sql, pairs)))

/**
 * Routes run `runId`'s current state to its recipients, inside the caller's transaction (worker/Runs.ts writes the
 * run's row first; worker/Answers.ts and `chat/Expire` settle its answer first): its launcher, branch watchers
 * (`Inbox.route`) and existing recipients, each subject to current branch access. Accessible existing rows still
 * settle after muting. A row's version goes up when the change needs attention again (`Inbox.raises`); a row that
 * would show the same thing is left alone. `launcherLogin` names the launcher on other people's rows. Records a span
 * `runs.fold` and a count per row written; never a title.
 */
export const foldRun = (runId: string, launcherLogin: string | undefined, locked?: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // Everyone this fold may touch, locked before any notification row (`lockRuns`); a transaction that folds several
    // runs locked them all already. Someone who started watching since is left for the next fold.
    const held = locked ?? (yield* lockRuns([runId]))
    const [run] = yield* sql<RunFacts>`
      SELECT r.status, r.answered_at IS NOT NULL AS answered, a.status AS answer, r.launched_by AS "launchedBy",
        r.conversation_id AS "conversationId", r.branch_id AS "branchId", r.repo_id AS "repoId",
        b.name AS "branchName", r.wait->>'prompt' AS prompt, q.text AS question
      FROM runs r
      LEFT JOIN messages a ON a.id = r.id
      LEFT JOIN messages q ON q.id = a.question_id
      LEFT JOIN branches b ON b.id = r.branch_id
      WHERE r.id = ${runId}`
    if (run === undefined) return yield* foldMissingRun(runId, held)
    const state = runState(run.status, run.answered, run.answer)
    const subject = runSubject(runId)
    const watchers = run.branchId === null
      ? []
      : yield* sql<Inbox.Watcher>`
        SELECT principal_id AS principal, level FROM watches WHERE subject = ${`branch:${run.branchId}`}
        ORDER BY created_at, principal_id`
    const ownRow = (recipient: string) => FeedLocks.holds(held, { repoId: run.repoId, personId: recipient })
    const existing = (yield* sql<Existing>`
      SELECT recipient, state, mine, quiet, title, version FROM notifications WHERE subject = ${subject} FOR UPDATE`)
      .filter((row) => ownRow(row.recipient))
    const before = new Map(existing.map((row) => [row.recipient, row]))
    // Feed locks serialize this check with recorded denials and their deletion of private rows. A failed first
    // lookup (-infinity) is not a denial. Every recipient is checked, including muted existing recipients.
    const policy = run.branchId === null ? undefined : yield* policyOf(run.branchId)
    const denied = new Set((run.repoId === null ? [] : yield* sql<{ readonly personId: string }>`
      SELECT person_id AS "personId" FROM github_repo_roles
      WHERE repo_id = ${run.repoId} AND checked_at <> '-infinity'
        AND (role IS NULL OR role NOT IN ('member', 'maintainer', 'admin'))
        AND ${sql.in("person_id", [...new Set([run.launchedBy, ...watchers.map((w) => w.principal), ...existing.map((r) => r.recipient)])])}
    `).map((row) => row.personId))
    const mayRead = (principal: string) => !denied.has(principal) && (run.branchId === null
      ? principal === run.launchedBy
      : policy !== undefined && canView(underPolicy(policy, principal, "member")))
    const deliveries = Inbox.route({
      launcher: run.launchedBy,
      state,
      watchers,
      mayRead,
    })
    const routedTo = new Set(deliveries.map((delivery) => delivery.recipient))
    // A muted recipient with branch access still sees their existing row settle.
    const all = [
      ...deliveries,
      ...existing.filter((row) => !routedTo.has(row.recipient)).map((row): Inbox.Delivery => ({
        recipient: row.recipient,
        mine: row.mine,
        quiet: row.quiet,
        state: !row.mine && state === "needs_you" ? "waiting" : state,
      })),
    ].filter((delivery) => mayRead(delivery.recipient) && ownRow(delivery.recipient))
    const home = run.conversationId === null ? undefined : yield* Conversations.home
    const href = run.conversationId !== null && run.conversationId === home
      ? HOME_HREF
      : run.repoId !== null && run.branchName !== null
      ? `${repoPath(run.repoId)}/tree/${run.branchName}`
      : HOME_HREF
    let written = 0
    // What anyone but the launcher reads: the run, its repository and branch, and the link. The page checks access.
    const place = run.repoId !== null && run.branchName !== null ? `${repoPath(run.repoId).slice(1)}/${run.branchName}` : null
    // Cut to a title's length (`titleOf`): a branch's name may be longer than a row holds.
    const shared = place === null ? "Agent run" : titleOf(`Agent run · ${place}`) ?? "Agent run"
    for (const delivery of all) {
      const old = before.get(delivery.recipient)
      const own = delivery.recipient === run.launchedBy
      const title = !own ? shared : delivery.state === "needs_you" ? titleOf(run.prompt) : titleOf(run.question)
      if (old !== undefined && old.state === delivery.state && old.quiet === delivery.quiet && old.title === title) continue
      // A run that asks again while it still needs the person asks a new question: it shows again too.
      const again = old !== undefined && delivery.state === "needs_you" && old.state === "needs_you" && old.title !== title
      const version = old === undefined
        ? 1
        : Inbox.raises(old.state, delivery.state) || again
        ? old.version + 1
        : old.version
      yield* sql`
        INSERT INTO notifications (recipient, subject, kind, state, mine, quiet, run_id, repo_id, conversation_id, actor,
          title, href, version)
        VALUES (${delivery.recipient}, ${subject}, 'run', ${delivery.state}, ${delivery.mine}, ${delivery.quiet}, ${runId},
          ${run.repoId}, ${run.conversationId}, ${own ? launcherLogin ?? null : null}, ${title}, ${href}, ${version})
        ON CONFLICT (recipient, subject) DO UPDATE SET
          state = EXCLUDED.state, mine = EXCLUDED.mine, quiet = EXCLUDED.quiet, title = EXCLUDED.title,
          actor = CASE WHEN EXCLUDED.mine THEN COALESCE(EXCLUDED.actor, notifications.actor) END, href = EXCLUDED.href,
          version = EXCLUDED.version,
          occurred_at = now(), updated_at = now()`
      written += 1
      yield* Metric.update(Metric.withAttributes(routed, { kind: "run", state: delivery.state }), 1)
    }
    yield* Effect.annotateCurrentSpan({ "smithers.run.id": runId, "smithers.notifications.written": written })
    return written
  }).pipe(Effect.withSpan("runs.fold"))

/** A repository event as the feed records it: `main` moving to `ref`, or release `ref` published. */
export interface RepoEvent {
  readonly kind: "main" | "release"
  readonly repoId: string
  readonly ref: string
  readonly title: string | null
  readonly actor: string | null
  /** When it happened, as GitHub says: the push, or the release's publication. */
  readonly occurredAt: Date
  readonly href: string
}

const Push = Schema.Struct({
  ref: Schema.String,
  after: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/)),
  deleted: Schema.optional(Schema.Boolean),
  repository: Schema.Struct({
    full_name: Schema.String,
    default_branch: Schema.String,
    pushed_at: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
})
const decodePush = Schema.decodeUnknownOption(Push)

const Release = Schema.Struct({
  action: Schema.Literal("published"),
  release: Schema.Struct({
    tag_name: Schema.String.check(Schema.isBetweenLength(1, 255)),
    published_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  repository: Schema.Struct({ full_name: Schema.String }),
})
const decodeRelease = Schema.decodeUnknownOption(Release)

/** The repository GitHub's delivery is about, as the routes name it. */
export interface Synced {
  readonly owner: string
  readonly name: string
  readonly id: string
}

/** Whether `fullName` (`owner/name`) is `repository`, as GitHub may change its case. */
const isRepository = (fullName: string, repository: Synced) =>
  fullName.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase()

/**
 * The feed's event in GitHub's delivery `event` of `payload`, for `repository`: a push to its default branch that moved
 * it (not one that deleted it) is `main`; a published release is `release`. Anything else, or another repository's, is
 * none. `now` dates an event GitHub doesn't.
 *
 * Its row names only the repository (`owner/name`), the commit or the tag, and the link: never the commit's message,
 * the release's name or who pushed. Watchers are picked by their role on the deployment's own repository, which may
 * not be their access to this one; the page the link opens checks that, as a GitHub notification links to a private
 * repository rather than quoting it.
 */
export const repoEventOf = (
  event: string,
  payload: unknown,
  repository: Synced,
  now: Date,
): Option.Option<RepoEvent> => {
  const path = `/${repository.owner}/${repository.name}`
  if (event === "push") {
    return Option.flatMap(decodePush(payload), (push): Option.Option<RepoEvent> =>
      push.deleted === true || !/[1-9a-f]/.test(push.after) ||
          push.ref !== `refs/heads/${push.repository.default_branch}` || !isRepository(push.repository.full_name, repository)
        ? Option.none()
        : Option.some({
          kind: "main",
          repoId: repository.id,
          ref: push.after,
          title: titleOf(`${repository.owner}/${repository.name}`),
          actor: null,
          occurredAt: typeof push.repository.pushed_at === "number" ? new Date(push.repository.pushed_at * 1000) : now,
          href: path,
        }))
  }
  if (event === "release") {
    return Option.flatMap(decodeRelease(payload), (published): Option.Option<RepoEvent> => {
      if (!isRepository(published.repository.full_name, repository)) return Option.none()
      const at = published.release.published_at == null ? Number.NaN : Date.parse(published.release.published_at)
      return Option.some({
        kind: "release",
        repoId: repository.id,
        ref: published.release.tag_name,
        title: titleOf(`${repository.owner}/${repository.name}`),
        actor: null,
        occurredAt: Number.isNaN(at) ? now : new Date(at),
        href: `${path}/tree/${published.release.tag_name}`,
      })
    })
  }
  return Option.none()
}

/** Local development's person, who has no session of their own: their id and fixed role (worker/DevChatApi.ts). */
export interface LocalPerson {
  readonly id: string
  readonly role: Actor["role"]
}

/**
 * Records `event` for everyone watching its repository who isn't muted and may still read it (`Inbox.audience`), in one
 * transaction. A watch outlives the access it was made with, so each watcher is checked at each delivery: a feed is a
 * Member's, so they hear of it only while they have a live session (not signed out, not revoked, not past its end) and
 * the role GitHub last confirmed for them, on any of their sessions (`SessionStore.latestRole`), is a Member's or above;
 * local development's own people (`localPeople`, who have no session) by their fixed role. Someone demoted, signed out
 * everywhere or never signed in hears nothing. `main:<repo id>` is one row per person whose version goes up each time
 * `main` moves to a newer commit (a late delivery of an older push changes nothing); `release:<repo id>:<tag>` is one
 * row per release, refreshed and raised when the tag is published again later (a replay or an older publication
 * changes nothing). Returns how many rows it wrote.
 */
export const recordRepoEvent = (event: RepoEvent, localPeople: ReadonlyArray<LocalPerson> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // A person's watch names their id, a UUID; any other principal has no session, so no role GitHub confirmed.
    const watchersOf = () => sql<Inbox.Watcher & { readonly mayRead: boolean }>`
      SELECT w.principal_id AS principal, w.level,
        COALESCE(${SessionStore.latestRole(sql, sql`person.id`)} IN ('admin', 'maintainer', 'member') AND EXISTS (
          SELECT 1 FROM sessions live
          WHERE live.person_id = person.id AND live.revoked_at IS NULL AND live.expires_at > now()
        ), false) AS "mayRead"
      FROM watches w
      CROSS JOIN LATERAL (
        SELECT CASE WHEN w.principal_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN w.principal_id::uuid END AS id
      ) person
      WHERE w.subject = ${`repo:${event.repoId}`}
        AND NOT EXISTS (SELECT 1 FROM github_repo_roles r
          WHERE r.repo_id = ${event.repoId} AND r.person_id = w.principal_id
            AND r.checked_at <> '-infinity' AND (r.role IS NULL OR r.role NOT IN ('member', 'maintainer', 'admin')))
      ORDER BY w.created_at, w.principal_id`
    const local = new Map(localPeople.map((person) => [person.id, person.role]))
    const audienceOf = (watchers: ReadonlyArray<Inbox.Watcher & { readonly mayRead: boolean }>) => {
      const readers = new Set(
        watchers.filter(({ principal, mayRead }) => local.has(principal) ? memberOrAbove(local.get(principal)!) : mayRead)
          .map((watcher) => watcher.principal),
      )
      return { readers, audience: Inbox.audience(watchers, (principal) => readers.has(principal)) }
    }
    // Who may hear it, read without locking anything; then their feed locks, sorted, before any notification row
    // (worker/FeedLocks.ts); then, read again after the locks, those locked who may still hear it.
    const held = yield* FeedLocks.lock(
      sql,
      audienceOf(yield* watchersOf()).audience.map((principal) => ({ repoId: event.repoId, personId: principal })),
    )
    const watchers = yield* watchersOf()
    const { readers, audience } = audienceOf(watchers)
    const subject = event.kind === "main" ? `main:${event.repoId}` : `release:${event.repoId}:${event.ref}`
    let written = 0
    for (const recipient of audience.filter((principal) => FeedLocks.holds(held, { repoId: event.repoId, personId: principal }))) {
      const rows = event.kind === "main"
        ? yield* sql`
          INSERT INTO notifications AS n (recipient, subject, kind, state, repo_id, actor, title, ref, href, occurred_at)
          VALUES (${recipient}, ${subject}, 'main', 'update', ${event.repoId}, ${event.actor}, ${event.title}, ${event.ref},
            ${event.href}, ${event.occurredAt})
          ON CONFLICT (recipient, subject) DO UPDATE SET
            actor = EXCLUDED.actor, title = EXCLUDED.title, ref = EXCLUDED.ref, href = EXCLUDED.href,
            occurred_at = EXCLUDED.occurred_at, version = n.version + 1, updated_at = now()
          WHERE EXCLUDED.occurred_at >= n.occurred_at AND EXCLUDED.ref IS DISTINCT FROM n.ref
          RETURNING 1`
        : yield* sql`
          INSERT INTO notifications AS n (recipient, subject, kind, state, repo_id, actor, title, ref, href, occurred_at)
          VALUES (${recipient}, ${subject}, 'release', 'update', ${event.repoId}, ${event.actor}, ${event.title},
            ${event.ref}, ${event.href}, ${event.occurredAt})
          ON CONFLICT (recipient, subject) DO UPDATE SET
            actor = EXCLUDED.actor, title = EXCLUDED.title, href = EXCLUDED.href, occurred_at = EXCLUDED.occurred_at,
            version = n.version + 1, updated_at = now()
          WHERE EXCLUDED.occurred_at > n.occurred_at
          RETURNING 1`
      written += rows.length
    }
    if (written > 0) yield* Metric.update(Metric.withAttributes(routed, { kind: event.kind, state: "update" }), written)
    yield* Effect.logInfo("notifications.repo_event").pipe(
      Effect.annotateLogs({ kind: event.kind, repoId: event.repoId, watchers: watchers.length, readers: readers.size, written }),
    )
    return written
  }).pipe(
    (effect) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(effect)),
    Effect.withSpan("notifications.repo_event", { attributes: { "smithers.notification.kind": event.kind } }),
  )

const decodeWatch = Schema.decodeUnknownEffect(Schema.fromJsonString(WatchRequest))
const decodeAck = Schema.decodeUnknownEffect(Schema.fromJsonString(AckRequest))

type Fields = Record<string, string | number | boolean>

const noStore = { "cache-control": "no-store" }
const refusal = (status: number, code: string) => HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
const ok = (txid: number | null) => HttpServerResponse.jsonUnsafe({ txid }, { headers: noStore })

/**
 * Follows `scope`'s branch and repository for `principal`, at the default level; a watch they already have keeps its
 * level. Answers the transaction, or `undefined` when they followed both already.
 */
const follow = (principal: string, scope: { readonly branchId: string; readonly repoId: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly txid: string }>`
      INSERT INTO watches (principal_id, subject, level)
      VALUES (${principal}, ${`branch:${scope.branchId}`}, ${Inbox.DEFAULT_LEVEL}),
        (${principal}, ${`repo:${scope.repoId}`}, ${Inbox.DEFAULT_LEVEL})
      ON CONFLICT (principal_id, subject) DO NOTHING
      RETURNING pg_current_xact_id()::xid::text AS txid`
    return rows[0] === undefined ? undefined : Number(rows[0].txid)
  })

/** The column each act moves. */
const COLUMN: Readonly<Record<Inbox.Act, string>> = {
  read: "read_version",
  dismiss: "dismissed_version",
  hide: "hidden_version",
}

/**
 * Records `act` at `version` on `recipient`'s row for `subject`, merged with `greatest()` and never past the row's own
 * version: its transaction, `null` when it changed nothing, `undefined` when the person has no such row.
 */
const applyAck = (recipient: string, request: AckRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const column = sql(COLUMN[request.act])
    const [row] = yield* sql<{ readonly txid: string }>`
      UPDATE notifications SET ${column} = least(${request.version}, version)
      WHERE recipient = ${recipient} AND subject = ${request.subject} AND ${column} < least(${request.version}, version)
      RETURNING pg_current_xact_id()::xid::text AS txid`
    if (row !== undefined) return Number(row.txid)
    const found = yield* sql`SELECT 1 FROM notifications WHERE recipient = ${recipient} AND subject = ${request.subject}`
    return found.length > 0 ? null : undefined
  })

/**
 * Reads Electric's connection (`ShapeProxy.config`) and returns the feed's routes: `watch` for `POST /api/watches`,
 * `ack` for `POST /api/notifications/ack`, and `shape` for `GET /api/shapes/notifications`. Each route request is a
 * log line `notifications.<route>`, a span `notifications.request` and a count; none carries a title. `database` opens a
 * Postgres client for the scope of each request.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
    const freshMs = yield* SessionStore.roleFreshMs

    /** Runs one route: method and sign-in, then `handle`; logs, counts and spans it. */
    const route = (
      name: "watch" | "ack",
      handle: (body: string, actor: Option.Some<Actor>, fields: Fields) => Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        unknown,
        SqlClient.SqlClient | BranchRoles
      >,
    ) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Fields = {}
        const response = yield* Effect.gen(function* () {
          if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
          const actor = yield* (yield* Sessions).resolve
          // A feed is anyone's signed in, of their own rows (ruling AUTH-8); following is a Member's (`watch`).
          if (Option.isNone(actor)) return refusal(401, "authentication")
          const body = yield* readBounded(request, MAX_ATTENTION_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
            Effect.result,
          )
          if (body._tag === "Failure") {
            return body.failure.reason === "too_large" ? refusal(413, "too_large") : refusal(400, "invalid")
          }
          return yield* handle(body.success, actor, fields).pipe(Effect.provide(database))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(Cause.squash(cause))
              return refusal(503, "unavailable")
            })
          ),
        )
        fields.status = response.status
        fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Metric.update(Metric.withAttributes(requests, { route: name, status: String(response.status) }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          `notifications.${name}`,
        ).pipe(Effect.annotateLogs(fields))
        return response
      }).pipe(Effect.withSpan("notifications.request", { kind: "server", attributes: { "smithers.route": name } }))

    /** `POST /api/watches`: follow the branch and repository of a conversation, `null` for the home one. */
    const watch = route("watch", (body, actor, fields) =>
      Effect.gen(function* () {
        // Following is a Member's or above's of the deployment's own repository, the session's role, as `foldRun`
        // checks each recipient as one.
        if (!isMember(actor)) return refusal(403, "forbidden")
        const decoded = yield* decodeWatch(body).pipe(Effect.option)
        if (Option.isNone(decoded)) return refusal(400, "invalid")
        const named = decoded.value.conversationId?.toLowerCase() ?? null
        const conversationId = named ?? (yield* Conversations.home)
        if (conversationId === undefined) return refusal(404, "not_found")
        fields.conversationId = conversationId
        // Only someone who may open the branch follows it.
        const branch = yield* branchAccess(actor, conversationId, "conversation")
        if (branch === undefined) return refusal(404, "not_found")
        if (!canView(branch.access)) return refusal(403, "forbidden")
        const txid = yield* follow(actor.value.subject.id, branch)
        if (txid === undefined) fields.existing = true
        return ok(txid ?? null)
      }))

    /** `POST /api/notifications/ack`: Read, Dismiss or Hide at a version. */
    const ack = route("ack", (body, actor, fields) =>
      Effect.gen(function* () {
        // Read, Dismiss and Hide record what the person saw and chose (decision 0017 slice 0).
        if (yield* refusesPersonOnly(actor.value, "notification/ack")) return refusal(403, "person_only")
        const decoded = yield* decodeAck(body).pipe(Effect.option)
        if (Option.isNone(decoded)) return refusal(400, "invalid")
        fields.subject = decoded.value.subject
        fields.act = decoded.value.act
        fields.version = decoded.value.version
        const txid = yield* applyAck(actor.value.subject.id, decoded.value)
        if (txid === undefined) return refusal(404, "not_found")
        if (txid === null) fields.existing = true
        return ok(txid)
      }))

    /**
     * `GET /api/shapes/notifications`: the signed-in Member's rows, anyone else's own acts' rows; signed out, none;
     * sessions unreadable, 503.
     */
    const shape = Effect.suspend(() => {
      let retryAfterSeconds = 0
      let unavailableRepositories = 0
      let allowedSubjects: Readonly<Record<string, string | null>> = {}
      let replaySubjects = new Set<string>()
      let validateAccess: Effect.Effect<boolean, ShapeProxy.Refused, R> = Effect.succeed(true)
      return ShapeProxy.make({
      ...connection,
      // Membership limits whose rows may sync; each repository's current role independently limits which of
      // those rows may sync, including historical launcher prompts that no recorded denial has deleted yet.
      shape: Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const actor = yield* ShapeAccess.actor
        const member = isMember(actor)
        const params: Record<string, string> = { "1": Option.isSome(actor) ? actor.value.subject.id : NOBODY }
        const base = member ? "recipient = $1" : "recipient = $1 AND mine = true"
        const repositories = Option.isNone(actor) ? [] : yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql<{ readonly repoId: string; readonly installed: boolean; readonly denialSequence: string }>`
            SELECT candidates."repoId", EXISTS (SELECT 1 FROM github_repositories g
              WHERE g.repo_id = candidates."repoId" AND g.installation_id IS NOT NULL) AS installed,
              coalesce(a.denial_sequence, 0)::text AS "denialSequence"
            FROM (SELECT repo_id AS "repoId" FROM notifications
            WHERE recipient = ${actor.value.subject.id} AND repo_id IS NOT NULL AND (${member} OR mine = true)
            UNION SELECT substring(subject FROM 6) AS "repoId" FROM watches
              WHERE principal_id = ${actor.value.subject.id} AND subject LIKE 'repo:github/%' AND level <> 'muted'
            UNION SELECT b.repo_id AS "repoId" FROM watches w JOIN branches b ON w.subject = 'branch:' || b.id
              WHERE w.principal_id = ${actor.value.subject.id} AND w.level <> 'muted' AND b.deleted_at IS NULL
            ) candidates LEFT JOIN notification_repository_access a
              ON a.recipient = ${actor.value.subject.id} AND a.repo_id = candidates."repoId"
            ORDER BY candidates."repoId"`
        ).pipe(Effect.provide(database), Effect.mapError(() => ShapeAccess.unavailable))
        const denialSequences = new Map(repositories.map(({ repoId, denialSequence }) => [repoId, denialSequence]))
        // The observation orders concurrent projections; an older read cannot undo a newer outage or denial.
        const [observation] = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql<{ readonly at: string }>`SELECT clock_timestamp()::text AS at`).pipe(
          Effect.provide(database), Effect.mapError(() => ShapeAccess.unavailable))
        // Reuse branch policy, but project access into rows rather than changing Electric's definition.
        const checked = yield* Effect.forEach(repositories, ({ repoId, installed }) => workRoleOn(Option.getOrThrow(actor), repoId, installed).pipe(
          Effect.tap((role) => Metric.update(Metric.withAttributes(repositoryChecks, { outcome: memberOrAbove(role) ? "allowed" : "denied" }), 1)),
          Effect.map((role) => ({ repoId, role, permitted: memberOrAbove(role) })),
          Effect.catch((refused) => Effect.gen(function* () {
            unavailableRepositories++
            retryAfterSeconds = Math.max(retryAfterSeconds, refused.retryAfterSeconds ?? ShapeAccess.RETRY_AFTER_SECONDS)
            yield* Metric.update(Metric.withAttributes(repositoryChecks, { outcome: "unavailable" }), 1)
            return { repoId, role: null, permitted: false }
          })),
        ), { concurrency: 4 })
        const permitted = checked.filter(result => result.permitted).map(result => result.repoId)
        if (Option.isSome(actor) && repositories.length > 0) {
          const personId = actor.value.subject.id
          const allowed = new Set(permitted)
          yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.gen(function* () {
            yield* FeedLocks.lock(sql, repositories.map(({ repoId }) => ({ repoId, personId })))
            // A resolver may itself record denial. Adopt its fence only for withheld repositories; a permitted
            // result must retain the sequence it started with, even if another tab already restored access.
            const withheld = repositories.filter(({ repoId }) => !allowed.has(repoId)).map(({ repoId }) => repoId)
            if (withheld.length > 0) {
              const denials = yield* sql<{ readonly repoId: string; readonly denialSequence: string }>`
                SELECT repo_id AS "repoId", denial_sequence::text AS "denialSequence"
                FROM notification_repository_access WHERE recipient = ${personId} AND repo_id = ANY(${withheld}::text[])`
              for (const row of denials) denialSequences.set(row.repoId, row.denialSequence)
            }
            for (const { repoId } of checked) {
              const updated = yield* sql<{ readonly denialSequence: string }>`
                INSERT INTO notification_repository_access (recipient, repo_id, readable, checked_at, denial_sequence)
                VALUES (${personId}, ${repoId}, ${allowed.has(repoId)}, ${observation!.at}::timestamptz,
                  0)
                ON CONFLICT (recipient, repo_id) DO UPDATE SET readable = EXCLUDED.readable, checked_at = EXCLUDED.checked_at,
                  denial_sequence = notification_repository_access.denial_sequence + CASE
                    WHEN notification_repository_access.readable AND NOT EXCLUDED.readable THEN 1 ELSE 0 END
                WHERE notification_repository_access.checked_at <= EXCLUDED.checked_at
                  AND (NOT EXCLUDED.readable OR notification_repository_access.denial_sequence = ${denialSequences.get(repoId)!}::bigint)
                RETURNING denial_sequence::text AS "denialSequence"`
              // Adopt only our accepted write's fence. An older allowed result that lost the CAS retains its old
              // sequence and is refused after Electric, even if another tab restored the same permission.
              if (updated[0] !== undefined) denialSequences.set(repoId, updated[0].denialSequence)
            }
          }))).pipe(Effect.provide(database), Effect.mapError(() => ShapeAccess.unavailable))
        }
        if (Option.isSome(actor)) {
          const personId = actor.value.subject.id
          const repoIds = repositories.map(({ repoId }) => repoId)
          const policy = yield* BranchRoles
          // One MVCC statement after the body is buffered: deployment authority, repository decisions, subjects
          // and cursor fences agree. Neither the request's old actor nor a cached log entry grants disclosure.
          validateAccess = Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.gen(function* () {
            yield* FeedLocks.lock(sql, repoIds.map(repoId => ({ repoId, personId })))
            const grantRows = checked.map(({ repoId }) => {
              const installedBasis = policy.grantBasis?.(repoId, true) ?? "repository"
              const uninstalledBasis = policy.grantBasis?.(repoId, false) ?? "public"
              const localRole = installedBasis === "local" || uninstalledBasis === "local"
                ? policy.uninstalled === undefined ? actor.value.role : policy.uninstalled(actor.value, repoId)
                : null
              return { repoId, installedBasis, uninstalledBasis, localRole,
                freshSeconds: policy.grantFreshSeconds ?? FRESH_SECONDS }
            })
            return yield* sql<{
              readonly subjects: Readonly<Record<string, string | null>>
              readonly repositories: ReadonlyArray<string>
              readonly replaySubjects: ReadonlyArray<string>
              readonly prunedSubjects: ReadonlyArray<string>
              readonly access: ReadonlyArray<{ readonly repoId: string; readonly denialSequence: string }>
            }>`
              WITH identity AS (
                SELECT ${actor.value.session === undefined} OR EXISTS (
                  SELECT 1 FROM sessions live WHERE live.id::text = ${actor.value.session ?? ""}
                    AND live.person_id::text = ${personId} AND live.revoked_at IS NULL AND live.expires_at > now()
                    AND (${actor.value.alias ?? null}::uuid IS NULL OR EXISTS (
                      SELECT 1 FROM host_sessions h WHERE h.id = ${actor.value.alias ?? null}::uuid
                        AND h.parent_id = live.id AND h.revoked_at IS NULL))) AS active
              ), deployment AS (
                SELECT active, CASE WHEN ${actor.value.session === undefined} THEN ${actor.value.role}::text
                  WHEN active AND ${SessionStore.latestRoleVerifiedAt(sql, sql`(SELECT id FROM people WHERE id::text = ${personId})`)}
                      BETWEEN clock_timestamp() - make_interval(secs => ${freshMs / 1000}) AND clock_timestamp()
                  THEN ${SessionStore.latestRole(sql, sql`(SELECT id FROM people WHERE id::text = ${personId})`)} END AS role
                FROM identity
              ), access AS (
                SELECT repo_id, readable, denial_sequence FROM notification_repository_access WHERE recipient = ${personId}
              ), grants AS (
                SELECT * FROM jsonb_to_recordset(${JSON.stringify(grantRows)}::jsonb)
                  AS grant_config("repoId" text, "localRole" text, "installedBasis" text, "uninstalledBasis" text, "freshSeconds" double precision)
              ), authority AS (
                SELECT a.repo_id, a.readable, CASE
                  WHEN grant_route.basis = 'local' THEN grant_config."localRole"
                  WHEN grant_route.basis = 'public' THEN CASE
                    WHEN g.private = false AND g.visibility_verified_at BETWEEN
                      clock_timestamp() - make_interval(secs => ${TTL_MS / 1000}) AND clock_timestamp() THEN d.role END
                  WHEN grant_route.basis = 'deployment' THEN d.role
                  WHEN grant_route.basis = 'repository' AND r.checked_at > clock_timestamp()
                    - make_interval(secs => grant_config."freshSeconds") THEN r.role
                  END AS role
                FROM access a CROSS JOIN deployment d
                LEFT JOIN grants grant_config ON grant_config."repoId" = a.repo_id
                LEFT JOIN github_repositories g ON g.repo_id = a.repo_id
                LEFT JOIN LATERAL (SELECT CASE WHEN g.installation_id IS NOT NULL
                  THEN grant_config."installedBasis" ELSE grant_config."uninstalledBasis" END AS basis) grant_route ON true
                LEFT JOIN github_repo_roles r ON r.repo_id = a.repo_id AND r.person_id = ${personId}
              ), pruned AS (
                DELETE FROM notifications n USING authority a
                WHERE n.recipient = ${personId} AND n.repo_id = a.repo_id AND n.kind = 'fleet'
                  AND a.readable = true AND a.role IS NOT NULL AND NOT ${FleetAudience.permits(sql, {
                    role: sql`a.role`, recipient: sql`n.recipient`, subject: sql`n.subject`, repoId: sql`n.repo_id`,
                  })}
                RETURNING n.subject
              ), readable AS (
                SELECT n.subject, n.repo_id,
                  d.active AND (d.role IN ('member', 'maintainer', 'admin') OR n.mine = true)
                    AND (n.repo_id IS NULL OR a.readable = true AND a.role IN ('member', 'maintainer', 'admin'))
                    AND (n.kind <> 'fleet' OR ${FleetAudience.permits(sql, {
                      role: sql`a.role`, recipient: sql`n.recipient`, subject: sql`n.subject`, repoId: sql`n.repo_id`,
                    })}) AS permitted
                FROM notifications n CROSS JOIN deployment d
                LEFT JOIN authority a ON a.repo_id = n.repo_id
                WHERE n.recipient = ${personId} AND n.feed_readable = true
                  AND NOT EXISTS (SELECT 1 FROM pruned WHERE pruned.subject = n.subject)
              ), permitted AS (
                SELECT subject, repo_id FROM readable WHERE permitted = true
              )
              SELECT coalesce((SELECT jsonb_object_agg(subject, repo_id) FROM permitted), '{}'::jsonb) AS subjects,
                ARRAY(SELECT DISTINCT repo_id FROM permitted WHERE repo_id IS NOT NULL) AS repositories,
                ARRAY(SELECT subject FROM readable WHERE permitted IS NOT TRUE) AS "replaySubjects",
                ARRAY(SELECT subject FROM pruned) AS "prunedSubjects",
                coalesce((SELECT jsonb_agg(jsonb_build_object('repoId', repo_id, 'denialSequence', denial_sequence::text)) FROM access WHERE repo_id = ANY(${repoIds}::text[])), '[]'::jsonb) AS access`
          }))).pipe(
            Effect.map(([current]) => {
              allowedSubjects = current!.subjects
              replaySubjects = new Set(current!.replaySubjects)
              // Only reductions/pruning need a cursor fence. Restoration can emit its inserts immediately using
              // this snapshot; comparing old readability would unnecessarily refuse that safe recovery.
              const cursorStable = current!.access.length === repoIds.length && current!.access.every((row) =>
                row.denialSequence === denialSequences.get(row.repoId))
              return { cursorStable, subjects: Object.keys(allowedSubjects).length, replaySubjects: replaySubjects.size,
                prunedSubjects: current!.prunedSubjects.length, repositories: current!.repositories.length }
            }),
            Effect.tap(fields => Metric.update(Metric.withAttributes(repositoryPruned, { scope: "fleet" }), fields.prunedSubjects)),
            Effect.tap(fields => Effect.logInfo("notifications.access.emit").pipe(Effect.annotateLogs(fields))),
            Effect.map(fields => fields.cursorStable),
            Effect.provide(database), Effect.mapError(() => ShapeAccess.unavailable),
          )
        }
        yield* Effect.logInfo("notifications.access").pipe(Effect.annotateLogs({
          repositories: repositories.length, permitted: permitted.length,
          unavailable: unavailableRepositories, retryAfterSeconds,
          durationMs: (yield* Clock.currentTimeMillis) - startedAt,
        }))
        return {
          table: NOTIFICATIONS_TABLE,
          where: `${base} AND feed_readable = true`,
          params,
          columns: SYNCED_NOTIFICATION_COLUMNS,
        }
      }).pipe(Effect.withSpan("notifications.access")),
      rowAccess: { keyColumns: ["recipient", "subject"], validate: Effect.suspend(() => validateAccess).pipe(Effect.withSpan("notifications.access.emit")), allows: (row) =>
        typeof row["subject"] === "string" && Object.hasOwn(allowedSubjects, row["subject"])
          && (!Object.hasOwn(row, "repo_id") || row["repo_id"] === allowedSubjects[row["subject"]]),
        retryIfDenied: (row) => typeof row["subject"] === "string" && replaySubjects.has(row["subject"]),
      },
      name: "notifications.shape",
      metric: shapes,
      }).pipe(Effect.map((response) => retryAfterSeconds === 0 ? response :
        HttpServerResponse.setHeader(response, "retry-after", String(retryAfterSeconds))))
    })

    return { watch, ack, shape }
  })
