import type { MemoryError, Opening } from "@smthrs/memory"
import * as OpeningMemory from "./memory"
import { Agent, AgentAction, Budget, EventSink, QuotaPolicy, Seat, SeatResolver } from "@smthrs/agent"
import type { AgentEvent } from "@smthrs/harness"
import { Interpreter } from "@smthrs/flow"
import { Evaluator, type Model, ModelProxy } from "@smthrs/model"
import { Registry } from "@smthrs/registry"
import { Duration, Effect, Layer } from "effect"
import * as Catalog from "../../flows/catalog"
import { SandboxRun } from "../sandbox/flows"
import { MODEL_ROUTE } from "../model/contract"
import * as Close from "./close"
import { AnswerApi, type NotYourTurn, TurnOutOfTime } from "./answers"
import { ANSWER_TURN_WAIT, MAX_FRAMES } from "./contract"
import { Answer, type Ending, ForgetProgress, LoadTurn, RecallOpening, Prepare, Respond, Settle } from "./flows"
import { RunReporter } from "../status/reporter"
import { AnswerProgress, failureOf, type Progress } from "./progress"
import type { AnswerWrite } from "./schema"

// What the agent's flow runs on (docs/features/agent.md#the-host): one composition for every host. The host supplies
// its engine (`FlowRuntime`), an Effect `HttpClient` and ChatApi's origin; this layer supplies the rest:
// - the `agent` seat: the server's model endpoint, read with `ModelProxy`'s client and keyed with its `prepare`, so
//   each model call is a sealed `ModelStep` and the key never reaches the device (decision 0011 §3);
// - the catalog: the app's own flows (src/flows/catalog.ts), and nothing else; no file system, no shell;
// - the policies: plain rate limits park durably; exhausted credit or quota ends the answer; the device budget is unbounded;
// - the sink: the agent's events become the answer's parts (progress.ts);
// - the turn wait: how long a run waits for its turn, while the queue before it doesn't move, before it settles its
//   answer `unfinished` (`ANSWER_TURN_WAIT` unless set).

/** The seat `chat/Respond` declares: the model endpoint's `agent` role. */
export const AGENT_SEAT = "agent"

/** The seat drafting a flow declares: the model endpoint's `plan` role, on the `hard` tier (decision 0107). */
export const PLAN_SEAT = "plan"

/**
 * The context window the agent compacts against. The endpoint picks the model, so the device can't ask it; this is a
 * floor every model the `agent` role may use is expected to meet.
 */
export const CONTEXT_WINDOW_TOKENS = 32_768

/** The most flow calls one cell may make. */
export const MAX_CALLS_PER_CELL = 8

/**
 * What the host gives the agent: ChatApi's origin, how often an answer's parts are written while it streams, and how
 * long one run waits for its turn while the queue before it doesn't move (`ANSWER_TURN_WAIT` unless set).
 */
export interface HostOptions {
  readonly memorySources?: Layer.Layer<Opening.Sources, MemoryError.MemoryError>
  readonly origin: string
  readonly partsEvery?: `${number} ${"millis" | "seconds"}`
  readonly turnWait?: Duration.Input
  /**
   * A model in place of the endpoint's, behind the same seat and route: only the end-to-end tests' scripted agent under
   * the dev server (src/test/scriptedAgent.ts), so a needs-you path runs the same every time.
   */
  readonly model?: Model.Model
}

/**
 * Two seats, `agent` and `plan`, each answered by its role of the model endpoint on `origin` (or `scripted`); any other
 * seat is unresolved.
 */
