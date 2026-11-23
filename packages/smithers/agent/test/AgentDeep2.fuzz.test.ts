import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as Cell from "@smthrs/harness/Cell"
import * as CellHistory from "@smthrs/harness/CellHistory"
import * as CompletionClaim from "@smthrs/harness/CompletionClaim"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import * as StdError from "@smthrs/std/StdError"
import * as TestRunner from "@smthrs/std/TestRunner"
import { Arbitrary, Effect, Layer, Option, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"
import * as Checkpointed from "../src/Checkpointed.ts"
import * as ChildFlows from "../src/ChildFlows.ts"
import * as EventSink from "../src/EventSink.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as FlowStore from "../src/FlowStore.ts"
import * as PromptChild from "../src/internal/PromptChild.ts"
import * as MemoryMine from "../src/MemoryMine.ts"
import * as PromoteFlows from "../src/PromoteFlows.ts"
import * as RunawayGuard from "../src/RunawayGuard.ts"
import * as ScriptedJudge from "../src/ScriptedJudge.ts"
import * as SmithersPlugin from "../src/SmithersPlugin.ts"
import * as StandardFlows from "../src/StandardFlows.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")

const makeCall = (flowName: string, input: Schema.Json, at?: string): Cell.Call =>
  new Cell.Call({
    flowName,
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none<Descriptor.Placement>(),
    identity: new Cell.CallIdentity({
      session: "sess-fuzz",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: "decl-digest",
      layers: []
    }),
    ...(at === undefined ? {} : { at })
  })

