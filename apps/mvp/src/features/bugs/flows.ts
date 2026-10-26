import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Context, type Duration, Effect, Layer, Option, Schema } from "effect"
import { asker } from "../../flows/askingTab"
import { bugContextChannel, CONTEXT_WITHIN } from "./contract"
import { Listed, ListPayload, ReportContext, ReportPayload, ReportRequest, Reported } from "./schema"

// Bug reports as flows (docs/features/bugs.md#the-flows). A person's `/bug`, the header's button and the agent
// run the same `app/bug/report`; an Admin and the agent read with `app/bug/list`.
//
//   app/bug/report { what, id? }
//     app/bug/report/context   asks the tab that asked what it shows (src/features/bugs/tab.ts), and picks the id
//     app/bug/report/send      POST /api/bugs; tried again while ChatApi can't be reached, for an hour
//   app/bug/list { limit? }
//     app/bug/list/read        GET /api/bugs
//
// Each runs on this device's engine. What each step does is steps.ts, which only an engine's host imports.

/** ChatApi refused the report or the read (`status`, a 4xx other than 408 or 429, with its `code`): final. */
export class BugRefused extends Schema.TaggedError<BugRefused>()("@smthrs/mvp/bugs/BugRefused", {
  status: Schema.Number,
  code: Schema.optional(Schema.String),
}) {}

/** ChatApi couldn't be reached, or failed: tried again. Its client's span has the HTTP status. */
export class BugUnsent extends Schema.TaggedError<BugUnsent>()("@smthrs/mvp/bugs/BugUnsent", {}) {}

/** What filing or reading can fail with. */
export const BugFailure = Schema.Union([BugRefused, BugUnsent])
export type BugFailure = typeof BugFailure.Type

/** 500 ms doubling to 30 s, for an hour: a report filed offline lands once the device is back. A refusal is final. */
export const SEND_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 30_000,
  expirationMs: 60 * 60 * 1000,
  nonRetryable: ["@smthrs/mvp/bugs/BugRefused"],
})

/** A read is asked again a few times, then fails: whoever asked reads again. */
export const READ_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 4_000,
  maxAttempts: 4,
  nonRetryable: ["@smthrs/mvp/bugs/BugRefused"],
})

/** The tabs of this browser as the report's step reaches them: only the tab that started a request answers for it. */
export class BugTabs extends Context.Service<
  BugTabs,
  {
    /** Asks the tab that started `requester` what it shows; none when no tab answered within the wait. */
    readonly ask: (requester: string) => Effect.Effect<Option.Option<ReportContext>>
  }
>()("@smthrs/mvp/bugs/BugTabs") {
  /** Over the bug channel of engine `name` (`TabChannel`), waiting `within` (`CONTEXT_WITHIN` unless set). */
  static readonly layerChannel = (options: { readonly name: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      BugTabs,
      Effect.gen(function* () {
        const ask = yield* asker<{ readonly kind: "context" }, typeof ReportContext>({
          channel: bugContextChannel(options.name),
          output: ReportContext,
          within: options.within ?? CONTEXT_WITHIN,
        })
        return BugTabs.of({
          ask: (requester) => ask(requester, { kind: "context" }).pipe(Effect.map(Option.map(({ output }) => output))),
        })
      }),
    )
}

/** The step: what the tab that asked shows, and the report's id. Journaled, so a run again files the same report. */
export const ContextStep = Action.make("app/bug/report/context", {
  payload: ReportPayload,
  success: ReportRequest,
})

/** The step: file the report with ChatApi. */
export const SendStep = Action.make("app/bug/report/send", {
  payload: ReportRequest.fields,
  success: Reported,
  error: BugFailure,
  retryPolicy: SEND_RETRY,
})

/** `app/bug/report`: tell the deployment's Admins what went wrong, with the ids that find it in our records. */
export const ReportBug = Flow.make("app/bug/report", {
  description: "Report a bug to the deployment's Admins: what happened, in the person's words. The report also " +
    "carries the page the person's tab showed, the build, and that tab's latest run ids, trace ids and failure codes, " +
    "never a message, an answer or a credential. Run it only when the person asks to report a bug, with `what` in " +
    "their words. Answers { id, github }: github is GitHub's prefilled new-issue form for it, which files nothing " +
    "until the person submits it there; offer it, never open it unasked.",
  modelInvocable: true,
  payload: ReportPayload,
  success: Reported,
  error: BugFailure,
  body: Node.capture({ context: ContextStep.name, send: SendStep.name }, (payload) =>
    ContextStep.call(payload).pipe(
      Node.bindPlanned(Node.capture({ send: SendStep.name }, (report) => SendStep.call(report))),
    )),
}).annotate(Flow.Placement, Placement.client())

/** The step: read the latest reports from ChatApi. */
export const ListStep = Action.make("app/bug/list/read", {
  payload: ListPayload,
  success: Listed,
  error: BugFailure,
  retryPolicy: READ_RETRY,
})

/** `app/bug/list`: the latest bug reports, newest first. */
export const ListBugs = Flow.make("app/bug/list", {
  description: "Read the deployment's latest bug reports, newest first (limit, default 50, at most 200): each with " +
    "what happened, who reported it, the page, the build, and the run ids, trace ids and failure codes it carries. " +
    "Admins only.",
  modelInvocable: true,
  payload: ListPayload,
  success: Listed,
  error: BugFailure,
  body: Node.capture({ read: ListStep.name }, (payload) => ListStep.call(payload)),
}).annotate(Flow.Placement, Placement.client())
