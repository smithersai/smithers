import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import {
  checkFlowOf,
  PULLS_SEGMENT,
  REVIEW_CHECK,
  REVIEW_SEGMENT,
  type ReviewRefusal,
  reviewExecutionId,
  SHA,
} from "../../src/features/pulls/contract.ts"
import { isRepository, REPOS_ROUTE } from "../../src/features/repo/contract.ts"
import { refusesPersonOnly, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import { FlowStarter } from "../Flows.ts"
import { checkRunIdOf, ReviewRun } from "../flows/Checks.ts"
import { type GitHubApp, type Repository, repositoryOf } from "./Config.ts"
import * as RepoRoles from "./RepoRoles.ts"

// Review on request (decision 0129, docs/features/pulls.md#review-on-request): `POST
// /api/repos/<owner>/<name>/pulls/<number>/review` asks Smithers to review a pull request's current head, any pull
// request of any repository the deployment acts on, for a Maintainer or Admin there (`RepoRoles`, decision 0079) in
// person. It reads the head from the pull request's projection, claims the head's one `checks/review` run row and starts
// `pull/Review` (worker/flows/Checks.ts) for the person who asked, in one transaction: a claim whose start failed is
// rolled back, so the next press starts it.
//
//   no review run on the head, or a failed one   claimed (working, for this person) ─▶ pull/Review started ─▶ 202
//   a review Running or Passed on the head       nothing started ─▶ 202, the same review
//   another check of the head Running            409 checks_running: checks/Run reviews the head after its scripts
//
// Each request is a span and a log line `pull.review.request` and one count by outcome: ids and codes, never a title,
// a diff or a finding.

/** Review requests, by `outcome`: `started`, `existing`, or the refusal's code. */
export const requests = Metric.counter("smithers_pull_review_requests", {
  description: "Requests to review a pull request's head, by outcome",
  incremental: true,
})

/** The most bytes a request's body may have: `{ "headSha": "<40 hex>" }` and room. */
export const MAX_REVIEW_BYTES = 1024

const Body = Schema.Struct({ headSha: Schema.optional(Schema.String.check(Schema.isPattern(SHA))) })
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Body))

/** `/api/repos/<owner>/<name>/pulls/<number>/review` as its parts, or `undefined` for any other path. */
export const parseReviewPath = (
  path: string,
): { readonly owner: string; readonly name: string; readonly number: number } | undefined => {
  if (!path.startsWith(`${REPOS_ROUTE}/`)) return undefined
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  if (segments.length !== 5 || segments[2] !== PULLS_SEGMENT || segments[4] !== REVIEW_SEGMENT) return undefined
  if (!/^[1-9][0-9]{0,9}$/.test(segments[3]!)) return undefined
  const number = Number(segments[3])
  if (number > 2_147_483_647) return undefined
  try {
    return { owner: decodeURIComponent(segments[0]!), name: decodeURIComponent(segments[1]!), number }
  } catch {
    return undefined
  }
}

/** What the route needs: the deployment's own repository, the App, who holds which role where, and where it acts. */
export interface Options<R> {
  readonly repository: Repository
  readonly app: Option.Option<GitHubApp>
  readonly roles: RepoRoles.RepoRoles<R>
  /** Whether the deployment acts on repository `id` (decision 0079 §4): worker/github/Api.ts `mayAct`. */
  readonly mayAct: (id: string) => boolean
}

const noStore = { "cache-control": "no-store" }

/** The pull request as its projection holds it. */
interface Pull {
  readonly head_sha: string
  readonly base_sha: string
  readonly head_ref: string
  readonly state: string
  readonly merged: boolean
}

