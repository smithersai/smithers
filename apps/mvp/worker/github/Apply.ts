import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Clock, Effect, Layer, Metric, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"
import { classify, withToken } from "./Calls.ts"
import { repositoryOf } from "./Config.ts"
import * as Metrics from "./Metrics.ts"
import { type Fetched, fetchIssue, project } from "./Project.ts"
import { fetchPull, projectPull } from "./Pulls.ts"
import * as Store from "./Store.ts"
import { candidates } from "./TreeScope.ts"
import type { GitHubTokens } from "./Tokens.ts"
import type { RepoRoles } from "./RepoRoles.ts"

// `github/Apply { deliveryId, repo, number, event }` (decision 0012 §2, docs/features/issues.md#the-webhook):
// a webhook rang the bell for issue `number`; this reads the issue and its comments from GitHub with an installation
// token and upserts them under the newer-than guard. For a pull request event it also reads the pull request, its
// commits and its reviews (docs/features/pulls.md). A payload names a subject; it never sets state. It runs remotely
// because it must happen while every device is off (decision 0011 §2), one execution per delivery, and on the Node host
// in the tests. Retries belong to the engine: the step's policy, which honors GitHub's `Retry-After`. A delivery whose
// subject stays unreadable past the retries ends `unavailable`, and Reconcile covers it.

/** GitHub or Postgres couldn't answer. The step's retry policy tries again, after `retryAfterMillis`. */
export class ApplyUnavailable extends Schema.TaggedError<ApplyUnavailable>()("@smthrs/mvp/github/ApplyUnavailable", {
  retryAfterMillis: Schema.optional(Schema.Number),
}) {}

/** 1 s doubling to a minute, for at most 30 minutes. */
export const APPLY_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

/**
 * The delivery a run is for: its id, the repository (`owner/name`), the issue and the event. Only what the delivery
 * itself says, so a redelivery starts the very same execution.
 */
const ApplyRequest = {
  deliveryId: Schema.String,
  repo: Schema.String,
  number: Schema.Int,
  event: Schema.String,
  /** Rows changed by earlier review-page rounds of this delivery. */
  changed: Schema.optional(Schema.Number),
  /** This delivery's own continuation; a new delivery starts at the first page. */
  reviewCursor: Schema.optional(Schema.String),
}

/** What the run did to the projection. */
export const Applied = Schema.Struct({
  outcome: Schema.Literals(["applied", "tombstoned", "not_installed", "unavailable"]),
  changed: Schema.Number,
})
export type Applied = typeof Applied.Type

const UNAVAILABLE: Applied = { outcome: "unavailable", changed: 0 }

/** The events whose subject is a pull request: re-read with its commits and reviews (worker/github/Pulls.ts). */
export const PULL_EVENTS: ReadonlySet<string> = new Set(["pull_request", "pull_request_review"])

/** The step: re-read the subject and upsert it. */
export const Read = Action.make("github/Apply/read", {
  payload: ApplyRequest,
  success: Schema.Struct({ ...Applied.fields, reviewCursor: Schema.optional(Schema.String) }),
  error: ApplyUnavailable,
  retryPolicy: APPLY_RETRY,
})

/** `github/Apply`: re-reads a webhook's subject from GitHub into Postgres. */
export const Apply: Flow.Flow<
  "github/Apply",
  Schema.Struct<typeof ApplyRequest>,
  typeof Applied,
  typeof ApplyUnavailable,
  Action.Requirement<"github/Apply/read">
> = Flow.make("github/Apply", {
  description: "Re-read the issue a GitHub webhook names, with its comments, into items and comments.",
  capabilities: ["db:write:items", "db:write:comments"],
  modelInvocable: false,
  payload: ApplyRequest,
  success: Applied,
  error: ApplyUnavailable,
  body: Node.capture({ read: Read.name }, (request) =>
    Read.call(request).pipe(
      Node.branch({
        if: Node.capture({}, (result) => result.reviewCursor !== undefined),
        then: Node.capture({ apply: "github/Apply", request }, (result) => Apply.to({ ...request, changed: result.changed, reviewCursor: result.reviewCursor })),
        else: Node.capture({}, (result) => Node.map(
          Node.succeed(result), Node.capture({}, ({ outcome, changed }) => ({ outcome, changed })),
        )),
      }),
      Node.catch({ onFailure: Node.capture({ applied: "unavailable" }, () => Node.succeed(UNAVAILABLE)) }),
    )),
})