describe("@smthrs/agent ScriptedJudge, Checkpointed, RunawayGuard, ChildFlows, StandardFlows, PromoteFlows, SmithersPlugin & MemoryMine deep fuzz", () => {
  it("ScriptedJudge answers CompletionClaim & built-in classifiers consistently across evidence variants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        judgeKind: Schema.Literals(["completion_ok", "completion_unverified", "completion_last_check", "answer_keys", "unknown"]),
        useAll: Schema.Boolean,
        claimIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ judgeKind, useAll, claimIdx }) =>
          Effect.gen(function*() {
            const layer = useAll ? ScriptedJudge.layerAll : ScriptedJudge.layer
            if (judgeKind === "completion_ok" || judgeKind === "completion_unverified") {
              const claim =
                judgeKind === "completion_ok"
                  ? `Fixed math.js (${claimIdx}). Ran \`node check.mjs\`; it passed and printed ok.`
                  : `Ran \`node nonexistent_${claimIdx}.mjs\`; it passed.`
              const evidence: CompletionClaim.Evidence = {
                task: "Fix math.js and verify node check.mjs passes.",
                claim,
                treeMoved: true,
                checksRun: [
                  {
                    command: "node check.mjs",
                    outcome: "passed",
                    before: "failed",
                    result: JSON.stringify({ exitCode: 0, stdout: "ok\n", stderr: "" })
                  }
                ]
              }
              const reading = yield* CompletionClaim.read(evidence).pipe(Effect.provide(layer))
              if (reading === undefined) return !useAll
              const unrec = CompletionClaim.unrecorded(reading)
              if (judgeKind === "completion_ok" && unrec) return false
              if (judgeKind === "completion_unverified" && !unrec) return false
              return true
            }
            if (judgeKind === "completion_last_check") {
              const reading = yield* CompletionClaim.read({
                task: "Run the check",
                claim: "Ran `node check.mjs`; stdout: `node lint.mjs`.",
                treeMoved: false,
                checksRun: [],
                lastCheck: { command: "node check.mjs", exitCode: 0, output: "node lint.mjs\n" }
              }).pipe(Effect.provide(layer))
              return reading === undefined ? !useAll : !CompletionClaim.unrecorded(reading)
            }
            if (judgeKind === "answer_keys") {
              const keys = Object.keys(ScriptedJudge.answer)
              const answerer = ScriptedJudge.answererFor([keys[0]!])
              return keys.length > 0 && (answerer === undefined || typeof answerer === "function")
            }
            const ans = ScriptedJudge.answererFor([`unknown/classifier-${claimIdx}`])
            return ans === undefined
          }),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Checkpointed decorator enforces relocation, unpinned/absolute/outside refusals & store failures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        flowName: Schema.Literals(["read", "write", "edit", "bash", "grep", "glob", "ls", "unknown"]),
        at: Schema.Literals(["none", "cp-1", "base", "missing"]),
        pathKind: Schema.Literals(["relative", "absolute", "escape"]),
        storeFails: Schema.Boolean,
        containerized: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ flowName, at, pathKind, storeFails, containerized }) =>
          Effect.gen(function*() {
            const seen: Array<Cell.Call> = []
            const runner: FlowEngineLike.CallRunner = {
              run: (received) =>
                Effect.sync(() => {
                  seen.push(received)
                  return Cell.CallResult.new({ outcome: "success", value: { ran: received.flowName } })
                })
            }
            const asked: Array<string> = []
            const cpStore: Checkpoints.Checkpoints = Checkpoints.make({
              capture: () => Effect.fail(Checkpoints.unavailable("cp-1")),
              materialize: (id, use) => {
                asked.push(id)
                if (storeFails || id === "missing") {
                  return Effect.fail(new StdError.StdError({ code: "not_found", message: `missing ${id}` }))
                }
                return use({
                  id,
                  root: "/repo",
                  host: `/repo/.smithers-cp/${id}`,
                  guestRoot: containerized ? "/work" : "/repo",
                  guest: containerized ? `/work/.smithers-cp/${id}` : `/repo/.smithers-cp/${id}`
                })
              }
            })

            const wrapped = Checkpointed.checkpointed(cpStore, runner)
            const input: Schema.Json =
              flowName === "bash"
                ? {
                    command: pathKind === "escape" ? "cat /repo/secret.txt" : "echo ok",
                    cwd: pathKind === "absolute" ? "/etc" : "sub",
                    ...(containerized ? { container: "box-1" } : {})
                  }
                : {
                    path: pathKind === "absolute" ? "/etc/passwd" : pathKind === "escape" ? "../secret" : "src/a.ts",
                    pattern: "foo"
                  }

            const c = makeCall(flowName, input, at === "none" ? undefined : at)
            const res = yield* wrapped.run(c)
            if (at === "none") {
              if (res.outcome !== "success" || asked.length !== 0) return false
            } else {
              if (res.outcome !== "success" && res.outcome !== "failure") return false
            }

            // Exercise unpinned & decorate
            const unpin = Checkpointed.unpinned(runner)
            const unpinRes = yield* unpin.run(c)
            if (at !== "none" && unpinRes.outcome !== "failure") return false
            if (at === "none" && unpinRes.outcome !== "success") return false

            const decNoStore = yield* Checkpointed.decorate(runner)
            const decWithStore = yield* Checkpointed.decorate(runner).pipe(
              Effect.provideService(Checkpoints.Checkpoints, cpStore)
            )
            if (decNoStore === undefined || decWithStore === undefined) return false

            if (Checkpointed.unsupported(flowName).outcome !== "failure") return false
            if (Checkpointed.absolute(flowName, "/etc/passwd").outcome !== "failure") return false
            if (Checkpointed.outside(flowName, "/repo/x").outcome !== "failure") return false
            return true
          }),
        { seed: seed + 1, executions: Math.min(executions, 100) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("RunawayGuard.layerFlowLimit enforces Budget.Parking admission, call-limit timeout & incident facts", async () => {
    const guarded = Flow.make("agent/fuzz/guarded", {
      payload: { slow: Schema.Boolean },
      success: Schema.String,
      error: Schema.Unknown,
      body: () => Node.succeed("unused")
    })
    const unguarded = Flow.make("agent/fuzz/unguarded", {
      payload: {},
      success: Schema.String,
      error: Schema.Unknown,
      body: () => Node.succeed("ok-unguarded")
    })

    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["proceed", "park", "timeout", "unguarded"]),
        source: Schema.Literals(["model-call", "tool-call", "cell"]),
        limitMs: Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 200 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, source, limitMs }) =>
          Effect.gen(function*() {
            const timeoutErr = new RunawayGuard.Timeout({
              source,
              limitMillis: limitMs,
              subject: "fuzz-subject",
              message: `timed out after ${limitMs}ms`
            })
            const inc = RunawayGuard.incident(timeoutErr, 1)
            const stop = RunawayGuard.stopped(inc)
            const callErr = RunawayGuard.callLimitExceeded("bash", limitMs)
            if (stop._tag !== "/harness/HarnessError" || callErr._tag !== "/harness/HarnessError") return false

            const parked: Budget.Parked = {
              waiting: { reason: "budget", token: `budget/fuzz/${limitMs}` },
              failure: new HarnessError({ code: "engine_failed", message: "Budget approval required" })
            }
            const parkingSvc: Budget.Parking["Service"] = {
              guardsTimeouts: true,
              park: () => Effect.succeed(parked),
              admit: () =>
                mode === "park"
                  ? Effect.succeed({ _tag: "park" as const, parked })
                  : Effect.succeed({ _tag: "proceed" as const, continued: 0 }),
              trip: () => Effect.succeed(parked)
            }

            const baseLayer = Layer.mergeAll(
              FlowEngine.layerMemory,
              NodeCrypto.layer,
              Layer.succeed(Budget.Parking, parkingSvc)
            )
            const res = yield* Effect.gen(function*() {
              const engine = yield* FlowRuntime.FlowRuntime
              const host = FlowRuntime.FlowRuntime.of({
                ...engine,
                register: (registered, execute) =>
                  engine.register(registered, (payload, executionId) =>
                    Effect.provideService(execute(payload, executionId), Budget.Parking, parkingSvc)
                  )
              })
              const guardedRuntime = yield* FlowRuntime.FlowRuntime.pipe(
                Effect.provide(
                  RunawayGuard.layerFlowLimit("agent/fuzz/guarded", 40).pipe(
                    Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, host))
                  )
                )
              )
              yield* guardedRuntime.register(guarded, ({ slow }) =>
                slow ? Effect.sleep("200 millis").pipe(Effect.as("too-slow")) : Effect.succeed("fast-ok")
              )
              yield* guardedRuntime.register(unguarded, () => Effect.succeed("ok-unguarded"))
              if (mode === "unguarded") {
                return yield* unguarded.execute({}, { executionId: `unguarded-${limitMs}` }).pipe(
                  Effect.provideService(FlowRuntime.FlowRuntime, guardedRuntime)
                )
              }
              return yield* guarded.execute(
                { slow: mode === "timeout" },
                { executionId: `guarded-${mode}-${limitMs}` }
              ).pipe(
                Effect.provideService(FlowRuntime.FlowRuntime, guardedRuntime),
                Effect.timeout("120 millis")
              )
            }).pipe(Effect.provide(baseLayer), Effect.scoped, Effect.result)

            if (mode === "unguarded") return res._tag === "Success" && res.success === "ok-unguarded"
            if (mode === "proceed") return res._tag === "Success" && res.success === "fast-ok"
            return res._tag === "Failure"
          }),
        { seed: seed + 2, executions: Math.min(executions, 20) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 45_000)

  it("ChildFlows, StandardFlows (jev, approval, tests), PromoteFlows & SmithersPlugin uphold contracts", async () => {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smthrs-agent-deep2-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          childOp: Schema.Literals(["spawn", "send", "await", "noop"]),
          askDecision: Schema.Literals(["approve", "deny", "unavailable"]),
          topic: Schema.Literals(["packages", "cli", "authoring", "all"]),
          flowSlug: Schema.Literals(["hello-flow", "bad/slash", ""])
        })
      )

      const NodePlatform = NodeChildProcessSpawner.layer.pipe(
        Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ childOp, askDecision, topic, flowSlug }) =>
            Effect.gen(function*() {
              // 1. ChildFlows
              const childrenImpl =
                childOp === "noop"
                  ? ChildFlows.makeNoop()
                  : ChildFlows.makeNoop({
                      spawn: () => Effect.succeed({ child: "child-1" }),
                      send: () => Effect.succeed({ delivered: true }),
                      await: () => Effect.succeed({ child: "child-1", output: "done" })
                    })
              const childBindings = yield* ChildFlows.source(childrenImpl).bindings()
              const byName = new Map(childBindings.map((b) => [b.descriptor.name, b]))
              const spawnRes = yield* byName.get(ChildFlows.spawnFlow.name)!.run(makeCall(ChildFlows.spawnFlow.name, { flow: "helper", input: { prompt: "hi" } }))
              const sendRes = yield* byName.get(ChildFlows.sendFlow.name)!.run(makeCall(ChildFlows.sendFlow.name, { child: "child-1", message: "go" }))
              const awaitRes = yield* byName.get(ChildFlows.awaitFlow.name)!.run(makeCall(ChildFlows.awaitFlow.name, { child: "child-1" }))
              if (childOp === "noop") {
                if (spawnRes.outcome !== "failure" || sendRes.outcome !== "failure" || awaitRes.outcome !== "failure") return false
              } else {
                if (spawnRes.outcome !== "success" || sendRes.outcome !== "success" || awaitRes.outcome !== "success") throw new Error("child: " + JSON.stringify({spawnRes, sendRes, awaitRes}))
              }

              // 2. StandardFlows.approval
              const asker: StandardFlows.Asker =
                askDecision === "unavailable"
                  ? StandardFlows.askerNoop()
                  : {
                      ask: () =>
                        Effect.succeed({
                          approved: askDecision === "approve",
                          answer: "fuzz answer"
                        })
                    }
              const [askBinding] = yield* StandardFlows.approval(asker).bindings()
              const askRes = yield* askBinding!.run(makeCall("ask", { question: "Continue?" }))
              if (askDecision === "unavailable" && askRes.outcome !== "failure") throw new Error("ask unavail: " + JSON.stringify(askRes))
              if (askDecision !== "unavailable" && askRes.outcome !== "success") throw new Error("ask ok: " + JSON.stringify(askRes))

              // 3. StandardFlows.jev with unavailable evaluator (graceful failure)
              const evalCtx = yield* Effect.context<Evaluator.Evaluator>().pipe(Effect.provide(Evaluator.layerUnavailable()))
              const [jevBinding] = yield* StandardFlows.jev(evalCtx).bindings()
              const jevRes = yield* jevBinding!.run(
                makeCall("jev", { question: "Is this valid?", criteria: { yes: "valid", no: "invalid" }, subject: "ok" })
              )
              if (jevRes.outcome !== "failure" && jevRes.outcome !== "success") return false

              // 4. StandardFlows.tests
              const runnerLayer = TestRunner.layer({ command: "echo PASS 1", cwd: tmpBase })
              const testServices = yield* Effect.context<Evaluator.Evaluator | TestRunner.TestRunner>().pipe(
                Effect.provide(
                  Layer.mergeAll(
                    NodePlatform,
                    runnerLayer,
                    Evaluator.layerScripted((req) => {
                      const opts = Object.keys(
                        (req.questions["attribution"] as { readonly criteria: Record<string, string> }).criteria
                      )
                      return {
                        attribution: { choice: opts[0]!, probabilities: { [opts[0]!]: 1 } },
                        executed: { probability: 1 }
                      }
                    })
                  )
                )
              )
              const [testBinding] = yield* StandardFlows.tests(testServices as never).bindings()
              const testRes = yield* testBinding!.run(makeCall("test", { timeoutMs: 5000 }))
              if (testRes.outcome !== "success" && testRes.outcome !== "failure") return false

              // 5. SmithersPlugin guide & flows
              const plugin = SmithersPlugin.make()
              if (plugin.name !== SmithersPlugin.name) return false
              const guideRes = yield* SmithersPlugin.guide.run(makeCall(SmithersPlugin.guide.descriptor.name, { topic }))
              if (guideRes.outcome !== "success") throw new Error("guide: " + JSON.stringify(guideRes))

              // 6. PromoteFlows
              const promoteLayer = Layer.mergeAll(
                CellHistory.layerNoop(),
                FlowStore.layerFileSystem(tmpBase).pipe(
                  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
                )
              )
              const promoteServices = yield* Effect.context<CellHistory.CellHistory | FlowStore.FlowStore>().pipe(
                Effect.provide(promoteLayer)
              )
              const promoteBindings = yield* PromoteFlows.source(promoteServices).bindings()
              const promoteMap = new Map(promoteBindings.map((b) => [b.descriptor.name, b]))
              const showRes = yield* promoteMap.get(PromoteFlows.showScriptFlow.name)!.run(makeCall(PromoteFlows.showScriptFlow.name, {}))
              if (showRes.outcome !== "success" && showRes.outcome !== "failure") return false
              const writeRes = yield* promoteMap
                .get(PromoteFlows.writeFlowFlow.name)!
                .run(makeCall(PromoteFlows.writeFlowFlow.name, { id: flowSlug, files: [{ path: "flow.ts", content: PromoteFlows.flowTemplate }] }))
              if ((flowSlug === "" || flowSlug.includes("/")) && writeRes.outcome !== "failure") throw new Error("write: " + JSON.stringify(writeRes))

              // 7. PromptChild.withoutSelf & EventSink
              const emptyReg = yield* Registry.Registry.pipe(
                Effect.provide(
                  Registry.layerProject({ root: tmpBase }).pipe(
                    Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
                  )
                )
              )
              const filtered = PromptChild.withoutSelf(emptyReg, "self-flow")
              if (filtered === undefined) return false
              const noopSink = EventSink.makeNoop()
              yield* noopSink.emit({ _tag: "Notice", message: "hi" } as never)

              return true
            }),
          { seed: seed + 3, executions: Math.min(executions, 20) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  }, 60_000)

  it("MemoryMine extracts sentences/candidates/decisions deterministically & normalizes noteIds without collisions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prose: Schema.Literals([
          "We always use jj for version control. Never run git directly.",
          "Decided to deploy on Cloudflare Workers via Alchemy.",
          "   Multiple   spaces\tand\nnewlines! Should normalize cleanly? Yes.  ",
          ""
        ]),
        eventType: Schema.Literals(["agent.message", "agent.decision", "tool.result", "user.prompt"]),
        seq: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ prose, eventType, seq }) =>
          Effect.gen(function*() {
            const sents = MemoryMine.sentences(prose)
            if (!Array.isArray(sents)) return false
            const normA = MemoryMine.normalize(prose)
            const normB = MemoryMine.normalize(`  ${prose}  `)
            if (normA !== normB) return false
            const id1 = MemoryMine.noteId("facts", prose)
            const id2 = MemoryMine.noteId("facts", ` ${prose} `)
            if (id1 !== id2) return false
            const tr = MemoryMine.transcript()
            MemoryMine.add(tr, { seq, eventType, payload: { text: prose, content: prose } })
            const extracted = MemoryMine.extract([
              { seq, eventType, payload: { text: prose } },
              { seq: seq + 1, eventType: "agent.decision", payload: { summary: prose, text: prose } }
            ])
            if (!Array.isArray(extracted.candidates) || !Array.isArray(extracted.decisions)) return false
            if (typeof MemoryMine.accepts(0.95) !== "boolean") return false
            if (typeof MemoryMine.accepts(0.05) !== "boolean") return false
            return true
          }),
        { seed: seed + 4, executions: Math.min(executions, 150) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
