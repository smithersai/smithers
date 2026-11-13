import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { GitHub } from "@smthrs/integrations"
import { Node } from "@smthrs/plan"
import { Clock, Effect, Layer, Metric, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
import { ISSUES_STREAM, SYNC_STALE_MS } from "../../src/features/issues/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import type { Services } from "./Apply.ts"
import { classify, withToken } from "./Calls.ts"
import { repositoryOf } from "./Config.ts"
import * as Metrics from "./Metrics.ts"
import { pullCurrent, readPull, reviewStream } from "./Pulls.ts"
import * as Store from "./Store.ts"

// `github/Reconcile { repo }` (decision 0012 §3, docs/features/issues.md#reconcile): walks GitHub's change-time listing
// of a repository's issues, then of their comments (`GitHub.Sync` from `@smthrs/integrations`), and upserts every row
// under the newer-than guard. Webhooks are hints: GitHub doesn't redeliver a failed delivery, so this is what makes the
// projection whole. A pull request's draft and merge state live in `pulls`, which the listing doesn't carry: one whose
// row is missing or older than the listing's `updated_at` is read in full (worker/github/Pulls.ts) before its page
// commits. Each page commits its cursor in `github_sync` before the next, so a run that dies resumes where it stopped
// and reads such a pull request again. A walk that runs out of its page budget is recorded `partial`, never complete. A read that finds the sync
// older than 5 minutes starts it (worker/github/Api.ts). `@smthrs/triggers` runs on the Cloudflare host now
// (worker/ci/Cron.ts); moving this walk onto a cron there is its own change (decision 0012 W9). A walk that comes due after the window after its read's has also passed is
// `superseded`: a newer read starts its own, so a backlog an outage left ends instead of walking all at once.

/** GitHub or Postgres couldn't answer. Retried, after `retryAfterMillis`; the next attempt resumes from the cursor. */
export class ReconcileUnavailable extends Schema.TaggedError<ReconcileUnavailable>()(
  "@smthrs/mvp/github/ReconcileUnavailable",
  { retryAfterMillis: Schema.optional(Schema.Number) },
) {}

/** 1 s doubling to a minute, for at most 30 minutes. */
export const RECONCILE_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

/** Pages one walk reads before it stops `partial`; the next stale read continues from the cursor. */
export const PAGES_PER_WALK = 50

const ReconcileRequest = {
  repo: Schema.String,
  /**
   * When the 5-minute bucket of the read that asked for the walk began (`reconcileBucketStart`). Requests started
   * before 2026-10-21 carry none and are superseded: they are the backlog the flow engine's outage left.
   */
  requestedAtMs: Schema.optional(Schema.Number),
  /** Counts accumulated before a review continuation handed off to this round. */
  previousPages: Schema.optional(Schema.Number),
  previousIssues: Schema.optional(Schema.Number),
  previousComments: Schema.optional(Schema.Number),
  previousSkipped: Schema.optional(Schema.Number),
}

/** How the walk ended, and what it changed. */
export const Reconciled = Schema.Struct({
  outcome: Schema.Literals(["complete", "partial", "not_installed", "refused", "unavailable", "superseded"]),
  pages: Schema.Number,
  issues: Schema.Number,
  comments: Schema.Number,
  /** Items GitHub listed that this app couldn't read: skipped, never guessed at. */
  skipped: Schema.Number,
})
export type Reconciled = typeof Reconciled.Type

const UNAVAILABLE: Reconciled = { outcome: "unavailable", pages: 0, issues: 0, comments: 0, skipped: 0 }
const SUPERSEDED: Reconciled = { outcome: "superseded", pages: 0, issues: 0, comments: 0, skipped: 0 }

/** The step: walk the listing from the cursor. */
export const Walk = Action.make("github/Reconcile/walk", {
  payload: ReconcileRequest,
  success: Schema.Struct({ ...Reconciled.fields, reviewsPending: Schema.optional(Schema.Boolean) }),
  error: ReconcileUnavailable,
  retryPolicy: RECONCILE_RETRY,
})

/** `github/Reconcile`: brings a repository's issues, pull requests and comments up to date with GitHub. */
export const Reconcile: Flow.Flow<
  "github/Reconcile",
  Schema.Struct<typeof ReconcileRequest>,
  typeof Reconciled,
  typeof ReconcileUnavailable,
  Action.Requirement<"github/Reconcile/walk">
> = Flow.make("github/Reconcile", {
  description: "Walk a repository's issues and comments on GitHub by change time into items, comments and pulls.",
  capabilities: ["db:write:items", "db:write:comments", "db:write:pulls", "db:write:github_sync"],
  modelInvocable: false,
  payload: ReconcileRequest,
  success: Reconciled,
  error: ReconcileUnavailable,
  body: Node.capture({ walk: Walk.name }, (request) =>
    Walk.call(request).pipe(
      Node.branch({
        if: Node.capture({}, (result) => result.reviewsPending === true),
        then: Node.capture({ reconcile: "github/Reconcile", request }, (result) => Reconcile.to({
          ...request, previousPages: result.pages, previousIssues: result.issues,
          previousComments: result.comments, previousSkipped: result.skipped,
        })),
        else: Node.capture({}, (result) => Node.map(Node.succeed(result), Node.capture({},
          ({ outcome, pages, issues, comments, skipped }) => ({ outcome, pages, issues, comments, skipped }),
        ))),
      }),
      Node.catch({ onFailure: Node.capture({ reconciled: "unavailable" }, () => Node.succeed(UNAVAILABLE)) }),
    )),
})

const ISSUE_OF = /\/issues\/(\d+)$/
const decodeIssue = Schema.decodeUnknownOption(GitHub.Issues.Issue)
const decodeComment = Schema.decodeUnknownOption(GitHub.Issues.IssueComment)

/** What the walk reads of the repository itself: its id, and whether it is private. */
const RepositoryFacts = Schema.Struct({ id: Schema.Number, private: Schema.Boolean })

/**
 * A comment a listing returned, with the number of its issue, or `None` for one this app can't read because GitHub's
 * shape changed: skipped and counted, never guessed at. `GitHub.Sync` has already refused a comment whose `issue_url`
 * names no issue.
 */
const commentOf = (payload: unknown) =>
  Option.map(decodeComment(payload), (comment) => ({ comment, number: Number(ISSUE_OF.exec(comment.issue_url)![1]) }))

/** What `github/Reconcile/walk` does, with its records: never a title, a body or a login. */
export const walk = <E, R>(services: Services<E, R>, pagesPerWalk: number = PAGES_PER_WALK) =>
(request: typeof Walk.payloadSchema.Type) =>
  Effect.gen(function* () {
    const repository = repositoryOf(request.repo)
    const now = yield* Clock.currentTimeMillis
    if (request.requestedAtMs === undefined || now - request.requestedAtMs >= 2 * SYNC_STALE_MS) {
      yield* Metric.update(Metric.withAttributes(Metrics.reconciles, { outcome: SUPERSEDED.outcome }), 1)
      yield* Effect.logInfo("github.reconcile").pipe(Effect.annotateLogs({ repoId: repository.id, ...SUPERSEDED }))
      return SUPERSEDED
    }
    const finished = (reconciled: Reconciled, failure: string | null) =>
      Effect.gen(function* () {
        yield* Store.finishSync(repository.id, ISSUES_STREAM, { complete: reconciled.outcome === "complete", failure })
        yield* Metric.update(Metric.withAttributes(Metrics.reconciles, { outcome: reconciled.outcome }), 1)
        yield* Effect.logWithLevel(reconciled.outcome === "complete" || reconciled.outcome === "partial" ? "Info" : "Warn")(
          "github.reconcile",
        ).pipe(Effect.annotateLogs({ repoId: repository.id, ...reconciled, ...(failure === null ? {} : { failure }) }))
        return reconciled
      })
    const token = yield* services.tokens.forInstallation(repository, "pulls").pipe(Effect.result)
    if (token._tag === "Failure") {
      if (token.failure.reason === "app_not_installed" || token.failure.reason === "not_allowed") {
        return yield* finished({ outcome: "not_installed", pages: 0, issues: 0, comments: 0, skipped: 0 }, token.failure.reason)
      }
      return yield* new ReconcileUnavailable(
        token.failure.retryAfterMillis === undefined ? {} : { retryAfterMillis: token.failure.retryAfterMillis },
      )
    }
    const before = yield* Store.syncState(repository.id, ISSUES_STREAM)
    const counts = {
      pages: request.previousPages ?? 0, issues: request.previousIssues ?? 0,
      comments: request.previousComments ?? 0, skipped: request.previousSkipped ?? 0,
    }
    const firstPage = counts.pages
    let reviewsPending = false
    const walked = yield* Effect.gen(function* () {
      const client = yield* GitHub.GitHubClient.GitHubClient
      // Whether the repository is public decides who may read its rows without signing in (worker/github/Api.ts).
      const observedAt = yield* Store.repositoryObservation
      const facts = yield* client.request(
        "GET",
        `/repos/${GitHub.Repository.repositoryPath(repository.owner, repository.name)}`,
        undefined,
        { schema: RepositoryFacts },
      )
      yield* Store.recordRepository(repository.id, { githubId: facts.id, private: facts.private }, observedAt)
      const adapter = GitHub.Sync.make({
        connectionId: repository.id,
        owner: repository.owner,
        repo: repository.name,
        client,
        stream: ISSUES_STREAM,
      })
      let cursor = before.cursor
      while (counts.pages - firstPage < pagesPerWalk) {
        const page = yield* adapter.changes(cursor)
        counts.pages += 1
        for (const record of page.records) {
          if (record.kind === "issue-comment") {
            const read = commentOf(record.payload)
            if (Option.isNone(read)) counts.skipped += 1
            else if (yield* Store.upsertComment(repository.id, read.value.number, read.value.comment, record.retrievedAtMs)) {
              counts.comments += 1
            }
          } else {
            const issue = decodeIssue(record.payload)
            if (Option.isNone(issue)) counts.skipped += 1
            else {
              if (yield* Store.upsertIssue(repository.id, issue.value, record.retrievedAtMs)) counts.issues += 1
              if (record.kind === "pull-request" && !(yield* pullCurrent(repository.id, issue.value))) {
                yield* readPull(repository, issue.value.number)
                if ((yield* Store.syncState(repository.id, reviewStream(issue.value.number))).cursor !== null) {
                  // Keep this listing page until the pull's durable review walk finishes.
                  reviewsPending = true
                  return "partial" as const
                }
              }
            }
          }
        }
        cursor = page.cursor
        yield* Store.commitCursor(repository.id, ISSUES_STREAM, cursor)
        if (page.done) return "complete" as const
      }
      return "partial" as const
    }).pipe(withToken(token.success, services.apiBaseUrl), Effect.result)
    // After the first walk, a row a reconcile had to change is one a webhook should have delivered.
    if (before.syncedAt !== null) {
      yield* Metric.update(Metric.withAttributes(Metrics.reconcileChanged, { kind: "issue" }), counts.issues - (request.previousIssues ?? 0))
      yield* Metric.update(Metric.withAttributes(Metrics.reconcileChanged, { kind: "comment" }), counts.comments - (request.previousComments ?? 0))
    }
    if (walked._tag === "Success") return {
      ...yield* finished({ outcome: walked.success, ...counts }, null),
      ...(reviewsPending ? { reviewsPending: true } : {}),
    }
    const classified = classify(walked.failure)
    if (classified.kind === "refused") {
      return yield* finished({ outcome: "refused", ...counts }, `github_${classified.status}`)
    }
    yield* Effect.logWarning("github.reconcile").pipe(
      Effect.annotateLogs({ repoId: repository.id, outcome: "failed", errorCode: codeOf(walked.failure), ...counts }),
    )
    return yield* new ReconcileUnavailable(
      classified.kind === "retry" && classified.retryAfterMillis !== undefined
        ? { retryAfterMillis: classified.retryAfterMillis }
        : {},
    )
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, services.http),
    Effect.provide(services.database),
    Effect.mapError((error) => (error instanceof ReconcileUnavailable ? error : new ReconcileUnavailable({}))),
    Effect.withSpan("github.reconcile", { attributes: { "smithers.github.repo": request.repo } }),
  )

/** Registers `github/Reconcile` with its step over `services`. */
export const registration = <E, R>(services: Services<E, R>, pagesPerWalk?: number) =>
  Interpreter.layerWithImplementations(Reconcile, Walk.toLayer(walk(services, pagesPerWalk))).pipe(
    Layer.provideMerge(Action.layerImplementations),
  )
