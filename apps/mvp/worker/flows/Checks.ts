import { Agent, AgentAction, Budget, QuotaPolicy, Seat as AgentSeat, SeatResolver } from "@smthrs/agent"
import { digestSync, Uuid, WebCrypto } from "@smthrs/crypto"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { GitHub } from "@smthrs/integrations"
import type { Sandbox, Steering } from "@smthrs/harness"
import { Evaluator } from "@smthrs/model"
import { CheckSuite } from "@smthrs/patterns"
import { Node, type Planned } from "@smthrs/plan"
import { Registry } from "@smthrs/registry"
import * as ReviewRounds from "@smthrs/review"
import type { SandboxTools } from "@smthrs/sandbox"
import { Effect, Layer, Metric, Option, type Redacted, Schema } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import {
  CHECK_NAME,
  CHECK_RUN_NAMESPACE,
  CHECKS_DIRECTORY,
  checkExecutionId,
  checkFlowOf,
  REVIEW_CHECK,
  SHA,
  statusContextOf,
} from "../../src/features/pulls/contract.ts"
import { COMMAND_LIMIT_SECONDS } from "../../src/features/sandbox/contract.ts"
import { Machines } from "../branch/Machines.ts"
import { codeOf } from "../ErrorCode.ts"
import { classify, withToken } from "../github/Calls.ts"
import { type Repository, repositoryOf } from "../github/Config.ts"
import { fetchPull, projectPull } from "../github/Pulls.ts"
import { type GitHubTokens, TokenUnavailable } from "../github/Tokens.ts"
import type { Seat } from "../ModelEndpoint.ts"
import type { SandboxBranch } from "../branch/Sandboxes.ts"
import * as SandboxCommand from "./SandboxCommand.ts"

// A pull request's checks (decision 0012 decision 12, decision 0016's factory simplified): Smithers runs on its head
// SHA, never GitHub check runs. `checks/Run` runs once per head (`check:<repo>:<sha>:all`), started when the `todo` run
// publishes. Each check is a row of `runs` with the head's SHA, which the pull request's Checks tab reads:
//
//   checks/Scripts  each `.smithers/checks/<name>.sh` of the head, run with sh at the head on the head's own throwaway job
//                   machine, one after another as a `CheckSuite` of discovered checks (`@smthrs/patterns`): `checks/<name>`, Passed when it exits 0, else Failed. Each script is a
//                   `sandbox/Command` job (worker/flows/SandboxCommand.ts), so a lint of the whole monorepo holds no
//                   step: the run parks while it runs, and a host that stops mid-script loses nothing. The job machine
//                   reaches the package registries and nothing else (worker/branch/RegistryEgress.ts), and sleeps once done
//   checks/Review   the `review` check: the review flow's rounds (`@smthrs/review`, .smithers/flows/review) read the
//                   first `MAX_REVIEW_FILES` changed files GitHub lists, one model call each on the owner's `review` role
//                   and one to verify the findings, as a child execution; the App posts one comment review with the
//                   `MAX_REVIEW_FINDINGS` most severe findings and the files it didn't read, never an approval; Failed
//                   when the review couldn't be made
//   checks/Report   after the scripts, and again after the review: each check of the head that ended, as a GitHub commit
//                   status `smithers/<name>` on that SHA (ruling GH-10), success or failure, as the App
//
// Each check also reports `pending` as it starts, best effort: a status that couldn't be sent is dropped and counted,
// because `checks/Report` sends the result from the runs, durably. Statuses are write-only: Smithers never reads one
// back, and a repository's branch protection, not Smithers, decides whether they gate the merge. Records carry ids,
// names and outcomes, never a command's output, a diff or a finding.

/** What one head's checks run for: the pull request's head and base, and the attempt whose machine runs them. */
export const ChecksRequest = Schema.Struct({
  repoId: Schema.String,
  sha: Schema.String,
  prNumber: Schema.Int,
  baseSha: Schema.String,
  attemptId: Schema.String,
  branch: Schema.String,
  ownerId: Schema.String,
})
export type ChecksRequest = typeof ChecksRequest.Type

/** How each check ended. */
export const Checked = Schema.Struct({
  checks: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.Literals(["done", "failed"]) })),
})
export type Checked = typeof Checked.Type

/** The machine, GitHub, the model or Postgres couldn't answer: retried. */
export class ChecksUnavailable extends Schema.TaggedError<ChecksUnavailable>()("@smthrs/mvp/checks/ChecksUnavailable", {}) {}

/** 1 s doubling to a minute, for at most 30 minutes. */
export const CHECKS_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

/** The most changed files one head's review reads (decision 0107): the rest are listed as not reviewed. */
export const MAX_REVIEW_FILES = 20

