import * as MirrorRefresh from "../MirrorRefresh.ts"
import { COMMITMENTS } from "../../src/features/issues/lifecycle.ts"
import { digestSync } from "@smthrs/crypto"
import { ShapeProxy } from "@smthrs/effect-electric"
import { Core, GitHub } from "@smthrs/integrations"
import { Cause, Clock, Duration, Effect, type Layer, Metric, Option, Redacted, Ref, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import {
  applyExecutionId,
  COMMENT_COLUMNS,
  COMMENTS_SHAPE_ROUTE,
  COMMENTS_TABLE,
  GITHUB_WEBHOOK_ROUTE,
  ISSUES_STREAM,
  ITEM_COLUMNS,
  ITEMS_SHAPE_ROUTE,
  ITEMS_TABLE,
  MAX_BODY_LENGTH,
  MAX_REASON_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TRIAGE_DAILY_TOKENS,
  MAX_WEBHOOK_BYTES,
  MAX_WRITE_BYTES,
  DEFAULT_TRIAGE_DAILY_TOKENS,
  reconcileBucketStart,
  reconcileExecutionId,
  SYNC_COLUMNS,
  SYNC_SHAPE_ROUTE,
  SYNC_STALE_MS,
  SYNC_TABLE,
  TRIAGE_DECISIONS,
  TRIAGE_SETTINGS_COLUMNS,
  TRIAGE_SETTINGS_SHAPE_ROUTE,
  TRIAGE_SETTINGS_TABLE,
  triageRunExecutionId,
  WRITE_COLUMNS,
  writeExecutionId,
  type WriteVia,
  type WriteRefusal,
  WRITES_SEGMENT,
  WRITES_SHAPE_ROUTE,
  WRITES_TABLE,
} from "../../src/features/issues/contract.ts"
import { ACTION_COLUMNS, ACTIONS_SHAPE_ROUTE } from "../../src/features/actions/contract.ts"
import {
  CHECK_COLUMNS,
  CHECKS_SHAPE_ROUTE,
  DEFAULT_MERGE_METHOD,
  MERGE_METHODS,
  mergeExecutionId,
  PULL_COLUMNS,
  PULL_COMMIT_COLUMNS,
  PULL_COMMITS_SHAPE_ROUTE,
  PULL_COMMITS_TABLE,
  PULLS_SHAPE_ROUTE,
  PULLS_TABLE,
  REVIEW_COLUMNS,
  REVIEWS_SHAPE_ROUTE,
  REVIEWS_TABLE,
  RUNS_TABLE,
  SHA,
} from "../../src/features/pulls/contract.ts"
import { isRepository, REPOS_ROUTE, repoId } from "../../src/features/repo/contract.ts"
import {
  publishExecutionId,
  resyncExecutionId,
  UPDATE_METHODS,
  updateExecutionId,
} from "../../src/features/branch/contract.ts"
import { branchAccess, canEdit } from "../branch/Access.ts"
import { Publish, publishBlocked, Resync, Update } from "../branch/Publish.ts"
import { type Actor, canAsk, refusesPersonOnly, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Dispatch from "../ci/Dispatch.ts"
import { FlowStarter, StartUnavailable } from "../Flows.ts"
import * as Notifications from "../Notifications.ts"
import * as ShapeAccess from "../ShapeAccess.ts"
import { Apply, PULL_EVENTS } from "./Apply.ts"
import * as Compare from "./Compare.ts"
import { statusOf } from "./Calls.ts"
import { apiUrl, type GitHubApp, type Repository, repositoryOf } from "./Config.ts"
import { Merge } from "./Merge.ts"
import * as Metrics from "./Metrics.ts"
import { Reconcile } from "./Reconcile.ts"
import * as ReadToken from "./ReadToken.ts"
import * as Visibility from "./Visibility.ts"
import * as RepoRoles from "./RepoRoles.ts"
import * as Store from "./Store.ts"
import { TriageRun } from "./Triage.ts"
import * as TriageStore from "./TriageStore.ts"
import { Write } from "./Write.ts"

// The git loop's routes in ChatApi (decision 0012 §2 and §4, docs/features/issues.md#routes):
// - `POST /api/github/webhook`: GitHub's webhook. Verified with `X-Hub-Signature-256` (`Core.Channel` from
//   `@smthrs/integrations`), it starts `github/Apply` for the issue it names, one execution per delivery, and records
//   the delivery; it never writes a row itself. A payload names a subject; it never sets state. With `REPO_FLOWS` on, a
//   push or a pull request also starts its `triggers/Dispatch` (worker/ci/Dispatch.ts).
// - `POST /api/repos/<owner>/<name>/writes`: the one door every git write goes through. It checks sign-in, the App,
//   the person's role on the repository the path names (`RepoRoles`, decision 0079), the bounds and the payload's
//   hash, records the write while that role holds, and starts `github/Write` keyed by the device's write id. The
//   settled row is the result; nothing waits on the remote run. Opening an issue and commenting go to any repository
//   the deployment may act on; every other write only to its own.
// - `GET /api/shapes/{items,comments,github-sync}`: the synced repository's rows, each with its column list, for a
//   signed-in person with a role on it, or for anyone once GitHub said the repository is public. A read of `items`
//   that finds the sync older than 5 minutes starts `github/Reconcile`, once per repository and 5-minute bucket, and
//   waits at most `RECONCILE_START_TIMEOUT` for admission beside its own work.
// - `GET /api/shapes/github-writes`: the signed-in person's own writes, their status only.
// - Triage (§5): the writes route takes a person's Accept or Not accepted, Run triage again, and Enable and Pause, each
//   at its own minimum role; `issues.opened` starts `triage/Run` while triage is on; and `GET
//   /api/shapes/triage-settings` serves whether it is.
// The webhook, the shapes and Reconcile serve every repository the deployment may act on (decision 0079, slice 1b):
// its own (`GITHUB_REPOSITORY`) and, with the App, any other `GITHUB_ALLOWED_REPOSITORIES` doesn't leave out. A shape
// names its repository with `?repo=<owner>/<name>`, its own unless it does; any other is `404 not_found`. Where the App
// isn't installed, Reconcile records `app_not_installed` on the repository's sync row, which the page reads to send
// people to GitHub instead.

const noStore = { "cache-control": "no-store" }

/** The shapes of one repository's rows, by route: each table, its columns, and its filter on `$1`, the repository's id. */
const REPOSITORY_SHAPES: Readonly<Record<string, { readonly table: string; readonly columns: ReadonlyArray<string>; readonly where: string }>> = {
  [ITEMS_SHAPE_ROUTE]: { table: ITEMS_TABLE, columns: ITEM_COLUMNS, where: "repo_id = $1" },
  [COMMENTS_SHAPE_ROUTE]: { table: COMMENTS_TABLE, columns: COMMENT_COLUMNS, where: "repo_id = $1" },
  [SYNC_SHAPE_ROUTE]: { table: SYNC_TABLE, columns: SYNC_COLUMNS, where: "repo_id = $1" },
  [TRIAGE_SETTINGS_SHAPE_ROUTE]: { table: TRIAGE_SETTINGS_TABLE, columns: TRIAGE_SETTINGS_COLUMNS, where: "repo_id = $1" },
  // Pull requests (docs/features/pulls.md): their rows, commits and reviews.
  [PULLS_SHAPE_ROUTE]: { table: PULLS_TABLE, columns: PULL_COLUMNS, where: "repo_id = $1" },
  [PULL_COMMITS_SHAPE_ROUTE]: { table: PULL_COMMITS_TABLE, columns: PULL_COMMIT_COLUMNS, where: "repo_id = $1" },
  [REVIEWS_SHAPE_ROUTE]: { table: REVIEWS_TABLE, columns: REVIEW_COLUMNS, where: "repo_id = $1" },
  // A pull request's checks are its head's `checks/Run` rows; a repository flow's runs are the repository's runs
  // (docs/features/actions.md), whose states the Checks tab doesn't read.
  [CHECKS_SHAPE_ROUTE]: { table: RUNS_TABLE, columns: CHECK_COLUMNS, where: "repo_id = $1 AND sha IS NOT NULL AND execution IS NULL" },
}

const refuse = (status: number, code: WriteRefusal | "not_configured" | "invalid_signature", retryAfterSeconds?: number) =>
  HttpServerResponse.jsonUnsafe({ code }, {
    status,
    headers: retryAfterSeconds === undefined ? noStore : { ...noStore, "retry-after": String(retryAfterSeconds) },
  })

/**
 * The writes any repository the deployment may act on takes (decision 0079, Slice 1); the rest only its own. Publish
 * and Update branch act on the branch's own repository, wherever `/new` made it (docs/features/branch-publish.md).
 */
const ANY_REPOSITORY: ReadonlySet<string> = new Set([
  "issue/create",
  "issue/comment",
  "branch/publish",
  "branch/update",
  "branch/resync",
])

/** No person's id: what a signed-out writes shape filters on, so it holds no rows. */
const NOBODY = ""

const WriteId = Schema.String.check(Schema.isUUID())
const Title = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= MAX_TITLE_LENGTH),
)
const IssueBody = Schema.String.check(Schema.isMaxLength(MAX_BODY_LENGTH))
const CommentBody = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= MAX_BODY_LENGTH),
)

const IssueNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }))
const Sha = Schema.String.check(Schema.isPattern(SHA))
const Reason = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= MAX_REASON_LENGTH),
)

/** A write as the device sends it. It names nobody: who acts is the session's or the run credential's to say. */
const WriteBody = Schema.Union([
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("issue/commitment"), number: IssueNumber, commitment: Schema.Literals(COMMITMENTS) }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("issue/create"), title: Title, body: IssueBody }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("issue/comment"), number: IssueNumber, body: CommentBody }),
  Schema.Struct({
    writeId: WriteId,
    op: Schema.Literal("issue/triage"),
    number: IssueNumber,
    decision: Schema.Literals(TRIAGE_DECISIONS),
    reason: Schema.optional(Reason),
  }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("triage/run"), number: IssueNumber }),
  Schema.Struct({
    writeId: WriteId,
    op: Schema.Literal("triage/enable"),
    dailyTokens: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_TRIAGE_DAILY_TOKENS }))),
  }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("triage/pause") }),
  Schema.Struct({
    writeId: WriteId,
    op: Schema.Literal("pr/merge"),
    number: IssueNumber,
    headSha: Sha,
    baseSha: Sha,
    method: Schema.optional(Schema.Literals(MERGE_METHODS)),
  }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("branch/publish"), branchId: WriteId, title: Title, body: IssueBody }),
  Schema.Struct({
    writeId: WriteId,
    op: Schema.Literal("branch/update"),
    branchId: WriteId,
    method: Schema.optional(Schema.Literals(UPDATE_METHODS)),
  }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("branch/resync"), branchId: WriteId }),
])
type WriteBody = typeof WriteBody.Type

/**
 * Whether `who` may make `write` (decision 0007, decision 0012 §3): opening an issue and commenting are Guest acts;
 * overriding triage and Run triage again Member and above (`repo:triage`); enabling and pausing it Maintainer and above
 * (`repo:triage-flow`). Triage is the person's own act: the route refuses anyone acting for them first.
 */
