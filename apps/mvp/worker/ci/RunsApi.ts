import { EngineStore } from "@smthrs/flows"
import type { QuickJSVariant } from "@smthrs/harness"
import { GitHub } from "@smthrs/integrations"
import { Cause, Clock, Effect, Function, type Layer, Metric, Option, Predicate, type Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { manualExecutionId, MAX_INPUT_BYTES, type RunsRefusal } from "../../src/features/actions/contract.ts"
import { settled } from "../../src/features/runs/contract.ts"
import { type Actor, Sessions } from "../Actor.vibe"
import { readBounded } from "../Body.vibe"
import { codeOf } from "../ErrorCode.vibe"
import { FlowStarter } from "../Flows.vibe"
import { withToken } from "../github/Calls.vibe"
import { type GitHubApp, type Repository, repositoryOf } from "../github/Config.vibe"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as Tokens from "../github/Tokens.ts"
import * as RepoRuns from "../RepoRuns.ts"
import * as ShapeAccess from "../ShapeAccess.vibe"
import { stillAdmitted } from "../RunAuthority.ts"
import { mayRead } from "../stack/Access.vibe"
import * as Realm from "./Realm.ts"
import * as RepoFlow from "./RepoFlow.vibe"
import * as Triggers from "./Triggers.vibe"

// Running a repository's flow by hand, and a run again (docs/features/actions.md#running-a-flow-by-hand,
// docs/features/actions.md#acts): three routes on a repository `REPO_FLOWS_REPOSITORIES` allows, for a Member or above
// on that repository (decision 0079), in person or through an agent acting for them (ruling FLOW-3).
//
//   GET  /api/repos/<owner>/<name>/flows                 the flows its default branch's manifest lets a person run
//   GET  /api/repos/<owner>/<name>/flows/<flow>?ref=<b>  that flow's inputs at the branch's head, as JSON Schema
//   POST /api/repos/<owner>/<name>/runs                  { id, flow, ref, input }: repo/Run at the branch's head, event
//                                                        "manual"; { id, retryOf, failed }: the run's flow again at its
//                                                        commit, all of it or only the jobs that didn't pass
//
// GitHub is read as the App (Contents: read); a flow's inputs are read in the QuickJS realm, never by the Worker. Each
// start is recorded as a repository run (worker/RepoRuns.ts) before it starts, under `<flow>:<id>`, so a request sent
// again starts nothing new. Records carry ids, names and outcomes, never an input's value.

/** Starts, by `kind` (`manual`, `retry`, `retry_failed`) and `outcome` (`started`, `existing`, or the refusal's code). */
export const starts = Metric.counter("smithers_repo_run_starts", {
  description: "Repository flow runs started by hand or again, by kind and outcome",
  incremental: true,
})

/** Flow reads (`flows`, `inputs`), by `outcome`. */
export const reads = Metric.counter("smithers_repo_flow_reads", {
  description: "A repository's flows and a flow's inputs read for a run by hand, by read and outcome",
  incremental: true,
})

/** A path of these routes, as its parts. */
export type Route =
  | { readonly kind: "flows"; readonly owner: string; readonly name: string }
  | { readonly kind: "inputs"; readonly owner: string; readonly name: string; readonly flow: string }
  | { readonly kind: "runs"; readonly owner: string; readonly name: string }

/** `path` as one of these routes, or `undefined`. */
export const parsePath = (path: string): Route | undefined => {
  if (!path.startsWith("/api/repos/")) return undefined
  const segments = path.slice("/api/repos/".length).split("/")
  try {
    const [owner, name, kind, flow] = segments.map(decodeURIComponent) as [string, string, string?, string?]
    if (owner === "" || name === "") return undefined
    if (segments.length === 3 && kind === "flows") return { kind: "flows", owner, name }
    if (segments.length === 4 && kind === "flows" && flow !== "") return { kind: "inputs", owner, name, flow: flow! }
    if (segments.length === 3 && kind === "runs") return { kind: "runs", owner, name }
    return undefined
  } catch {
    return undefined
  }
}

/** Whether ChatApi routes `path` here. */
export const handles = (path: string): boolean => parsePath(path) !== undefined

const Uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const InputValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
const StartBody = Schema.Struct({
  id: Uuid,
  flow: Schema.String.check(Schema.isPattern(RepoFlow.FLOW_NAME)),
  ref: Schema.String,
  input: Schema.optionalKey(Schema.Record(Schema.String, InputValue)),
})
const RetryBody = Schema.Struct({ id: Uuid, retryOf: Schema.String.check(Schema.isBetweenLength(1, 256)), failed: Schema.Boolean })
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Union([StartBody, RetryBody])))
const decodeRequest = Schema.decodeUnknownEffect(RepoFlow.RunRequest)
const decodeReported = Schema.decodeUnknownOption(Schema.fromJsonString(RepoFlow.Reported))
const DefaultBranch = Schema.Struct({ default_branch: Schema.String })

