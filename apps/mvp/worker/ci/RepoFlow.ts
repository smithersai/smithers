import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { EngineStore } from "@smthrs/flows"
import type { QuickJSVariant } from "@smthrs/harness"
import { Core, GitHub } from "@smthrs/integrations"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Effect, Layer, Metric, Option, type Redacted, Schema } from "effect"
import { HttpClient } from "effect/http"
import type { SqlClient } from "effect/sql"
import { statusContextOf } from "../../src/features/pulls/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import { classify, withToken } from "../github/Calls.ts"
import { type Repository, repositoryOf } from "../github/Config.ts"
import type { GitHubTokens } from "../github/Tokens.ts"
import * as Realm from "./Realm.ts"

// A repository's own flow on Smithers (docs/features/ci.md#repository-flows): `.smithers/flows/<flow>/flow.ts` at the
// run's commit, planned in the QuickJS realm (worker/ci/Realm.ts), its jobs each a `ci/job` on its own machine
// (worker/flows/CiJobMachine.ts), its result a GitHub commit status `smithers/<flow>` on that commit (ruling GH-10).
//
//   repo/Run    repo/Plan     reads flow.ts at the commit as the App (Contents: read) and plans it in the realm
//               repo/Jobs     a child run: `smithers/<flow>` pending, the jobs as a `ci/graph` child (each job a
//                             `ci/job` once its needs passed, skipped if one didn't), then repo/Report: success when
//                             every job passed, else failure, as the App (Commit statuses)
//
// The Worker and the engine never evaluate the repository's code: the realm plans, the job machines run. A flow that
// can't be planned (no flow.ts at the commit, a syntax error, a refused import, a realm limit) runs no job and reports
// failure. Records carry ids, names and outcomes, never the source, a command or its output.

/** A repository flow's name: its directory under `.smithers/flows/`, and its status's context after `smithers/`. */
export const FLOW_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Where a repository flow's file lives. */
export const flowPath = (flow: string): string => `.smithers/flows/${flow}/flow.ts`

/**
 * Whether GitHub's answer to a file read means no retry will read it: a refusal, or a file it won't give as text (a
 * directory, over 1 MB, not UTF-8). Anything else is an outage, retried.
 */
export const isUnreadable = (error: unknown): boolean =>
  (Core.IntegrationError.isIntegrationError(error) && error.reason === "decode-failed") || classify(error).kind === "refused"

