import type { Flow } from "@smthrs/flow"
import { EngineStore } from "@smthrs/flows"
import { Cause, Clock, Effect, Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { CLOUD_RUNS_LIMIT } from "../src/features/runs/contract.ts"
import type { CloudRun, CloudTrigger } from "../src/features/runs/schema.ts"
import { type Actor, Sessions } from "./Actor.ts"
import { codeOf } from "./ErrorCode.ts"
import * as ShapeAccess from "./ShapeAccess.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { repositoryOf } from "./github/Config.ts"
import * as GitHubHost from "./github/Host.ts"
import * as Dispatch from "./ci/Dispatch.ts"
import * as Checks from "./flows/Checks.ts"
import * as DatabaseLoad from "./flows/DatabaseLoad.ts"
import * as RepoClone from "./flows/RepoClone.ts"
import * as SpendAlert from "./flows/SpendAlert.ts"
import { mayRead } from "./stack/Access.ts"

// The runs on Cloudflare a person may read, for the Runs page beside this device's own (docs/features/runs.md#runs-on-cloudflare,
// ruling FLOW-13: runs read like GitHub Actions). One read, `GET /api/cloud-runs?limit=<n>`, joins three indexes the app
// already keeps to the engine's own state of each run (`RunInspection.list` over the engine's schema):
//
//   TODO runs           todo_attempts + todo_requests   a Member of the deployment's repository, as the TODO itself
//   repositories' runs  runs (execution, ref, event)    a Member of that run's own repository (decision 0098)
//   system flows        the engine's runs, by flow      an Admin of the deployment: issue sync, webhooks, triage, ...
//
// A system flow is listed only when its declaration is here, so its run page renders every value through its own schema
// (`Schema.Redacted` as `<redacted>`). Conversations' flows (`chat/*`), sign-in's (`auth/*`), secrets', models' and
// sandboxes' are never listed: they belong to one person, or carry what no list should.
//
// Each read is a span, a log line `runs.cloud.list` and one count by outcome: counts and codes, never a run's values.

/** The deployment's own flows an Admin sees, each read through its declaration. */
export const SYSTEM_FLOWS: ReadonlyArray<Flow.Any> = [
  ...GitHubHost.flows,
  RepoClone.Clone,
  SpendAlert.SpendAlert,
  DatabaseLoad.DatabaseLoad,
  Checks.ChecksRun,
  Dispatch.Dispatch,
]

/** Their tags. */
export const SYSTEM_FLOW_TAGS: ReadonlyArray<string> = SYSTEM_FLOWS.map((flow) => flow._tag)

/** Reads of the Cloud runs list, by `outcome` (`read`, `partial`, or a refusal's code). */
export const lists = Metric.counter("smithers_cloud_run_lists", {
  description: "Reads of the runs on Cloudflare a person may read, by outcome",
  incremental: true,
})

/** The most repositories one read resolves a role on; older repositories' runs wait for the next read. */
export const MAX_REPOSITORIES = 8

const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CLOUD_RUNS_LIMIT }))
const decodeLimit = Schema.decodeUnknownOption(Schema.NumberFromString.pipe(Schema.decodeTo(Limit)))

const noStore = { "cache-control": "no-store" }

/** One TODO attempt as the list reads it. */
interface TodoRow {
  readonly id: string
  readonly ordinal: number
  readonly status: string
  readonly branch: string | null
  readonly repo_id: string
  readonly created_ms: string | number
  readonly by_login: string
}

/** One repository run as the list reads it. */
interface RepoRow {
  readonly execution: string
  readonly repo_id: string
  readonly flow: string
  readonly ref: string
  readonly event: "push" | "pull_request" | "manual"
  readonly launched_by: string
  readonly created_ms: string | number
}

/** `github/<owner>/<name>` as `owner/name`. */
const repoOf = (repoId: string): string => repoId.slice("github/".length)

/** The row a run gets before the engine begins it: what its index recorded, `pending`. */
const pending = (base: Omit<CloudRun, "status" | "cancelRequested" | "startedAtMs" | "finishedAtMs">): CloudRun => ({
  ...base,
  status: "pending",
  cancelRequested: false,
  startedAtMs: null,
  finishedAtMs: null,
})

/** A row with the engine's state of its run, when the engine holds it. */
const withState = (row: CloudRun, summary: EngineStore.RunInspection.RunSummary | undefined): CloudRun =>
  summary === undefined ? row : {
    ...row,
    status: summary.status,
    cancelRequested: summary.cancelRequestedAtMs !== null,
    createdAtMs: summary.createdAtMs,
    startedAtMs: summary.startedAtMs,
    finishedAtMs: summary.finishedAtMs,
  }

/**
 * The runs on Cloudflare `actor` may read, newest first, at most `limit`. A repository whose role can't be resolved
 * now leaves its runs out and marks the read `partial`; the list still answers.
 */
