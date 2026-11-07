import { Uuid } from "@smthrs/crypto"
import { FlowRuntime, Interpreter } from "@smthrs/flow"
import { Clock, Context, type Duration, Effect, Layer, Metric, Option } from "effect"
import { asker } from "../../flows/askingTab"
import { RunCredentials } from "../../flows/credentials"
import type { Door } from "../../flows/dispatch"
import { requesterOf } from "../../flows/requests"
import { issuesChannel, QUEUE_WITHIN, type TriageDecision, WRITE_ID_NAMESPACE } from "./contract"
import {
  IssueCommitment,
  QueueCommitment,
  IssueComment,
  IssueCreate,
  IssueTriage,
  IssueWriteRefused,
  QueueComment,
  QueueCreate,
  QueueEnable,
  QueuePause,
  QueueRun,
  QueueTriage,
  TriageEnable,
  TriagePause,
  TriageRunAgain,
  type WriteRequested,
} from "./flows"
import { writes } from "#vibelang/emitted/src/features/issues/metrics"
import { Queued, type QueuedWrite } from "./schema"

// The issue writes' steps (docs/features/issues.md#flows). A step runs in the leader tab's engine worker, which has no
// outbox of its own, so it asks over the engine's issues channel for the tab that started the request
// (src/flows/askingTab.ts) to queue the write: the tab whose button or slash command dispatched it, or, for the agent's
// call, the tab whose composer asked. The write's id is its run's: a version 5 UUID of the execution id, so a step run
// again names the same write, and the tab queues it once. A tab that doesn't answer within the wait is gone, and the
// retry policy asks again. Nothing records the title or the body.

/** What the tab answered: the door it started the request through, and whether its outbox took the write. */
export interface Reply {
  readonly door: Door
  readonly queued: boolean
}

/** The outboxes of this browser's tabs, as the step reaches them: only the tab that started a request answers. */
export class TabIssues extends Context.Service<
  TabIssues,
  {
    /**
     * Asks the tab that started `requester` to queue `write`. Answers with its reply, or none when no tab answered
     * within the wait: the tab that asked is gone.
     */
    readonly queue: (call: { readonly requester: string; readonly write: QueuedWrite }) => Effect.Effect<Option.Option<Reply>>
  }
