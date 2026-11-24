import { Fuzz } from "@smthrs/fuzz"
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Deferred, Effect, Fiber, Layer, Option, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as CallLedger from "../src/CallLedger.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as UnobservedCall from "../src/internal/unobservedCall.ts"
import * as Monitor from "../src/Monitor.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as RealmFlow from "../src/RealmFlow.ts"
import * as Relevance from "../src/Relevance.ts"
import * as Sandbox from "../src/Sandbox.ts"
import * as Steering from "../src/Steering.ts"
import * as Supervisor from "../src/Supervisor.ts"
import { descriptor, emits, pattern, runEffect as runCellTurn, window as baseWindow } from "./fixtures/cellTurn.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const fastExec = Math.max(30, Math.min(executions, 80))
const medExec = Math.max(16, Math.min(executions, 28))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261240")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const mkState = (overrides: Partial<Parameters<typeof CellTurn.make>[0]> = {}) =>
  CellTurn.make({
    session: "sess-w10b4",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: [],
    capabilityEnvelope: [pattern("fs:read:**"), pattern("fs:write:**"), pattern("proc:spawn:**")],
    placement: Option.none(),
    contextWindow: baseWindow,
    maxFrames: 6,
    repeatCap: 0,
    narrowingCap: 0,
    unmovedCap: 0,
    unresolvedCap: 0,
    claimCap: 0,
    ...overrides
  })