/** The most findings the review posts, the most severe first. */
export const MAX_REVIEW_FINDINGS = 10

/** The file reviews that run at once. */
export const REVIEW_CONCURRENCY = 4

/** The seat a head's review asks for: its owner's `review` role, `checks/review:<owner id>`. */
export const REVIEW_SEAT_PREFIX = "checks/review:"

/** The review seats' context window. */
export const REVIEW_CONTEXT_TOKENS = 200_000

/** What the review rounds read before their model steps: the head's files and why none were read. */
export const PreparedReview = Schema.Struct({
  rounds: ReviewRounds.ReviewFilesPayload,
  /** The changed files the rounds don't read: past `MAX_REVIEW_FILES`, or not source the review flow reads. */
  notReviewed: Schema.Array(Schema.String),
  /** Why GitHub's comparison couldn't be read (an error code), or null: the rounds then review nothing. */
  refusal: Schema.NullOr(Schema.String),
})
export type PreparedReview = typeof PreparedReview.Type

/** `checks/ReviewPrepare`: the review check's start and the change set its rounds read, from GitHub's comparison. */
export const ReviewPrepare = Action.make("checks/ReviewPrepare", {
  payload: { request: ChecksRequest },
  success: PreparedReview,
  error: ChecksUnavailable,
  retryPolicy: CHECKS_RETRY,
})

export const Scripts = Action.make("checks/Scripts", {
  payload: { request: ChecksRequest },
  success: Checked,
  error: ChecksUnavailable,
  retryPolicy: CHECKS_RETRY,
})

/** `checks/Review`: the rounds' result as one comment review on the head, and how the check ended. */
export const Review = Action.make("checks/Review", {
  payload: {
    request: ChecksRequest,
    notReviewed: PreparedReview.fields.notReviewed,
    refusal: PreparedReview.fields.refusal,
    result: Schema.NullOr(ReviewRounds.ReviewResult),
  },
  success: Checked,
  error: ChecksUnavailable,
  retryPolicy: CHECKS_RETRY,
})

/** Which checks a report follows: the scripts, or the review. */
export const ReportAfter = Schema.Literals(["scripts", "review"])

/** What `checks/Report` sent: each ended check's status, or why none was sent. */
export const Reported = Schema.Struct({
  statuses: Schema.Array(Schema.Struct({
    name: Schema.String,
    state: Schema.Literals(["success", "failure"]),
    outcome: Schema.Literals(["sent", "refused"]),
  })),
})
export type Reported = typeof Reported.Type

/**
 * Reporting retries until GitHub takes it, 1 s doubling to a minute, never giving up: a status left `pending` would
 * hold a required check forever. A refusal ends it.
 */
export const REPORT_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

export const Report = Action.make("checks/Report", {
  payload: { request: ChecksRequest, after: ReportAfter },
  success: Reported,
  error: ChecksUnavailable,
  retryPolicy: REPORT_RETRY,
})

/**
 * The review of `request`'s head: its change set from GitHub, the review flow's rounds over it as one child execution
 * (`ReviewFiles` handing off to `VerifyReview` and `NarrateReview`), then one comment review. Rounds that fail leave
 * the check Failed.
 */
const reviewOf = (request: ChecksRequest) =>
  ReviewPrepare.call({ request }).pipe(
    Node.bindPlanned(Node.capture({ request, rounds: ReviewRounds.ReviewFiles.name }, (prepared: Planned.Planned<PreparedReview>) =>
      ReviewRounds.ReviewFiles.child(prepared.rounds).pipe(
        Node.catch({ onFailure: Node.capture({ none: "none" }, () => Node.succeed(null)) }),
        Node.bindPlanned(Node.capture(
          { request, review: Review.name },
          (result: Planned.Planned<ReviewRounds.ReviewResult | null>) =>
            Review.call({ request, notReviewed: prepared.notReviewed, refusal: prepared.refusal, result }),
        )),
      ))),
  )

/** The flows the review check runs as its child execution, which a host registers beside `checks/Run`. */
export const reviewFlows = ReviewRounds.flows

/** `checks/Run`: a pull request head's checks, each a Smithers run on that commit, reported as a commit status. */
export const ChecksRun = Flow.make("checks/Run", {
  description: "Run a pull request head's checks as Smithers runs on its commit: each .smithers/checks script on the " +
    "branch's machine, and the review flow's rounds, whose findings the App posts as one comment review. Each check is reported " +
    "on the commit as the GitHub status smithers/<name>.",
  capabilities: ["db:write:runs", "db:write:reviews"],
  modelInvocable: false,
  payload: ChecksRequest,
  success: Reported,
  error: ChecksUnavailable,
  body: Node.capture({ scripts: Scripts.name, review: Review.name, report: Report.name }, (request) =>
    Scripts.call({ request }).pipe(
      Node.catch({ onFailure: Node.capture({ none: "none" }, () => Node.succeed({ checks: [] })) }),
      Node.andThen(Report.call({ request, after: "scripts" })),
      Node.catch({ onFailure: Node.capture({ none: "none" }, () => Node.succeed({ statuses: [] })) }),
      Node.andThen(reviewOf(request)),
      Node.catch({ onFailure: Node.capture({ none: "none" }, () => Node.succeed({ checks: [] })) }),
      Node.andThen(Report.call({ request, after: "review" })),
      Node.catch({ onFailure: Node.capture({ none: "none" }, () => Node.succeed({ statuses: [] })) }),
    )),
})