>()("@smthrs/mvp/issues/TabIssues") {
  /** Over the issues channel of engine `name` (`TabChannel`), waiting `within` (`QUEUE_WITHIN` unless set). */
  static readonly layerChannel = (options: { readonly name: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      TabIssues,
      Effect.gen(function* () {
        const ask = yield* asker<{ readonly write: QueuedWrite }, typeof Queued>({
          channel: issuesChannel(options.name),
          output: Queued,
          within: options.within ?? QUEUE_WITHIN,
        })
        return TabIssues.of({
          queue: ({ requester, write }) =>
            ask(requester, { write }).pipe(
              Effect.map(Option.map(({ door, output }) => ({ door, queued: output.queued }))),
            ),
        })
      }),
    )
}

/** How a step ended: queued by its tab, or why not. */
export type QueueOutcome = "queued" | "not_admitted" | "tab_gone" | "no_credential"

/** A write's text by operation, as the step reads it from its payload. */
type Text =
  | { readonly op: "issue/commitment"; readonly repo: string; readonly number: number; readonly commitment: import("./lifecycle").Commitment }
  | { readonly op: "issue/create"; readonly repo: string; readonly title: string; readonly body?: string | undefined }
  | { readonly op: "issue/comment"; readonly repo: string; readonly number: number; readonly body: string }
  | {
    readonly op: "issue/triage"
    readonly repo: string
    readonly number: number
    readonly decision: TriageDecision
    readonly reason?: string | undefined
  }
  | { readonly op: "triage/run"; readonly repo: string; readonly number: number }
  | { readonly op: "triage/enable"; readonly repo: string; readonly dailyTokens?: number | undefined }
  | { readonly op: "triage/pause"; readonly repo: string }

/**
 * What `issue/create/queue` and `issue/comment/queue` do: derive the write's id from the run, ask the tab that started
 * it to queue the write, and answer `requested`. A run that isn't the person's own press, the agent's call among them,
 * hands the tab its run credential with the write, so the server reads who acts from that, and writes the agent's as
 * the App, for the person (decision 0017 slice 0). Records the step as a span `issues.write.queue`, a log line and a
 * count of `writes` by operation, door and outcome, never the text. A tab gone, an outbox that wouldn't take it, or a
 * run with no credential to send fails `IssueWriteRefused`.
 */
export const queueWrite = (text: Text) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const { executionId } = yield* FlowRuntime.FlowInstance
    const requester = requesterOf(executionId)
    const credential = yield* Effect.result((yield* RunCredentials).bearer)
    const writeId = yield* Uuid.v5(WRITE_ID_NAMESPACE, executionId).pipe(Effect.orDie)
    const write: QueuedWrite = {
      id: writeId,
      repo: text.repo,
      op: text.op,
      ...(credential._tag === "Success" && Option.isSome(credential.success) ? { credential: credential.success.value } : {}),
      title: text.op === "issue/create" ? text.title.trim() : "",
      number: "number" in text ? text.number : 0,
      body: text.op === "issue/create" || text.op === "issue/comment"
        ? text.body ?? ""
        : text.op === "issue/triage"
        ? text.reason ?? ""
        : "",
      ...(text.op === "issue/triage" ? { decision: text.decision } : {}),
      ...(text.op === "issue/commitment" ? { commitment: text.commitment } : {}),
      ...(text.op === "triage/enable" && text.dailyTokens !== undefined ? { dailyTokens: text.dailyTokens } : {}),
    }
    // A run that has no credential to send queues nothing: its write never goes in the person's session.
    const reply = credential._tag === "Failure" ? Option.none() : yield* (yield* TabIssues).queue({ requester, write })
    // A run's write belongs to the answer its tab asked for; the person's own dispatch names its door in its reply.
    const door: Door | "unknown" = write.credential !== undefined
      ? "agent"
      : Option.match(reply, { onNone: () => "unknown" as const, onSome: (answered) => answered.door })
    const outcome: QueueOutcome = credential._tag === "Failure"
      ? "no_credential"
      : Option.isNone(reply)
      ? "tab_gone"
      : reply.value.queued
      ? "queued"
      : "not_admitted"
    yield* Metric.update(Metric.withAttributes(writes, { op: text.op, door, outcome }), 1)
    yield* Effect.annotateCurrentSpan({ writeId, op: text.op, door, outcome })
    yield* Effect.logWithLevel(outcome === "queued" ? "Info" : "Warn")("issues.write.queue").pipe(
      Effect.annotateLogs({
        writeId,
        op: text.op,
        door,
        outcome,
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
        feature: "issues",
      }),
    )
    if (outcome !== "queued") return yield* new IssueWriteRefused({ reason: outcome })
    return { writeId, status: "requested" } satisfies WriteRequested
  }).pipe(Effect.withSpan("issues.write.queue"))

/**
 * Registers `issue/create`, `issue/comment` and triage's `issue/triage`, `triage/run`, `triage/enable` and
 * `triage/pause` with their steps, queueing through the host's `TabIssues`.
 */
export const registration = Layer.mergeAll(
  Interpreter.layerWithImplementations(IssueCommitment, QueueCommitment.toLayer((payload) => queueWrite({ op: "issue/commitment", ...payload }))),
  Interpreter.layerWithImplementations(
    IssueCreate,
    QueueCreate.toLayer((payload) => queueWrite({ op: "issue/create", ...payload })),
  ),
  Interpreter.layerWithImplementations(
    IssueComment,
    QueueComment.toLayer((payload) => queueWrite({ op: "issue/comment", ...payload })),
  ),
  Interpreter.layerWithImplementations(
    IssueTriage,
    QueueTriage.toLayer((payload) => queueWrite({ op: "issue/triage", ...payload })),
  ),
  Interpreter.layerWithImplementations(TriageRunAgain, QueueRun.toLayer((payload) => queueWrite({ op: "triage/run", ...payload }))),
  Interpreter.layerWithImplementations(
    TriageEnable,
    QueueEnable.toLayer((payload) => queueWrite({ op: "triage/enable", ...payload })),
  ),
  Interpreter.layerWithImplementations(
    TriagePause,
    QueuePause.toLayer((payload) => queueWrite({ op: "triage/pause", ...payload })),
  ),
)
