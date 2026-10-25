import { COMMITMENTS } from "../../src/features/issues/lifecycle.ts"
import { digestSync } from "@smthrs/crypto"
import { ShapeProxy } from "@smthrs/effect-electric"
import { Core, GitHub } from "@smthrs/integrations"
import { Cause, Clock, Effect, type Layer, Metric, Option, Redacted, Schema, Scope } from "effect"
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
import { type Actor, canAsk, refusesPersonOnly, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Dispatch from "../ci/Dispatch.ts"
import { FlowStarter } from "../Flows.ts"
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
//   that finds the sync older than 5 minutes starts `github/Reconcile` without waiting.
// - `GET /api/shapes/github-writes`: the signed-in person's own writes, their status only.
// - Triage (§5): the writes route takes a person's Accept or Not accepted, Run triage again, and Enable and Pause, each
//   at its own minimum role; `issues.opened` starts `triage/Run` while triage is on; and `GET
//   /api/shapes/triage-settings` serves whether it is.
// The webhook, the shapes and Reconcile serve one repository, `GITHUB_REPOSITORY`, the deployment's own (decision
// 0012, Consequences; decision 0079, Slice 1).

const noStore = { "cache-control": "no-store" }

const refuse = (status: number, code: WriteRefusal | "not_configured" | "invalid_signature", retryAfterSeconds?: number) =>
  HttpServerResponse.jsonUnsafe({ code }, {
    status,
    headers: retryAfterSeconds === undefined ? noStore : { ...noStore, "retry-after": String(retryAfterSeconds) },
  })

/** The writes any repository the deployment may act on takes (decision 0079, Slice 1); the rest only its own. */
const ANY_REPOSITORY: ReadonlySet<string> = new Set(["issue/create", "issue/comment"])

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
    write.op === "issue/commitment" || write.op === "pr/merge")

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
    const scope = yield* Scope.Scope
    // Check current metadata for anonymous readers, using the shared metadata token policy.
    const readToken = yield* ReadToken.fromConfig.pipe(
      options.http === undefined ? Effect.provide(FetchHttpClient.layer) : Effect.provideService(HttpClient.HttpClient, options.http),
      Effect.orDie,
    )
    const metadataApiUrl = Option.isSome(options.app) ? options.app.value.apiBaseUrl : (yield* apiUrl)
    const metadataClient = Effect.flatMap(readToken, (token) => GitHub.GitHubClient.make({
      apiBaseUrl: metadataApiUrl,
      token: Option.isSome(token) ? Redacted.value(token.value) : undefined,
    }, {})).pipe(
      options.http === undefined ? Effect.provide(FetchHttpClient.layer) : Effect.provideService(HttpClient.HttpClient, options.http),
      Effect.orDie,
    )
    const visibility = (target: Repository) => Effect.gen(function* () {
      const client = yield* metadataClient
      const result = yield* client.request("GET", `/repos/${GitHub.Repository.repositoryPath(target.owner, target.name)}`,
        undefined, { schema: Schema.Struct({ private: Schema.Boolean }) }).pipe(Effect.result)
      const visible = result._tag === "Success" ? Option.some(!result.success.private)
        : statusOf(result.failure) === 404 || statusOf(result.failure) === 410 ? Option.some(false) : Option.none<boolean>()
      const outcome = Option.isNone(visible) ? "unavailable" : visible.value ? "public" : "private"
      yield* Metric.update(Metric.withAttributes(Metrics.visibilityReads, { outcome }), 1)
      yield* Effect.logInfo("github.visibility").pipe(Effect.annotateLogs({ repoId: target.id, outcome }))
      return visible
    }).pipe(Effect.withSpan("github.visibility"))
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
        const named = Option.filter(subject, (found) => {
          const [owner = "", name = ""] = found.repository.full_name.split("/")
          return repoId(owner, name) === repository.id
        })
        const first = yield* Store.recordDelivery({
          deliveryId,
          event,
          action: typeof action === "string" ? action.slice(0, 64) : null,
          repoId: Option.isSome(named) ? repository.id : null,
          subject: Option.isSome(named) ? named.value.issue.number : null,
        }).pipe(Effect.provide(database))
        // Only issue and pull request events of the synced repository name a subject; the rest (ping, installation,
        // other repositories) are recorded and answered.
        if (Option.isSome(named)) {
          const number = named.value.issue.number
          fields.number = number
          const repo = `${repository.owner}/${repository.name}`
          yield* (yield* FlowStarter).start(Apply, {
            executionId: applyExecutionId(deliveryId),
            payload: { deliveryId, repo, number, event },
          })
          // A new issue, while triage is on: the repository's triage flow decides it (decision 0012 §5).
          if (event === "issues" && action === "opened" && (yield* TriageStore.isOn(repository.id).pipe(Effect.provide(database)))) {
            fields.triage = "started"
            yield* (yield* FlowStarter).start(TriageRun, {
              executionId: triageRunExecutionId(deliveryId),
              payload: { repo, number, trigger: "opened", key: deliveryId },
            })
          }
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
        return yield* answer(200, Option.isSome(named) || Option.isSome(repoEvent) || Option.isSome(dispatch) ? "applied" : "ignored")
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
          if (write.op !== "issue/create" && write.op !== "issue/comment" && (yield* refusesPersonOnly(who, write.op))) {
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

    /**
     * Starts `github/Reconcile` when the synced repository's issues are older than `SYNC_STALE_MS`, one execution per
     * 5-minute bucket, without waiting. A failure here is logged and the read goes on.
     */
    const reconcileIfStale = Effect.gen(function* () {
      if (Option.isNone(options.app)) return
      const now = yield* Clock.currentTimeMillis
      const state = yield* Store.syncState(repository.id, ISSUES_STREAM).pipe(Effect.provide(database))
      if (state.syncedAt !== null) yield* Metric.update(Metrics.syncAge, Math.round((now - state.syncedAt) / 1000))
      if (state.syncedAt !== null && now - state.syncedAt < SYNC_STALE_MS) return
      yield* (yield* FlowStarter).start(Reconcile, {
        executionId: reconcileExecutionId(repository.id, now),
        payload: { repo: `${repository.owner}/${repository.name}`, requestedAtMs: reconcileBucketStart(now) },
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("github.reconcile.start").pipe(
          Effect.annotateLogs({ repoId: repository.id, outcome: "not_started", errorCode: codeOf(Cause.squash(cause)) }),
        )
      ),
    )

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
     * they can see it; anyone else only when a current GitHub metadata read says the repository is public. `None` when they may read,
     * else the refusal: signed out `401`, no role `403`, unavailable checks `503`.
     */
    const readRefusal = (target = repository) => Effect.gen(function* () {
      const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
      if (Option.isNone(actor)) return Option.some(refuse(503, "unavailable"))
      if (Option.isSome(actor.value)) {
        const resolved = yield* options.roles.resolve(actor.value.value, target).pipe(Effect.result)
        if (resolved._tag === "Failure") {
          const status = RepoRoles.REFUSALS[resolved.failure.code]
          const temporary = status === 503 || status === 429
          return Option.some(refuse(temporary ? 503 : 403, temporary ? "unavailable" : "forbidden", resolved.failure.retryAfterSeconds))
        }
        if (resolved.success.role !== null) return Option.none()
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
      if (path === ITEMS_SHAPE_ROUTE) {
        // Only admission runs in the Worker's scope; Reconcile's work stays on the durable engine.
        // A read never waits for admission, and a later stale read can request the same bucket again.
        yield* Effect.forkIn(reconcileIfStale, scope)
        return yield* readable(ITEMS_TABLE, ITEM_COLUMNS)
      }
      if (path === COMMENTS_SHAPE_ROUTE) return yield* readable(COMMENTS_TABLE, COMMENT_COLUMNS)
      if (path === SYNC_SHAPE_ROUTE) return yield* readable(SYNC_TABLE, SYNC_COLUMNS)
      if (path === TRIAGE_SETTINGS_SHAPE_ROUTE) return yield* readable(TRIAGE_SETTINGS_TABLE, TRIAGE_SETTINGS_COLUMNS)
      if (path === WRITES_SHAPE_ROUTE) return yield* ownWrites
      // Pull requests (docs/features/pulls.md): their rows, and a head's checks: the runs on a commit.
      if (path === PULLS_SHAPE_ROUTE) return yield* readable(PULLS_TABLE, PULL_COLUMNS)
      if (path === PULL_COMMITS_SHAPE_ROUTE) return yield* readable(PULL_COMMITS_TABLE, PULL_COMMIT_COLUMNS)
      if (path === REVIEWS_SHAPE_ROUTE) return yield* readable(REVIEWS_TABLE, REVIEW_COLUMNS)
      // A pull request's checks are its head's `checks/Run` rows; a repository flow's runs are the repository's runs
      // (docs/features/actions.md), whose states the Checks tab doesn't read.
      if (path === CHECKS_SHAPE_ROUTE) {
        return yield* readable(RUNS_TABLE, CHECK_COLUMNS, "repo_id = $1 AND sha IS NOT NULL AND execution IS NULL")
      }
      if (path === ACTIONS_SHAPE_ROUTE) {
        const named = new URL(request.url, "http://localhost").searchParams.get("repo")
        const [owner = "", name = "", ...rest] = (named ?? `${repository.owner}/${repository.name}`).split("/")
        if (rest.length !== 0 || !isRepository(owner, name)) return refuse(400, "invalid")
        return yield* readable(RUNS_TABLE, ACTION_COLUMNS, "repo_id = $1 AND execution IS NOT NULL", repositoryOf(`${owner}/${name}`))
      }
      const compared = Compare.parseComparePath(path)
      if (compared !== undefined) {
        if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
        if (repoId(compared.owner, compared.name) !== repository.id) return refuse(404, "not_found")
        const refused = yield* readRefusal()
        if (Option.isSome(refused)) return refused.value
        if (Option.isNone(compare)) return refuse(503, "not_configured")
        return yield* compare.value(repository, compared.base, compared.head).pipe(
          Effect.provide(database),
          Effect.catchCause(() => Effect.succeed(refuse(503, "unavailable"))),
        )
      }
      const target = parseWritesPath(path)
      if (target !== undefined) return yield* writes(target)
      return HttpServerResponse.empty({ status: 404 })
    })

    return { fetch }
  })
