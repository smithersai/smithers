import { quotaRefused } from "../model/contract"
import { Interpreter } from "@smthrs/flow"
import { ModelStep } from "@smthrs/agent"
import { Relevance } from "@smthrs/harness"
import { Flows, MemoryError, MemoryStore, Opening, Recall, RecallKeyword } from "@smthrs/memory"
import { Evaluator, ModelError } from "@smthrs/model"
import { Clock, Config, Effect, Layer, Metric, Stream } from "effect"
import { FlowsClient } from "../flows-ui/api"
import { JudgeSeat } from "../jev/steps"
import { OpeningFailed, OpeningRefused, prompt } from "./flows"
import { MEMORY_BANK, Remember, RememberRecord } from "./memoryFlows"
import type { Turn } from "./schema"

/** Conservative UTF-8 token ceiling, including escaped labels and fences. */
export const OPENING_TOKENS = 4096
export const catalogUnavailable = Metric.counter("smithers_memory_catalog_unavailable")
export const recalled = Metric.counter("smithers_memory_recalled")
export const inserted = Metric.counter("smithers_memory_inserted")
export const remembered = Metric.counter("smithers_memory_remembered")
export const filtered = Metric.counter("smithers_memory_filtered")
export const recallDuration = Metric.histogram("smithers_memory_recall_ms", { boundaries: [10, 100, 1000, 5000, 30000] })
export const duration = Metric.histogram("smithers_memory_ms", { boundaries: [10, 100, 1000, 5000, 30000] })

export const recall = (turn: Turn) => Effect.gen(function*() {
  const started = yield* Clock.currentTimeMillis
  const sources = yield* Opening.Sources
  const candidates = yield* sources.recall(Opening.boundedQuery(prompt(turn))).pipe(Effect.mapError((error) => error.code === "store" ? new OpeningFailed() : new OpeningRefused()))
  const durationMs = (yield* Clock.currentTimeMillis) - started
  yield* Metric.update(recallDuration, durationMs)
  yield* Effect.logInfo("memory.recall").pipe(Effect.annotateLogs({ recalled: candidates.length, durationMs }))
  return { ...turn, candidates }
}).pipe(Effect.withSpan("memory.recall"))

/** The sealed action's result is the frame-zero snapshot on every resume. */
export const prepare = (turn: Turn & { readonly candidates: ReadonlyArray<Opening.Candidate> }) => Effect.gen(function*() {
  const started = yield* Clock.currentTimeMillis
  const tokenBudget = yield* Config.Int("AGENT_OPENING_TOKENS").pipe(Config.withDefault(OPENING_TOKENS), Effect.mapError(() => new OpeningFailed()))
  const selection = yield* Opening.select({
    query: Opening.boundedQuery(prompt(turn)), candidates: turn.candidates, tokenBudget,
    judge: (items) => Effect.gen(function*() {
      const seat = yield* JudgeSeat
      const model = yield* ModelStep.model({ name: "chat/Opening/model", ...seat })
      let quota = false
      const observed = { ...model, stream: (request: Parameters<typeof model.stream>[0]) => model.stream(request).pipe(
        Stream.tapError((error) => Effect.sync(() => {
          quota = error instanceof ModelError.ModelError && quotaRefused(error.code, error.httpStatus)
        })),
      ) }
      const reading = yield* Relevance.judge({ task: Opening.boundedQuery(prompt(turn)) }, items.map((item) => ({
        kind: item.kind, id: item.key, text: item.text,
      }))).pipe(Effect.provide(Evaluator.layerFromSeat({ modelId: "judge", model: observed })), Effect.mapError(() => new OpeningFailed(quota ? { quota: true } : {})))
      return reading.verdicts.map((verdict, index) => ({
        index, unnecessary: verdict.p, withheld: verdict.withheld,
      }))
    }),
  })
  const durationMs = (yield* Clock.currentTimeMillis) - started
  yield* Metric.update(recalled, selection.recalled)
  yield* Metric.update(inserted, selection.inserted)
  yield* Metric.update(filtered, selection.filtered)
  yield* Metric.update(duration, durationMs)
  yield* Effect.logInfo("memory.opening").pipe(Effect.annotateLogs({
    recalled: selection.recalled, inserted: selection.inserted, filtered: selection.filtered,
    skillsRecalled: selection.skillsRecalled, skillsInserted: selection.skillsInserted, durationMs,
  }))
  return { question: turn.question, history: turn.history, memoryDebug: { recalled: selection.recalled, inserted: selection.inserted, filtered: selection.filtered, skillsInserted: selection.skillsInserted }, opening: selection.rows.map((row) => ({ ...row, origin: "recall" as const })) }
}).pipe(Effect.withSpan("memory.opening"))

/** SQL and serialized writes are injected by the browser or Node engine host. */
export const layer = (origin: string) => Layer.merge(
  Layer.effect(Opening.Sources, Effect.gen(function*() {
    const recall = yield* Recall.Recall
    const flows = yield* FlowsClient
    return { recall: (query: string) => Effect.gen(function*() {
      const rows = yield* recall.recall({ banks: [MEMORY_BANK], query, maxTokens: 16_384 })
      const catalog = yield* flows.list.pipe(
        Effect.catchTag("@smthrs/mvp/flows/FlowsUnavailable", () => Effect.gen(function*() {
          yield* Metric.update(catalogUnavailable, 1)
          yield* Effect.logWarning("memory.catalog_unavailable")
          return { flows: [] }
        }).pipe(Effect.withSpan("memory.catalog_unavailable"))),
        Effect.mapError(() => new MemoryError.MemoryError({
          code: "invalid_namespace", message: "Skill catalog unavailable",
        })))
      return [
        ...rows.map((row): Opening.Candidate => ({ ...row, kind: "memory" })),
        ...catalog.flows.map((flow): Opening.Candidate => ({
          kind: "skill", bank: "skills", key: flow.name,
          text: `Saved flow ${flow.name}, revision ${flow.revision}: ${flow.description}`,
        })),
      ]
    }) }
  })).pipe(
    Layer.provide(RecallKeyword.layer), Layer.provide(MemoryStore.layer),
    Layer.provide(FlowsClient.layer({ origin })),
  ),
  JudgeSeat.layer(origin),
)

export const judgeLayer = JudgeSeat.layer


export const rememberRegistration = Interpreter.layerWithImplementations(Remember,
  RememberRecord.toLayer((payload) => Flows.handlersFor(Remember).remember({ ...payload, bank: MEMORY_BANK }).pipe(
    Effect.tap(() => Metric.update(remembered, 1)),
    Effect.tap(() => Effect.logInfo("memory.remember")),
    Effect.withSpan("memory.remember"),
  )),
).pipe(Layer.provide(MemoryStore.layer))
