import { AnswersUnavailable } from "../agent/answers"
import { SETTLE_RETRY } from "../agent/close"
import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Schema } from "effect"
import { ACT_REFUSALS, MAX_STEER_CHARS } from "./contract"

// The acts on runs and the run reads, as flows (decision 0014 §2, docs/features/runs.md#acts): a person's button on the
// run page and the agent's cell run the same declarations. Each is one step on this device's engine, which holds the
// runs it acts on:
//
//   run/cancel { runId, seq }     Stop: the engine records the cancellation and interrupts the run; with
//                                 host "cloud", a repository's run, which its Durable Object stops
//   run/retry { runId, version }  Retry: a new run of the same flow with the same payload, pinned or current
//   run/retry/from { runId, step } Retry from here: a new run that replays the steps before `step` and runs from it
//   run/resume { runId, seq }     Resume: the engine drives a run again that hasn't settled; a durable timer stays
//   run/list {}                   the newest runs
//   run/inspect { runId }         one run: its status, steps and result
//
// `seq` is the run's last journal sequence the page read: Resume on a run that moved since is refused `stale`, and Stop
// on a run that settled meanwhile answers its final status (`Control`'s terminal receipt) instead of refusing. What the
// steps do is injected by the host (./steps.ts), which reads the engine's own `RunInspection`.

/** An act on a run was refused, by why (contract.ts `ACT_REFUSALS`). */
export class RunActRefused extends Schema.TaggedError<RunActRefused>()("@smthrs/mvp/runs/RunActRefused", {
  code: Schema.Literals(ACT_REFUSALS),
}) {}

/** A run's id and the last journal sequence the page read of it. */
const Fenced = {
  runId: Schema.String.check(Schema.isBetweenLength(1, 1024)),
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
}

/** Where a run runs, when it isn't this device: `cloud`, a repository's run on Cloudflare (docs/features/actions.md). */
const Host = Schema.optionalKey(Schema.Literal("cloud"))

/** Stop's payload: the run, the last journal sequence the page read, and where it runs. */
const CancelPayload = { ...Fenced, host: Host }

/** The engine's statuses. */
export const RunStatus = Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled"])

/**
 * What Stop answers: the cancellation was recorded, or the run had settled, with its status on this device. Cloudflare
 * answers no status: the run's page reads it.
 */
export const Stopped = Schema.Struct({ outcome: Schema.Literals(["requested", "settled"]), status: Schema.optionalKey(RunStatus) })

/** Cancellation is recorded, but its engine cleanup has not produced a terminal receipt yet. */
export class CancelPending extends Schema.TaggedError<CancelPending>()("@smthrs/mvp/runs/CancelPending", {}) {}

const CancelError = Schema.Union([RunActRefused, CancelPending, AnswersUnavailable])

/** The step: record the cancellation. */
export const CancelRun = Action.make("run/cancel/request", {
  payload: CancelPayload,
  success: Stopped,
  error: CancelError,
  tier: "sealed",
  retryPolicy: RetryPolicy.make({ ...SETTLE_RETRY, nonRetryable: ["@smthrs/mvp/runs/RunActRefused"] }),
})

/** `run/cancel`: Stop a run on this device. */
export const Cancel = Flow.make("run/cancel", {
  description: "Stop a run on this device, or with host \"cloud\" a repository's run on Cloudflare. seq is the run's " +
    "last journal sequence you read. Answers whether the stop was recorded, or the run had already settled.",
  modelInvocable: true,
  payload: CancelPayload,
  success: Stopped,
  error: CancelError,
  body: Node.capture({ cancel: CancelRun.name }, (payload) => CancelRun.call(payload)),
}).annotate(Flow.Placement, Placement.client())

/** Which flow a retry runs: the revision the run pinned, or the current one. */
export const RetryVersion = Schema.Literals(["pinned", "current"])

/** The step: start the new run. */
export const RetryRun = Action.make("run/retry/start", {
  payload: { runId: Fenced.runId, version: RetryVersion },
  success: Schema.Struct({ runId: Schema.String }),
  error: RunActRefused,
  tier: "sealed",
})

/** `run/retry`: a settled run again, as a new run. */
export const Retry = Flow.make("run/retry", {
  description: "Run a settled run again as a new run, with the same input: version \"pinned\" runs the revision it " +
    "ran, \"current\" the latest. Answers with the new run's id.",
  modelInvocable: true,
  payload: { runId: Fenced.runId, version: RetryVersion },
  success: Schema.Struct({ runId: Schema.String }),
  error: RunActRefused,
  body: Node.capture({ retry: RetryRun.name }, ({ runId, version }) => RetryRun.call({ runId, version })),
}).annotate(Flow.Placement, Placement.client())

/** The step: start the new run, seeded from the run it retries. */
export const RetryFromRun = Action.make("run/retry/from/start", {
  payload: { runId: Fenced.runId, step: Schema.String.check(Schema.isBetweenLength(1, 1024)) },
  success: Schema.Struct({ runId: Schema.String }),
  error: RunActRefused,
  tier: "sealed",
})

/**
 * `run/retry/from`: Retry from here (ruling FLOW-11). A new run of the same flow with the same input, in which every
 * step that finished before `step` began replays its recorded result and `step` and every step after it run again. The
 * settled run is not changed: it is a retry, not a history fork.
 */