const mayWrite = (who: Actor, write: WriteBody): boolean => {
  switch (write.op) {
    case "issue/create":
    case "issue/comment":
      return who.role !== null
    case "issue/triage":
    case "triage/run":
    // Publish, Update branch and Resync are a Member's (`repo:branch-create`), on a branch they may edit.
    case "branch/publish":
    case "branch/update":
    case "branch/resync":
      return canAsk(who)
    case "issue/commitment":
    case "triage/enable":
    case "triage/pause":
    // Merging's minimum is Maintainer (decision 0007 `repo:merge`, decision 0012 decision 6).
    case "pr/merge":
      return who.role === "admin" || who.role === "maintainer"
  }
}

/**
 * Who a write acts for, as the request says it, never its body (decision 0017 slice 0): the person in their own
 * session, or the agent through its run credential, whose write goes as the App.
 */
const viaOf = (who: Actor): WriteVia => (who.act === undefined ? "person" : "agent")

/** The writes that act on GitHub with the person's own token, so need their session. */
const withPersonToken = (write: WriteBody, via: WriteVia): boolean =>
  via === "person" &&
  (write.op === "issue/create" || write.op === "issue/comment" || write.op === "issue/triage" ||
    write.op === "issue/commitment" || write.op === "pr/merge" || write.op === "branch/publish" ||
    write.op === "branch/update" || write.op === "branch/resync")

/** A write's payload as it is recorded and hashed. */
const payloadOf = (write: WriteBody): Store.WritePayload => {
  switch (write.op) {
    case "issue/commitment":
      return { op: write.op, number: write.number, commitment: write.commitment }
    case "pr/merge":
      return {
        op: write.op,
        number: write.number,
        headSha: write.headSha,
        baseSha: write.baseSha,
        method: write.method ?? DEFAULT_MERGE_METHOD,
      }
    case "issue/create":
      return { op: write.op, title: write.title.trim(), body: write.body }
    case "issue/comment":
      return { op: write.op, number: write.number, body: write.body }
    case "issue/triage":
      return { op: write.op, number: write.number, decision: write.decision, reason: write.reason ?? null }
    case "triage/run":
      return { op: write.op, number: write.number }
    case "triage/enable":
      return { op: write.op, dailyTokens: write.dailyTokens ?? DEFAULT_TRIAGE_DAILY_TOKENS }
    case "triage/pause":
      return { op: write.op }
    case "branch/publish":
      return { op: write.op, branchId: write.branchId.toLowerCase(), title: write.title.trim(), body: write.body }
    case "branch/update":
      return { op: write.op, branchId: write.branchId.toLowerCase(), method: write.method ?? "merge" }
    case "branch/resync":
      return { op: write.op, branchId: write.branchId.toLowerCase() }
  }
}
const decodeWrite = Schema.decodeUnknownOption(Schema.fromJsonString(WriteBody))

/** `/api/repos/<owner>/<name>/writes` as its owner and name, or `undefined` for any other path. */
export const parseWritesPath = (path: string): { readonly owner: string; readonly name: string } | undefined => {
  if (!path.startsWith(`${REPOS_ROUTE}/`)) return undefined
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  if (segments.length !== 3 || segments[2] !== WRITES_SEGMENT) return undefined
  try {
    return { owner: decodeURIComponent(segments[0]!), name: decodeURIComponent(segments[1]!) }
  } catch {
    return undefined
  }
}

const SHAPES: ReadonlySet<string> = new Set([
  ITEMS_SHAPE_ROUTE,
  COMMENTS_SHAPE_ROUTE,
  WRITES_SHAPE_ROUTE,
  SYNC_SHAPE_ROUTE,
  TRIAGE_SETTINGS_SHAPE_ROUTE,
  PULLS_SHAPE_ROUTE,
  PULL_COMMITS_SHAPE_ROUTE,
  REVIEWS_SHAPE_ROUTE,
  CHECKS_SHAPE_ROUTE,
  ACTIONS_SHAPE_ROUTE,
])

/** Whether ChatApi routes `path` here. */
export const handles = (path: string): boolean =>
  path === GITHUB_WEBHOOK_ROUTE || SHAPES.has(path) || parseWritesPath(path) !== undefined ||
  Compare.parseComparePath(path) !== undefined

/**
 * How long a stale read of the issues waits for `github/Reconcile`'s start to be admitted: one idempotent Durable Object
 * call, keyed by the bucket's execution id. A slower admission is dropped with the read's answer, and the next stale
 * read asks again.
 */
export const RECONCILE_START_TIMEOUT = Duration.seconds(2)

/** The bounds of a delivery id: GitHub's are UUIDs; anything up to 128 characters is taken. */
const DELIVERY_ID = /^[A-Za-z0-9-]{1,128}$/

/** The subject a delivery names: the repository and issue of an `issues` or `issue_comment` event. */
const Subject = Schema.Struct({
  repository: Schema.Struct({ full_name: Schema.String }),
  issue: Schema.Struct({ number: Schema.Int }),
})
const decodeSubject = Schema.decodeUnknownOption(Subject)

/** The subject of a `pull_request` or `pull_request_review` event: the repository and pull request. */
const PullSubject = Schema.Struct({
  repository: Schema.Struct({ full_name: Schema.String }),
  pull_request: Schema.Struct({ number: Schema.Int }),
})
const decodePullSubject = Schema.decodeUnknownOption(PullSubject)

/** The events whose subject is an issue. */
const ISSUE_EVENTS: ReadonlySet<string> = new Set(["issues", "issue_comment"])