/**
 * `pull/Review`: the review a Maintainer asked for on a pull request's head (decision 0129), any pull request of a
 * repository the deployment acts on, not only one a TODO opened. The head's `checks/Review` for the person who asked,
 * then `checks/Report`, so the head's `smithers/review` status says how it ended. No scripts and no machine: the review
 * reads the diff from GitHub. `POST /api/repos/<owner>/<name>/pulls/<n>/review` starts it (worker/github/Review.ts).
 */
export const ReviewRun = Flow.make("pull/Review", {
  description: "Review a pull request's head on request: the review flow's rounds read the diff, the App posts their findings as one " +
    "comment review, and the head's smithers/review status says how it ended.",
  capabilities: ["db:write:runs", "db:write:reviews"],
  modelInvocable: false,
  payload: ChecksRequest,
  success: Reported,
  error: ChecksUnavailable,
  body: Node.capture({ review: Review.name, report: Report.name }, (request) =>
    reviewOf(request).pipe(
      Node.catch({ onFailure: Node.capture({ none: "none" }, () => Node.succeed({ checks: [] })) }),
      Node.andThen(Report.call({ request, after: "review" })),
      Node.catch({ onFailure: Node.capture({ none: "none" }, () => Node.succeed({ statuses: [] })) }),
    )),
})

/** Checks that ran, by `check` (`script` or `review`) and `outcome` (`done`, `failed`). */
export const checks = Metric.counter("smithers_checks", {
  description: "Pull request checks run as Smithers runs, by check kind and outcome",
  incremental: true,
})

/**
 * Commit statuses, by `state` (`pending`, `success`, `failure`) and `outcome`: `sent`; `refused` by GitHub or a token
 * the App can't have (no Commit statuses permission, the App not installed); `dropped`, a pending status that couldn't
 * be sent, which the report's result replaces.
 */
export const statuses = Metric.counter("smithers_check_statuses", {
  description: "GitHub commit statuses reporting Smithers checks, by state and outcome",
  incremental: true,
})

/** A check run's status as GitHub's: a check that passed is `success`, any other end `failure`. */
export const statusStateOf = (status: "done" | "failed"): "success" | "failure" =>
  status === "done" ? "success" : "failure"

/** What a commit status says beside its context, in the Checks tab's words. */
export const STATUS_DESCRIPTIONS = { pending: "Running", success: "Passed", failure: "Failed" } as const

/** What the checks need: Postgres, GitHub, and the judge model role. The host provides `Machines`. */
export interface Services<E, R> {
  readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
  readonly tokens: GitHubTokens
  readonly http: HttpClient.HttpClient
  readonly apiBaseUrl: string
  /**
   * The `review` role for the review of `ownerId`'s TODO: their own model's `hard` tier when they saved one, as their
   * TODO run's agent is; else the deployment's while hosted inference is on, else refused (decisions 0099 and 0107).
   */
  readonly reviewerFor: (ownerId: string) => Seat
  /**
   * The review agents' cell sandbox and steering: `Agent.layerDefaults` unless given; on Cloudflare the QuickJS build a
   * Worker bundles (worker/AgentSandbox.ts `defaults`).
   */
  readonly reviewAgent?: Layer.Layer<Sandbox.Sandbox | Steering.Source, unknown> | undefined
}

/**
 * The throwaway machine `request`'s head's checks run on: one per repository and head SHA, a check job (`kind: "job"`),
 * checking the head's branch out from GitHub, its tools running as the person who committed the TODO. Its box reaches
 * the package registry and nothing else; never the TODO's own machine, whose working copy the agent made.
 */