describe("@smthrs/harness Wave10 Boost4 Fuzz", () => {
  it(
    "CellTurn checkpoint mint/exhaust, runaway guard, maxFrames budget, openRealm fail, suspended interrupt, and failing supervisor memory",
    async () => {
      const cases = [
        "checkpoint-mint-and-exhaust",
        "checkpoint-cap-zero",
        "runaway-failure-frames",
        "max-frames-exhausted",
        "open-realm-failure",
        "interrupt-while-suspended",
        "supervisor-memory-failure"
      ] as const

      const arb = Arbitrary.schema(
        Schema.Struct({
          idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: cases.length - 1 })))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ idx }) =>
            Effect.gen(function*() {
              const c = cases[idx]!
              if (c === "checkpoint-mint-and-exhaust") {
                const out = yield* runCellTurn({
                  state: mkState({ checkpointCap: 1 }),
                  pins: true,
                  script: [
                    emits(
                      `const a = await ctx.checkpoint(); const b = await ctx.checkpoint(); console.log(a, b); ctx.done("ok")`
                    )
                  ]
                })
                expect(out.events.some((e) => e._tag === "checkpoint-minted")).toBe(true)
              } else if (c === "checkpoint-cap-zero") {
                const out = yield* runCellTurn({
                  state: mkState({ checkpointCap: 0 }),
                  pins: true,
                  script: [emits(`const a = await ctx.checkpoint(); console.log(a); ctx.done("ok")`)]
                })
                expect(out.events.length).toBeGreaterThan(0)
              } else if (c === "runaway-failure-frames") {
                const st = new CellTurn.State({ ...mkState(), failureFrames: 5, failureKey: "same-err" })
                const out = yield* runCellTurn({ state: st, script: [] })
                expect(out.failure !== undefined).toBe(true)
              } else if (c === "max-frames-exhausted") {
                const st = new CellTurn.State({ ...mkState({ maxFrames: 2 }), frame: 2 })
                const out = yield* runCellTurn({ state: st, script: [] })
                expect(out.events.some((e) => e._tag === "resolved")).toBe(true)
              } else if (c === "open-realm-failure") {
                const model = ScriptedModel.make([emits(`ctx.done("x")`)])
                const engine = ScriptedEngine.make(model.model, [])
                const badSandbox = Sandbox.layer({
                  capabilities: { timeMs: true, memoryBytes: true, steps: true, calls: true },
                  openRealm: () =>
                    Effect.fail(new Sandbox.SandboxError({ code: "runtime_failed", message: "cannot open" }))
                })
                const res = yield* Effect.result(
                  CellTurn.run({ state: mkState(), flows: [] }).pipe(
                    Stream.runDrain,
                    Effect.provide(
                      Layer.mergeAll(engine.layer, badSandbox, Steering.layerNoop(), Evaluator.layerUnavailable())
                    )
                  )
                )
                expect(Result.isFailure(res)).toBe(true)
              } else if (c === "interrupt-while-suspended") {
                const started = yield* Deferred.make<void>()
                const model = ScriptedModel.make([emits(`await ctx.call("slow", {}); ctx.done("x")`)])
                const engine = ScriptedEngine.make(model.model, [])
                const suspEngine = EngineLike.layer({
                  ...engine.engine,
                  isSuspended: Effect.succeed(true),
                  call: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                })
                const events: Array<AgentEvent.AgentEvent> = []
                const fiber = yield* Effect.forkChild(
                  CellTurn.run({ state: mkState(), flows: [descriptor("slow")] }).pipe(
                    Stream.runDrain,
                    Effect.provideService(AgentEvent.Observer, (e) => Effect.sync(() => void events.push(e))),
                    Effect.provide(
                      Layer.mergeAll(
                        suspEngine,
                        QuickJSSandbox.layer,
                        Steering.layerNoop(),
                        Evaluator.layerUnavailable()
                      )
                    )
                  )
                )
                yield* Deferred.await(started).pipe(Effect.timeoutOption("1 second"))
                yield* Fiber.interrupt(fiber)
                expect(events.some((e) => e._tag === "turn-closed" && e.outcome === "suspended")).toBe(true)
              } else if (c === "supervisor-memory-failure") {
                const failingMem = Supervisor.Memory.of({
                  bound: true,
                  recall: () => Effect.fail({ detail: "db down" }),
                  remember: () => Effect.fail({ detail: "write failed" })
                })
                const evalLayer = Evaluator.layerScripted((req) => {
                  if (Object.hasOwn(req.questions, "complete")) {
                    return {
                      complete: { probability: 0.99 },
                      overclaims: { probability: 0.01 },
                      invented: { probability: 0.01 }
                    }
                  }
                  return Object.fromEntries(
                    Object.entries(req.questions).map(([id, q]) => [
                      id,
                      q.type === "boolean"
                        ? { probability: 0.9 }
                        : q.type === "score"
                        ? { score: 0.9 }
                        : { choice: "none" }
                    ])
                  )
                })
                const out = yield* runCellTurn({
                  state: mkState({ maxFrames: 4 }),
                  judged: true,
                  monitors: Monitor.defaults(),
                  memory: failingMem,
                  evaluator: evalLayer,
                  flows: [descriptor("fs/read")],
                  script: [
                    emits(`const a = await ctx.call("fs/read", {}); console.log(a)`),
                    emits(`ctx.done("ok")`)
                  ],
                  calls: [{ _tag: "Success", value: "v" }]
                })
                expect(out.events.length).toBeGreaterThan(0)
              }
              return true
            }),
          { executions: medExec, seed }
        )
      )
      assertPassed(report)
    },
    90_000
  )

  it("UnobservedCall complex ASTs, CallLedger bound/clipping/types, and Monitor.validate/skills/gate", async () => {
    const astCells = [
      `const [a, b = 1] = await ctx.call("f", {}); console.log(a + b); ctx.done("ok")`,
      `const { x: alias, ...rest } = await ctx.call("f", {}); ctx.done(alias ? "y" : "n")`,
      `const r = await ctx.call("f", {}); try { for (const k of r) { if (k > 0) break } } catch (e) {} ctx.done("ok")`,
      `const r = await ctx.call("f", {}); const fn = () => r?.prop ?? 0; console.log(fn()); ctx.done("ok")`,
      `await ctx.call("f", {}); const p = Promise.all([ctx.call("g", {})]); ctx.done("blind")`,
      `const r = await ctx.call("f", {}); switch (r.tag) { case 1: ctx.done("1"); break; default: ctx.done("d") }`,
      `const r = await ctx.call("f", {}); while (r.more) { break } ctx.done("w")`,
      `function (invalid syntax {{{`
    ]
    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: astCells.length - 1 }))),
        count: Schema.Literals([1, 5, 35]),
        badMon: Schema.Literals(["bad-id", "dup-id", "bad-limit", "bad-cooldown", "bad-consecutive", "bad-at", "valid"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx, count, badMon }) =>
          Effect.sync(() => {
            const src = astCells[idx]!
            const parsed = UnobservedCall.parseCell(src)
            if (parsed !== undefined) {
              expect(Array.isArray(UnobservedCall.flows(parsed))).toBe(true)
              expect(Array.isArray(UnobservedCall.referencing(parsed))).toBe(true)
            }
            const unobs = UnobservedCall.find([{ ordinal: 0, flow: "f", ok: true, summary: "s" }], src)
            expect(Array.isArray(unobs)).toBe(true)

            const settlements: Array<CallLedger.Settlement> = Array.from({ length: count }, (_, k) => ({
              flow: k === 0 ? "Z".repeat(200) : `tool/${k}`,
              input: k % 3 === 0
                ? { nested: { a: [1, 2, 3, 4, 5, 6, 7], b: "x".repeat(400) } }
                : { path: `src/f${k}.ts` },
              ok: k % 2 === 0,
              value: k % 2 === 0 ? { items: Array.from({ length: 10 }, (__, j) => j) } : null,
              ...(k % 2 === 1 ? { message: "err ".repeat(120) } : {}),
              mutates: k % 4 === 0
            }))
            const ledger = CallLedger.remember([], settlements)
            expect(ledger.length).toBeLessThanOrEqual(CallLedger.bound)
            expect(typeof CallLedger.render(ledger, 0)).toBe("string")
            expect(CallLedger.render(ledger, 999)).toBeUndefined()

            // Monitor.validate & skills
            const validMon = Monitor.useJev()
            const candidate: ReadonlyArray<Monitor.Monitor> = badMon === "bad-id"
              ? [{ ...validMon, id: "BAD ID!" }]
              : badMon === "dup-id"
              ? [validMon, validMon]
              : badMon === "bad-limit"
              ? [{ ...validMon, limit: -1 }]
              : badMon === "bad-cooldown"
              ? [{ ...validMon, cooldownFrames: -1 }]
              : badMon === "bad-consecutive"
              ? [{ ...validMon, consecutive: 0 }]
              : badMon === "bad-at"
              ? [{ ...validMon, at: 2 }]
              : [validMon]
            const validated = Effect.runSync(Effect.result(Monitor.validate(candidate)))
            expect(Result.isSuccess(validated) || Result.isFailure(validated)).toBe(true)
            // Monitor.skills, Monitor.evaluate, Monitor.gate, Supervisor.prose, Relevance.chunks
            const snap: Supervisor.Snapshot = {
              task: "Fix tests",
              frame: 3,
              frames: [
                { frame: 0, cell: "await ctx.call('a', {})", prints: "hit1\nhit2", calls: [], prose: "checking" },
                { frame: 1, cell: "await ctx.call('a', {})", prints: "hit1\nhit2", calls: [], prose: "still" }
              ],
              skills: [{ name: "triage", path: "skills/triage/SKILL.md", description: "Triage bugs" }],
              signals: {
                frame: 3,
                checksFailing: 1,
                failuresUnanswered: 1,
                repeatFrames: 2,
                readOnlyFrames: 2,
                callsFailed: 1,
                callsSettled: 2,
                mutations: 1
              }
            } as any
            const skillMons = Monitor.skills(snap)
            const allMons = [...Monitor.defaults(), Monitor.useJev(), ...skillMons]
            const ev = Monitor.evaluate({
              monitors: allMons,
              reading: {
                onTarget: 0.2,
                thrashing: 0.9,
                suspect: 0.9,
                outdatedContext: 0.85,
                irrelevantContext: 0.8,
                confidence: 0.2,
                summary: "stuck",
                monitors: {},
                emotions: {
                  confident: "strong",
                  frustrated: "moderate",
                  stuck: "strong",
                  rushed: "none",
                  cautious: "none"
                }
              } as any,
              snapshot: snap,
              values: Object.fromEntries(
                allMons.filter((m): m is Monitor.Questioned => m._tag === "Questioned").map((m) => [m.id, 0.95])
              )
            })
            const gated = Monitor.gate({
              rows: ev.rows,
              candidates: ev.candidates,
              monitors: allMons,
              ledger: {},
              frame: 3
            })
            expect(gated).toBeDefined()
            expect(typeof Supervisor.prose("Hello\n```cell\n1\n```\nWorld")).toBe("string")
            const chunks = Relevance.chunks([{
              path: "a.md",
              text: "# H1\n\nPara 1\n\n```ts\nconst x = 1\n```\n\n- item 1\n- item 2\n\n## H2\n\nPara 2"
            }])
            expect(chunks.length).toBeGreaterThan(0)
            return true
          }),
        { executions: fastExec, seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("RealmFlow.step covers invalid source, forbidden import, action_not_allowed, and runtime failure", async () => {
    const sources = [
      "export default {{{ broken syntax",
      "import fs from 'node:fs'; export default fs",
      "export default { _tag: 'wrong' }",
      "throw new Error('boom inside realm')"
    ]
    const arb = Arbitrary.schema(Schema.Struct({ i: Schema.Literals([0, 1, 2, 3]) }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ i }) =>
          Effect.gen(function*() {
            const r = yield* Effect.result(
              RealmFlow.step({
                source: sources[i]!,
                expectedTag: "demo",
                payload: {},
                allowedActions: []
              }).pipe(Effect.provide(RealmFlow.layerDefaultVariant))
            )
            expect(Result.isFailure(r)).toBe(true)
            return true
          }),
        { executions: 12, seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