/** The route's handler for `target`, over `database`; who asks comes from `Sessions`, where flows start from `FlowStarter`. */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, options: Options<R>) =>
(target: { readonly owner: string; readonly name: string; readonly number: number }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    const fields: Record<string, string | number> = { number: target.number }
    const refused = (status: number, code: ReviewRefusal, retryAfterSeconds?: number) => {
      fields.outcome = code
      return HttpServerResponse.jsonUnsafe({ code }, {
        status,
        headers: retryAfterSeconds === undefined ? noStore : { ...noStore, "retry-after": String(retryAfterSeconds) },
      })
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
      // Asking for a review is the person's own press: anyone acting for them is refused, and counted.
      if (yield* refusesPersonOnly(signed, "pull/review")) return refused(403, "person_only")
      if (!isRepository(target.owner, target.name)) return refused(404, "not_found")
      const repo = repositoryOf(`${target.owner}/${target.name}`)
      fields.repoId = repo.id
      if (!options.mayAct(repo.id)) return refused(404, "not_found")
      // On the deployment's own repository the session's role decides, checked before the App, as the writes route does.
      if (repo.id === options.repository.id && signed.role === null) return refused(403, "forbidden")
      if (Option.isNone(options.app)) return refused(503, "not_configured")
      const resolved = yield* options.roles.resolve(signed, repo).pipe(Effect.result)
      if (resolved._tag === "Failure") {
        const { code, retryAfterSeconds } = resolved.failure
        return refused(RepoRoles.REFUSALS[code], code, retryAfterSeconds)
      }
      // A Maintainer's or Admin's act on that repository (decision 0007 `repo:merge`'s tier): the review spends a model.
      const role = resolved.success.role
      if (role !== "maintainer" && role !== "admin") return refused(403, "forbidden")
      const text = yield* readBounded(request, MAX_REVIEW_BYTES).pipe(Effect.result)
      if (text._tag === "Failure") return refused(400, "invalid")
      const body = decodeBody(text.success === "" ? "{}" : text.success)
      if (Option.isNone(body)) return refused(400, "invalid")
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [pull] = yield* sql<Pull>`
          SELECT p.head_sha, p.base_sha, p.head_ref, i.state, p.merged
          FROM pulls p JOIN items i ON i.id = p.item_id
          WHERE p.repo_id = ${repo.id} AND p.number = ${target.number}`
        if (pull === undefined) return refused(404, "not_found")
        fields.sha = pull.head_sha
        if (pull.merged || pull.state !== "open") return refused(409, "closed")
        // Bound to the head the page showed: a newer head is a new review the person hasn't seen asked for.
        if (body.value.headSha !== undefined && body.value.headSha !== pull.head_sha) return refused(409, "head_moved")
        const id = yield* checkRunIdOf({ repoId: repo.id, sha: pull.head_sha }, REVIEW_CHECK)
        return yield* sql.withTransaction(Effect.gen(function* () {
          const [review] = yield* sql<{ readonly status: string }>`SELECT status FROM runs WHERE id = ${id}::uuid FOR UPDATE`
          const existing = () => {
            fields.outcome = "existing"
            return HttpServerResponse.jsonUnsafe({ sha: pull.head_sha, started: false }, { status: 202, headers: noStore })
          }
          if (review !== undefined && review.status !== "failed") return existing()
          const [running] = yield* sql`
            SELECT 1 FROM runs
            WHERE repo_id = ${repo.id} AND sha = ${pull.head_sha} AND flow LIKE 'checks/%' AND status = 'working'
            LIMIT 1`
          if (running !== undefined) return refused(409, "checks_running")
          // A head's one review run, claimed for this person: new, or a failed one asked again.
          const [claimed] = yield* sql<{ readonly claimed: string | number }>`
            INSERT INTO runs (id, flow, status, launched_by, repo_id, sha)
            VALUES (${id}::uuid, ${checkFlowOf(REVIEW_CHECK)}, 'working', ${signed.subject.id}, ${repo.id}, ${pull.head_sha})
            ON CONFLICT (id) DO UPDATE SET status = 'working', launched_by = EXCLUDED.launched_by, updated_at = now()
              WHERE runs.status = 'failed'
            RETURNING (extract(epoch FROM updated_at) * 1000)::bigint AS claimed`
          // Another press claimed the head between the read and the insert: its review is this one.
          if (claimed === undefined) return existing()
          const executionId = reviewExecutionId(repo.id, pull.head_sha, Number(claimed.claimed))
          yield* (yield* FlowStarter).start(ReviewRun, {
            executionId,
            payload: {
              repoId: repo.id,
              sha: pull.head_sha,
              prNumber: target.number,
              baseSha: pull.base_sha,
              attemptId: executionId,
              branch: pull.head_ref,
              ownerId: signed.subject.id,
            },
          })
          fields.outcome = "started"
          return HttpServerResponse.jsonUnsafe({ sha: pull.head_sha, started: true }, { status: 202, headers: noStore })
        }))
      }).pipe(Effect.provide(database))
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          fields.errorCode = codeOf(Cause.squash(cause))
          return refused(503, "unavailable")
        })
      ),
    )
    const outcome = String(fields.outcome)
    yield* Metric.update(Metric.withAttributes(requests, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, "smithers.review.outcome": outcome })
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      "pull.review.request",
    ).pipe(
      Effect.annotateLogs({
        ...fields,
        outcome,
        status: response.status,
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      }),
    )
    return response
  }).pipe(Effect.withSpan("pull.review.request", { kind: "server" }))