/** The issue or pull request a delivery of `event` names, as one shape. */
const subjectOf = (event: string, payload: unknown) =>
  ISSUE_EVENTS.has(event)
    ? decodeSubject(payload)
    : PULL_EVENTS.has(event)
    ? Option.map(decodePullSubject(payload), (found) => ({
      repository: found.repository,
      issue: { number: found.pull_request.number },
    }))
    : Option.none()

/**
 * What the routes need besides Postgres: the deployment's own repository, the GitHub App when it is configured, and
 * who has which role on which repository.
 */
export interface Options<R = never> {
  readonly repository: Repository
  readonly app: Option.Option<GitHubApp>
  readonly roles: RepoRoles.RepoRoles<R>
  /** How the routes' own reads reach GitHub (the compare route's): `fetch` unless set. */
  readonly http?: HttpClient.HttpClient
  /** Whether pushes and pull requests start repositories' flows (`REPO_FLOWS`, docs/features/ci.md#triggers). */
  readonly repoFlows?: boolean
  /** `GITHUB_ALLOWED_REPOSITORIES` (`RepoRoles.allowed`): none, every repository the App is installed on. */
  readonly allowed?: Option.Option<ReadonlySet<string>>
}

/**
 * Reads Electric's connection and returns the GitHub routes' `fetch`. `database` opens a Postgres client for the scope
 * of each request; `Sessions` (who is asking) and `FlowStarter` (where a remote flow starts) come from the request's
 * context, as RepoApi's do.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, options: Options<R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
    const { repository } = options
    const allowed = options.allowed ?? Option.none<ReadonlySet<string>>()
    /**
     * Whether the deployment syncs and acts on repository `id` (decision 0079 §4): its own, or, with the App, any other
     * the allowed list doesn't leave out. Whether the App is installed there is Reconcile's to find out.
     */
    const mayAct = (id: string) =>
      id === repository.id ||
      (Option.isSome(options.app) && Option.match(allowed, { onNone: () => true, onSome: (ids) => ids.has(id) }))
    // Check current metadata for anonymous readers, using the shared metadata token policy.
    const readToken = yield* ReadToken.fromConfig.pipe(
      options.http === undefined ? Effect.provide(FetchHttpClient.layer) : Effect.provideService(HttpClient.HttpClient, options.http),
      Effect.orDie,
    )
    const metadataApiUrl = Option.isSome(options.app) ? options.app.value.apiBaseUrl : (yield* apiUrl)
    const metadataHttp = options.http ?? (yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
    const visibility = Visibility.make(metadataApiUrl, readToken, metadataHttp)
    // A pull request's files (worker/github/Compare.ts), read with the App's token: none without the App.
    const compare = Option.isSome(options.app)
      ? Option.some(yield* Compare.make(options.app.value, Option.fromUndefinedOr(options.http)))
      : Option.none()

    // The webhook's channel (`Core.Channel`): GitHub's HMAC over the exact bytes, then strict JSON into an
    // `ExternalEvent`. Built once, when the secret is configured.
    const channel = Option.flatMap(options.app, (app) =>
      Option.map(app.webhookSecret, (secret) =>
        Core.Channel.make({
          name: "github",
          credential: Redacted.make({ id: "github-webhook", name: "GITHUB_WEBHOOK_SECRET" }),
          secret: Core.Channel.constantSecret(secret),
          verify: (raw, key) =>
            Core.Signature.verifySignature({
              payload: raw.body,
              secret: key,
              signature: raw.headers["x-hub-signature-256"],
              prefix: Core.Signature.GITHUB_SIGNATURE_PREFIX,
            }),
          decode: (raw, payload) => ({
            source: "github",
            eventName: Core.SignalName.eventName("github", raw.headers["x-github-event"] ?? ""),
            correlationId: null,
            payload: payload as Schema.Json,
            dedupeKey: raw.idempotencyKey,
            receivedAtMs: Date.now(),
          }),
          // The routes start `github/Apply` themselves, for the issue a delivery names; a channel needs a route.
          route: Core.Channel.startFlow(Apply._tag),
        })
      ))

    /** `POST /api/github/webhook`. */
    const webhook = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const event = request.headers["x-github-event"] ?? "unknown"
      const metricEvent = new Set(["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment",
        "push", "release", "ping", "installation", "installation_repositories", "repository"]).has(event) ? event : "unknown"
      const fields: Record<string, string | number> = { event: metricEvent }
      const answer = (status: number, outcome: string, code?: "not_configured" | "invalid_signature" | WriteRefusal) =>
        Effect.gen(function* () {
          fields.outcome = outcome
          yield* Metric.update(Metric.withAttributes(Metrics.webhooks, { event: metricEvent, outcome }), 1)
          return code === undefined
            ? HttpServerResponse.empty({ status, headers: noStore })
            : refuse(status, code)
        })
      const response = yield* Effect.gen(function* () {
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        if (Option.isNone(channel)) return yield* answer(503, "not_configured", "not_configured")
        const deliveryId = request.headers["x-github-delivery"] ?? ""
        if (!DELIVERY_ID.test(deliveryId)) return yield* answer(400, "invalid", "invalid")
        fields.deliveryId = deliveryId
        const text = yield* readBounded(request, MAX_WEBHOOK_BYTES, (bytes) => (fields.bytes = bytes)).pipe(Effect.result)
        if (text._tag === "Failure") {
          return text.failure.reason === "too_large"
            ? yield* answer(413, "too_large", "too_large")
            : yield* answer(400, "invalid", "invalid")
        }
        const raw = {
          body: new TextEncoder().encode(text.success),
          headers: { ...request.headers },
          idempotencyKey: deliveryId,
        }
        const verified = yield* channel.value.verify(raw).pipe(Effect.result)
        if (verified._tag === "Failure") return yield* answer(401, "refused", "invalid_signature")
        const decoded = yield* channel.value.decode(raw).pipe(Effect.result)
        if (decoded._tag === "Failure") return yield* answer(400, "invalid", "invalid")
        // `Core.Channel` checked the decoder's output as an `ExternalEvent`.
        const delivered = decoded.success as Core.ExternalEvent.ExternalEvent
        const action = (delivered.payload as { readonly action?: unknown }).action
        const subject = subjectOf(event, delivered.payload)
        // An issue or pull request event of a repository the deployment acts on (decision 0079, slice 1b).
        const named = Option.flatMap(subject, (found) => {
          const [owner = "", name = ""] = found.repository.full_name.split("/")
          return isRepository(owner, name) && mayAct(repoId(owner, name))
            ? Option.some({ ...found, target: repositoryOf(`${owner}/${name}`) })
            : Option.none()
        })
        const first = yield* Store.recordDelivery({
          deliveryId,
          event,
          action: typeof action === "string" ? action.slice(0, 64) : null,
          repoId: Option.isSome(named) ? named.value.target.id : null,
          subject: Option.isSome(named) ? named.value.issue.number : null,
        }).pipe(Effect.provide(database))
        // Only issue and pull request events of a repository the deployment acts on name a subject; the rest (ping,
        // installation, repositories it doesn't act on) are recorded and answered.
        if (Option.isSome(named)) {
          const number = named.value.issue.number
          const target = named.value.target
          fields.number = number
          fields.repoId = target.id
          const repo = `${target.owner}/${target.name}`
          yield* (yield* FlowStarter).start(Apply, {
            executionId: applyExecutionId(deliveryId),
            payload: { deliveryId, repo, number, event },
          })
          // A new issue, while triage is on: the repository's triage flow decides it (decision 0012 §5).
          if (event === "issues" && action === "opened" && (yield* TriageStore.isOn(target.id).pipe(Effect.provide(database)))) {
            fields.triage = "started"
            yield* (yield* FlowStarter).start(TriageRun, {
              executionId: triageRunExecutionId(deliveryId),
              payload: { repo, number, trigger: "opened", key: deliveryId },
            })
          }
        }
        const mirror = MirrorRefresh.pushRepository(event, delivered.payload)
        if (Option.isSome(mirror)) {
          yield* MirrorRefresh.request(mirror.value.owner, mirror.value.name, deliveryId)
          fields.mirror = "requested"
        }
        // A push or a pull request of any repository the App is installed on: its flows' triggers decide what runs
        // (docs/features/ci.md#triggers), on the delivery's own `triggers/Dispatch`.
        const dispatch = options.repoFlows === true ? Dispatch.requestOf(event, deliveryId, delivered.payload) : Option.none()
        if (Option.isSome(dispatch)) {
          yield* (yield* FlowStarter).start(Dispatch.Dispatch, {
            executionId: Dispatch.dispatchExecutionId(deliveryId),
            payload: dispatch.value,
          })
          fields.dispatched = dispatch.value.repo
        }
        // `main` moving and a new release reach everyone watching the repository (decision 0009 §8).
        const now = new Date(yield* Clock.currentTimeMillis)
        const repoEvent = Notifications.repoEventOf(event, delivered.payload, repository, now)
        if (Option.isSome(repoEvent)) {
          fields.notified = yield* Notifications.recordRepoEvent(repoEvent.value).pipe(Effect.provide(database))
        }
        if (!first) return yield* answer(200, "duplicate")
        return yield* answer(200, Option.isSome(named) || Option.isSome(repoEvent) || Option.isSome(dispatch) || Option.isSome(mirror) ? "applied" : "ignored")
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            fields.errorCode = codeOf(Cause.squash(cause))
            return yield* answer(503, "unavailable", "unavailable")
          })
        ),
      )
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        "github.webhook",
      ).pipe(Effect.annotateLogs({ ...fields, status: response.status }))
      return response
    }).pipe(Effect.withSpan("github.webhook", { kind: "server" }))

    /** `POST /api/repos/<owner>/<name>/writes`. */
    const writes = (target: { readonly owner: string; readonly name: string }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Record<string, string | number> = {}
        const refused = (status: number, code: WriteRefusal) => {
          fields.outcome = code
          return refuse(status, code)
        }
        const response = yield* Effect.gen(function* () {
          if (request.method !== "POST") {
            fields.outcome = "method"
            return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
          }
          const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
          if (Option.isNone(actor)) return refused(503, "unavailable")
          if (Option.isNone(actor.value)) return refused(401, "authentication")
          const signed = actor.value.value
          if (!isRepository(target.owner, target.name)) return refused(404, "not_found")
          const repo = repositoryOf(`${target.owner}/${target.name}`)
          const own = repo.id === repository.id
          // Every write needs a role on the repository. No role means a repository the person can't see. On the
          // deployment's own repository that is the session's role, checked before the App as it always was.
          if (own && signed.role === null) return refused(403, "forbidden")
          if (Option.isNone(options.app)) return refused(503, "not_configured")
          const resolved = yield* options.roles.resolve(signed, repo).pipe(Effect.result)
          if (resolved._tag === "Failure") {
            const { code, retryAfterSeconds } = resolved.failure
            fields.outcome = code
            return refuse(RepoRoles.REFUSALS[code], code, retryAfterSeconds)
          }
          const who: Actor = { ...signed, role: resolved.success.role }
          if (who.role === null) return refused(403, "forbidden")
          const text = yield* readBounded(request, MAX_WRITE_BYTES).pipe(Effect.result)
          if (text._tag === "Failure") {
            return text.failure.reason === "too_large" ? refused(413, "too_large") : refused(400, "invalid")
          }
          const body = decodeWrite(text.success)
          if (Option.isNone(body)) return refused(400, "invalid")
          const write = body.value
          const via = viaOf(who)
          fields.op = write.op
          fields.via = via
          fields.writeId = write.writeId
          if (!own && !ANY_REPOSITORY.has(write.op)) return refused(404, "not_found")
          // Triage is the person's own act: anyone acting for them is refused, and counted as such (decision 0017).
          if (
            write.op !== "issue/create" && write.op !== "issue/comment" && write.op !== "branch/publish" &&
            write.op !== "branch/update" && write.op !== "branch/resync" && (yield* refusesPersonOnly(who, write.op))
          ) {
            return refused(403, "forbidden")
          }
          // A person's own write to GitHub runs with their GitHub token, which only a signed-in session holds.
          if (withPersonToken(write, via) && who.session === undefined) return refused(401, "authentication")
          // The agent's write runs as the App. Only a person who may ask Smithers has an agent (decision 0007
          // `repo:ask`, Member or above), so a Guest's write goes as the Guest or not at all, never as the bot.
          if (via === "agent" && !canAsk(who)) return refused(403, "forbidden")
          if (!mayWrite(who, write)) return refused(403, "forbidden")
          // The App writes triage under the role of the person who enabled it, re-checked by their GitHub login.
          if (write.op === "triage/enable" && who.login === undefined) return refused(401, "authentication")
          // Publish, Update branch and Resync: a branch of this repository the writer may edit; Publish and Resync, one
          // at a time per branch.
          if (write.op === "branch/publish" || write.op === "branch/update" || write.op === "branch/resync") {
            const branchId = write.branchId.toLowerCase()
            fields.branchId = branchId
            const branch = yield* branchAccess(Option.some(who), branchId).pipe(Effect.provide(database))
            if (branch === undefined || branch.repoId !== repo.id) return refused(404, "not_found")
            if (!canEdit(branch.access)) return refused(403, "forbidden")
            if (write.op === "branch/publish" || write.op === "branch/resync") {
              const blocked = yield* publishBlocked(branchId, write.writeId).pipe(Effect.provide(database))
              if (blocked !== undefined) {
                fields.blocked = blocked
                return refused(409, "conflict")
              }
            }
          }
          const payload = payloadOf(write)
          const payloadHash = digestSync(JSON.stringify({ via, ...payload }))
          const held = resolved.success.held
          const inserted = yield* Store.insertWrite({
            id: write.writeId,
            repoId: repo.id,
            actorId: who.subject.id,
            sessionId: via === "person" ? who.session ?? null : null,
            via,
            payload,
            payloadHash,
          }, Option.isSome(held) ? RepoRoles.holds(held.value) : undefined).pipe(Effect.provide(database))
          // The role changed between the read and the write: decided again on the next send.
          if (inserted.kind === "stale") return refused(403, "forbidden")
          // Another repository's or another person's write id is never theirs to resend.
          if (inserted.kind === "taken") return refused(409, "conflict")
          if (inserted.kind === "existing" && inserted.payloadHash !== payloadHash) return refused(409, "conflict")
          // A new write starts its run; a resend starts the same execution again, which changes nothing, so a start
          // that never reached its Durable Object gets there now. Run triage again is its own run: `triage/Run`
          // settles the write.
          if (inserted.kind === "inserted" || inserted.status === "pending") {
            yield* write.op === "triage/run"
              ? (yield* FlowStarter).start(TriageRun, {
                executionId: triageRunExecutionId(write.writeId),
                payload: {
                  repo: `${repository.owner}/${repository.name}`,
                  number: write.number,
                  trigger: "again",
                  key: write.writeId,
                },
              })
              : write.op === "pr/merge"
              ? (yield* FlowStarter).start(Merge, {
                executionId: mergeExecutionId(write.writeId),
                payload: { writeId: write.writeId },
              })
              : write.op === "branch/publish"
              ? (yield* FlowStarter).start(Publish, {
                executionId: publishExecutionId(write.writeId),
                payload: { writeId: write.writeId },
              })
              : write.op === "branch/update"
              ? (yield* FlowStarter).start(Update, {
                executionId: updateExecutionId(write.writeId),
                payload: { writeId: write.writeId },
              })
              : write.op === "branch/resync"
              ? (yield* FlowStarter).start(Resync, {
                executionId: resyncExecutionId(write.writeId),
                payload: { writeId: write.writeId },
              })
              : (yield* FlowStarter).start(Write, {
                executionId: writeExecutionId(write.writeId),
                payload: { writeId: write.writeId },
              })
          }
          if (inserted.kind === "existing") {
            fields.outcome = "existing"
            return HttpServerResponse.jsonUnsafe(
              { txid: null, writeId: write.writeId, status: inserted.status },
              { status: 200, headers: noStore },
            )
          }
          fields.outcome = "started"
          return HttpServerResponse.jsonUnsafe(
            { txid: inserted.txid, writeId: write.writeId },
            { status: 202, headers: noStore },
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(Cause.squash(cause))
              return refused(503, "unavailable")
            })
          ),
        )
        const outcome = String(fields.outcome)
        yield* Metric.update(
          Metric.withAttributes(Metrics.writeRequests, { op: String(fields.op ?? "unknown"), outcome }),
          1,
        )
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          "github.write.request",
        ).pipe(
          Effect.annotateLogs({
            ...fields,
            outcome,
            status: response.status,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          }),
        )
        return response
      }).pipe(Effect.withSpan("github.write.request", { kind: "server" }))

    // The last admitted bucket per repository: completed values only. Each request that finds a bucket behind
    // starts it itself, without sharing pending work (decision 0104).
    const admitted = yield* Ref.make<ReadonlyMap<string, number>>(new Map())

    /**
     * Starts `github/Reconcile` when `target`'s issues are older than `SYNC_STALE_MS`, one execution per repository and
     * 5-minute bucket, and waits at most `RECONCILE_START_TIMEOUT` for admission. A bucket admitted for that repository
     * isn't asked again. It never fails the read: each start logs `github.reconcile.start` and counts
     * `github_reconcile_starts` by outcome (`started`, `timed_out`, `not_started` with its error code).
     */
    const reconcileIfStale = (target: Repository) => Effect.gen(function* () {
      if (Option.isNone(options.app)) return
      const now = yield* Clock.currentTimeMillis
      const state = yield* Store.syncState(target.id, ISSUES_STREAM).pipe(Effect.provide(database))
      if (state.syncedAt !== null) yield* Metric.update(Metrics.syncAge, Math.round((now - state.syncedAt) / 1000))
      if (state.syncedAt !== null && now - state.syncedAt < SYNC_STALE_MS) return
      const bucket = reconcileBucketStart(now)
      if ((yield* Ref.get(admitted)).get(target.id) === bucket) return
      const started = yield* (yield* FlowStarter).start(Reconcile, {
        executionId: reconcileExecutionId(target.id, now),
        payload: { repo: `${target.owner}/${target.name}`, requestedAtMs: bucket },
      }).pipe(Effect.timeoutOption(RECONCILE_START_TIMEOUT))
      const outcome = Option.isSome(started) ? "started" : "timed_out"
      if (Option.isSome(started)) yield* Ref.update(admitted, (buckets) => new Map(buckets).set(target.id, bucket))
      yield* Metric.update(Metric.withAttributes(Metrics.reconcileStarts, { outcome }), 1)
      yield* Effect.logWithLevel(outcome === "started" ? "Info" : "Warn")("github.reconcile.start").pipe(
        Effect.annotateLogs({
          repoId: target.id,
          outcome,
          durationMs: (yield* Clock.currentTimeMillis) - now,
          ...(Option.isNone(started) ? { errorCode: "TimeoutError" } : {}),
        }),
      )
    }).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        return Effect.andThen(
          Metric.update(Metric.withAttributes(Metrics.reconcileStarts, { outcome: "not_started" }), 1),
          Effect.logWarning("github.reconcile.start").pipe(
            Effect.annotateLogs({
              repoId: target.id,
              outcome: "not_started",
              errorCode: error instanceof StartUnavailable ? error.errorCode : codeOf(error),
            }),
          ),
        )
      }),
      Effect.withSpan("github.reconcile.start"),
    )

    /**
     * The repository a shape names, `?repo=<owner>/<name>`, the deployment's own unless it names one: one the
     * deployment acts on (`mayAct`), else the refusal: `400 invalid` for a name GitHub couldn't have, `404 not_found`
     * for a repository it doesn't act on.
     */
    const shapeTarget = (url: string): Result.Result<Repository, HttpServerResponse.HttpServerResponse> => {
      const named = new URL(url, "http://localhost").searchParams.get("repo")
      if (named === null) return Result.succeed(repository)
      const [owner = "", name = "", ...rest] = named.split("/")
      if (rest.length !== 0 || !isRepository(owner, name)) return Result.fail(refuse(400, "invalid"))
      const target = repositoryOf(`${owner}/${name}`)
      return mayAct(target.id) ? Result.succeed(target) : Result.fail(refuse(404, "not_found"))
    }

    /** An Electric shape of `table` with its `columns`, filtered by `where` and `params`. */
    const shape = (
      table: string,
      columns: ReadonlyArray<string>,
      where: string,
      params: Readonly<Record<string, string>>,
    ) =>
      ShapeProxy.make({
        ...connection,
        shape: { table, where, params, columns },
        name: `github.shape.${table}`,
        metric: Metric.withAttributes(Metrics.shapes, { table }),
      })

    /**
     * Who may read the repository's rows (decision 0012, Consequences: until shapes are authorized per request, only a
     * public repository's rows reach a visitor): a signed-in person with a role on it, which GitHub granted because
     * they can see it; anyone else only when a GitHub metadata answer less than 60 seconds old says the repository is public. `None` when they may read,
     * else the refusal: signed out `401`, no role `403`, unavailable checks `503`.
     */
    const readRefusal = (target = repository) => Effect.gen(function* () {
      const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
      if (Option.isNone(actor)) return Option.some(refuse(503, "unavailable"))
      if (Option.isSome(actor.value)) {
        const resolved = yield* options.roles.resolve(actor.value.value, target).pipe(Effect.result)
        if (resolved._tag === "Failure") {
          // Where the App can't act, nobody has a role there: the public check below decides, as for anyone. Every
          // other refusal is GitHub or Postgres not answering now.
          if (!RepoRoles.CANT_ACT.has(resolved.failure.code)) {
            return Option.some(refuse(503, "unavailable", resolved.failure.retryAfterSeconds))
          }
        } else if (resolved.success.role !== null) return Option.none()
      }
      const isPublic = yield* Store.isPublic(target.id).pipe(Effect.provide(database), Effect.option)
      if (Option.isNone(isPublic)) return Option.some(refuse(503, "unavailable"))
      if (Option.getOrElse(isPublic.value, () => false)) {
        const current = yield* visibility(target)
        if (Option.isNone(current)) return Option.some(refuse(503, "unavailable"))
        if (current.value) return Option.none()
      }
      return Option.some(Option.isNone(actor.value) ? refuse(401, "authentication") : refuse(403, "forbidden"))
    })

    /** A repository shape, served only to whom `readRefusal` lets read it; the refusal is counted under its table. */
    const readable = (table: string, columns: ReadonlyArray<string>, where = "repo_id = $1", target = repository) =>
      Effect.gen(function* () {
        const refused = yield* readRefusal(target)
        if (Option.isSome(refused)) {
          yield* Metric.update(
            Metric.withAttributes(Metrics.shapes, { table, status: String(refused.value.status), live: "false" }),
            1,
          )
          yield* Effect.logWarning(`github.shape.${table}`).pipe(Effect.annotateLogs({ status: refused.value.status }))
          return refused.value
        }
        return yield* shape(table, columns, where, { "1": target.id })
      })

    /**
     * `GET /api/shapes/github-writes`: the signed-in person's own writes; signed out, none; sessions unreadable, 503
     * (worker/ShapeAccess.ts), never another person's scope under the device's handle.
     */
    const ownWrites = ShapeProxy.make({
      ...connection,
      shape: Effect.map(ShapeAccess.actor, (actor) => ({
        table: WRITES_TABLE,
        where: "actor_id = $1",
        params: { "1": Option.match(actor, { onNone: () => NOBODY, onSome: (actor) => actor.subject.id }) },
        columns: WRITE_COLUMNS,
      })),
      name: `github.shape.${WRITES_TABLE}`,
      metric: Metric.withAttributes(Metrics.shapes, { table: WRITES_TABLE }),
    })

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = request.url.split("?")[0]!
      if (path === GITHUB_WEBHOOK_ROUTE) return yield* webhook
      if (path === WRITES_SHAPE_ROUTE) return yield* ownWrites
      // A repository's issues, comments, sync and triage, its pull requests and a head's checks (the runs on a
      // commit): the repository `?repo=` names, its own unless it names one (decision 0079, slice 1b).
      const repositoryShape = REPOSITORY_SHAPES[path]
      if (repositoryShape !== undefined) {
        const target = shapeTarget(request.url)
        if (Result.isFailure(target)) return target.failure
        // Where an About read found the App absent lately, and Smithers knows no installation, the deployment doesn't
        // sync the repository: `404 app_not_installed`, which the page shows as GitHub's list. Postgres not answering
        // here leaves it to the read below.
        if (target.success.id !== repository.id) {
          const absent = yield* Store.appAbsent(target.success.id).pipe(Effect.provide(database), Effect.orElseSucceed(() => false))
          if (absent) {
            yield* Metric.update(
              Metric.withAttributes(Metrics.shapes, { table: repositoryShape.table, status: "404", live: "false" }),
              1,
            )
            yield* Effect.logInfo(`github.shape.${repositoryShape.table}`).pipe(
              Effect.annotateLogs({ status: 404, errorCode: "app_not_installed", repoId: target.success.id }),
            )
            return refuse(404, "app_not_installed")
          }
        }
        const read = readable(repositoryShape.table, repositoryShape.columns, repositoryShape.where, target.success)
        if (path === ITEMS_SHAPE_ROUTE) {
          // Admission runs beside the shape read inside this request, bounded at `RECONCILE_START_TIMEOUT`.
          // Reconcile's work stays on the durable engine; no admission outlives the request (decision 0104).
          const [, response] = yield* Effect.all([reconcileIfStale(target.success), read], { concurrency: 2 })
          return response
        }
        return yield* read
      }
      if (path === ACTIONS_SHAPE_ROUTE) {
        const named = new URL(request.url, "http://localhost").searchParams.get("repo")
        const [owner = "", name = "", ...rest] = (named ?? `${repository.owner}/${repository.name}`).split("/")
        if (rest.length !== 0 || !isRepository(owner, name)) return refuse(400, "invalid")
        return yield* readable(RUNS_TABLE, ACTION_COLUMNS, "repo_id = $1 AND execution IS NOT NULL", repositoryOf(`${owner}/${name}`))
      }
      // Any repository the person may read: a published branch's comparison lives on its own (docs/features/branch-publish.md).
      const compared = Compare.parseComparePath(path)
      if (compared !== undefined) {
        if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
        if (!isRepository(compared.owner, compared.name)) return refuse(404, "not_found")
        const target = repositoryOf(`${compared.owner}/${compared.name}`)
        if (!mayAct(target.id)) return refuse(404, "not_found")
        const refused = yield* readRefusal(target)
        if (Option.isSome(refused)) return refused.value
        if (Option.isNone(compare)) return refuse(503, "not_configured")
        return yield* compare.value(target, compared.base, compared.head).pipe(
          Effect.provide(database),
          Effect.catchCause(() => Effect.succeed(refuse(503, "unavailable"))),
        )
      }
      const target = parseWritesPath(path)
      if (target !== undefined) return yield* writes(target)
      return HttpServerResponse.empty({ status: 404 })
    })

    /**
     * Whether the deployment syncs repository `target`'s issues and pull requests, as its shapes' `404` says, for anyone
     * (decision 0079 slice 1b): its own; another the allowed list keeps, where an About read didn't find the App absent.
     * Postgres not answering leaves it synced: the shapes then answer for themselves.
     */
    const maySync = (target: Repository) =>
      target.id === repository.id
        ? Effect.succeed(true)
        : !mayAct(target.id)
        ? Effect.succeed(false)
        : Store.appAbsent(target.id).pipe(Effect.provide(database), Effect.map((absent) => !absent), Effect.orElseSucceed(() => true))

    return { fetch, mayRead: (target: Repository) => Effect.map(readRefusal(target), Option.isNone), maySync }
  })
