import { quotaRefused } from "../model/contract"
import { type AgentEvent, DoneText } from "@smthrs/harness"
import { Context, Effect, Layer, Metric, Option, Queue, Stream } from "effect"
import { AnswerApi } from "./answers"
import type { AnswerFailure, Part } from "./schema"

// What an answer shows while the agent works on it (docs/features/agent.md#streaming): its text as the model writes
// it, and the steps it took, as parts, folded from the agent's events. The text is the literal the reply passes to its
// last `ctx.done(`, decoded as far as it has arrived (`DoneText.project`); a new model call or a retry starts the reply
// over.
// The agent's `EventSink` records each event against its answer (the run's execution id is the answer's id), and a
// writer sends each answer's text and parts to its row at most once a second. The sealed events are what counts: a
// resumed run replays them through the same fold, and `chat/Settle` writes the final text and parts. Nothing here
// reaches the answer but the text a person reads, flow names and how each call went: no code, no flow input, no result.

/** One answer's progress: its text so far, its parts, the tokens its model calls spent, and how they ended. */
export interface Progress {
  /** The current model call's text so far. */
  readonly reply: string
  /** The answer's text so far: the last projection of a reply's `ctx.done(` literal. */
  readonly text: string | undefined
  /**
   * The projection of a reply whose cell calls a flow, held until the cell settles: until then a call may fail, or wait
   * for the person's approval, and the text would say done what isn't.
   */
  readonly held?: string | undefined
  /** What the answer showed when the current reply began: what a reply that turns out to hold its text goes back to. */
  readonly before?: string | undefined
  readonly parts: ReadonlyArray<Part>
  readonly inputTokens: number
  readonly outputTokens: number
  /** Whether model credit or quota was spent, the call was rate limited, or another error ended it. */
  readonly modelFailure: "quota" | "rate_limited" | "model_error" | undefined
}

/** An answer the agent hasn't shown anything for. */
export const empty: Progress = {
  reply: "",
  text: undefined,
  parts: [],
  inputTokens: 0,
  outputTokens: 0,
  modelFailure: undefined,
}

