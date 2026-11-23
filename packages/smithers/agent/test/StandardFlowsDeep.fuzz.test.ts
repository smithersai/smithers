import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Context, Effect, Logger, Option, Schema } from "effect"
import * as Path from "effect/Path"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as StandardFlows from "../src/StandardFlows.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "50")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261134")
const silentLogger = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeCall = (flowName: string, input: Schema.Json = {}): Cell.Call =>
  new Cell.Call({
    flowName,
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({ session: "sf-sess", frame: 0, cell: "c0", ordinal: 0, declaration: "d0", layers: [] })
  })

describe("@smthrs/agent StandardFlows Deep Fuzz (jev, clock, approval, shell)", () => {
  it("StandardFlows.jev fuzzes empty questions, state byte cap, unavailable evaluator, and scripted responses", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["emptyQuestions", "oversizedState", "unavailable", "ok"]),
        maxStateBytes: Schema.Literals([64, 4096])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            const evalLayer = c.mode === "unavailable"
              ? Evaluator.layerUnavailable()
              : Evaluator.layerScripted(((req: Evaluator.Request) => {
                const out: Record<string, unknown> = {}
                for (const [qName, q] of Object.entries(req.questions)) {
                  const crits = Array.isArray(q.criteria) ? (q.criteria as ReadonlyArray<string>) : Object.keys(q.criteria as Record<string, unknown>)
                  out[qName] = { choice: crits[0]!, confidence: 0.9 }
                }
                return out as any
              }) as any)

            const evaluator = yield* Evaluator.Evaluator.pipe(Effect.provide(evalLayer))
            const src = StandardFlows.jev(Context.make(Evaluator.Evaluator, evaluator), { maxStateBytes: c.maxStateBytes })
            const cat = yield* FlowBinding.catalog([src])
            const binding = cat.bindings.get("jev")!

            const input: Schema.Json = c.mode === "emptyQuestions"
              ? { state: { a: 1 }, questions: {} }
              : c.mode === "oversizedState"
              ? { state: { big: "x".repeat(c.maxStateBytes + 200) }, questions: { q1: { type: "choice", instructions: "pick one", criteria: { yes: "y", no: "n" } } } }
              : { state: { msg: "ok" }, questions: { q1: { type: "choice", instructions: "pick one", criteria: { yes: "y", no: "n" } } } }

            const res = yield* binding.run(makeCall("jev", input))
            if (c.mode === "ok" && res.outcome !== "success") throw new Error("jev_ok: " + JSON.stringify(res)); if (c.mode === "ok") return true
            return res.outcome === "failure"
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("StandardFlows.clock, approval & shell agent-terminal refusal fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        waitSeconds: Schema.Literals([-1, 0, 120, 5000]),
        maxSeconds: Schema.Literals([10, 300]),
        askerKind: Schema.Literals(["noop", "approve", "reject"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            const cryptoCtx = yield* Effect.scoped(Effect.context<never>().pipe(Effect.provide(NodeCrypto.layer)))
            const clkServices = cryptoCtx.pipe(
              Context.add(FlowRuntime.FlowRuntime, {} as any),
              Context.add(FlowRuntime.FlowInstance, {} as any)
            )
            const clkSrc = StandardFlows.clock(clkServices as any, { maxSeconds: c.maxSeconds })
            const clkCat = yield* FlowBinding.catalog([clkSrc])
            const waitBinding = clkCat.bindings.get(StandardFlows.waitFlow.name)!

            if (c.waitSeconds < 0 || c.waitSeconds > c.maxSeconds) {
              const res = yield* waitBinding.run(makeCall(StandardFlows.waitFlow.name, { seconds: c.waitSeconds }))
              if (res.outcome !== "failure") return false
            }

            const asker: StandardFlows.Asker = c.askerKind === "noop"
              ? StandardFlows.askerNoop()
              : {
                ask: (input) =>
                  Effect.succeed({
                    approved: c.askerKind === "approve",
                    answer: `${c.askerKind}:${input.question}`
                  })
              }
            const appSrc = StandardFlows.approval(asker)
            const appCat = yield* FlowBinding.catalog([appSrc])
            const askBinding = appCat.bindings.get(StandardFlows.askFlow.name)!
            const askRes = yield* askBinding.run(makeCall(StandardFlows.askFlow.name, { question: "proceed?" }))
            if (c.askerKind === "noop" && askRes.outcome !== "failure") return false
            if (c.askerKind !== "noop" && askRes.outcome !== "success") return false

            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)

    // Exercise StandardFlows.shell with terminal: "agent" and no terminalPort -> AgentTerminal.unavailable
    await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const path = yield* Path.Path
        const shellServices = Context.make(ChildProcessSpawner.ChildProcessSpawner, spawner).pipe(
          Context.add(Path.Path, path)
        )
        const shSrc = StandardFlows.shell(shellServices, undefined, { terminal: "agent" })
        const shCat = yield* FlowBinding.catalog([shSrc])
        const bashBinding = shCat.bindings.get("bash")!
        const res = yield* bashBinding.run(makeCall("bash", { command: "echo hi" }))
        expect(res.outcome).toBe("failure")
      }).pipe(
        Effect.provide(NodeChildProcessSpawner.layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
        Effect.provide(silentLogger)
      )
    )
  })
})
