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
import { type Actor, refusesPersonOnly, Sessions } from "./Actor.ts"
import { branchAccess, branchAccessAs, type BranchRoles, canView, isMember, policyOf, underPolicy } from "./branch/Access.ts"
import * as Conversations from "./branch/Conversations.ts"
import { readBounded } from "./Body.ts"
import { codeOf } from "./ErrorCode.ts"
import * as ShapeAccess from "./ShapeAccess.ts"

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
const foldMissingRun = (runId: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const existing = yield* sql<{ readonly recipient: string; readonly mine: boolean; readonly conversationId: string | null }>`
    SELECT recipient, mine, conversation_id AS "conversationId" FROM notifications
    WHERE run_id = ${runId} AND state IN ('working', 'waiting', 'needs_you') FOR UPDATE`
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
 * Routes run `runId`'s current state to its recipients, inside the caller's transaction (worker/Runs.ts writes the
 * run's row first; worker/Answers.ts and `chat/Expire` settle its answer first): its launcher, branch watchers
 * (`Inbox.route`) and existing recipients, each subject to current branch access. Accessible existing rows still
 * settle after muting. A row's version goes up when the change needs attention again (`Inbox.raises`); a row that
 * would show the same thing is left alone. `launcherLogin` names the launcher on other people's rows. Records a span
 * `runs.fold` and a count per row written; never a title.
 */
export const foldRun = (runId: string, launcherLogin: string | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [run] = yield* sql<RunFacts>`
      SELECT r.status, r.answered_at IS NOT NULL AS answered, a.status AS answer, r.launched_by AS "launchedBy",
        r.conversation_id AS "conversationId", r.branch_id AS "branchId", r.repo_id AS "repoId",
        b.name AS "branchName", r.wait->>'prompt' AS prompt, q.text AS question
      FROM runs r
      LEFT JOIN messages a ON a.id = r.id
      LEFT JOIN messages q ON q.id = a.question_id
      LEFT JOIN branches b ON b.id = r.branch_id
      WHERE r.id = ${runId}`
    if (run === undefined) return yield* foldMissingRun(runId)
    const state = runState(run.status, run.answered, run.answer)
    const subject = runSubject(runId)
    const watchers = run.branchId === null
      ? []
      : yield* sql<Inbox.Watcher>`
        SELECT principal_id AS principal, level FROM watches WHERE subject = ${`branch:${run.branchId}`}
        ORDER BY created_at, principal_id`
    const existing = yield* sql<Existing>`
      SELECT recipient, state, mine, quiet, title, version FROM notifications WHERE subject = ${subject} FOR UPDATE`
    const before = new Map(existing.map((row) => [row.recipient, row]))
    // Every recipient hears only of a branch they may still open (worker/branch/Access.ts): only a Member follows one
    // (`watch`), so each is checked as one, against the branch's shares as they are now.
    const policy = run.branchId === null ? undefined : yield* policyOf(run.branchId)
    const mayRead = (principal: string) => run.branchId === null
      ? principal === run.launchedBy
      : policy !== undefined && canView(underPolicy(policy, principal, "member"))
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
    ].filter((delivery) => mayRead(delivery.recipient))
    const home = run.conversationId === null ? undefined : yield* Conversations.home
    const href = run.conversationId !== null && run.conversationId === home
      ? HOME_HREF
      : run.repoId !== null && run.branchName !== null
      ? `${repoPath(run.repoId)}/tree/${run.branchName}`
      : HOME_HREF
    let written = 0
    for (const delivery of all) {
      const old = before.get(delivery.recipient)
      const title = delivery.state === "needs_you" ? titleOf(run.prompt) : titleOf(run.question)
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
          ${run.repoId}, ${run.conversationId}, ${launcherLogin ?? null}, ${title}, ${href}, ${version})
        ON CONFLICT (recipient, subject) DO UPDATE SET
          state = EXCLUDED.state, mine = EXCLUDED.mine, quiet = EXCLUDED.quiet, title = EXCLUDED.title,
          actor = COALESCE(EXCLUDED.actor, notifications.actor), href = EXCLUDED.href, version = EXCLUDED.version,
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
  head_commit: Schema.optional(Schema.NullOr(Schema.Struct({ message: Schema.String }))),
  pusher: Schema.optional(Schema.Struct({ name: Schema.String })),
})
const decodePush = Schema.decodeUnknownOption(Push)

const Release = Schema.Struct({
  action: Schema.Literal("published"),
  release: Schema.Struct({
    tag_name: Schema.String.check(Schema.isBetweenLength(1, 255)),
    name: Schema.optional(Schema.NullOr(Schema.String)),
    published_at: Schema.optional(Schema.NullOr(Schema.String)),
    author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
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
          title: titleOf(push.head_commit?.message),
          actor: push.pusher?.name.slice(0, 100) ?? null,
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
        title: titleOf(published.release.name) ?? titleOf(published.release.tag_name),
        actor: published.release.author?.login.slice(0, 100) ?? null,
        occurredAt: Number.isNaN(at) ? now : new Date(at),
        href: `${path}/tree/${published.release.tag_name}`,
      })
    })
  }
  return Option.none()
}

/**
 * Records `event` for everyone watching its repository who isn't muted (`Inbox.audience`), in one transaction:
 * `main:<repo id>` is one row per person whose version goes up each time `main` moves to a newer commit (a late
 * delivery of an older push changes nothing); `release:<repo id>:<tag>` is one row per release. A replay writes
 * nothing. Returns how many rows it wrote.
 */
export const recordRepoEvent = (event: RepoEvent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const watchers = yield* sql<Inbox.Watcher>`
      SELECT principal_id AS principal, level FROM watches WHERE subject = ${`repo:${event.repoId}`}
      ORDER BY created_at, principal_id`
    const subject = event.kind === "main" ? `main:${event.repoId}` : `release:${event.repoId}:${event.ref}`
    let written = 0
    for (const recipient of Inbox.audience(watchers)) {
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
          INSERT INTO notifications (recipient, subject, kind, state, repo_id, actor, title, ref, href, occurred_at)
          VALUES (${recipient}, ${subject}, 'release', 'update', ${event.repoId}, ${event.actor}, ${event.title},
            ${event.ref}, ${event.href}, ${event.occurredAt})
          ON CONFLICT (recipient, subject) DO NOTHING
          RETURNING 1`
      written += rows.length
    }
    if (written > 0) yield* Metric.update(Metric.withAttributes(routed, { kind: event.kind, state: "update" }), written)
    yield* Effect.logInfo("notifications.repo_event").pipe(
      Effect.annotateLogs({ kind: event.kind, repoId: event.repoId, watchers: watchers.length, written }),
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
    const shape = ShapeProxy.make({
      ...connection,
      // A Member or above of the deployment's own repository, as before, syncs every row of theirs, which only they
      // follow (`watch`); anyone else signed in, the rows of their own acts (`mine`: their runs, clones and writes), so
      // a person whose role was taken keeps no feed of what others do (ruling AUTH-8).
      shape: Effect.map(ShapeAccess.actor, (actor) => ({
        table: NOTIFICATIONS_TABLE,
        where: isMember(actor) ? "recipient = $1" : "recipient = $1 AND mine = true",
        params: { "1": Option.isSome(actor) ? actor.value.subject.id : NOBODY },
        columns: SYNCED_NOTIFICATION_COLUMNS,
      })),
      name: "notifications.shape",
      metric: shapes,
    })

    return { watch, ack, shape }
  })
