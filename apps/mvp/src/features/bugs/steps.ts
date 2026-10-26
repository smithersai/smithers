import { FlowRuntime, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Metric, Option } from "effect"
import { requesterOf } from "../../flows/requests"
import { BugsClient, type BugsNotTaken } from "./api"
import { UNANSWERED } from "./context"
import {
  type BugFailure,
  BugRefused,
  BugTabs,
  BugUnsent,
  ContextStep,
  ListBugs,
  ListStep,
  ReportBug,
  SendStep,
} from "./flows"
import { issueUrl } from "./github"
import type { ReportRequest } from "./schema"

// What bug reports' steps do (docs/features/bugs.md#the-flows), on this device's engine: ask the tab that asked
// what it shows, file the report with ChatApi, and read the latest reports. Each is a log line and a count with its
// outcome and counts, never what the person wrote, the page or an id of theirs.

/** Reports a tab sent, by `door` (`tab`, `agent`) and `outcome`: `filed`, `refused` or `unsent`. */
export const reports = Metric.counter("smithers_web_bug_reports", {
  description: "Bug reports sent to ChatApi, by door and outcome",
  incremental: true,
})

/** Contexts the report's step asked for, by `outcome`: `answered`, or `gone` when the tab that asked didn't answer. */
export const contexts = Metric.counter("smithers_web_bug_contexts", {
  description: "Bug report contexts asked of the tab that asked, by outcome",
  incremental: true,
})

/** Reads of the latest reports, by `outcome`: `read`, `refused` or `unsent`. */
export const lists = Metric.counter("smithers_web_bug_lists", {
  description: "Reads of the latest bug reports, by outcome",
  incremental: true,
})

/** What ChatApi's refusal means to a flow: a 4xx other than timeout or rate limiting is final; the rest retry. */
export const failureOf = (refused: BugsNotTaken): BugFailure =>
  refused.status !== undefined && refused.status >= 400 && refused.status < 500 &&
    refused.status !== 408 && refused.status !== 429
    ? new BugRefused({ status: refused.status, ...(refused.code === undefined ? {} : { code: refused.code }) })
    : new BugUnsent()

const outcomeOf = (failure: BugFailure | undefined, done: string) =>
  failure === undefined ? done : failure._tag === "@smthrs/mvp/bugs/BugRefused" ? "refused" : "unsent"

/** The run's door: the agent's call belongs to the answer whose run made it; any other is a tab's own dispatch. */
const doorOf = (executionId: string) => (executionId === requesterOf(executionId) ? "tab" : "agent")

/**
 * `app/bug/report/context`: what the tab that started the run shows, asked over the bug channel; a tab that is gone
 * leaves the report with what the step knows (`UNANSWERED`), so it is filed anyway. Picks the report's id when the
 * door chose none. A `bug.context` line and a count, with how many ids it found.
 */
export const capture = (payload: { readonly what: string; readonly id?: string | undefined }) =>
  Effect.gen(function* () {
    const { executionId } = yield* FlowRuntime.FlowInstance
    const answered = yield* (yield* BugTabs).ask(requesterOf(executionId))
    const context = Option.getOrElse(answered, () => UNANSWERED)
    const outcome = Option.isSome(answered) ? "answered" : "gone"
    yield* Metric.update(Metric.withAttributes(contexts, { outcome }), 1)
    yield* Effect.logWithLevel(outcome === "gone" ? "Warn" : "Info")("bug.context").pipe(
      Effect.annotateLogs({
        outcome,
        door: doorOf(executionId),
        traces: context.traces.length,
        runs: context.runs.length,
        failures: context.failures.length,
      }),
    )
    return { id: payload.id ?? crypto.randomUUID(), what: payload.what, ...context } satisfies ReportRequest
  }).pipe(Effect.withSpan("bug.context"))

/**
 * `app/bug/report/send`: one `POST /api/bugs`, answered with the report's id and GitHub's prefilled form for it. A
 * `bug.report` line and a count by door and outcome, with ChatApi's status and code when it refused.
 */
export const send = (report: ReportRequest) =>
  Effect.gen(function* () {
    const { executionId } = yield* FlowRuntime.FlowInstance
    const answer = yield* Effect.result((yield* BugsClient).file(report))
    const failure = answer._tag === "Failure" ? failureOf(answer.failure) : undefined
    const outcome = outcomeOf(failure, "filed")
    const door = doorOf(executionId)
    yield* Metric.update(Metric.withAttributes(reports, { door, outcome }), 1)
    yield* Effect.logWithLevel(failure === undefined ? "Info" : "Warn")("bug.report").pipe(
      Effect.annotateLogs({
        outcome,
        door,
        ...(answer._tag === "Failure" && answer.failure.status !== undefined ? { status: answer.failure.status } : {}),
        ...(answer._tag === "Failure" && answer.failure.code !== undefined ? { code: answer.failure.code } : {}),
      }),
    )
    if (failure !== undefined) return yield* Effect.fail(failure)
    return { id: report.id, github: issueUrl(report) }
  }).pipe(Effect.withSpan("bug.report"))

/** `app/bug/list/read`: one `GET /api/bugs`. A `bug.list` line and a count by outcome, with how many reports came. */
export const list = (payload: { readonly limit?: number | undefined }) =>
  Effect.gen(function* () {
    const answer = yield* Effect.result((yield* BugsClient).list(payload.limit))
    const failure = answer._tag === "Failure" ? failureOf(answer.failure) : undefined
    const outcome = outcomeOf(failure, "read")
    yield* Metric.update(Metric.withAttributes(lists, { outcome }), 1)
    yield* Effect.logWithLevel(failure === undefined ? "Info" : "Warn")("bug.list").pipe(
      Effect.annotateLogs({
        outcome,
        ...(answer._tag === "Success" ? { count: answer.success.reports.length } : {}),
        ...(answer._tag === "Failure" && answer.failure.status !== undefined ? { status: answer.failure.status } : {}),
      }),
    )
    if (answer._tag === "Failure") return yield* Effect.fail(failureOf(answer.failure))
    return answer.success
  }).pipe(Effect.withSpan("bug.list"))

/** Registers `app/bug/report` and `app/bug/list` with their steps, asking through the host's `BugsClient` and `BugTabs`. */
export const registration = Layer.mergeAll(
  Interpreter.layerWithImplementations(ReportBug, Layer.merge(ContextStep.toLayer(capture), SendStep.toLayer(send))),
  Interpreter.layerWithImplementations(ListBugs, ListStep.toLayer(list)),
)

/** The flows, asking ChatApi on `origin`. Needs the host's `HttpClient` and `BugTabs`. */
export const registrationAt = (origin: string) => registration.pipe(Layer.provide(BugsClient.layer({ origin })))