/** What the GitHub flows need from their host. */
export interface Services<E = unknown, R = never> {
  /** Postgres with the app's tables (not the engine's schema). */
  readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
  readonly tokens: GitHubTokens
  /** Deferred protected writes refresh repository roles outside their final transaction. */
  readonly roles?: RepoRoles<R>
  /** How GitHub is reached: Effect's `HttpClient` over `fetch` when deployed, a scripted GitHub in the tests. */
  readonly http: HttpClient.HttpClient
  /** GitHub's REST API (`GITHUB_API_URL`). */
  readonly apiBaseUrl: string
  /** Whether this deployment acts on repository `id` now (`RepoRoles.actsOn`). */
  readonly mayAct: (id: string) => boolean
  /** The App's login on GitHub, `<GITHUB_APP_SLUG>[bot]`, read once when the host starts: who wrote what the App wrote. */
  readonly appLogin: string
  /** Independently configured tree candidates, in addition to recorded repositories. */
  readonly allowedRepositories?: ReadonlyArray<string>
  /** Complete a TODO's durable wait and wake its host; delivery is retried by this step. */
  readonly invalidateTodo?: (stop: { readonly attemptId: string; readonly todoId: string; readonly baseClosed: boolean }) => Effect.Effect<void, unknown>
  readonly signalTodo?: (executionId: string, prNumber: number) => Effect.Effect<void, unknown>
  /** Starts `github/Apply` for an issue on its own durable execution; the same request again changes nothing. */
  readonly startApply?: (request: typeof Read.payloadSchema.Type) => Effect.Effect<void, unknown>
}

/**
 * The parents to read again when `issue` changed: a child's parent or state moving changes its parents' counts and, on
 * GitHub, perhaps their `updated_at`. What the row says now against what GitHub answers.
 */
const neighbours = (repoId: string, before: { readonly state: string | null; readonly parentId: string | null }, fetched: Fetched) => {
  const named = (id: string | null) => {
    if (id === null) return undefined
    const hash = id.lastIndexOf("#")
    return { repository: repositoryOf(id.slice("github/".length, hash)), number: Number(id.slice(hash + 1)), id }
  }
  if (fetched.kind === "gone") return before.parentId === null ? [] : [named(before.parentId)!]
  const stated = Store.statedParent(repoId, fetched.issue)
  const parentNow = stated === undefined ? before.parentId : stated === null ? null : stated.id
  const moved = parentNow !== before.parentId
  const closed = before.state !== null && before.state !== fetched.issue.state
  if (!moved && !closed) return []
  return [...new Set([before.parentId, parentNow])].flatMap((id) => {
    const parent = named(id)
    return parent === undefined ? [] : [parent]
  })
}