export const jobMachineOf = (request: ChecksRequest): { readonly branch: SandboxBranch; readonly ownerId: string } => {
  const [owner = "", name = ""] = request.repoId.replace(/^github\//, "").split("/")
  // Named by a digest of the repository and the SHA together, so no two repositories' jobs share a machine, however
  // their names split (`acme/tools-ui` and `acme-tools/ui`).
  const job = digestSync(JSON.stringify([request.repoId, request.sha])).slice(0, 40)
  return {
    branch: { branchId: `job-${job}`, owner, name, branch: request.branch, forge: "github", kind: "job" },
    ownerId: request.ownerId,
  }
}

/** The check a head gets when its job machine couldn't check out exactly that commit: Failed, never a script's pass. */
export const CHECKOUT_CHECK = "checkout"

/**
 * The checks Smithers itself runs on a head. A script named for one (`review.sh`, `checkout.sh`) never runs: its run row
 * and status would be the built-in check's, so its pass could hide a review or checkout that failed.
 */
export const BUILT_IN_CHECKS: ReadonlySet<string> = new Set([REVIEW_CHECK, CHECKOUT_CHECK])

/** Check `name`'s run id on `request`'s head: the version 5 UUID of its execution and name. */
export const checkRunIdOf = (request: Pick<ChecksRequest, "repoId" | "sha">, name: string) =>
  Uuid.v5(CHECK_RUN_NAMESPACE, `${checkExecutionId(request.repoId, request.sha, "all")}:${name}`).pipe(
    Effect.provide(WebCrypto.layer),
  )

/** Records check `name` running on the head, once: whether this call recorded it. */
const started = (request: ChecksRequest, id: string, name: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      INSERT INTO runs (id, flow, status, launched_by, repo_id, sha)
      VALUES (${id}::uuid, ${checkFlowOf(name)}, 'working', ${request.ownerId}, ${request.repoId}, ${request.sha})
      ON CONFLICT (id) DO NOTHING RETURNING id`).pipe(Effect.map((rows) => rows.length > 0))

/** Records how check `id` ended, once: whether this call recorded it. */
const ended = (id: string, status: "done" | "failed") =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE runs SET status = ${status}, updated_at = now() WHERE id = ${id}::uuid AND status = 'working' RETURNING id`)
    .pipe(Effect.map((rows) => rows.length > 0))

/** Severities, the most severe first. */
const SEVERITY_ORDER = ["critical", "major", "minor", "info"] as const

/** Text from the diff or a model as the App posts it: no mentions, no links. */
const inert = (text: string) => text.replace(/@(?=[A-Za-z0-9])/g, "@\u200b").replace(/https?:\/\/\S+/g, "(link removed)")

/**
 * The review's text as the App posts it: the `MAX_REVIEW_FINDINGS` most severe findings, each with its file and line,
 * the files the review didn't read, then whom it acted for.
 */
export const reviewBodyOf = (
  findings: ReadonlyArray<typeof ReviewRounds.ReviewComment.Type>,
  notReviewed: ReadonlyArray<string>,
  login: string,
): string => {
  const comments = [...findings].sort((left, right) =>
    SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity))
  const shown = comments.slice(0, MAX_REVIEW_FINDINGS).map((comment) =>
    `- **${comment.severity}** \`${comment.path}${comment.startLine > 0 ? `:${comment.startLine}` : ""}\`: ${inert(comment.content.trim().split("\n")[0] ?? "").slice(0, 500)}`)
  const listed = comments.length === 0
    ? "No findings."
    : [
      comments.length > MAX_REVIEW_FINDINGS
        ? `The ${MAX_REVIEW_FINDINGS} most severe of ${comments.length} findings:`
        : `${comments.length} finding${comments.length === 1 ? "" : "s"}, the most severe first:`,
      ...shown,
    ].join("\n")
  const skipped = notReviewed.length === 0 ? [] : [
    `Not reviewed (a review reads source files, at most ${MAX_REVIEW_FILES} of them): ${
      notReviewed.slice(0, MAX_REVIEW_FILES).map((path) => `\`${inert(path)}\``).join(", ")
    }${notReviewed.length > MAX_REVIEW_FILES ? ` and ${notReviewed.length - MAX_REVIEW_FILES} more` : ""}.`,
  ]
  return [listed, ...skipped, `Reviewed by Smithers for @${login} (review).`].join("\n\n").slice(0, 8000)
}

/**
 * The review rounds' seats: `checks/review:<owner id>` is that owner's `review` role (`reviewerFor`); any other seat is
 * unresolved.
 */
export const reviewSeats = (reviewerFor: (ownerId: string) => Seat) =>
  SeatResolver.layer({
    resolve: (id) => {
      if (!id.startsWith(REVIEW_SEAT_PREFIX)) {
        return Effect.fail(new AgentSeat.SeatUnresolved({ seat: id, message: "A head's review has one seat, checks/review:<owner>." }))
      }
      const seat = reviewerFor(id.slice(REVIEW_SEAT_PREFIX.length))
      return Effect.succeed(AgentSeat.make({
        id,
        modelId: REVIEW_CHECK,
        model: seat.model,
        route: seat.route,
        contextWindowTokens: REVIEW_CONTEXT_TOKENS,
      }))
    },
  })

/**
 * The steps over `services` and the host's `Machines`. Each check script runs for up to `commandSeconds`, the
 * deployment's longest command (`SANDBOX_COMMAND_MAX_SECONDS`, src/features/sandbox/config.ts `commandMaxSeconds`;
 * `COMMAND_LIMIT_SECONDS` unless given).
 */
export const steps = <E, R>(
  services: Services<E, R>,
  commandSeconds: number = COMMAND_LIMIT_SECONDS,
  stepWaitSeconds: number = COMMAND_LIMIT_SECONDS,
) => {
  const repositoryOfRequest = (request: ChecksRequest) => repositoryOf(request.repoId.replace(/^github\//, ""))

  /** Sends check `name`'s `state` on the head as the App, with a token that may write commit statuses only. */
  const sendStatus = (
    repository: Repository,
    request: ChecksRequest,
    token: Redacted.Redacted<string>,
    name: string,
    state: "pending" | "success" | "failure",
  ) =>
    GitHub.Statuses.create(repository.owner, repository.name, request.sha, {
      state,
      context: statusContextOf(name),
      description: STATUS_DESCRIPTIONS[state],
    }).pipe(withToken(token, services.apiBaseUrl), Effect.provideService(HttpClient.HttpClient, services.http))

  const statusRecorded = (request: ChecksRequest, name: string, state: string, outcome: string, error?: unknown) =>
    Effect.andThen(
      Metric.update(Metric.withAttributes(statuses, { state, outcome }), 1),
      Effect.logInfo("checks.status").pipe(Effect.annotateLogs({
        repoId: request.repoId,
        sha: request.sha,
        check: name,
        state,
        outcome,
        ...(error === undefined ? {} : { errorCode: codeOf(error) }),
      })),
    )

  /**
   * Reports check `name` running, best effort: a token or status that couldn't be had is dropped and counted, since
   * `checks/Report` sends the result durably once the check ends.
   */
  const pending = (request: ChecksRequest, name: string) =>
    Effect.gen(function* () {
      const repository = repositoryOfRequest(request)
      const token = yield* services.tokens.forInstallation(repository, "status")
      yield* sendStatus(repository, request, token, name, "pending")
      yield* statusRecorded(request, name, "pending", "sent")
    }).pipe(Effect.catch((error) => statusRecorded(request, name, "pending", "dropped", error)))

  const scripts = ({ request }: typeof Scripts.payloadSchema.Type) =>
    Effect.gen(function* () {
      const machines = yield* Machines
      const machine = jobMachineOf(request)
      // The machine generation the last tool ran on, which the checkout's success sets: the one put to sleep at the end.
      let generation = 0
      const tool = (name: string, call: SandboxTools.Call) =>
        Effect.gen(function* () {
          const callId = yield* Uuid.v5(CHECK_RUN_NAMESPACE, `${request.attemptId}:${request.sha}:${name}`).pipe(
            Effect.provide(WebCrypto.layer),
          )
          const ran = yield* machines.tool(machine.branch, machine.ownerId, callId, call)
          generation = ran.generation
          return ran.result
        })
      // The checkout at exactly the head: the machine fetches it from the forge. The branch passed git's ref rules and
      // the SHA is 40 hex digits, so neither can change the command. A checkout that isn't exactly the head runs no
      // script: the head gets a Failed `checkout` check, never a pass another commit earned. A machine that couldn't
      // start is tried again; a command the machine ran and failed isn't, since it runs once per call.
      const synced = !(GitHub.Refs.isBranch(request.branch) && SHA.test(request.sha)) ? "refused" as const : yield* tool("sync", {
        tool: "run",
        command: `git fetch --quiet origin '${request.branch}' && git reset --quiet --hard ${request.sha} && git clean -fdq`,
        timeoutSeconds: 120,
      }).pipe(
        // A tool answers its own call's result.
        Effect.map((result) => ((result as typeof SandboxTools.RunResult.Type).exitCode === 0 ? "synced" as const : "failed" as const)),
        Effect.catch((error) =>
          error._tag === "@smthrs/mvp/branch/SandboxUnavailable" ? Effect.fail(error) : Effect.succeed("failed" as const)
        ),
      )
      if (synced !== "synced") {
        yield* Effect.logWarning("checks.sync").pipe(Effect.annotateLogs({ repoId: request.repoId, sha: request.sha, outcome: synced }))
        const id = yield* checkRunIdOf(request, CHECKOUT_CHECK)
        yield* started(request, id, CHECKOUT_CHECK)
        yield* ended(id, "failed")
        yield* Metric.update(Metric.withAttributes(checks, { check: "script", outcome: "failed" }), 1)
        return { checks: [{ name: CHECKOUT_CHECK, status: "failed" as const }] } satisfies Checked
      }
      const listed = yield* tool("list", { tool: "list", path: CHECKS_DIRECTORY }).pipe(Effect.option)
      const found = Option.match(listed, {
        onNone: () => [],
        onSome: (result) =>
          (result as typeof SandboxTools.ListResult.Type).entries.filter((entry) => entry.kind === "file" && entry.name.endsWith(".sh"))
            .map((entry) => entry.name.slice(0, -3)).filter((name) => CHECK_NAME.test(name)).sort(),
      })
      const names = found.filter((name) => !BUILT_IN_CHECKS.has(name))
      for (const name of found.filter((name) => BUILT_IN_CHECKS.has(name))) {
        yield* Effect.logWarning("checks.reserved").pipe(Effect.annotateLogs({ repoId: request.repoId, sha: request.sha, check: name }))
      }
      // The scripts are a check suite of the checks this head turned out to have (`CheckSuite.runDiscovered`,
      // `@smthrs/patterns`), one at a time in name order. A script that fails is its check's answer, a failed row, so
      // the next still runs; a machine or Postgres that couldn't answer fails the suite, and this step for its retry
      // policy. A head with no scripts has none to fail.
      const verdict = yield* CheckSuite.runDiscovered({ checks: names, input: request }, {
        strategy: "all-pass",
        concurrency: 1,
        continueOnFail: false,
        onEmpty: "pass",
        check: ({ check: name }) =>
          Effect.gen(function* () {
            const id = yield* checkRunIdOf(request, name)
            // Each script runs as its own `sandbox/Command` (`SandboxCommand.run`): one that ends within the step's wait
            // answers here, and a longer one parks this step while its job runs, which then runs again from the top once
            // it ends: a check is announced, counted and logged only by the call that recorded its start or end.
            if (yield* started(request, id, name)) yield* pending(request, name)
            const callId = yield* Uuid.v5(CHECK_RUN_NAMESPACE, `${request.attemptId}:${request.sha}:check:${name}`).pipe(
              Effect.provide(WebCrypto.layer),
            )
            const script = { tool: "run" as const, command: `sh ${CHECKS_DIRECTORY}/${name}.sh`, timeoutSeconds: commandSeconds }
            const ran = yield* SandboxCommand.run(machines, machine, callId, script, SandboxCommand.stepWait(script, stepWaitSeconds))
              .pipe(Effect.option)
            const status = Option.match(ran, {
              onNone: () => "failed" as const,
              onSome: (run) => (run.exitCode === 0 && !run.timedOut ? "done" as const : "failed" as const),
            })
            if (yield* ended(id, status)) {
              yield* Metric.update(Metric.withAttributes(checks, { check: "script", outcome: status }), 1)
              yield* Effect.logInfo("checks.script").pipe(
                Effect.annotateLogs({ repoId: request.repoId, sha: request.sha, check: name, outcome: status }),
              )
            }
            return { passed: status === "done" }
          }),
      })
      const done = names.map((name) => ({ name, status: verdict.failed.includes(name) ? "failed" as const : "done" as const }))
      // Done with the job: its machine sleeps now rather than idling until its keep-alive gives up. Best effort.
      yield* machines.sleepIfIdle(machine.branch.branchId, generation, 0).pipe(Effect.ignore)
      return { checks: done } satisfies Checked
    }).pipe(
      Effect.provide(services.database),
      Effect.mapError(() => new ChecksUnavailable()),
      Effect.withSpan("checks.scripts", { attributes: { "smithers.checks.sha": request.sha } }),
    )

  /** Whether `error` is GitHub's refusal or a token the App can't have, which fails the check; else it's retried. */
  const refused = (error: unknown) =>
    error instanceof TokenUnavailable
      ? error.reason !== "unavailable" && error.reason !== "refreshing"
      : classify(error).kind === "refused"

  const prepare = ({ request }: typeof ReviewPrepare.payloadSchema.Type) =>
    Effect.gen(function* () {
      const id = yield* checkRunIdOf(request, REVIEW_CHECK)
      yield* started(request, id, REVIEW_CHECK)
      yield* pending(request, REVIEW_CHECK)
      const repository = repositoryOfRequest(request)
      const read = yield* Effect.gen(function* () {
        const token = yield* services.tokens.forInstallation(repository, "review")
        const compared = yield* GitHub.Commits.compare(repository.owner, repository.name, request.baseSha, request.sha)
          .pipe(withToken(token, services.apiBaseUrl))
        return { files: compared.files, refusal: null }
      }).pipe(
        Effect.catch((error) =>
          refused(error) ? Effect.succeed({ files: [], refusal: codeOf(error) }) : Effect.fail(new ChecksUnavailable())
        ),
      )
      // A refused comparison still runs the rounds, with nothing to review: they ask no model.
      const input = Schema.decodeUnknownSync(ReviewRounds.ReviewInput)({
        narrate: false,
        concurrency: REVIEW_CONCURRENCY,
        runReview: read.refusal === null,
        reviewSeat: `${REVIEW_SEAT_PREFIX}${request.ownerId}`,
        narrateSeat: `${REVIEW_SEAT_PREFIX}${request.ownerId}`,
      })
      const snapshot = ReviewRounds.comparisonSnapshot({
        input,
        repository: `${repository.owner}/${repository.name}`,
        base: request.baseSha,
        head: request.sha,
        files: read.files.slice(0, MAX_REVIEW_FILES),
        truncated: read.files.length >= GitHub.Commits.MAX_COMPARE_FILES,
      })
      const prepared = ReviewRounds.preparedReviewOf(snapshot)
      return {
        rounds: { input, prepared, offset: 0, outcomes: [] },
        // The files the rounds don't read: those of the first `MAX_REVIEW_FILES` that aren't source, and the rest.
        notReviewed: [
          ...prepared.changes.files.filter((file) => !file.reviewed).map((file) => file.path),
          ...read.files.slice(MAX_REVIEW_FILES).map((file) => file.filename),
        ],
        refusal: read.refusal,
      } satisfies PreparedReview
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, services.http),
      Effect.provide(services.database),
      Effect.mapError(() => new ChecksUnavailable()),
      Effect.withSpan("checks.review.prepare", { attributes: { "smithers.checks.sha": request.sha } }),
    )

  const review = ({ request, notReviewed, refusal, result }: typeof Review.payloadSchema.Type) =>
    Effect.gen(function* () {
      const failure: { stage?: string; errorCode?: string } = {}
      const id = yield* checkRunIdOf(request, REVIEW_CHECK)
      const repository = repositoryOfRequest(request)
      const fail = (stage: string, errorCode: string) => Effect.as(Effect.sync(() => Object.assign(failure, { stage, errorCode })), "failed" as const)
      const reviewed = refusal !== null
        ? yield* fail("github", refusal)
        : result === null
        ? yield* fail("rounds", "rounds_failed")
        : result.review.status === "failed"
        ? yield* fail("model", "review_failed")
        : yield* Effect.gen(function* () {
          const token = yield* services.tokens.forInstallation(repository, "review")
          const login = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql<{ readonly login: string }>`SELECT github_login AS login FROM people WHERE id::text = ${request.ownerId}`)
          return yield* Effect.gen(function* () {
            // One review, keyed by this run's check: a step run again after a lost answer finds it by that key.
            yield* Action.once(
              "review",
              GitHub.Once.review(repository.owner, repository.name, request.prNumber, {
                commitId: request.sha,
                event: "COMMENT",
                body: reviewBodyOf(result.review.comments, notReviewed, login[0]?.login ?? "unknown"),
              }),
              { key: id },
            )
            // Read the pull request back, so its page shows the review before the webhook rings.
            yield* projectPull(repository, request.prNumber, yield* fetchPull(repository, request.prNumber))
            return "done" as const
          }).pipe(withToken(token, services.apiBaseUrl))
        }).pipe(
          // GitHub's refusal, or a token the App can't have, fails the check; a lost answer or an outage is tried again,
          // and the next attempt finds the review it posted by its key.
          Effect.catch((error) => refused(error) ? fail("github", codeOf(error)) : Effect.fail(new ChecksUnavailable())),
        )
      yield* ended(id, reviewed)
      yield* Metric.update(Metric.withAttributes(checks, { check: "review", outcome: reviewed }), 1)
      yield* Effect.annotateCurrentSpan({
        "smithers.review.outcome": reviewed,
        ...(failure.errorCode === undefined ? {} : { "smithers.review.error_code": failure.errorCode }),
      })
      yield* Effect.logWithLevel(reviewed === "failed" ? "Warn" : "Info")("checks.review").pipe(
        Effect.annotateLogs({
          repoId: request.repoId,
          sha: request.sha,
          prNumber: request.prNumber,
          outcome: reviewed,
          findings: result?.review.comments.length ?? 0,
          notReviewed: notReviewed.length,
          ...failure,
        }),
      )
      return { checks: [{ name: REVIEW_CHECK, status: reviewed }] } satisfies Checked
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, services.http),
      Effect.provide(services.database),
      Effect.mapError(() => new ChecksUnavailable()),
      Effect.withSpan("checks.review", { attributes: { "smithers.checks.sha": request.sha } }),
    )

  /**
   * Sends each check of the head that ended, as its run in Postgres says, as a commit status, after failing any still
   * Running: the step that ran it finished or gave up. Reading the runs, not the step before, makes a report sent again
   * say the same thing. A refusal (no Commit statuses permission, the App not installed, a commit GitHub doesn't have)
   * is recorded and ends the report; an outage or a lost answer is retried until GitHub takes it.
   */
  const report = ({ request }: typeof Report.payloadSchema.Type) =>
    Effect.gen(function* () {
      // A report follows a step that finished or gave up, so a check of this head still Running never will: it failed.
      yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`
          UPDATE runs SET status = 'failed', updated_at = now()
          WHERE repo_id = ${request.repoId} AND sha = ${request.sha} AND flow LIKE 'checks/%' AND status = 'working'`)
      const ended = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly flow: string; readonly status: "done" | "failed" }>`
          SELECT flow, status FROM runs
          WHERE repo_id = ${request.repoId} AND sha = ${request.sha} AND flow LIKE 'checks/%'
            AND status IN ('done', 'failed')
          ORDER BY flow`)
      const ofHead = ended.map((run) => ({ name: run.flow.slice("checks/".length), state: statusStateOf(run.status) }))
        .filter((run) => CHECK_NAME.test(run.name))
      if (ofHead.length === 0) return { statuses: [] } satisfies Reported
      const repository = repositoryOfRequest(request)
      const refusedBy = (error: unknown) =>
        Effect.gen(function* () {
          for (const run of ofHead) yield* statusRecorded(request, run.name, run.state, "refused", error)
          return { statuses: ofHead.map((run) => ({ ...run, outcome: "refused" as const })) } satisfies Reported
        })
      const token = yield* services.tokens.forInstallation(repository, "status").pipe(Effect.result)
      if (token._tag === "Failure") {
        return yield* token.failure.reason === "unavailable" ? Effect.fail(new ChecksUnavailable()) : refusedBy(token.failure)
      }
      const sent: Array<Reported["statuses"][number]> = []
      for (const run of ofHead) {
        const outcome = yield* sendStatus(repository, request, token.success, run.name, run.state).pipe(
          Effect.as("sent" as const),
          Effect.catch((error) =>
            classify(error).kind === "refused"
              ? Effect.as(statusRecorded(request, run.name, run.state, "refused", error), "refused" as const)
              : Effect.fail(new ChecksUnavailable())
          ),
        )
        if (outcome === "sent") yield* statusRecorded(request, run.name, run.state, "sent")
        sent.push({ ...run, outcome })
      }
      return { statuses: sent } satisfies Reported
    }).pipe(
      Effect.provide(services.database),
      Effect.mapError(() => new ChecksUnavailable()),
      Effect.withSpan("checks.report", { attributes: { "smithers.checks.sha": request.sha } }),
    )

  return { scripts, prepare, review, report }
}

/** The review agents' cell limits: a file review answers in one cell. */
const REVIEW_HOST = { registry: Registry.makeNoop(), limits: { calls: 8 }, maxFrames: 4, capabilityEnvelope: [] }

/**
 * The review flow's rounds (`@smthrs/review`) over the owner's `review` role (`reviewerFor`), with no registry, no
 * tools and no budget of their own: the model endpoint admits and meters each call.
 */
export const reviewRounds = <E, R>(services: Services<E, R>) =>
  ReviewRounds.layer.pipe(
    Layer.provide(Layer.mergeAll(AgentAction.layerHost(REVIEW_HOST), reviewSeats(services.reviewerFor), Agent.layer)),
    Layer.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())),
    Layer.provide(Layer.mergeAll(services.reviewAgent ?? Agent.layerDefaults, Evaluator.layerUnavailable())),
  )

/**
 * Registers `checks/Run` and `pull/Review` with their steps over `services` and the host's `Machines`, and the review
 * flow's rounds they run, each check script running for up to `commandSeconds` (`COMMAND_LIMIT_SECONDS` unless given),
 * its step waiting on it for up to `stepWaitSeconds`.
 */
export const registration = <E, R>(
  services: Services<E, R>,
  commandSeconds: number = COMMAND_LIMIT_SECONDS,
  stepWaitSeconds: number = COMMAND_LIMIT_SECONDS,
) => {
  const implementation = steps(services, commandSeconds, stepWaitSeconds)
  const prepare = ReviewPrepare.toLayer(implementation.prepare)
  const review = Review.toLayer(implementation.review)
  const report = Report.toLayer(implementation.report)
  return Layer.mergeAll(
    Interpreter.layerWithImplementations(
      ChecksRun,
      Layer.mergeAll(Scripts.toLayer(implementation.scripts), prepare, review, report),
    ),
    Interpreter.layerWithImplementations(ReviewRun, Layer.mergeAll(prepare, review, report)),
    reviewRounds(services),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}