/** A reply's fenced blocks, closed or still streaming, as the harness reads them, whatever their tag. */
const FENCE = /^```[^\n`]*\r?\n([\s\S]*?)(?:\n?^```[ \t]*(?=\r?$)|(?![\s\S]))/gm

/**
 * Whether a reply's blocks do anything but one `ctx.done(` of a literal: then its text holds until the cell settles,
 * since a call may fail or wait for the person, however it is spelled. Every block counts, whatever its tag, a superset
 * of the ones the harness runs (`cell`, `js`, `ts` and their long names).
 */
const doesMore = (reply: string): boolean => {
  const program = [...reply.matchAll(FENCE)].map((block) => block[1]).join("\n")
  return !DONE_ALONE.test(program)
}

/** A program that is one `ctx.done(` of one literal, closed or still arriving, with no `${` to run code in it. */
const DONE_ALONE =
  /^\s*ctx\.done\s*\(\s*(?:"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\$]|\\.|\$(?!\{))*`?)?\s*\)?\s*;?\s*$/

/** A rate-limit code or status on a failed model call. */
const rateLimited = (code: string, httpStatus: number | undefined) =>
  code === "rate_limited" || httpStatus === 429

/** Folds one agent event into an answer's progress. Events that show nothing leave it as it was. */
export const fold = (progress: Progress, event: AgentEvent.AgentEvent): Progress => {
  switch (event._tag) {
    case "cell-call-started": {
      const id = `${event.call.identity.frame}.${event.call.identity.ordinal}`
      if (progress.parts.some((part) => part.id === id)) return progress
      return {
        ...progress,
        parts: [...progress.parts, { id, kind: "step", flow: event.call.flowName, status: "running" }],
      }
    }
    case "cell-call-settled": {
      // A resumed run replays a sealed call's settlement without its start, so a settlement adds its part if needed.
      const id = `${event.identity.frame}.${event.identity.ordinal}`
      const status = event.result.outcome === "success" ? "done" : "failed"
      const settled: Part = { id, kind: "step", flow: event.flowName, status }
      return {
        ...progress,
        parts: progress.parts.some((part) => part.id === id)
          ? progress.parts.map((part) => (part.id === id ? settled : part))
          : [...progress.parts, settled],
      }
    }
    case "model-requested":
    case "model-retried":
      return { ...progress, reply: "", held: undefined, before: progress.text }
    case "model-delta": {
      if (event.delta.type !== "text-delta") return progress
      const reply = progress.reply + event.delta.text
      const text = Option.getOrUndefined(DoneText.project(reply))
      // Holding, the answer takes back anything this reply showed before it was seen to do more.
      if (text !== undefined && doesMore(reply)) return { ...progress, reply, held: text, text: progress.before ?? "" }
      return text === undefined || text === progress.text ? { ...progress, reply } : { ...progress, reply, text }
    }
    case "cell-settled": {
      if (progress.held === undefined) return progress
      return event.outcome._tag === "settled"
        ? { ...progress, text: progress.held, held: undefined }
        : { ...progress, held: undefined }
    }
    case "model-settled":
      return {
        ...progress,
        inputTokens: progress.inputTokens + (event.usage.inputTokens ?? 0),
        outputTokens: progress.outputTokens + (event.usage.outputTokens ?? 0),
      }
    case "model-failed":
      return { ...progress, modelFailure: quotaRefused(event.code, event.httpStatus)
        ? "quota"
        : rateLimited(event.code, event.httpStatus) ? "rate_limited" : "model_error" }
    default:
      return progress
  }
}

/**
 * Why an answer the agent didn't finish failed: its model's failure, else it ran out of frames. A run this engine has
 * no progress for, resumed after its agent step failed, failed in its model.
 */
export const failureOf = (progress: Progress | undefined): AnswerFailure =>
  progress === undefined ? "model_error" : progress.modelFailure ?? "unfinished"

/** Progress writes accepted by the answer routes. */
export const progressWrites = Metric.counter("smithers_answer_progress_writes", { incremental: true })

/** Each answer's progress in this engine, and the writer that streams its text and parts. */
export class AnswerProgress extends Context.Service<
  AnswerProgress,
  {
    /** Folds `event` into the progress of the answer `answerId`, and queues what it shows to be written. */
    readonly record: (answerId: string, event: AgentEvent.AgentEvent) => Effect.Effect<void>
    /** The answer's progress, if this engine has seen any. */
    readonly get: (answerId: string) => Effect.Effect<Progress | undefined>
    /** Forgets the answer once it has settled. */
    readonly forget: (answerId: string) => Effect.Effect<void>
  }
>()("@smthrs/mvp/agent/AnswerProgress") {
  /**
   * The progress, with its writer running until the scope closes: the answers whose text or parts changed, written at
   * most once per `every`, each with its latest. A write the routes refuse is dropped: the settle writes what counts.
   */
  static readonly layer = (every: `${number} ${"millis" | "seconds"}` = "1 seconds") =>
    Layer.effect(
      AnswerProgress,
      Effect.gen(function* () {
        const api = yield* AnswerApi
        const answers = new Map<string, Progress>()
        const changed = yield* Queue.unbounded<string>()
        const scope = yield* Effect.scope
        const writing = new Set<string>()
        yield* Stream.fromQueue(changed).pipe(
          Stream.groupedWithin(Number.MAX_SAFE_INTEGER, every),
          Stream.runForEach((ids) =>
            Effect.forEach(
              new Set(ids),
              (id) => {
                const progress = answers.get(id)
                if (progress === undefined || writing.has(id)) return Effect.void
                writing.add(id)
                // Each answer owns at most one write. Other answers and later batches keep moving.
                return api.write(id, {
                  status: "streaming",
                  parts: progress.parts,
                  ...(progress.text === undefined ? {} : { text: progress.text }),
                }).pipe(
                  Effect.tap(() => Metric.update(progressWrites, 1)),
                  Effect.catchTag("@smthrs/mvp/agent/AnswerSettled", () => Effect.sync(() => void answers.delete(id))),
                  Effect.catchTag("@smthrs/mvp/agent/AnswersUnavailable", (error) =>
                    Effect.logWarning("chat.answer.progress.failed").pipe(Effect.annotateLogs({ answerId: id, status: error.status ?? 0 }))),
                  Effect.ensuring(Effect.suspend(() => {
                    writing.delete(id)
                    const latest = answers.get(id)
                    // Changes received during this write are coalesced into the next tick, never retried here.
                    return latest !== undefined && (latest.parts !== progress.parts || latest.text !== progress.text)
                      ? Queue.offer(changed, id).pipe(Effect.asVoid)
                      : Effect.void
                  })),
                  Effect.withSpan("chat.answer.progress"),
                  Effect.forkIn(scope),
                  Effect.asVoid,
                )
              },
              { discard: true },
            )
          ),
          Effect.forkScoped,
        )
        return AnswerProgress.of({
          record: (answerId, event) =>
            Effect.suspend(() => {
              const before = answers.get(answerId) ?? empty
              const after = fold(before, event)
              answers.set(answerId, after)
              return after.parts === before.parts && after.text === before.text
                ? Effect.void
                : Queue.offer(changed, answerId).pipe(Effect.asVoid)
            }),
          get: (answerId) => Effect.sync(() => answers.get(answerId)),
          forget: (answerId) => Effect.sync(() => void answers.delete(answerId)),
        })
      }),
    )
}