/** The App or GitHub couldn't answer: the route answers 503. */
class Unavailable extends Schema.TaggedError<Unavailable>()("@smthrs/mvp/ci/RunsUnavailable", {}) {}

/** Whether `input` is what the flow's form takes: its fields only, each of its type and choices, the required present. */
export const fits = (inputs: Realm.Inputs, input: Readonly<Record<string, Realm.InputValue>>): boolean =>
  Object.entries(input).every(([name, value]) => {
    const property = Object.hasOwn(inputs.properties, name) ? inputs.properties[name] : undefined
    if (property === undefined) return false
    const typed = property.type === "string"
      ? typeof value === "string"
      : property.type === "boolean"
      ? typeof value === "boolean"
      : property.type === "integer"
      ? Number.isInteger(value)
      : typeof value === "number" && Number.isFinite(value)
    return typed && (property.enum === undefined || property.enum.includes(value))
  }) && inputs.required.every((name) => Object.hasOwn(input, name))

/** `input` with each field it leaves out that the form gives a default: the body never sees a defaulted field missing. */
export const withDefaults = (
  inputs: Realm.Inputs,
  input: Readonly<Record<string, Realm.InputValue>>,
): Readonly<Record<string, Realm.InputValue>> => {
  const filled: Record<string, Realm.InputValue> = { ...input }
  for (const [name, property] of Object.entries(inputs.properties)) {
    if (!Object.hasOwn(filled, name) && property.default !== undefined) filled[name] = property.default
  }
  return filled
}

/** What the routes need beyond Postgres. */
export interface Options<R, EE, ER> {
  /** `REPO_FLOWS_REPOSITORIES`, as `owner/name` in lower case: only their flows run here. */
  readonly repositories: ReadonlySet<string>
  /** The GitHub App, which reads the repository; none switches the routes off. */
  readonly app: Option.Option<GitHubApp>
  /** Whether repository flows run here (`REPO_FLOWS`). */
  readonly repoFlows: boolean
  /** The asker's role on the route's repository (decision 0079). */
  readonly roles: RepoRoles.RepoRoles<R>
  /** A reader of the engine's schema, for a run Retry starts again. */
  readonly engine: Layer.Layer<SqlClient.SqlClient, EE, ER>
  /** The realm's QuickJS build. */
  readonly variant: Layer.Layer<QuickJSVariant.Variant, unknown>
  /** How the routes reach GitHub: `fetch` unless set. */
  readonly http?: HttpClient.HttpClient
}

const noStore = { "cache-control": "no-store" }

/**
 * Whether `actor` may run `repository`'s flows: a Member or above there, by `RepoRoles`; a refusal that says the
 * deployment can't act on it is `not_found`, GitHub asking to wait `rate_limited`, and GitHub or Postgres not answering
 * `unavailable`, never a guess.
 */
const admission = <R>(roles: RepoRoles.RepoRoles<R>, actor: Actor, repository: Repository) =>
  roles.resolve(actor, repository).pipe(
    Effect.map((resolved): RepoRoles.Resolved | RunsRefusal =>
      mayRead(Option.some({ ...actor, role: resolved.role })) ? resolved : "forbidden"
    ),
    Effect.catch((error) =>
      Effect.succeed<RunsRefusal>(
        RepoRoles.CANT_ACT.has(error.code) ? "not_found" : error.code === "rate_limited" ? "rate_limited" : "unavailable",
      )
    ),
  )

/** Authority changed while reading the body or GitHub: roll back the ownership row before answering. */
class AdmissionRefused extends Schema.TaggedError<AdmissionRefused>()("@smthrs/mvp/ci/RunAdmissionRefused", {
  code: Schema.Literals(["authentication", "forbidden"]),
}) {}

