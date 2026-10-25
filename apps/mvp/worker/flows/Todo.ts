import { AgentAction } from "@smthrs/agent"
import { digestSync, Uuid, WebCrypto } from "@smthrs/crypto"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { GitHub } from "@smthrs/integrations"
import { Node, type Planned } from "@smthrs/plan"
import { Cause, Config, Effect, Layer, Metric, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
import type { SqlClient } from "effect/sql"
import { agentAttribution } from "../../src/features/issues/contract.ts"
import { checkExecutionId, todoExecutionId } from "../../src/features/pulls/contract.ts"
import { TODO_FAILURES } from "../../src/features/todos/contract.ts"
import * as Change from "../branch/Change.ts"
import type { Machines } from "../branch/Machines.ts"
import { codeOf } from "../ErrorCode.ts"
import { agentFailureCodes } from "./TodoDiagnostic.ts"
import { classify, withToken } from "../github/Calls.ts"
import { repositoryOf } from "../github/Config.ts"
import { fetchPull, projectPull } from "../github/Pulls.ts"
import type { GitHubTokens } from "../github/Tokens.ts"
import * as Stack from "../stack/Stack.ts"
import { ChecksRun } from "./Checks.ts"
import { Implement } from "./TodoAgent.ts"
import { awaitPullClosed, readPullClosed } from "./TodoWait.ts"
import { machineOf } from "./TodoMachine.ts"

// The `todo` run (decision 0016, the factory simplified): one durable run per attempt, on Cloudflare, started by the
// stack's writer through `TodoRuns`. It takes one TODO to a merged pull request:
//
//   todo/Begin      the TODO and its prompt; its base, the head of the TODO in review before it (stacked), else of the
//                   default branch; its branch's name `smithers/t<n>-<slug>-<key>` reserved, nothing written to GitHub
//                   ─▶ writer: branch and its base, step implement
//   todo/Implement  the agent writes the change on the attempt's machine, checked out at the base, with the sandbox tools
//                   (worker/flows/TodoAgent.ts, worker/flows/TodoMachine.ts)
//   todo/Collect    the files it changed, read whole from the machine; none ─▶ failed empty_change
//   todo/Publish    the branch made on GitHub at the base, as the App, with the reserved name; one commit,
//                   `createCommitOnBranch` fenced by the base; the pull request into its base (a draft while that is
//                   another TODO's branch), its body ending "Fixes #n" for a TODO from issue n ─▶ writer: in review,
//                   which frees the lane for the next TODO; the head's checks start
//   todo/Await      parks until GitHub signals a merge or close; an hourly durable clock covers a lost delivery.
//                   Stacked, once the TODO below merges, it merges that merge in, its new head's checks start, and the
//                   pull request is marked ready and moves onto the default branch; once the TODO below closes unmerged,
//                   it closes its own and fails `base_closed`
//   todo/Settle     writer: merged, or dropped when it was closed; the next Queued TODO starts
//   todo/Fail       any step that gave up ─▶ writer: failed with the step's code; queued dependents hold. A TODO a person
//                   dropped (`ended`) closes the pull request its run opened, and changes nothing else
//
// Every writer call is fenced by the TODO and the attempt (`Stack.report`), so a dropped TODO's run stops at its next
// one. GitHub is written only at Publish, so an attempt that publishes nothing leaves nothing on GitHub (ruling GH-11).
// Every GitHub write goes through `Action.once` with a `GitHub.Once` adapter: it carries its key (the branch's name
// suffix, from the attempt, `branchKeyOf`, which Begin reserves; the commit's `Smithers-Write` trailer and the pull
// request's marker, the step's own), and a step that runs again after a lost answer or a crash finds its write by that
// key, never by a name, a message or a parent that only look alike (docs/proposals/durable-external-effects.md).
// Nothing here merges, approves or forces a ref: a person merges (decision 0012 decision 6). Records carry ids, numbers
// and outcomes, never a title, a prompt or a file.

/**
 * `TODO_RUNS`: whether this deployment runs TODOs: on unless set to `false`. Off, every TODO stays Queued, as before
 * Track B. The run needs the GitHub App too (worker/ChatApi.ts).
 */
export const enabled = Config.Boolean("TODO_RUNS").pipe(Config.withDefault(true))

/** The attempt a run is for: what the writer's `AttemptStart` says, so `TodoRuns.start` hands it over as it is. */
export const TodoRequest = Schema.Struct({
  attemptId: Schema.String.check(Schema.isUUID()),
  todoId: Schema.String.check(Schema.isUUID()),
  repoId: Schema.String,
  number: Schema.Int,
  ordinal: Schema.Int,
  revision: Schema.Int,
})
export type TodoRequest = typeof TodoRequest.Type

/** Why a run gave up: a TODO failure code, or `ended`: a person dropped the TODO, so the run just stops. */
export const STEP_FAILURES = [...TODO_FAILURES, "ended"] as const
export type StepFailure = (typeof STEP_FAILURES)[number]

/** A step gave up for good, with the TODO's failure code. Not retried. */
export class TodoFailed extends Schema.TaggedError<TodoFailed>()("@smthrs/mvp/todo/TodoFailed", {
  failure: Schema.Literals(STEP_FAILURES),
}) {}

/** The steps that call GitHub, the machine or Postgres, as a failure that outlived its retries names them. */
export const STEPS = ["begin", "collect", "publish", "await", "settle"] as const
export type Step = (typeof STEPS)[number]

/**
 * GitHub, the machine or Postgres couldn't answer step `step`: retried, after `retryAfterMillis` when GitHub said. One
 * that outlives its step's retries fails the run with the step's code (`failureOf`).
 */
export class TodoUnavailable extends Schema.TaggedError<TodoUnavailable>()("@smthrs/mvp/todo/TodoUnavailable", {
  step: Schema.Literals(STEPS),
  retryAfterMillis: Schema.optional(Schema.Number),
}) {}

/** An inspection found an open PR. The registered action catches it and parks on its terminal event. */
export class StillOpen extends Schema.TaggedError<StillOpen>()("@smthrs/mvp/todo/StillOpen", {}) {}

const StepError = Schema.Union([TodoFailed, TodoUnavailable])

/** A step's calls to GitHub and Postgres: 1 s doubling to a minute, for at most an hour. A refusal isn't retried. */
export const STEP_RETRY = RetryPolicy.make({
  initialMs: 1_000,
  factor: 2,
  maxMs: 60_000,
  expirationMs: 60 * 60_000,
  nonRetryable: ["@smthrs/mvp/todo/TodoFailed"],
})

/** Transport failures during merge inspection retain the existing retry policy for persisted plans. */
export const AWAIT_RETRY = RetryPolicy.make({
  initialMs: 5_000,
  factor: 2,
  maxMs: 60_000,
  nonRetryable: ["@smthrs/mvp/todo/TodoFailed"],
})

/**
 * What `todo/Begin` read and reserved: the TODO's text, its branch's name and its base, and who committed it. The
 * branch exists on GitHub only once `todo/Publish` makes it, at `baseSha`.
 */
export const Begun = Schema.Struct({
  branch: Schema.String,
  baseSha: Schema.String,
  /**
   * The branch its branch is made from and its pull request is into: the default branch, or the TODO below's. Absent
   * in a run begun before stacking, whose base is the default branch (`baseOf`).
   */
  baseRef: Schema.optional(Schema.String),
  defaultBranch: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  acceptance: Schema.Array(Schema.String),
  issueNumber: Schema.NullOr(Schema.Int),
  ownerId: Schema.String,
  ownerLogin: Schema.String,
})
export type Begun = typeof Begun.Type

/** The change, read whole from the machine: each changed file base64, and each deleted path. */
export const Collected = Schema.Struct({
  additions: Schema.Array(Schema.Struct({ path: Schema.String, contents: Schema.String })),
  deletions: Schema.Array(Schema.String),
})
export type Collected = typeof Collected.Type

/** The commit and the pull request `todo/Publish` made. */
export const Published = Schema.Struct({ headSha: Schema.String, prNumber: Schema.Int })
export type Published = typeof Published.Type

/** How the pull request ended: merged at `mergeSha`, closed unmerged, or the TODO was dropped in Smithers (`ended`). */
export const Awaited = Schema.Struct({
  state: Schema.Literals(["merged", "closed", "ended"]),
  mergeSha: Schema.NullOr(Schema.String),
})
export type Awaited = typeof Awaited.Type

/** How the run ended. */
export const Ran = Schema.Struct({ state: Schema.Literals(["merged", "dropped", "failed", "ended"]) })
export type Ran = typeof Ran.Type

/** The most files one TODO's commit changes. */
export const MAX_FILES = 50

/** The most bytes one TODO's commit adds. */
export const MAX_CHANGE_BYTES = 1024 * 1024

/**
 * A step whose GitHub writes all go through `Action.once` repeats safely, so it declares the attempt as its key: a
 * durable engine then re-runs an attempt that died mid-write instead of stopping it, and `once` finds the write.
 */
const byAttempt = ({ request }: { readonly request: TodoRequest }) => ({ attempt: request.attemptId })

/**
 * Begin's and Publish's implementation versions. v2 (2026-10-21) writes through `Action.once` and finds its writes by
 * key; a run parked on a v1 plan stops with `plan_changed` rather than resume under different recovery.
 *
 * Moving the branch's creation from Begin to Publish (2026-10-25, ruling GH-11) keeps v2 on purpose: a version bump
 * stops every run already in flight, those parked on a person's merge included, and nothing in their recovery changed.
 * A run Begin reserved for creates its branch in Publish, found by the attempt's key (`branchKeyOf`); a run begun
 * before the move already has its branch on GitHub, which Publish recognizes by its name not being the reserved one, and
 * commits onto as before.
 */
export const BEGIN_VERSION = "todo/begin/v2"
export const PUBLISH_VERSION = "todo/publish/v2"

export const Begin = Action.make("todo/Begin", {
  payload: { request: TodoRequest },
  success: Begun,
  error: StepError,
  implementationVersion: BEGIN_VERSION,
  tier: "irreversible",
  idempotencyKey: byAttempt,
  retryPolicy: STEP_RETRY,
})

export const Collect = Action.make("todo/Collect", {
  payload: { request: TodoRequest, begun: Begun },
  success: Collected,
  error: StepError,
  retryPolicy: STEP_RETRY,
})

export const Publish = Action.make("todo/Publish", {
  payload: { request: TodoRequest, begun: Begun, collected: Collected },
  success: Published,
  error: StepError,
  implementationVersion: PUBLISH_VERSION,
  tier: "irreversible",
  idempotencyKey: byAttempt,
  retryPolicy: STEP_RETRY,
})

export const Await = Action.make("todo/Await", {
  // `begun` is absent in a run that reached its await before stacking: never stacked, so nothing to restack.
  payload: { request: TodoRequest, begun: Schema.optional(Begun), published: Published },
  success: Awaited,
  error: Schema.Union([TodoFailed, TodoUnavailable, StillOpen]),
  retryPolicy: AWAIT_RETRY,
})

export const Settle = Action.make("todo/Settle", {
  payload: { request: TodoRequest, awaited: Awaited },
  success: Ran,
  error: TodoUnavailable,
  // Once the terminal report commits, admission must keep retrying its receipt rather than fall through to Fail.
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})

/** What `todo/Fail` reads: a step's own failure, or the agent's. */
const Failure = Schema.Union([TodoFailed, TodoUnavailable, StillOpen, AgentAction.AgentFailure])
type Failure = typeof Failure.Type

export const Fail = Action.make("todo/Fail", {
  payload: { request: TodoRequest, error: Failure },
  success: Ran,
  error: TodoUnavailable,
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})

/** The TODO failure code a run that gave up ends with: a step's own, its step's, or the agent's `implement`. */
export const failureOf = (error: Failure): StepFailure => {
  if (error instanceof TodoFailed) return error.failure
  if (error instanceof TodoUnavailable) {
    return error.step === "begin" || error.step === "publish" ? "publish_refused" : error.step === "collect"
      ? "implement"
      : "pr_refused"
  }
  return "implement"
}

/** `todo`: one attempt of one TODO, from its base to a person's merge. */
export const Todo = Flow.make("todo", {
  description: "Take one TODO to a merged pull request: reserve its branch at its base, have the agent write the " +
    "change on the attempt's machine, make the branch with one commit and open the pull request, start its checks, " +
    "then wait for a person to merge it.",
  capabilities: ["db:write:todos", "db:write:todo_attempts", "db:write:items", "db:write:pulls"],
  modelInvocable: false,
  payload: TodoRequest,
  success: Ran,
  error: TodoUnavailable,
  body: Node.capture(
    {
      begin: Begin.name,
      implement: Implement.name,
      collect: Collect.name,
      publish: Publish.name,
      await: Await.name,
      settle: Settle.name,
      fail: Fail.name,
    },
    (request) =>
      Begin.call({ request }).pipe(
        Node.bindPlanned(Node.capture({ implement: Implement.name }, (begun: Planned.Planned<Begun>) =>
          Implement.call({
            attemptId: request.attemptId,
            todoId: request.todoId,
            repoId: request.repoId,
            number: request.number,
            title: begun.title,
            prompt: begun.prompt,
            acceptance: begun.acceptance,
            branch: begun.branch,
          }).pipe(
            Node.andThen(Collect.call({ request, begun })),
            Node.bindPlanned(Node.capture({ publish: Publish.name }, (collected: Planned.Planned<Collected>) =>
              Publish.call({ request, begun, collected }))),
            Node.bindPlanned(Node.capture({ await: Await.name }, (published: Planned.Planned<Published>) =>
              Await.call({ request, begun, published }))),
            Node.bindPlanned(Node.capture({ settle: Settle.name }, (awaited: Planned.Planned<Awaited>) =>
              Settle.call({ request, awaited }))),
          ))),
        Node.catch({
          onFailure: Node.capture({ fail: Fail.name }, (error: Planned.Planned<Failure>) => Fail.call({ request, error })),
        }),
      ),
  ),
})

/** What the run needs from its host. */
export interface Services<E, R> {
  /** Postgres with the app's tables. */
  readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
  readonly tokens: GitHubTokens
  readonly http: HttpClient.HttpClient
  readonly apiBaseUrl: string
  /** The engine's durable cancellation request, including an execution not yet admitted. */
  readonly cancel?: (executionId: string) => Effect.Effect<void, unknown>
  /**
   * Starts a remote execution on its own host: the next TODO's run, a head's checks. The same start again changes
   * nothing. Admission failures reach the step's durable retry policy, which replays the writer's persisted receipt.
   */
  readonly start: (flow: Flow.Any, options: { readonly executionId: string; readonly payload: unknown }) => Effect.Effect<void, Stack.RunsUnavailable>
}

/** Admissions requested by TODO steps, by flow and outcome; ids are confined to logs and spans. */
export const admissions = Metric.counter("smithers_todo_admissions", {
  description: "Remote execution admissions requested by TODO steps, by flow and outcome",
  incremental: true,
})

/** The production admission adapter: a lost or refused acknowledgment fails the durable action for replay. */
export const admission = (
  start: (flow: Flow.Any, options: { readonly executionId: string; readonly payload: unknown }) => Effect.Effect<void, unknown>,
): Services<never, never>["start"] => (flow, options) => {
  const record = (outcome: "started" | "not_started", errorCode?: string) =>
    Effect.gen(function* () {
      yield* Metric.update(Metric.withAttributes(admissions, { flow: flow._tag, outcome }), 1)
      yield* Effect.logWithLevel(outcome === "started" ? "Info" : "Warn")("todo.start").pipe(
        Effect.annotateLogs({ flow: flow._tag, executionId: options.executionId, outcome, ...(errorCode === undefined ? {} : { errorCode }) }),
      )
    })
  return start(flow, options).pipe(
    Effect.tap(() => record("started")),
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.interrupt
      const failure = Cause.squash(cause)
      const errorCode = failure instanceof Stack.RunsUnavailable ? failure.errorCode : codeOf(failure)
      return record("not_started", errorCode).pipe(Effect.andThen(Effect.fail(new Stack.RunsUnavailable({ errorCode }))))
    }),
    Effect.withSpan("todo.start", { attributes: { "smithers.execution.id": options.executionId, "smithers.flow": flow._tag } }),
  )
}

