import { Effect, Metric } from "effect"

// What your own flows count and log in the engine (docs/observability.md#your-own-flows, decision 0014 §7): one line,
// one count and the outcome on the span per draft round, per save, per write and per load, and per realm evaluation and
// host call of a run. Ids, counts and codes only: never a request, a file, a question, an answer, a description, a
// flow's name, its code, a payload or a value.

/** Draft rounds, by `scope`, `outcome` (`ready`, `needs_you`, `failed`) and, for a failed one, `failure` (./failure.ts). */
export const authorRounds = Metric.counter("smithers_flow_author_rounds", {
  description: "Draft rounds flow/new finished, by scope and outcome",
  incremental: true,
})

/** Saves, by `outcome` (`saved`, or the refusal's code). */
export const saves = Metric.counter("smithers_flow_saves", {
  description: "Saves flow/save asked for, by outcome",
  incremental: true,
})

/** Code written to a flow, by `outcome` (`written`, or the refusal's code) and `placement`. */
export const writes = Metric.counter("smithers_flow_writes", {
  description: "Writes of a flow's code flow/write asked for, by outcome and placement",
  incremental: true,
})

/**
 * Realm evaluations of a person's code, by `outcome`: `call` (it asked for a host call), `agent` (an agent step),
 * `complete`, or the failure's closed code.
 */
export const realmEvaluations = Metric.counter("smithers_flow_realm_evaluations", {
  description: "Evaluations of a person's flow code in the QuickJS realm, by outcome",
  incremental: true,
})

/** Host calls a person's code made, by `kind` (`agent`, `flow`) and `outcome` (`ok`, `failed`, or the refusal's code). */
export const realmCalls = Metric.counter("smithers_flow_realm_calls", {
  description: "Host calls a person's flow code made from the QuickJS realm, by kind and outcome",
  incremental: true,
})

/** One round's record. */
export interface Round {
  readonly draftId: string
  readonly round: number
  readonly outcome: "ready" | "needs_you" | "failed"
  /** Why it failed (./failure.ts), or null. */
  readonly failure: string | null
  readonly checks: ReadonlyArray<string>
  readonly questions: number
  readonly durationMs: number
}

/** Records a finished round: `flow.author`, Warn when it failed, and its count. */
export const recordRound = (round: Round) =>
  Effect.gen(function* () {
    yield* Metric.update(
      Metric.withAttributes(authorRounds, {
        scope: "person",
        outcome: round.outcome,
        ...(round.failure === null ? {} : { failure: round.failure }),
      }),
      1,
    )
    yield* Effect.annotateCurrentSpan({
      "smithers.flow.outcome": round.outcome,
      ...(round.failure === null ? {} : { "smithers.flow.failure": round.failure }),
    })
    yield* Effect.logWithLevel(round.outcome === "failed" ? "Warn" : "Info")("flow.author").pipe(
      Effect.annotateLogs({
        feature: "flows",
        draftId: round.draftId,
        round: round.round,
        scope: "person",
        target: "flow",
        outcome: round.outcome,
        ...(round.failure === null ? {} : { failure: round.failure }),
        checks: round.checks.join(","),
        questions: round.questions,
        durationMs: round.durationMs,
      }),
    )
  })

/** Records a save: `flow.save` with its outcome, and its count. */
export const recordSave = (draftId: string, outcome: string) =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(saves, { outcome }), 1)
    yield* Effect.logWithLevel(outcome === "saved" ? "Info" : "Warn")("flow.save").pipe(
      Effect.annotateLogs({ feature: "flows", draftId, outcome }),
    )
  })

/** Records a write of a flow's code: `flow.write` with its outcome and where the code runs, and its count. */
export const recordWrite = (outcome: string, placement: string) =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(writes, { outcome, placement }), 1)
    yield* Effect.logWithLevel(outcome === "written" ? "Info" : "Warn")("flow.write").pipe(
      Effect.annotateLogs({ feature: "flows", outcome, placement }),
    )
  })

/**
 * Records a load: `flow.run.load` with `realm` when the revision runs in the QuickJS realm, `sandbox` when it needs a
 * machine, or the failing check's code.
 */
export const recordLoad = (outcome: string) =>
  Effect.logWithLevel(outcome === "realm" ? "Debug" : "Warn")("flow.run.load").pipe(
    Effect.annotateLogs({ feature: "flows", outcome }),
  )

/** Records one realm evaluation: `flow.run.evaluate` with its outcome and the receipts it replayed, and its count. */
export const recordEvaluate = (outcome: string, receipts: number) =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(realmEvaluations, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ "smithers.flow.outcome": outcome })
    yield* Effect.logWithLevel(["call", "agent", "complete"].includes(outcome) ? "Debug" : "Warn")("flow.run.evaluate").pipe(
      Effect.annotateLogs({ feature: "flows", outcome, receipts }),
    )
  })

/** Records one host call: `flow.run.call` with its kind and outcome, and its count. */
export const recordCall = (kind: "agent" | "flow", outcome: string) =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(realmCalls, { kind, outcome }), 1)
    yield* Effect.logWithLevel(outcome === "ok" ? "Debug" : "Warn")("flow.run.call").pipe(
      Effect.annotateLogs({ feature: "flows", kind, outcome }),
    )
  })