export const read = <E, R, EE, ER>(
  actor: Actor,
  limit: number,
  options: {
    readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
    readonly engine: Layer.Layer<SqlClient.SqlClient, EE, ER>
    readonly inspection: Layer.Layer<EngineStore.RunInspection.RunInspection, never, SqlClient.SqlClient>
    readonly roles: RepoRoles.RepoRoles<R>
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const member = mayRead(Option.some(actor))
    const todos = member
      ? yield* sql<TodoRow>`
        SELECT a.id::text AS id, a.ordinal, a.status, a.branch, a.repo_id, r.by_login,
          (extract(epoch FROM a.created_at) * 1000)::bigint AS created_ms
        FROM todo_attempts a JOIN todo_requests r ON r.todo_id = a.todo_id AND r.revision = a.revision
        ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit}`
      : []
    const repoRows = yield* sql<RepoRow>`
      SELECT execution, repo_id, flow, ref, event, launched_by,
        (extract(epoch FROM created_at) * 1000)::bigint AS created_ms
      FROM runs WHERE execution IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT ${limit}`
    // A role read on one repository says nothing of another's (decision 0098): each repository is resolved once.
    const readable = new Map<string, boolean>()
    let partial = false
    for (const repoId of [...new Set(repoRows.map((row) => row.repo_id))].slice(0, MAX_REPOSITORIES)) {
      const resolved = yield* options.roles.resolve(actor, repositoryOf(repoOf(repoId))).pipe(Effect.result)
      if (resolved._tag === "Failure") {
        const status = RepoRoles.REFUSALS[resolved.failure.code]
        if (status === 503 || resolved.failure.code === "rate_limited") partial = true
        readable.set(repoId, false)
      } else {
        readable.set(repoId, mayRead(Option.some({ ...actor, role: resolved.success.role })))
      }
    }
    if (new Set(repoRows.map((row) => row.repo_id)).size > MAX_REPOSITORIES) partial = true
    const repos = repoRows.filter((row) => readable.get(row.repo_id) === true)
    const indexed: ReadonlyArray<CloudRun> = [
      ...todos.map((row) =>
        pending({
          runId: `todo:${row.id}`,
          flow: "todo",
          kind: "todo",
          createdAtMs: Number(row.created_ms),
          trigger: row.ordinal === 1 ? "commit" : "retry",
          branch: row.branch,
          actor: row.by_login,
          repo: repoOf(row.repo_id),
        })
      ),
      ...repos.map((row) =>
        pending({
          runId: row.execution,
          flow: row.flow,
          kind: "repo",
          createdAtMs: Number(row.created_ms),
          trigger: row.event satisfies CloudTrigger,
          branch: row.ref,
          actor: row.launched_by,
          repo: repoOf(row.repo_id),
        })
      ),
    ]
    const reads = yield* EngineStore.RunInspection.RunInspection
    const known = indexed.length === 0
      ? []
      : (yield* reads.list({ runIds: indexed.map((row) => row.runId), roots: false, limit: indexed.length })).runs
    const states = new Map(known.map((summary) => [summary.runId, summary]))
    // A TODO's engine can complete after settling its TODO failed (docs/features/runs.md#the-run-page): its row reads
    // the work's result, failed, as its page's header does.
    const failedTodos = new Set(todos.filter((row) => row.status === "failed").map((row) => `todo:${row.id}`))
    const system = actor.role === "admin"
      ? (yield* reads.list({ flows: SYSTEM_FLOW_TAGS, limit })).runs.map((summary): CloudRun => ({
        runId: summary.runId,
        flow: summary.flowName,
        kind: "system",
        status: summary.status,
        cancelRequested: summary.cancelRequestedAtMs !== null,
        createdAtMs: summary.createdAtMs,
        startedAtMs: summary.startedAtMs,
        finishedAtMs: summary.finishedAtMs,
        trigger: "system",
        branch: null,
        actor: null,
        repo: null,
      }))
      : []
    const runs = [
      ...indexed.map((row) => {
        const stated = withState(row, states.get(row.runId))
        return stated.status === "completed" && failedTodos.has(row.runId) ? { ...stated, status: "failed" as const } : stated
      }),
      ...system,
    ]
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .slice(0, limit)
    return { runs, partial, counts: { todo: todos.length, repo: repos.length, system: system.length } }
  }).pipe(
    Effect.provide(options.database),
    Effect.provide(Layer.provide(options.inspection, options.engine)),
  )

/** `GET /api/cloud-runs?limit=<n>`: the runs on Cloudflare the asker may read, newest first. */
export const route = <E, R, EE, ER>(options: Parameters<typeof read<E, R, EE, ER>>[2]) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    const fields: Record<string, string | number> = {}
    const refused = (status: number, code: string) => {
      fields.outcome = code
      return HttpServerResponse.jsonUnsafe({ code }, {
        status,
        headers: status === 503 ? { ...noStore, "retry-after": String(ShapeAccess.RETRY_AFTER_SECONDS) } : noStore,
      })
    }
    const response = yield* Effect.gen(function* () {
      if (request.method !== "GET") {
        fields.outcome = "method"
        return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
      }
      const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
      if (Option.isNone(actor)) return refused(503, "unavailable")
      if (Option.isNone(actor.value)) return refused(401, "authentication")
      const text = new URL(request.url, "http://localhost").searchParams.get("limit")
      const limit = text === null ? Option.some(CLOUD_RUNS_LIMIT) : decodeLimit(text)
      if (Option.isNone(limit)) return refused(400, "invalid")
      const listed = yield* read(actor.value.value, limit.value, options)
      fields.outcome = listed.partial ? "partial" : "read"
      fields.runs = listed.runs.length
      fields.todo = listed.counts.todo
      fields.repo = listed.counts.repo
      fields.system = listed.counts.system
      return HttpServerResponse.jsonUnsafe({ runs: listed.runs }, { headers: noStore })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          fields.errorCode = codeOf(Cause.squash(cause))
          return refused(503, "unavailable")
        })
      ),
    )
    const outcome = String(fields.outcome)
    fields.status = response.status
    fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
    yield* Metric.update(Metric.withAttributes(lists, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      "runs.cloud.list",
    ).pipe(Effect.annotateLogs({ ...fields, outcome }))
    return response
  }).pipe(Effect.withSpan("runs.cloud.list", { kind: "server" }))