export const RetryFrom = Flow.make("run/retry/from", {
  description: "Run a settled run again as a new run from one of its steps: the steps before it replay what they " +
    "recorded, and it and every step after it run again. step is the step's nodeId as run/inspect lists it. Answers " +
    "with the new run's id.",
  modelInvocable: true,
  payload: { runId: Fenced.runId, step: Schema.String.check(Schema.isBetweenLength(1, 1024)) },
  success: Schema.Struct({ runId: Schema.String }),
  error: RunActRefused,
  body: Node.capture({ retry: RetryFromRun.name }, ({ runId, step }) => RetryFromRun.call({ runId, step })),
}).annotate(Flow.Placement, Placement.client())

/** The step: drive the run again. */
export const ResumeRun = Action.make("run/resume/drive", {
  payload: Fenced,
  success: Schema.Struct({ resumed: Schema.Boolean }),
  error: RunActRefused,
  tier: "sealed",
})

/** `run/resume`: drive a run again that hasn't settled and that nothing drives. */
export const Resume = Flow.make("run/resume", {
  description: "Drive a stuck run on this device again. seq is the run's last journal sequence you read; a run that " +
    "moved since is refused stale.",
  modelInvocable: true,
  payload: Fenced,
  success: Schema.Struct({ resumed: Schema.Boolean }),
  error: RunActRefused,
  body: Node.capture({ resume: ResumeRun.name }, ({ runId, seq }) => ResumeRun.call({ runId, seq })),
}).annotate(Flow.Placement, Placement.client())

/** One run as the agent reads the list. */
export const Listed = Schema.Struct({
  runId: Schema.String,
  flow: Schema.String,
  status: RunStatus,
  createdAtMs: Schema.Number,
  finishedAtMs: Schema.NullOr(Schema.Number),
  seq: Schema.Number,
})

/** The step: read the newest runs. */
export const ListRuns = Action.make("run/list/read", {
  payload: {},
  success: Schema.Struct({ runs: Schema.Array(Listed) }),
})

/** `run/list`: the newest runs on this device. */
export const List = Flow.make("run/list", {
  description: "List the newest runs on this device: each one's id, flow, status, times and last journal sequence.",
  modelInvocable: true,
  payload: {},
  success: Schema.Struct({ runs: Schema.Array(Listed) }),
  body: Node.capture({ list: ListRuns.name }, () => ListRuns.call({})),
}).annotate(Flow.Placement, Placement.client())

/** One run as the agent reads it: its status, its steps by action, and its result's text, redacted and cut. */
export const Inspected = Schema.Struct({
  runId: Schema.String,
  flow: Schema.String,
  status: RunStatus,
  seq: Schema.Number,
  steps: Schema.Array(Schema.Struct({ nodeId: Schema.String, action: Schema.NullOr(Schema.String), status: Schema.String })),
  result: Schema.NullOr(Schema.String),
})

/** The step: read one run. */
export const InspectRun = Action.make("run/inspect/read", {
  payload: { runId: Fenced.runId },
  success: Inspected,
  error: RunActRefused,
})

/** `run/inspect`: one run on this device. */
export const Inspect = Flow.make("run/inspect", {
  description: "Read one run on this device: its flow, status, steps and result.",
  modelInvocable: true,
  payload: { runId: Fenced.runId },
  success: Inspected,
  error: RunActRefused,
  body: Node.capture({ inspect: InspectRun.name }, ({ runId }) => InspectRun.call({ runId })),
}).annotate(Flow.Placement, Placement.client())

/**
 * Why a steer step didn't queue its message: the tab that asked couldn't keep it, or was gone, or the run that sent it
 * has no credential to send it with (it never goes in the person's session).
 */
export class SteerStepRefused extends Schema.TaggedError<SteerStepRefused>()("@smthrs/mvp/runs/SteerStepRefused", {
  reason: Schema.Literals(["not_kept", "tab_gone", "no_credential"]),
}) {}

/** A steer's payload: the TODO's run (`todo:<attempt id>`) and the message. */
const SteerPayload = {
  runId: Schema.String.check(Schema.isPattern(/^todo:[0-9a-f-]{36}$/)),
  body: Schema.String.check(Schema.isBetweenLength(1, MAX_STEER_CHARS)),
}

/** What a steer answers: its message's id, requested. The route's answer and the agent's reading follow on the page. */
export const SteerRequested = Schema.Struct({ steerId: Schema.String, status: Schema.Literal("requested") })

/** The step: put the message in the device's outbox. */
export const QueueSteer = Action.make("run/steer/queue", {
  payload: SteerPayload,
  success: SteerRequested,
  error: SteerStepRefused,
  tier: "sealed",
})

/** `run/steer`: a message to the agent working on a TODO, read at its next turn (ruling TODO-3). */
export const Steer = Flow.make("run/steer", {
  description: "Send a message to the agent working on a TODO, which reads it at its next turn. runId is the TODO's " +
    "run, todo:<attempt id>. Answers { steerId, status: \"requested\" }; the run's page shows when the agent read it.",
  modelInvocable: true,
  payload: SteerPayload,
  success: SteerRequested,
  error: SteerStepRefused,
  body: Node.capture({ steer: QueueSteer.name }, ({ runId, body }) => QueueSteer.call({ runId, body })),
}).annotate(Flow.Placement, Placement.client())