const statusOf: Readonly<Record<RunsRefusal, number>> = {
  invalid: 400,
  authentication: 401,
  forbidden: 403,
  not_found: 404,
  not_manual: 404,
  inputs: 422,
  nothing_failed: 409,
  not_settled: 409,
  conflict: 409,
  rate_limited: 429,
  off: 503,
  unavailable: 503,
}

/** The routes over `database`, the app's tables. `Sessions` and `FlowStarter` come from the request's context. */
export const make = <E, R, EE, ER>(database: Layer.Layer<SqlClient.SqlClient, E, R>, options: Options<R, EE, ER>) =>
  Effect.sync(() => {
    const inspection = EngineStore.RunInspection.layerWith({ flows: [RepoFlow.Run] })

    /** The routes for one repository, as the App reads it. */
    const on = (app: GitHubApp, repository: Repository) => {
      /** Runs `effect` against GitHub as the App, with read access to the repository's contents. */
      const asApp = <A, X>(effect: Effect.Effect<A, X, GitHub.GitHubClient.GitHubClient | HttpClient.HttpClient>) =>
        Effect.gen(function* () {
          // The signer is built for each request, never shared across them (worker/github/RepoRoles.ts).
          const auth = yield* GitHub.AppAuth.make({ appId: app.appId, privateKey: app.privateKey, apiBaseUrl: app.apiBaseUrl })
          const tokens = Tokens.make({ app: auth, keys: Option.none(), refresh: Function.constant(Effect.void) })
          const token: Redacted.Redacted<string> = yield* tokens.forInstallation(repository, "contents")
          return yield* effect.pipe(withToken(token, app.apiBaseUrl))
        }).pipe(
          options.http === undefined
            ? Effect.provide(FetchHttpClient.layer)
            : Effect.provideService(HttpClient.HttpClient, options.http),
          Effect.provide(database),
          Effect.mapError(() => new Unavailable()),
        )

      /** The repository's default branch, as GitHub says. */
      const defaultBranch = asApp(
        Effect.flatMap(GitHub.GitHubClient.GitHubClient, (client) =>
          client.request("GET", `/repos/${repository.owner}/${repository.name}`, undefined, { schema: DefaultBranch })),
      ).pipe(Effect.map((answer) => answer.default_branch))

      /** The flows the default branch's manifest lets a person run by hand: what a person merged, never a branch's say. */
      const manualFlows = Effect.flatMap(defaultBranch, (branch) =>
        asApp(
          GitHub.Contents.getText(repository.owner, repository.name, Triggers.MANIFEST_PATH, { ref: branch }).pipe(
            Effect.map(Option.match({
              onNone: () => [],
              onSome: (file) => Triggers.manualFlows(Triggers.triggersOf(file.text)),
            })),
          ),
        ).pipe(Effect.map((flows) => ({ flows, defaultBranch: branch }))))

      /**
       * Flow `flow` at branch `ref`'s head, or at commit `at` for a run recorded before: its commit and its inputs, or
       * why not.
       */
      const flowAt = (flow: string, ref: string, at: Option.Option<string> = Option.none()) =>
        Effect.gen(function* () {
          if (!(yield* manualFlows).flows.some((manual) => manual.name === flow)) {
            return { _tag: "refused", code: "not_manual" } as const
          }
          const head = Option.isSome(at)
            ? Option.some({ sha: at.value })
            : yield* asApp(GitHub.Refs.getBranch(repository.owner, repository.name, ref))
          if (Option.isNone(head)) return { _tag: "refused", code: "not_found" } as const
          const source = yield* asApp(
            GitHub.Contents.getText(repository.owner, repository.name, RepoFlow.flowPath(flow), { ref: head.value.sha }),
          )
          if (Option.isNone(source)) return { _tag: "refused", code: "not_found" } as const
          const described = yield* Realm.describe(flow, source.value.text).pipe(Effect.provide(options.variant))
          if (described._tag === "refused") return { _tag: "refused", code: "inputs" } as const
          return { _tag: "found", sha: head.value.sha, inputs: described.inputs } as const
        })

      return { manualFlows, flowAt }
    }

    /**
     * Records the run, then starts it on its own object: `started` when it is new, `existing` when the same request
     * came before, `conflict` when its id holds another run. A request sent again replays the run as first recorded,
     * at its commit, never the branch's head now.
     */
    const startRun = (repository: Repository, request: RepoFlow.RunRequest, actor: Actor, authority: RepoRoles.Resolved) =>
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.gen(function* () {
        const fresh = yield* RepoRuns.record({
          execution: request.run,
          repoId: repository.id,
          flow: request.flow,
          sha: request.sha,
          ref: request.ref,
          event: request.event,
          launchedBy: actor.subject.id,
        })
        // The ownership insert acquired the run's lock. Refusal must fail the transaction, leaving no row behind.
        const refusal = yield* stillAdmitted(actor, authority)
        if (refusal !== undefined) return yield* Effect.fail(new AdmissionRefused({ code: refusal }))
        // Not new: its row is there, with the commit it recorded.
        const sha = fresh
          ? request.sha
          : Option.getOrThrow(yield* RepoRuns.recordedSha(request.run))
        return yield* (yield* FlowStarter).start(RepoFlow.Run, { executionId: request.run, payload: { ...request, sha } }).pipe(
          Effect.as(fresh ? "started" as const : "existing" as const),
        )
      }))).pipe(
        // A conflicting intent or stale authority must roll ownership back before the refusal becomes a success value.
        Effect.catchTag("@smthrs/mvp/flows/StartConflict", () => Effect.succeed("conflict" as const)),
        Effect.catchTag("@smthrs/mvp/ci/RunAdmissionRefused", (refusal) => Effect.succeed(refusal.code)),
        Effect.provide(database),
      )

    /** A run Retry starts again: the run's own request, or why not. */
    const retried = (repository: Repository, retryOf: string, failed: boolean) =>
      Effect.gen(function* () {
        const admitted = yield* RepoRuns.admit(retryOf, options.engine).pipe(Effect.provide(database))
        if (Option.isNone(admitted) || admitted.value.execution !== retryOf || admitted.value.repoId !== repository.id) {
          return { _tag: "refused", code: "not_found" } as const
        }
        const engine = yield* EngineStore.RunInspection.RunInspection
        const read = yield* engine.inspect(retryOf, { limit: 1 }).pipe(Effect.option)
        const stored = yield* engine.payload(retryOf).pipe(Effect.option)
        if (Option.isNone(read) || Option.isNone(stored)) return { _tag: "refused", code: "not_settled" } as const
        // The projection alone cannot authorize copying a payload or its repository secrets setting.
        const owned = RepoRuns.repositoryIntent({ flow: stored.value.flowName, executionId: retryOf, payload: stored.value.payload })
        if (Option.isNone(owned) || owned.value.repoId !== repository.id) return { _tag: "refused", code: "not_found" } as const
        if (!settled(read.value.run.status)) return { _tag: "refused", code: "not_settled" } as const
        // A repository's run is a repo/Run: its payload is the run's request.
        const request = yield* decodeRequest(stored.value.payload)
        if (!failed) return { _tag: "found", request } as const
        const result = Option.flatMap(Option.fromNullishOr(read.value.run.result), (value) => decodeReported(value.text))
        const names = Option.match(result, {
          onNone: () => [],
          onSome: (reported) => reported.jobs.filter((job) => job.outcome !== "passed").map((job) => job.name),
        })
        if (names.length === 0) return { _tag: "refused", code: "nothing_failed" } as const
        return { _tag: "found", request: { ...request, only: names } } as const
      }).pipe(Effect.provide(inspection), Effect.provide(options.engine))

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      const route = parsePath(url.pathname)!
      const startedAt = yield* Clock.currentTimeMillis
      const fields: Record<string, string | number> = { route: route.kind }
      const refused = (code: RunsRefusal) => {
        fields.outcome = code
        const status = statusOf[code]
        return HttpServerResponse.jsonUnsafe({ code }, {
          status,
          headers: status === 503 ? { ...noStore, "retry-after": String(ShapeAccess.RETRY_AFTER_SECONDS) } : noStore,
        })
      }
      const answered = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status, headers: noStore })
      const response = yield* Effect.gen(function* () {
        const method = route.kind === "runs" ? "POST" : "GET"
        if (request.method !== method) {
          fields.outcome = "method"
          return HttpServerResponse.empty({ status: 405, headers: { allow: method } })
        }
        const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
        if (Option.isNone(actor)) return refused("unavailable")
        if (Option.isNone(actor.value)) return refused("authentication")
        fields.via = actor.value.value.act === undefined ? "person" : "agent"
        const full = `${route.owner}/${route.name}`.toLowerCase()
        // Only a repository repository flows run for: any other has no flows here.
        if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(full) || !options.repositories.has(full)) return refused("not_found")
        const repository = repositoryOf(full)
        fields.repoId = repository.id
        if (!options.repoFlows || Option.isNone(options.app)) return refused("off")
        // A Member or above on the repository, in person or through an agent acting for them: running a flow neither
        // approves nor merges.
        const admitted = yield* admission(options.roles, actor.value.value, repository).pipe(Effect.provide(database))
        if (typeof admitted === "string") return refused(admitted)
        const github = on(options.app.value, repository)

        if (route.kind === "flows") {
          const found = yield* github.manualFlows
          fields.outcome = "read"
          fields.flows = found.flows.length
          return answered(found)
        }

        if (route.kind === "inputs") {
          fields.flow = route.flow
          const ref = url.searchParams.get("ref") ?? ""
          if (!RepoFlow.FLOW_NAME.test(route.flow) || !GitHub.Refs.isBranch(ref)) return refused("invalid")
          const found = yield* github.flowAt(route.flow, ref)
          if (found._tag === "refused") return refused(found.code)
          fields.outcome = "read"
          return answered({ inputs: found.inputs, sha: found.sha })
        }

        const text = yield* readBounded(request, MAX_INPUT_BYTES * 2).pipe(Effect.option)
        const body = Option.flatMap(text, decodeBody)
        if (Option.isNone(body)) return refused("invalid")
        if ("retryOf" in body.value) {
          const { id, retryOf, failed } = body.value
          fields.kind = failed ? "retry_failed" : "retry"
          const found = yield* retried(repository, retryOf, failed)
          if (found._tag === "refused") return refused(found.code)
          const run = manualExecutionId(found.request.flow, id)
          const { only, ...again } = found.request
          const next: RepoFlow.RunRequest = { ...again, run, ...(failed && only !== undefined ? { only } : {}) }
          const started = yield* startRun(repository, next, actor.value.value, admitted)
          if (started !== "started" && started !== "existing") return refused(started)
          fields.outcome = started
          fields.runId = run
          return answered({ runId: run }, started === "started" ? 202 : 200)
        }
        const { id, flow, ref, input = {} } = body.value
        fields.kind = "manual"
        fields.flow = flow
        if (!GitHub.Refs.isBranch(ref) || new TextEncoder().encode(JSON.stringify(input)).length > MAX_INPUT_BYTES) {
          return refused("invalid")
        }
        const run = manualExecutionId(flow, id)
        // A request sent again reads the form at the commit its run recorded, so it replays the same run.
        const recorded = yield* RepoRuns.recordedSha(run).pipe(Effect.provide(database))
        const found = yield* github.flowAt(flow, ref, recorded)
        if (found._tag === "refused") return refused(found.code)
        if (!fits(found.inputs, input)) return refused("inputs")
        const started = yield* startRun(repository, {
          run,
          repo: full,
          flow,
          sha: found.sha,
          ref: `refs/heads/${ref}`,
          event: "manual",
          // A Member started it from the repository itself: its jobs may have the repository's secrets.
          secrets: true,
          input: withDefaults(found.inputs, input),
        }, actor.value.value, admitted)
        if (started !== "started" && started !== "existing") return refused(started)
        fields.outcome = started
        fields.runId = run
        return answered({ runId: run }, started === "started" ? 202 : 200)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause)
            if (!Predicate.isTagged(error, "@smthrs/mvp/ci/RunsUnavailable")) fields.errorCode = codeOf(error)
            return refused("unavailable")
          })
        ),
      )
      const outcome = String(fields.outcome)
      fields.status = response.status
      fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
      if (route.kind === "runs") {
        yield* Metric.update(Metric.withAttributes(starts, { kind: String(fields.kind ?? "unknown"), outcome }), 1)
      } else {
        yield* Metric.update(Metric.withAttributes(reads, { read: route.kind, outcome }), 1)
      }
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        route.kind === "runs" ? "repo.run.start" : "repo.flow.read",
      ).pipe(Effect.annotateLogs({ ...fields, outcome }))
      return response
    }).pipe(Effect.withSpan("repo.runs", { kind: "server" }))

    return { fetch }
  })