/** The part of a TODO's branch name every attempt shares: `smithers/t<n>-`. */
export const branchPrefixOf = (number: number): string => `smithers/t${number}-`

/**
 * The key of attempt `attemptId`'s branch: 64 hex of SHA-256 over a version line and the attempt's id. `todo/Begin`
 * reserves the name it ends (`GitHub.Once.branchName`), and `todo/Publish` makes the branch with it and finds it again
 * by it, so both steps name one branch, and no other attempt's.
 */
export const branchKeyOf = (attemptId: string): string => digestSync(`smithers/todo-branch/v1\n${attemptId}`)

/**
 * A TODO's title as a branch name's label, at most 40 characters: accents come off their letters (NFKD, then the
 * combining marks go), and anything else not a letter or digit is a dash. A label is for people; the branch is found
 * by the key `GitHub.Once.branch` ends its name with.
 */
export const slugOf = (title: string): string =>
  title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40)
    .replace(/-+$/, "")

/** A commit's headline and body as the run writes them; `GitHub.Once.commitOnBranch` adds the step's trailer. */
export const commitMessageOf = (number: number, title: string, login: string) => ({
  headline: `T${number}: ${title}`.slice(0, 200),
  body: agentAttribution(login),
})

/** The branch a begun TODO's branch was made from and its pull request is into. */
export const baseOf = (begun: Begun): string => begun.baseRef ?? begun.defaultBranch