export const seats = (origin: string, scripted?: Model.Model) =>
  Layer.effect(
    SeatResolver.SeatResolver,
    Effect.gen(function* () {
      const seatOf = (id: string) =>
        Effect.gen(function* () {
          const url = `${origin}${MODEL_ROUTE}/${id}`
          return Seat.make({
            id,
            modelId: id,
            model: scripted ?? (yield* ModelProxy.makeClient({ url })),
            route: { prepare: ModelProxy.prepare({ url }) },
            contextWindowTokens: CONTEXT_WINDOW_TOKENS,
          })
        })
      const known = new Map([[AGENT_SEAT, yield* seatOf(AGENT_SEAT)], [PLAN_SEAT, yield* seatOf(PLAN_SEAT)]])
      return SeatResolver.make({
        resolve: (id) => {
          const seat = known.get(id)
          return seat === undefined
            ? Effect.fail(new Seat.SeatUnresolved({ seat: id, message: "The app's agent has two seats, agent and plan." }))
            : Effect.succeed(seat)
        },
      })
    }),
  )

/**
 * The agent's cell limits: at most `MAX_CALLS_PER_CELL` calls, and a sandbox command's wait spends none of the frame's
 * backstop, so a command may run as long as its own timeout says (up to an hour); its call's own ceiling is its timeout
 * and the default call limit more (`Sandbox.callLimit`).
 */
export const LIMITS = { calls: MAX_CALLS_PER_CELL, pauseTotalMsFor: [SandboxRun._tag] }

/** The host every `chat/Respond` shares: the app's catalog, the frame cap and the sandbox's limits. */
export const agentHost = Layer.effect(
  AgentAction.Host,
  Effect.map(Catalog.source, (app) =>
    AgentAction.makeHost({
      registry: Registry.makeNoop(),
      flows: [app],
      limits: LIMITS,
      capabilityEnvelope: [],
      maxFrames: MAX_FRAMES,
    })),
)

/**
 * `agent.cell`: how each of the answer's cells ended and how many flow calls it made, never its code or its answer.
 * A cell that completed after calls that all settled done answered from its own reading of them: on 2026-10-25 a write
 * the machine had made was answered "I couldn't write the file." that way, and the records showed only the write.
 */
const cellRecord = (answerId: string, event: AgentEvent.AgentEvent) => {
  if (event._tag !== "cell-settled") return Effect.void
  const { outcome, work } = event
  return Effect.logInfo("agent.cell").pipe(
    Effect.annotateLogs({
      answerId,
      outcome: outcome._tag,
      ...(outcome._tag === "settled" ? { transition: outcome.transition._tag } : {}),
      ...(outcome._tag === "rejected" ? { code: outcome.code } : {}),
      ...(work === undefined ? {} : { work: work.kind, calls: work.calls }),
    }),
  )
}

/** The agent's events, recorded against the answer the run is for: its execution id. */
export const sink = Layer.effect(
  EventSink.EventSink,
  Effect.gen(function* () {
    const progress = yield* AnswerProgress
    return EventSink.make({
      emit: (event, step) =>
        step === undefined
          ? Effect.void
          : Effect.andThen(cellRecord(step.executionId, event), progress.record(step.executionId, event)),
    })
  }),
)

/**
 * What `chat/Settle` writes for how the run ended: `unfinished` when its turn wait ran out, else the text when there is
 * one, else why the agent didn't answer; with the parts it showed. Token counts are whole, as the routes take them: a
 * provider's fractional count is rounded rather than refused, which would kill the step and leave the answer streaming.
 */
export const settlement = (
  ending: Ending,
  progress: Progress | undefined,
): Exclude<AnswerWrite, { readonly status: "streaming" }> => {
  const shown = progress === undefined ? {} : { parts: progress.parts }
  const { text, timedOut } = ending
  if (timedOut) return { status: "failed", failure: "unfinished", ...shown }
  if (text !== null && text.trim() !== "") {
    return {
      status: "done",
      text,
      ...shown,
      ...(progress === undefined
        ? {}
        : { inputTokens: Math.round(progress.inputTokens), outputTokens: Math.round(progress.outputTokens) }),
    }
  }
  return { status: "failed", failure: text === null ? ending.failure ?? failureOf(progress) : "empty", ...shown }
}

