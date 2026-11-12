import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as ScoreGate from "../src/ScoreGate.ts"
import * as ScoreStore from "../src/ScoreStore.ts"
import * as Scoring from "../src/Scoring.ts"
import * as SqlScoreStore from "../src/SqlScoreStore.ts"

const layer = SqlScoreStore.layer.pipe(Layer.provideMerge(TestDatabase.layer))
const run = <A, E>(effect: Effect.Effect<A, E, ScoreStore.ScoreStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

const job = (score: Scoring.Job["score"], identity = "job"): Scoring.Job => ({
  identity,
  observation: { targetStepKey: "target", scorerKey: "scorer" },
  score,
  at: 1
})

describe("Scoring observation persistence", () => {
  const bearer = "Bearer sk-ant-api03-SECRET7f3aXYZ"
  const url = "https://judge:hunter2@judge.example/v1/score"
  const reason = `called ${url} with ${bearer}`

  it("returns the same scrubbed scores and failures that the SQL store retains", async () => {
    const output = await run(Effect.gen(function*() {
      const store = yield* ScoreStore.ScoreStore
      const outcomes = yield* Scoring.runBatchCorrelated([
        job(Effect.succeed({ score: 0.5, reason, meta: { authorization: bearer, nested: { url } } }), "score"),
        job(Effect.fail(new Error(reason)), "failure"),
        job(Effect.die(new Error(reason)), "defect")
      ])
      return { outcomes, stored: yield* store.observations("target") }
    }))
    expect(output.outcomes.map(({ recorded }) => recorded)).toEqual(["persisted", "persisted", "persisted"])
    expect(output.outcomes.map(({ observation }) => observation)).toEqual(output.stored)
    expect(output.outcomes[0]?.observation).toMatchObject({
      kind: "score",
      reason: "called https://judge:[REDACTED]@judge.example/v1/score with Bearer [REDACTED_TOKEN]",
      meta: { authorization: "[REDACTED]", nested: { url: "https://judge:[REDACTED]@judge.example/v1/score" } }
    })
    for (const outcome of output.outcomes.slice(1)) {
      expect(outcome.observation).toMatchObject({ kind: "inconclusive", code: "inconclusive" })
      expect(outcome.observation.reason).toContain("Error: called https://judge:[REDACTED]@")
    }
    expect(JSON.stringify(output)).not.toContain("hunter2")
    expect(JSON.stringify(output)).not.toContain("SECRET7f3a")
    const samples = output.outcomes.flatMap(({ observation }): ReadonlyArray<ScoreGate.ScoreSample> =>
      observation.kind === "inconclusive"
        ? [{
          case: "example",
          stepKey: observation.targetStepKey,
          scorer: observation.scorerKey,
          kind: observation.kind,
          reason: observation.reason
        }]
        : []
    )
    const verdict = ScoreGate.grade(await Effect.runPromise(ScoreGate.expectScores(samples).mean(1)))
    expect(verdict.exitCode).toBe(5)
    expect(verdict.summary).toContain("https://judge:[REDACTED]@")
    expect(JSON.stringify(verdict)).not.toContain("hunter2")
    expect(JSON.stringify(verdict)).not.toContain("SECRET7f3a")
  })

  it("scrubs runBatch and the standalone inconclusive helper without relying on a SQL store", async () => {
    const output = await Effect.runPromise(
      Scoring.runBatch([
        job(Effect.succeed({ score: 1, reason, meta: { authorization: bearer } })),
        job(Effect.fail(new Error(reason)))
      ]).pipe(Effect.provide(ScoreStore.layerNoop))
    )
    const standalone = Scoring.inconclusive(job(Effect.succeed({ score: 1 })), new Error(reason))
    expect(JSON.stringify({ output, standalone })).not.toContain("hunter2")
    expect(JSON.stringify({ output, standalone })).not.toContain("SECRET7f3a")
    expect(output[0]).toMatchObject({ meta: { authorization: "[REDACTED]" } })
  })

  const invalidMetadata: ReadonlyArray<readonly [string, () => unknown]> = [
    ["undefined member", () => ({ nested: { note: undefined } })],
    ["date", () => new Date(0)],
    ["map", () => new Map([["note", "value"]])],
    ["class instance", () =>
      new (class Metadata {
        note = "value"
      })()],
    ["bigint", () => ({ value: 1n })],
    ["function", () => ({ value: () => 1 })],
    ["symbol", () => ({ value: Symbol("value") })],
    ["cycle", () => {
      const value: { self?: unknown } = {}
      value.self = value
      return value
    }],
    ["revoked proxy during inspection", () => {
      let enumerations = 0
      const { proxy, revoke } = Proxy.revocable({}, {
        ownKeys: () => {
          enumerations += 1
          if (enumerations === 3) revoke()
          return []
        }
      })
      return proxy
    }],
    ["throwing getter", () => ({
      get note() {
        throw new Error("unreadable metadata")
      }
    })],
    ["oversized", () => ({ note: "x".repeat(ScoreStore.maxMetadataBytes) })],
    [
      "oversized after redaction",
      () => Object.fromEntries(Array.from({ length: 2_400 }, (_value, index) => [`k${index}`, "Bearer abcd"]))
    ]
  ]

  it.each(invalidMetadata)("records %s metadata as inconclusive and deduplicates replay", async (_name, makeMeta) => {
    const output = await run(Effect.gen(function*() {
      const store = yield* ScoreStore.ScoreStore
      const request = job(Effect.sync(() => ({ score: 1, meta: makeMeta() })))
      const first = yield* Scoring.runBatchCorrelated([request])
      const replay = yield* Scoring.runBatchCorrelated([request])
      return { first, replay, stored: yield* store.observations("target"), aggregate: yield* store.aggregate("target") }
    }))
    expect(output.first).toMatchObject([{
      identity: "job",
      recorded: "persisted",
      observation: { kind: "inconclusive", code: "invalid_observation", at: 1 }
    }])
    expect(output.first[0]?.observation.reason).toContain("metadata")
    expect(output.replay).toMatchObject([{ identity: "job", recorded: "duplicate" }])
    expect(output.stored).toEqual(output.first.map(({ observation }) => observation))
    expect(output.aggregate).toEqual({ count: 0, mean: undefined, min: undefined, inconclusive: 1 })
  })

  it.each([null, true, 1, "text", ["value"], { a: 1 }, undefined])(
    "preserves valid metadata %j in returned and persisted scores",
    async (meta) => {
      const output = await run(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        const outcomes = yield* Scoring.runBatchCorrelated([job(Effect.succeed({ score: 1, meta }))])
        return { outcomes, stored: yield* store.observations("target") }
      }))
      expect(output.outcomes).toMatchObject([{ recorded: "persisted", observation: { kind: "score", score: 1 } }])
      expect(output.stored).toEqual(output.outcomes.map(({ observation }) => observation))
      if (meta !== undefined) expect(output.stored[0]).toHaveProperty("meta", meta)
    }
  )

  it.each([
    ["score", "AKIA" + "A".repeat(16)],
    ["inconclusive", "AKIA" + "A".repeat(16)],
    ["score", "npm_" + "A".repeat(36)],
    ["inconclusive", "npm_" + "A".repeat(36)]
  ])("scrubs a token exposed by truncation of a %s reason (%s)", async (kind, token) => {
    const lead = kind === "score" ? "" : "Scorer execution was inconclusive: "
    const reason = "x".repeat(ScoreStore.maxReasonBytes - lead.length - token.length - 1) + " " + token + "A"
    const score = kind === "score" ? Effect.succeed({ score: 1, reason }) : Effect.fail(reason)
    const output = await run(Effect.gen(function*() {
      const store = yield* ScoreStore.ScoreStore
      const outcomes = yield* Scoring.runBatchCorrelated([job(score)])
      return { outcomes, stored: yield* store.observations("target") }
    }))
    expect(output.outcomes).toMatchObject([{ recorded: "persisted", observation: { kind } }])
    expect(output.outcomes[0]?.observation.reason).not.toContain(token)
    expect(output.outcomes[0]?.observation.reason).toContain("[REDACTED]")
    expect(output.stored).toEqual(output.outcomes.map(({ observation }) => observation))
  })

  it("accepts metadata exactly at its encoded byte bound and truncates a scrub-grown reason", async () => {
    const short = "Bearer abcd"
    const longReason = `${short} ${"é".repeat(ScoreStore.maxReasonBytes)}`
    const meta = "é".repeat((ScoreStore.maxMetadataBytes - 2) / 2)
    const output = await run(Effect.gen(function*() {
      const store = yield* ScoreStore.ScoreStore
      const outcomes = yield* Scoring.runBatchCorrelated([
        job(Effect.succeed({ score: 1, reason: longReason, meta }))
      ])
      return { outcomes, stored: yield* store.observations("target") }
    }))
    expect(output.outcomes).toMatchObject([{ recorded: "persisted", observation: { kind: "score", meta } }])
    expect(output.stored).toEqual(output.outcomes.map(({ observation }) => observation))
    const scrubbed = output.outcomes[0]?.observation.reason ?? ""
    expect(scrubbed).toMatch(/^Bearer \[REDACTED_TOKEN\] /)
    expect(new TextEncoder().encode(scrubbed).length).toBeLessThanOrEqual(ScoreStore.maxReasonBytes)
    expect(scrubbed).not.toContain("�")
  })
})