/**
 * The pull request's body: the prompt, then for a TODO from issue n "Fixes #n", or "Part of #n" while a TODO above it
 * in the stack comes from the same issue (`closes` false), so merging the bottom of a stack doesn't close the issue the
 * rest still work on; then whom the App acted for.
 */
export const pullBodyOf = (begun: Begun, closes = true): string =>
  [
    begun.prompt,
    ...(begun.issueNumber === null ? [] : [`${closes ? "Fixes" : "Part of"} #${begun.issueNumber}`]),
    agentAttribution(begun.ownerLogin),
  ].join("\n\n")

/** The namespace a step's own tool call's id is a version 5 UUID of `<attempt>:<step>:<name>` in. */
export const STEP_CALL_NAMESPACE = "c7a41d58-2e93-4f0b-86d5-1b9e3f7a0c24"

/** The steps over `services` and the host's `Machines`. */
export const steps = <E, R>(services: Services<E, R>) => {
  const attemptOf = (request: TodoRequest): Stack.RunAttempt => ({
    attemptId: request.attemptId,
    todoId: request.todoId,
    repoId: request.repoId,
    ordinal: request.ordinal,
  })
  const repositoryOfRequest = (request: TodoRequest) => repositoryOf(request.repoId.replace(/^github\//, ""))

  /** Starts the run of a TODO the writer started. */
  const startTodo = (start: Stack.AttemptStart) =>
    services.start(Todo, { executionId: todoExecutionId(start.attemptId), payload: start })

  /**
   * Starts the checks of head `headSha` of pull request `prNumber`: Smithers runs on the TODO's machine, recorded in
   * `runs` with the head (decision 0012 decision 12), the review reading the diff from `baseSha`. Once per head.
   */
  const startChecks = (request: TodoRequest, begun: Begun, prNumber: number, headSha: string, baseSha: string) =>
    services.start(ChecksRun, {
      executionId: checkExecutionId(request.repoId, headSha, "all"),
      payload: {
        repoId: request.repoId,
        sha: headSha,
        prNumber,
        baseSha,
        attemptId: request.attemptId,
        branch: begun.branch,
        ownerId: begun.ownerId,
      },
    })

  const assertBase = (request: TodoRequest, baseRef: string) => Effect.gen(function* () {
    if (yield* Stack.closedBase(request.repoId, baseRef)) return yield* new TodoFailed({ failure: "base_closed" })
  })

  /** Reports to the writer; a stale report (a dropped TODO, another attempt) ends the run. */
  // Postgres failing fails the step for its retry policy (`step`'s `failureIn`).
  // A stale attempt first starts again what its publish started: a run that stopped between its publish committing and
  // the next TODO's start being admitted, then saw its TODO dropped, would otherwise leave the next one Working forever.
  const report = (request: TodoRequest, event: Stack.RunEvent) =>
    Effect.gen(function* () {
      const reported = yield* Stack.report(attemptOf(request), event, { runs: true })
      if (reported.outcome === "base_closed") return yield* new TodoFailed({ failure: "base_closed" })
      if (reported.outcome === "stale") {
        yield* Effect.forEach(yield* Stack.publishedStarts(attemptOf(request)), startTodo, { discard: true })
        return yield* new TodoFailed({ failure: "ended" })
      }
      yield* Effect.forEach(reported.starts, startTodo, { discard: true })
    })

  /** A failure of step `step` as the run reads it: its own, GitHub's refusal as `refused`, anything else retried. */
  const failureIn = (step: Step, refused: StepFailure) => (error: unknown): TodoFailed | TodoUnavailable => {
    if (error instanceof TodoFailed || error instanceof TodoUnavailable) return error
    const classified = classify(error)
    if (classified.kind === "refused") return new TodoFailed({ failure: refused })
    return new TodoUnavailable(
      classified.kind === "retry" && classified.retryAfterMillis !== undefined
        ? { step, retryAfterMillis: classified.retryAfterMillis }
        : { step },
    )
  }

  /** An installation token for the request's repository; none is the run's failure, or a wait. */
  const tokenFor = (step: Step, request: TodoRequest, access: "publish" | "pulls") =>
    services.tokens.forInstallation(repositoryOfRequest(request), access).pipe(
      Effect.mapError((failure) =>
        failure.reason === "app_not_installed" || failure.reason === "not_allowed"
          ? new TodoFailed({ failure: "app_not_installed" })
          : new TodoUnavailable(
            failure.retryAfterMillis === undefined ? { step } : { step, retryAfterMillis: failure.retryAfterMillis },
          )
      ),
    )

  /**
   * Runs step `name` (`begin`, `collect` or `publish`) with GitHub's HTTP and Postgres, as a span and a log line with
   * ids and the outcome only. GitHub refusing what it didn't name otherwise is `publish_refused`.
   */
  const step = <A>(
    name: Extract<Step, "begin" | "collect" | "publish">,
    request: TodoRequest,
    effect: Effect.Effect<A, unknown, SqlClient.SqlClient | HttpClient.HttpClient | Machines>,
  ) =>
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, services.http),
      Effect.provide(services.database),
      Effect.mapError(failureIn(name, "publish_refused")),
      Effect.tap(() =>
        Effect.logInfo("todo.step").pipe(
          Effect.annotateLogs({ step: name, attemptId: request.attemptId, todoId: request.todoId, outcome: "done" }),
        )
      ),
      Effect.tapError((error) =>
        Effect.logWarning("todo.step").pipe(
          Effect.annotateLogs({
            step: name,
            attemptId: request.attemptId,
            todoId: request.todoId,
            outcome: error instanceof TodoFailed ? error.failure : "retry",
          }),
        )
      ),
      Effect.withSpan(`todo.${name}`, {
        attributes: { "smithers.todo.attempt": request.attemptId, "smithers.todo.number": request.number },
      }),
    )

  const begin = ({ request }: typeof Begin.payloadSchema.Type) =>
    step("begin", request, Effect.gen(function* () {
      const found = yield* Stack.attemptTodo(attemptOf(request))
      if (Option.isNone(found)) return yield* new TodoFailed({ failure: "ended" })
      const todo = found.value
      if (todo.attempt !== request.ordinal || (todo.state !== "working" && todo.state !== "in_review")) {
        return yield* new TodoFailed({ failure: "ended" })
      }
      const repository = repositoryOfRequest(request)
      // Begin writes nothing to GitHub, but takes the token Publish will: an App that can't publish fails here, before
      // the agent spends a turn.
      const token = yield* tokenFor("begin", request, "publish")
      // The branch's name, reserved: the TODO's number and title, then its key, from the attempt. `todo/Publish` makes
      // the branch under this name; until then it exists nowhere (ruling GH-11).
      const branch = GitHub.Once.branchName(branchPrefixOf(todo.number), slugOf(todo.title), branchKeyOf(request.attemptId))
      const made = yield* Effect.gen(function* () {
        const client = yield* GitHub.GitHubClient.GitHubClient
        const facts = yield* client.request(
          "GET",
          `/repos/${GitHub.Repository.repositoryPath(repository.owner, repository.name)}`,
          undefined,
          { schema: Schema.Struct({ default_branch: Schema.String }) },
        )
        const defaultBranch = facts.default_branch
        // Its base: the one a run of this step recorded already, else the nearest TODO in review before it, by its
        // branch's head on GitHub (stacked), else the default branch.
        const below = todo.baseRef !== null ? Option.none() : yield* Stack.belowOf(attemptOf(request))
        const belowHead = Option.isSome(below)
          ? yield* GitHub.Refs.getBranch(repository.owner, repository.name, below.value.branch)
          : Option.none()
        if (Option.isSome(below) && Option.isNone(belowHead)) return yield* new TodoFailed({ failure: "base_closed" })
        const baseRef = todo.baseRef ?? (Option.isSome(belowHead) ? belowHead.value.name : defaultBranch)
        yield* assertBase(request, baseRef)
        // The base's head: a TODO's branch gone is a closed base, never a fall back to the default branch.
        const head = yield* GitHub.Refs.getBranch(repository.owner, repository.name, baseRef)
        if (Option.isNone(head)) {
          return yield* new TodoFailed({ failure: baseRef === defaultBranch ? "publish_refused" : "base_closed" })
        }
        // A run of this step that reported its branch already keeps the base it reported, even after its base moved.
        const baseSha = todo.branch === branch && todo.baseSha !== null ? todo.baseSha : head.value.sha
        return { branch, baseSha, baseRef, defaultBranch }
      }).pipe(withToken(token, services.apiBaseUrl))
      yield* report(request, { kind: "branch", branch: made.branch, baseSha: made.baseSha, baseRef: made.baseRef })
      yield* report(request, { kind: "step", step: "implement" })
      return {
        ...made,
        title: todo.title,
        prompt: todo.prompt,
        acceptance: todo.acceptance,
        issueNumber: todo.issueNumber,
        ownerId: todo.createdBy,
        ownerLogin: todo.createdLogin,
      } satisfies Begun
    }))

  const collect = ({ request, begun }: typeof Collect.payloadSchema.Type) =>
    step("collect", request, Effect.gen(function* () {
      yield* assertBase(request, baseOf(begun))
      const machine = machineOf({
        attemptId: request.attemptId,
        repoId: request.repoId,
        checkout: begun.baseSha,
        ownerId: begun.ownerId,
      })
      // The working copy's change against the base, read as Publish reads a branch's (worker/branch/Change.ts).
      return yield* Change.collect({
        branch: machine.branch,
        ownerId: machine.ownerId,
        base: begun.baseSha,
        maxFiles: MAX_FILES,
        maxBytes: MAX_CHANGE_BYTES,
        callId: (name) =>
          Uuid.v5(STEP_CALL_NAMESPACE, `${request.attemptId}:collect:${name}`).pipe(Effect.provide(WebCrypto.layer), Effect.orDie),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "@smthrs/mvp/branch/ChangeRefused"
            ? new TodoFailed({ failure: error.reason === "empty" ? "empty_change" : "implement" })
            : new TodoUnavailable({ step: "collect" })
        ),
      )
    }))

  const publish = ({ request, begun, collected }: typeof Publish.payloadSchema.Type) =>
    step("publish", request, Effect.gen(function* () {
      yield* assertBase(request, baseOf(begun))
      yield* report(request, { kind: "step", step: "publish" })
      const repository = repositoryOfRequest(request)
      const token = yield* tokenFor("publish", request, "publish")
      const message = commitMessageOf(request.number, begun.title, begun.ownerLogin)
      const closes = begun.issueNumber === null || (yield* Stack.openAboveFromIssue(attemptOf(request))) === 0
      const published = yield* Effect.gen(function* () {
        // The branch, made once at the base under the name `todo/Begin` reserved, and found again only by the
        // attempt's key, even after its base moved. One the key finds under another name isn't the reserved one.
        // A run begun before Publish made branches has its branch from Begin already (BEGIN_VERSION).
        const reserved = GitHub.Once.branchName(branchPrefixOf(request.number), slugOf(begun.title), branchKeyOf(request.attemptId))
        if (begun.branch === reserved) {
          const made = yield* Action.once(
            "branch",
            GitHub.Once.branch(repository.owner, repository.name, {
              prefix: branchPrefixOf(request.number),
              label: slugOf(begun.title),
              at: Effect.succeed(begun.baseSha),
            }),
            { key: branchKeyOf(request.attemptId) },
          )
          if (made.name !== begun.branch) return yield* new TodoFailed({ failure: "publish_refused" })
        }
        // The commit, appended once at the base and found again only by this step's trailer. A head someone else
        // moved is refused (409, stale), never adopted because its parent and message look like ours.
        const headSha = yield* Action.once(
          "commit",
          GitHub.Once.commitOnBranch(repository.owner, repository.name, {
            branch: begun.branch,
            expectedHeadOid: begun.baseSha,
            headline: message.headline,
            body: message.body,
            additions: collected.additions,
            deletions: collected.deletions,
          }),
        )
        // A close arriving during commit must not advance to the next external write.
        yield* assertBase(request, baseOf(begun))
        // The pull request, found among the branch's by this step's marker, or opened once. Stacked on another TODO's
        // branch, it opens as a draft, so nobody merges it into that branch by mistake.
        const pull = yield* Action.once(
          "pull",
          GitHub.Once.pull(repository.owner, repository.name, {
            head: begun.branch,
            base: baseOf(begun),
            title: `T${request.number}: ${begun.title}`.slice(0, 256),
            body: pullBodyOf(begun, closes),
            draft: baseOf(begun) !== begun.defaultBranch,
          }),
        ).pipe(Effect.mapError(failureIn("publish", "pr_refused")))
        // Read it back into the projection, so every device sees it before the webhook rings.
        yield* projectPull(repository, pull.number, yield* fetchPull(repository, pull.number))
        return { headSha, prNumber: pull.number } satisfies Published
      }).pipe(withToken(token, services.apiBaseUrl))
      yield* report(request, {
        kind: "published",
        headSha: published.headSha,
        prNumber: published.prNumber,
        draft: baseOf(begun) !== begun.defaultBranch,
      })
      yield* startChecks(request, begun, published.prNumber, published.headSha, begun.baseSha)
      return published
    }))

  /**
   * The TODO below merged: its merge commit `mergeSha` merged into this TODO's branch (never a rebase), the new head
   * reported and its checks started, then the pull request moved onto the default branch, and only then marked ready,
   * so it is never a ready pull request into the old branch. A step that stops part way does it all again, each part a
   * no-op once done; one stopped between the move and the mark is finished by `ready`. A merge GitHub can't make (a
   * conflict) closes the pull request and fails the TODO `pr_refused`.
   */
  const restack = (
    request: TodoRequest,
    begun: Begun,
    pull: GitHub.Pulls.PullRequest,
    below: Stack.BaseTodo & { readonly mergeSha: string },
  ) =>
    Effect.gen(function* () {
      const repository = repositoryOfRequest(request)
      const token = yield* tokenFor("await", request, "publish")
      const merged = yield* GitHub.Commits.mergeInto(repository.owner, repository.name, {
        base: begun.branch,
        head: below.mergeSha,
        commitMessage: `Merge T${below.number} from ${begun.defaultBranch} into T${request.number}`,
      }).pipe(Effect.result, withToken(token, services.apiBaseUrl))
      if (merged._tag === "Failure") {
        if (classify(merged.failure).kind !== "refused") return yield* Effect.fail(merged.failure)
        yield* GitHub.Pulls.closePull(repository.owner, repository.name, pull.number).pipe(withToken(token, services.apiBaseUrl))
        return yield* new TodoFailed({ failure: "pr_refused" })
      }
      // Up to date: the head this step read already holds the merge, as after an answer that was lost.
      const headSha = merged.success.kind === "merged" ? merged.success.sha : pull.head.sha
      yield* report(request, { kind: "published", headSha, prNumber: pull.number, draft: pull.draft })
      yield* startChecks(request, begun, pull.number, headSha, below.mergeSha)
      yield* GitHub.Pulls.setBase(repository.owner, repository.name, pull.number, begun.defaultBranch).pipe(
        withToken(token, services.apiBaseUrl),
      )
      yield* ready(request, pull, headSha)
      yield* Effect.logInfo("todo.restack").pipe(
        Effect.annotateLogs({ attemptId: request.attemptId, todoId: request.todoId, below: below.number, prNumber: pull.number }),
      )
    })

  /**
   * A stacked pull request now into the default branch, at head `headSha`: out of draft unless a person took it out
   * already, and the writer told. The next await's read projects it.
   */
  const ready = (request: TodoRequest, pull: GitHub.Pulls.PullRequest, headSha: string) =>
    Effect.gen(function* () {
      if (pull.draft) {
        const repository = repositoryOfRequest(request)
        const token = yield* tokenFor("await", request, "publish")
        yield* GitHub.Pulls.markReady(repository.owner, repository.name, pull.node_id).pipe(withToken(token, services.apiBaseUrl))
      }
      yield* report(request, { kind: "published", headSha, prNumber: pull.number, draft: false })
    })

  /** Whether the TODO below won't merge: dropped, closed on GitHub, or failed, so nothing will merge or restack it. */
  const belowClosed = (below: Option.Option<Stack.BaseTodo>) =>
    Option.isSome(below) && (below.value.state === "dropped" || below.value.state === "failed")

  const await_ = ({ request, begun, published }: typeof Await.payloadSchema.Type, baseSignaled = false) =>
    Effect.gen(function* () {
      const repository = repositoryOfRequest(request)
      const found = yield* Stack.attemptTodo(attemptOf(request))
      const dropped = Option.match(found, {
        onNone: () => true,
        onSome: (todo) => todo.attempt !== request.ordinal || todo.state === "dropped",
      })
      const token = yield* tokenFor("await", request, dropped ? "publish" : "pulls")
      const read = yield* Effect.gen(function* () {
        // Dropped in Smithers while its pull request is open: the run closes what it opened, as the App.
        if (dropped) {
          yield* GitHub.Pulls.closePull(repository.owner, repository.name, published.prNumber)
          return { state: "ended", mergeSha: null } satisfies Awaited
        }
        const fetched = yield* fetchPull(repository, published.prNumber)
        yield* projectPull(repository, published.prNumber, fetched)
        if (fetched.kind === "gone") return { state: "closed", mergeSha: null } satisfies Awaited
        if (fetched.pull.merged) return { state: "merged", mergeSha: fetched.pull.merge_commit_sha } satisfies Awaited
        return fetched.pull
      }).pipe(withToken(token, services.apiBaseUrl))
      if (!("node_id" in read)) return read
      // A run from before stacking carries no `begun`: its pull request is into the default branch.
      const stacked = begun !== undefined && baseOf(begun) !== begun.defaultBranch
      if (stacked && read.base.ref !== begun.defaultBranch) {
        // Stacked on another TODO's branch. That TODO closed unmerged, or failed: this branch holds a change that
        // won't merge, so close this pull request too, and fail `base_closed`, whichever came first: a close whose
        // answer was lost still ends here, never as closed on GitHub.
        let below = yield* Stack.baseTodoOf(request.repoId, read.base.ref)
        // The hourly fallback must also recover a missed base webhook, without waiting for its TODO run to settle.
        if (Option.isSome(below) && below.value.state === "in_review" && below.value.prNumber !== null) {
          const base = yield* fetchPull(repository, below.value.prNumber).pipe(withToken(token, services.apiBaseUrl))
          yield* projectPull(repository, below.value.prNumber, base)
          below = Option.some({
            ...below.value,
            state: base.kind === "gone" ? "dropped" : base.pull.merged ? "merged"
              : base.pull.state === "closed" || baseSignaled ? "dropped" : below.value.state,
            mergeSha: base.kind === "found" ? base.pull.merge_commit_sha : null,
          })
        }
        if (belowClosed(below)) {
          if (read.state === "open") {
            const closing = yield* tokenFor("await", request, "publish")
            yield* GitHub.Pulls.closePull(repository.owner, repository.name, read.number).pipe(
              withToken(closing, services.apiBaseUrl),
            )
          }
          return yield* new TodoFailed({ failure: "base_closed" })
        }
        if (read.state === "closed") return { state: "closed", mergeSha: null } satisfies Awaited
        // That TODO merged: take its merge in and move onto the default branch.
        if (Option.isSome(below) && below.value.state === "merged" && below.value.mergeSha !== null) {
          yield* restack(request, begun, read, { ...below.value, mergeSha: below.value.mergeSha })
        }
        return yield* new StillOpen()
      }
      if (read.state === "closed") return { state: "closed", mergeSha: null } satisfies Awaited
      // Moved onto the default branch, but stopped before it was marked ready: finish that.
      if (stacked && read.draft) yield* ready(request, read, read.head.sha)
      return yield* new StillOpen()
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, services.http),
      Effect.provide(services.database),
      Effect.mapError((error) => (error instanceof StillOpen ? error : failureIn("await", "pr_refused")(error))),
      Effect.withSpan("todo.await", { attributes: { "smithers.todo.attempt": request.attemptId } }),
    )

  const settle = ({ request, awaited }: typeof Settle.payloadSchema.Type) =>
    Effect.gen(function* () {
      if (awaited.state === "ended") return { state: "ended" } satisfies Ran
      const state = awaited.state === "merged" ? "merged" : "dropped"
      const reported = yield* Stack.report(attemptOf(request), {
        kind: "finished",
        state,
        ...(awaited.state === "closed" ? { note: "closed_on_github" as const } : {}),
        ...(awaited.mergeSha === null ? {} : { mergeSha: awaited.mergeSha }),
      }, { runs: true })
      yield* Effect.forEach(reported.starts, startTodo, { discard: true })
      yield* Effect.logInfo("todo.settle").pipe(
        Effect.annotateLogs({ attemptId: request.attemptId, todoId: request.todoId, state, outcome: reported.outcome }),
      )
      return { state: reported.outcome === "stale" ? "ended" : state } satisfies Ran
    }).pipe(
      Effect.provide(services.database),
      Effect.mapError(() => new TodoUnavailable({ step: "settle" })),
      Effect.withSpan("todo.settle", { attributes: { "smithers.todo.attempt": request.attemptId } }),
    )

  const fail = ({ request, error }: typeof Fail.payloadSchema.Type) =>
    Effect.gen(function* () {
      const failure = failureOf(error)
      const { harnessCode, modelCode, budgetScope, causeCode } = agentFailureCodes(error)
      yield* Effect.logWarning("todo.fail").pipe(
        Effect.annotateLogs({ attemptId: request.attemptId, todoId: request.todoId, failure, errorCode: codeOf(error), harnessCode, modelCode, budgetScope, causeCode }),
      )
      if (failure === "ended") return { state: "ended" } satisfies Ran
      const reported = yield* Stack.report(attemptOf(request), { kind: "finished", state: "failed", failure }, {
        runs: true,
      })
      yield* Effect.forEach(reported.starts, startTodo, { discard: true })
      return { state: reported.outcome === "stale" ? "ended" : "failed" } satisfies Ran
    }).pipe(
      Effect.provide(services.database),
      Effect.mapError(() => new TodoUnavailable({ step: "settle" })),
      Effect.withSpan("todo.fail", { attributes: { "smithers.todo.attempt": request.attemptId } }),
    )

  // Inspection stays independently testable. The registered action parks, rather than recording StillOpen as
  // failed attempts. There are only two external facts to wait for: the base PR, then this PR.
  const awaitMerge = (payload: typeof Await.payloadSchema.Type) => {
    const own = () => awaitPullClosed(payload.published.prNumber).pipe(
      Effect.andThen(await_(payload)),
      // A verified close ends this attempt even if the PR was reopened before the host resumed.
      // The hourly fallback never completes this terminal deferred.
      Effect.catchTag("@smthrs/mvp/todo/StillOpen", () => Effect.succeed({ state: "closed", mergeSha: null } as Awaited)),
    )
    return await_(payload).pipe(Effect.catchTag("@smthrs/mvp/todo/StillOpen", () =>
      Effect.gen(function* () {
        const base = payload.begun?.baseRef
        const below = base !== undefined && base !== payload.begun?.defaultBranch
          ? yield* Stack.baseTodoOf(payload.request.repoId, base).pipe(
            Effect.provide(services.database), Effect.mapError(() => new TodoUnavailable({ step: "await" })),
          )
          : Option.none()
        if (Option.isSome(below)) {
          if (below.value.prNumber !== null) yield* readPullClosed(below.value.prNumber)
          const signaled = below.value.state === "in_review" && below.value.prNumber !== null
          if (signaled) yield* awaitPullClosed(below.value.prNumber!)
          return yield* await_(payload, signaled).pipe(Effect.catchTag("@smthrs/mvp/todo/StillOpen", own))
        }
        return yield* own()
      })))
  }

  return { begin, collect, publish, await: await_, awaitMerge, settle, fail }
}

/**
 * Registers `todo` with its steps over `services`, the host's `Machines`, and `implement`: `todo/Implement`'s
 * implementation (worker/flows/TodoAgent.ts `registration`).
 */
export const registration = <E, R, IE, IR>(
  services: Services<E, R>,
  implement: Layer.Layer<Layer.Success<typeof Implement.layer>, IE, IR>,
) => {
  const implementation = steps(services)
  return Interpreter.layerWithImplementations(
    Todo,
    Layer.mergeAll(
      Begin.toLayer(implementation.begin, { implementationVersion: BEGIN_VERSION }),
      Collect.toLayer(implementation.collect),
      Publish.toLayer(implementation.publish, { implementationVersion: PUBLISH_VERSION }),
      Await.toLayer(implementation.awaitMerge),
      Settle.toLayer(implementation.settle),
      Fail.toLayer(implementation.fail),
      implement,
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}