/** What `github/Apply/read` does: one re-read with its records, never a title, a body or a login. */
export const read = <E, R>(services: Services<E, R>) => (request: typeof Read.payloadSchema.Type) =>
  Effect.gen(function* () {
    const repository = repositoryOf(request.repo)
    const fields = { deliveryId: request.deliveryId, repoId: repository.id, number: request.number, event: request.event }
    const pull = PULL_EVENTS.has(request.event)
    const token = yield* services.tokens.forInstallation(repository, pull ? "pulls" : "read").pipe(Effect.result)
    if (token._tag === "Failure") {
      if (token.failure.reason === "app_not_installed" || token.failure.reason === "not_allowed") {
        yield* Metric.update(Metric.withAttributes(Metrics.applies, { outcome: "not_installed" }), 1)
        yield* Effect.logWarning("github.apply").pipe(Effect.annotateLogs({ ...fields, outcome: "not_installed" }))
        return { outcome: "not_installed", changed: 0 } satisfies Applied
      }
      return yield* new ApplyUnavailable(
        token.failure.retryAfterMillis === undefined ? {} : { retryAfterMillis: token.failure.retryAfterMillis },
      )
    }
    // The neighbours start before the projection: a retry after a crash between them finds the same difference and starts
    // the same executions, where the other order would lose them. Each is named by the delivery and the issue, so a chain
    // of them can't go round a cycle.
    const reread = Effect.gen(function* () {
      const fetched = yield* fetchIssue(repository, request.number)
      if (services.startApply !== undefined) {
        const delivery = request.deliveryId.split(":")[0]!
        const before = yield* Store.relationBefore(repository.id, request.number)
        for (const parent of neighbours(repository.id, before, fetched)) {
          if (!services.mayAct(parent.repository.id)) continue
          const known = yield* candidates(parent.repository.owner, services.allowedRepositories ?? [])
          if (!known.includes(parent.repository.id)) continue
          yield* services.startApply({
            deliveryId: `${delivery}:${parent.id}`,
            repo: `${parent.repository.owner}/${parent.repository.name}`,
            number: parent.number,
            event: request.event,
          }).pipe(Effect.mapError(() => new ApplyUnavailable({})))
        }
      }
      return yield* project(repository, request.number, fetched)
    })
    let reviewCursor: string | null = null
    const rereadPull = Effect.gen(function* () {
      // Each delivery owns its walk: another delivery may already have projected a later page.
      const fetched = yield* fetchPull(repository, request.number, request.reviewCursor ?? null)
      reviewCursor = fetched.kind === "found" ? fetched.reviewsNext : null
      return yield* projectPull(repository, request.number, fetched)
    })
    const projected = yield* (pull ? rereadPull : reread).pipe(
      withToken(token.success, services.apiBaseUrl),
      Effect.tapError((error) =>
        Effect.logWarning("github.apply").pipe(Effect.annotateLogs({ ...fields, outcome: "failed", errorCode: codeOf(error) }))
      ),
      Effect.mapError((error) => {
        if (error instanceof ApplyUnavailable) return error
        const classified = classify(error)
        return new ApplyUnavailable(
          classified.kind === "retry" && classified.retryAfterMillis !== undefined
            ? { retryAfterMillis: classified.retryAfterMillis }
            : {},
        )
      }),
    )
    if (pull && services.signalTodo !== undefined) {
      const sql = yield* SqlClient.SqlClient
      // Only an authoritative terminal projection signals. Include stacked dependents: they must restack or
      // fail even if the base run has not yet reported its own settlement.
      const waiting = yield* sql<{ runId: string }>`
        SELECT DISTINCT t.run_id AS "runId" FROM pulls p JOIN items i ON i.id = p.item_id
        JOIN todos t ON t.repo_id = p.repo_id AND (t.pr_number = p.number OR t.base_ref = p.head_ref)
        WHERE p.repo_id = ${repository.id} AND p.number = ${request.number}
          AND (p.merged OR i.state = 'closed') AND t.state IN ('working', 'in_review') AND t.run_id IS NOT NULL`
      yield* Effect.forEach(waiting, ({ runId }) => services.signalTodo!(runId, request.number), { discard: true })
      yield* Effect.logInfo("todo.webhook").pipe(Effect.annotateLogs({ ...fields, woken: waiting.length }))
    }
    if (pull && services.invalidateTodo !== undefined) {
      const sql = yield* SqlClient.SqlClient
      const roots = yield* sql<{ attemptId: string; todoId: string }>`
        SELECT a.id AS "attemptId", t.id AS "todoId" FROM pulls p JOIN items i ON i.id = p.item_id
        JOIN todo_attempts a ON a.repo_id = p.repo_id AND a.pr_number = p.number
        JOIN todos t ON t.id = a.todo_id
        WHERE p.repo_id = ${repository.id} AND p.number = ${request.number} AND NOT p.merged AND i.state = 'closed'`
      yield* Effect.forEach(roots, (root) => services.invalidateTodo!({ ...root, baseClosed: true }), { discard: true })
    }
    // From the delivery's arrival, once the route recorded it.
    const received = yield* Store.receivedAt(request.deliveryId)
    const now = yield* Clock.currentTimeMillis
    const lag = Option.map(received, (at) => Math.max(0, now - at))
    yield* Metric.update(Metric.withAttributes(Metrics.applies, { outcome: projected.outcome }), 1)
    if (Option.isSome(lag)) yield* Metric.update(Metrics.deliveryLag, lag.value)
    yield* Effect.logInfo("github.apply").pipe(
      Effect.annotateLogs({
        ...fields,
        outcome: projected.outcome,
        changed: projected.changed,
        ...(Option.isSome(lag) ? { lagMs: lag.value } : {}),
      }),
    )
    return { ...projected, changed: projected.changed + (request.changed ?? 0), ...(reviewCursor === null ? {} : { reviewCursor }) }
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, services.http),
    Effect.provide(services.database),
    // Postgres couldn't be reached for the token's installation, or a connection failed to open: tried again.
    Effect.mapError((error) => (error instanceof ApplyUnavailable ? error : new ApplyUnavailable({}))),
    Effect.withSpan("github.apply", {
      attributes: { "smithers.github.delivery": request.deliveryId, "smithers.github.number": request.number },
    }),
  )

/** Registers `github/Apply` with its step over `services`. */
export const registration = <E, R>(services: Services<E, R>) =>
  Interpreter.layerWithImplementations(Apply, Read.toLayer(read(services))).pipe(
    Layer.provideMerge(Action.layerImplementations),
  )