/** One settlement attempt; the durable action owns retries. */
export const settleAnswer = ({ answerId, ending }: { readonly answerId: string; readonly ending: Ending }) =>
  Effect.gen(function* () {
    const api = yield* AnswerApi
    const progress = yield* AnswerProgress
    const write = settlement(ending, yield* progress.get(answerId))
    yield* api.write(answerId, write).pipe(
      Effect.tapErrorTag("@smthrs/mvp/agent/AnswerSettled", () => progress.forget(answerId)),
    )
    yield* progress.forget(answerId)
    yield* (yield* RunReporter).report(answerId, { status: write.status })
    return { status: write.status }
  })

/** The implementation layers for the settlement graph. */
export const settlementLayers = Layer.mergeAll(
  Settle.toLayer(settleAnswer),
  ForgetProgress.toLayer(({ answerId }) => Effect.flatMap(AnswerProgress, (progress) => progress.forget(answerId))),
)

/**
 * `chat/Answer` and its steps: the turn and the settle through `AnswerApi`, the agent through `Agent`, and a turn wait
 * of `turnWait`, counted by the routes from when the queue before the answer last moved.
 */
export const registration = (turnWait: Duration.Input = ANSWER_TURN_WAIT) => {
  const turnWaitMs = Duration.toMillis(Duration.fromInputUnsafe(turnWait))
  return Layer.unwrap(Effect.map(AnswerApi, (api) => Interpreter.layerWithImplementations(
    Answer,
    Layer.mergeAll(
      // A turn whose queue hasn't moved for the turn wait: the wait is over.
      // The run reports its status from these steps (decision 0015 §2): waiting while an earlier answer holds its turn,
      // working once its turn comes, and how it settled. A report never fails the step.
      LoadTurn.toLayer(({ answerId }) =>
        Effect.gen(function* () {
          const reporter = yield* RunReporter
          const turn = yield* (yield* AnswerApi).turn(answerId).pipe(
            Effect.catchTag(
              "@smthrs/mvp/agent/NotYourTurn",
              (error): Effect.Effect<never, NotYourTurn | TurnOutOfTime> =>
                error.waitedMs >= turnWaitMs
                  ? Effect.fail(new TurnOutOfTime())
                  : Effect.andThen(reporter.report(answerId, { status: "waiting", waiting: "turn" }), Effect.fail(error)),
            ),
          )
          yield* reporter.report(answerId, { status: "working" })
          return turn
        })
      ),
      RecallOpening.toLayer(OpeningMemory.recall),
      Prepare.toLayer(OpeningMemory.prepare),
      Respond.layer,
      settlementLayers,
    ),
    { onHeartbeat: (answerId) => api.heartbeat(answerId).pipe(
      // Lost server authority ends the receipt. Subsequent writes remain
      // fenced by the settled answer; transient outages do not renew liveness.
      // expected: a settled answer ends the heartbeat receipt
      Effect.catchTag("@smthrs/mvp/agent/AnswerSettled", () => Effect.void),
      Effect.catchTag("@smthrs/mvp/agent/AnswersUnavailable", (error) => Effect.logWarning("chat.answer.heartbeat.failed").pipe(Effect.annotateLogs({ answerId, status: error.status ?? 0 }))),
    ) },
  )))
}

/**
 * The agent's flows with everything they run on but the engine: needs the host's `FlowRuntime`, `Crypto` and
 * `HttpClient`, the `RunReporter` its steps report status through, and whatever the catalog's flows need (the theme's
 * `Preferences`).
 */
export const layer = (options: HostOptions) =>
  Layer.mergeAll(registration(options.turnWait), Close.registration, OpeningMemory.rememberRegistration).pipe(
    Layer.provide(Layer.mergeAll(agentHost, seats(options.origin, options.model), sink, Agent.layer)),
    Layer.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())),
    Layer.provide(Layer.mergeAll(Agent.layerDefaults, Evaluator.layerUnavailable())),
    Layer.provide(options.memorySources === undefined ? OpeningMemory.layer(options.origin) : Layer.merge(options.memorySources, OpeningMemory.judgeLayer(options.origin))),
    Layer.provideMerge(AnswerProgress.layer(options.partsEvery)),
    Layer.provideMerge(AnswerApi.layerHttp(options.origin)),
  )