/** What one run of a repository flow is for. `run` is its execution id, `<flow>:<delivery>`. */
export const RunRequest = Schema.Struct({
  run: CiJob.Target.fields.run,
  repo: CiJob.Target.fields.repo,
  flow: Schema.String.check(Schema.isPattern(FLOW_NAME)),
  sha: CiJob.Target.fields.sha,
  ref: CiJob.Target.fields.ref,
  /** What started it: a push, a pull request, or a person by hand (docs/features/actions.md#running-a-flow-by-hand). */
  event: Schema.Literals(["push", "pull_request", "manual"]),
  /** Whether the run's jobs may have the repository's secrets: never for a fork's pull request. */
  secrets: Schema.Boolean,
  /** A run by hand's inputs, which the flow's body receives beside the run's own fields. */
  input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
  /** Only these of the flow's jobs, by name: Retry failed's (docs/features/actions.md#acts). */
  only: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type RunRequest = typeof RunRequest.Type

/**
 * A flow that couldn't be read at the commit: no `flow.ts` there, GitHub refused the read or answered no text, or GitHub
 * or Postgres didn't answer for the plan's 30 minutes of retries.
 */
export const Unread = Schema.Struct({
  _tag: Schema.Literal("refused"),
  reason: Schema.Literals(["not_found", "unreadable", "unavailable"]),
})

/** What `repo/Plan` settles: the realm's plan, or why there is none. */
export const PlanResult = Schema.Union([Realm.Planned, Realm.Refused, Unread])
export type PlanResult = typeof PlanResult.Type

/** GitHub or the realm couldn't answer: retried. */
export class RepoFlowUnavailable extends Schema.TaggedError<RepoFlowUnavailable>()(
  "@smthrs/mvp/ci/RepoFlowUnavailable",
  {},
) {}

/** 1 s doubling to a minute, for at most 30 minutes. */
export const RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

/** Reporting retries until GitHub takes it, never giving up: a status left pending would hold a required check. */
export const REPORT_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

export const Plan = Action.make("repo/Plan", {
  payload: { request: RunRequest },
  success: PlanResult,
  error: RepoFlowUnavailable,
  retryPolicy: RETRY,
})

export const Pending = Action.make("repo/Pending", {
  payload: { request: RunRequest },
  success: Schema.Void,
})

/** What `repo/Report` sent: the run's state, and whether GitHub took it. */
export const Reported = Schema.Struct({
  state: Schema.Literals(["success", "failure"]),
  outcome: Schema.Literals(["sent", "refused"]),
  jobs: Schema.Array(Schema.Struct({ name: Schema.String, outcome: CiJob.Outcome })),
})
export type Reported = typeof Reported.Type

export const Report = Action.make("repo/Report", {
  payload: {
    request: RunRequest,
    names: Schema.Array(Schema.String),
    results: Schema.Record(Schema.String, CiJob.Result),
    refused: Schema.NullOr(Schema.String),
  },
  success: Reported,
  error: RepoFlowUnavailable,
  retryPolicy: REPORT_RETRY,
})

/** The key each job's result has in `ci/graph`'s success: its position, since a job's name may hold a dot. */
export const jobKey = CiJob.key

/** The target a run's jobs run on: its own commit, repository and ref, never the flow's say. */
export const targetOf = (request: RunRequest): CiJob.Target => ({
  run: request.run,
  repo: request.repo,
  sha: request.sha,
  ref: request.ref,
})

/**
 * `repo/Jobs`: a planned flow's jobs as one `ci/graph`, then its status; a flow with no plan reports failure and runs
 * none. A job skipped because a need didn't pass hasn't passed.
 */
export const Jobs = Flow.make("repo/Jobs", {
  description: "Run a repository flow's planned jobs, each on its own machine, and report the flow's result on its " +
    "commit as the GitHub status smithers/<flow>.",
  modelInvocable: false,
  payload: { request: RunRequest, plan: PlanResult },
  success: Reported,
  error: RepoFlowUnavailable,
  body: Node.capture(
    { pending: Pending.name, graph: CiJob.Graph.name, report: Report.name },
    ({ plan, request }: { readonly request: RunRequest; readonly plan: PlanResult }) => {
      if (plan._tag === "refused") return Report.call({ request, names: [], results: {}, refused: plan.reason })
      const names = plan.jobs.map((job) => job.name)
      return Pending.call({ request }).pipe(
        Node.andThen(CiJob.Graph.child({ target: targetOf(request), jobs: plan.jobs })),
        Node.bindPlanned(Node.capture(
          { report: Report.name, request, names },
          function(this: { readonly request: RunRequest; readonly names: ReadonlyArray<string> }, results) {
            return Report.call({ request: this.request, names: this.names, results: results as never, refused: null })
          },
        )),
      )
    },
  ),
})

/** `repo/Run`: one run of a repository flow at a commit. */
export const Run = Flow.make("repo/Run", {
  description: "Run a repository's own flow, .smithers/flows/<flow>/flow.ts at a commit: plan it in the QuickJS " +
    "realm, run each job on its own machine, and report smithers/<flow> on the commit.",
  capabilities: ["sandbox:job"],
  modelInvocable: false,
  payload: RunRequest,
  success: Reported,
  error: RepoFlowUnavailable,
  body: Node.capture({ plan: Plan.name, jobs: Jobs.name }, (request: RunRequest) =>
    Plan.call({ request }).pipe(
      // A plan that never could be read still reports, so a required check never waits on a status that won't come.
      Node.catch({
        onFailure: Node.capture({}, () => Node.succeed({ _tag: "refused" as const, reason: "unavailable" as const })),
      }),
      Node.bindPlanned(Node.capture(
        { jobs: Jobs.name, request },
        function(this: { readonly request: RunRequest }, plan) {
          return Jobs.child({ request: this.request, plan })
        },
      )),
    )),
})

/** Repository flows planned, by `outcome`: `planned` or the refusal's reason. */
export const plans = Metric.counter("smithers_repo_flow_plans", {
  description: "Repository flows planned in the realm, by outcome",
  incremental: true,
})

/** Repository flows' commit statuses, by `state` and `outcome` (`sent`, `refused`, `dropped`). */
export const statuses = Metric.counter("smithers_repo_flow_statuses", {
  description: "GitHub commit statuses reporting repository flows, by state and outcome",
  incremental: true,
})

/** What a status says beside its context: the result in product words, at most GitHub's 140 characters. */
export const descriptionOf = (state: "pending" | "success" | "failure", failed: ReadonlyArray<string>, refused: string | null) =>
  (state === "pending"
    ? "Running"
    : state === "success"
    ? "Passed"
    : refused !== null
    ? `Couldn't run the flow (${refused})`
    : `Failed: ${failed.join(", ")}`).slice(0, 140)

/** What repository flows need: Postgres (where the App's installations are kept) and GitHub as the App. */
export interface Services<E, R> {
  readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
  readonly tokens: GitHubTokens
  readonly http: HttpClient.HttpClient
  readonly apiBaseUrl: string
  /** The job machines the deployment declared beside its default one (worker/branch/JobMachines.ts `declared`). */
  readonly machines: ReadonlyArray<string>
}

/** The steps over `services`; the realm's QuickJS build comes from the host. */
export const steps = <E, R>(services: Services<E, R>) => {
  const repositoryOfRequest = (request: RunRequest): Repository => repositoryOf(request.repo)

  const sendStatus = (
    request: RunRequest,
    token: Redacted.Redacted<string>,
    state: "pending" | "success" | "failure",
    description: string,
  ) => {
    const repository = repositoryOfRequest(request)
    return GitHub.Statuses.create(repository.owner, repository.name, request.sha, {
      state,
      context: statusContextOf(request.flow),
      description,
    }).pipe(withToken(token, services.apiBaseUrl), Effect.provideService(HttpClient.HttpClient, services.http))
  }

  const statusRecorded = (request: RunRequest, state: string, outcome: string, error?: unknown) =>
    Effect.andThen(
      Metric.update(Metric.withAttributes(statuses, { state, outcome }), 1),
      Effect.logInfo("ci.repo_flow.status").pipe(Effect.annotateLogs({
        run: request.run,
        repo: request.repo,
        flow: request.flow,
        sha: request.sha,
        state,
        outcome,
        ...(error === undefined ? {} : { errorCode: codeOf(error) }),
      })),
    )

  /** The App's token for `access`, or the refusal when the App can't have one (not installed, not granted); an outage fails, to be retried. */
  const tokenFor = (request: RunRequest, access: "contents" | "status") =>
    services.tokens.forInstallation(repositoryOfRequest(request), access).pipe(
      Effect.result,
      Effect.flatMap((token) =>
        token._tag === "Failure" && (token.failure.reason === "unavailable" || token.failure.reason === "refreshing")
          ? Effect.fail(new RepoFlowUnavailable())
          : Effect.succeed(token)
      ),
    )

  const plan = ({ request }: typeof Plan.payloadSchema.Type) =>
    Effect.gen(function* () {
      const repository = repositoryOfRequest(request)
      const token = yield* tokenFor(request, "contents")
      if (token._tag === "Failure") return { _tag: "refused", reason: "unreadable" } as const
      const file = yield* GitHub.Contents.getText(repository.owner, repository.name, flowPath(request.flow), { ref: request.sha })
        .pipe(
          withToken(token.success, services.apiBaseUrl),
          Effect.provideService(HttpClient.HttpClient, services.http),
          Effect.map(Option.match({ onNone: () => "not_found" as const, onSome: (found) => found.text })),
          Effect.catch((error) =>
            isUnreadable(error) ? Effect.succeed("unreadable" as const) : Effect.fail(new RepoFlowUnavailable())
          ),
        )
      if (file === "not_found" || file === "unreadable") return { _tag: "refused", reason: file } as const
      const planned = yield* Realm.plan(request.flow, file, {
        ...request.input,
        run: request.run,
        repo: request.repo,
        sha: request.sha,
        ref: request.ref,
        event: request.event,
      })
      // A job may name only a machine this deployment declared: anything else runs nothing (decision 0145).
      if (
        planned._tag === "planned" &&
        planned.jobs.some((job) => job.machine !== undefined && !services.machines.includes(job.machine))
      ) return { _tag: "refused", reason: "machine" } as const
      // Retry failed runs only the jobs that didn't pass: the same commit plans the same jobs. A need on a job it
      // doesn't run again passed before, so it is dropped.
      const only = request.only
      if (planned._tag !== "planned" || only === undefined) return planned
      const kept = planned.jobs.filter((job) => only.includes(job.name))
      return kept.length === 0 ? { _tag: "refused", reason: "invalid_plan" } as const : {
        ...planned,
        jobs: kept.map((job) =>
          job.needs === undefined ? job : { ...job, needs: job.needs.filter((need) => only.includes(need)) }
        ),
      }
    }).pipe(
      Effect.tap((planned) =>
        Effect.andThen(
          Metric.update(Metric.withAttributes(plans, { outcome: planned._tag === "planned" ? "planned" : planned.reason }), 1),
          Effect.logInfo("ci.repo_flow.plan").pipe(Effect.annotateLogs({
            run: request.run,
            repo: request.repo,
            flow: request.flow,
            sha: request.sha,
            outcome: planned._tag === "planned" ? "planned" : planned.reason,
            ...(planned._tag === "planned" ? { jobs: planned.jobs.length } : {}),
          })),
        )
      ),
      Effect.provide(services.database),
      Effect.mapError(() => new RepoFlowUnavailable()),
      Effect.withSpan("ci.repo_flow.plan", { attributes: { "smithers.ci.flow": request.flow } }),
    )

  /** `pending` as the jobs start, best effort: `repo/Report` sends the result durably. */
  const pending = ({ request }: typeof Pending.payloadSchema.Type) =>
    Effect.gen(function* () {
      const token = yield* services.tokens.forInstallation(repositoryOfRequest(request), "status")
      yield* sendStatus(request, token, "pending", descriptionOf("pending", [], null))
      yield* statusRecorded(request, "pending", "sent")
    }).pipe(
      Effect.provide(services.database),
      Effect.catch((error) => statusRecorded(request, "pending", "dropped", error)),
    )

  /**
   * The run's result as a commit status: success when every job passed, else failure. A refusal (no Commit statuses
   * permission, the App not installed, a commit GitHub doesn't have) is recorded and ends the report; an outage is retried.
   */
  const report = ({ names, refused, request, results }: typeof Report.payloadSchema.Type) =>
    Effect.gen(function* () {
      const jobs = names.map((name, index) => ({ name, outcome: results[jobKey(index)]!.outcome }))
      const failed = jobs.filter((job) => job.outcome !== "passed").map((job) => job.name)
      const state = refused === null && failed.length === 0 && jobs.length > 0 ? "success" as const : "failure" as const
      const description = descriptionOf(state, failed, refused)
      const token = yield* tokenFor(request, "status")
      if (token._tag === "Failure") {
        yield* statusRecorded(request, state, "refused", token.failure)
        return { state, outcome: "refused" as const, jobs } satisfies Reported
      }
      const outcome = yield* sendStatus(request, token.success, state, description).pipe(
        Effect.as("sent" as const),
        Effect.catch((error) =>
          classify(error).kind === "refused"
            ? Effect.as(statusRecorded(request, state, "refused", error), "refused" as const)
            : Effect.fail(new RepoFlowUnavailable())
        ),
      )
      if (outcome === "sent") yield* statusRecorded(request, state, "sent")
      return { state, outcome, jobs } satisfies Reported
    }).pipe(
      Effect.provide(services.database),
      Effect.mapError(() => new RepoFlowUnavailable()),
      Effect.withSpan("ci.repo_flow.report", { attributes: { "smithers.ci.flow": request.flow } }),
    )

  return { plan, pending, report }
}

/**
 * Registers `repo/Run` and its `repo/Jobs` child over `services` and the realm's QuickJS build (`variant`). `ci/graph`
 * and `ci/job` are registered beside them (worker/ExecutionHost.ts `withCiJobs`).
 */
export const registration = <E, R, VE, VR>(services: Services<E, R>, variant: Layer.Layer<QuickJSVariant.Variant, VE, VR>) => {
  const implementation = steps(services)
  return Layer.mergeAll(
    Interpreter.layer(Run),
    Interpreter.layer(Jobs),
    Plan.toLayer((payload) => implementation.plan(payload)),
    Pending.toLayer(implementation.pending),
    Report.toLayer(implementation.report),
  ).pipe(
    Layer.provide(variant),
    Layer.provideMerge(Action.layerImplementations),
  )
}

const decodeReported = Schema.decodeUnknownOption(Schema.fromJsonString(Reported))

/**
 * Whether run `execution` of a repository flow reported failure: a job that didn't pass, or a flow that couldn't run.
 * `repo/Run` never fails, so the engine says `completed` either way; its result says which.
 */
export const reportedFailure = <E, R>(execution: string, engine: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.flatMap(EngineStore.RunInspection.RunInspection, (reads) => reads.inspect(execution, { limit: 1 })).pipe(
    Effect.map((read) =>
      Option.exists(
        Option.flatMap(Option.fromNullishOr(read.run.result), (result) => decodeReported(result.text)),
        (reported) => reported.state === "failure",
      )
    ),
    Effect.provide(EngineStore.RunInspection.layerWith({ flows: [Run] })),
    Effect.provide(engine),
  )
