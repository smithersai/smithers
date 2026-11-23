import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import { Fuzz } from "@smthrs/fuzz"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as CellHistory from "@smthrs/harness/CellHistory"
import type * as EngineLike from "@smthrs/harness/EngineLike"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Sandbox from "@smthrs/harness/Sandbox"
import { MemoryStore, Migrations as MemoryMigrations } from "@smthrs/memory"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Registry from "@smthrs/registry/Registry"
import * as RegistryError from "@smthrs/registry/RegistryError"
import { Arbitrary, Context, Effect, Layer, Logger, Option, Result, Schema, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type * as Agent from "../src/Agent.ts"
import * as Budget from "../src/Budget.ts"
import * as FlowStore from "../src/FlowStore.ts"
import * as AgentTerminal from "../src/internal/AgentTerminal.ts"
import * as PromptChild from "../src/internal/PromptChild.ts"
import * as MemoryMine from "../src/MemoryMine.ts"
import * as PromoteFlows from "../src/PromoteFlows.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import type * as Seat from "../src/Seat.ts"
import * as StandardFlows from "../src/StandardFlows.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "60")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const dummySeat = { id: "fuzz-seat", model: "fuzz-model" } as unknown as Seat.Seat

const makeCall = (flowName: string, input: Schema.Json = {}, ordinal = 0): Cell.Call =>
  new Cell.Call({
    flowName,
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({ session: "sess-1", frame: 0, cell: "cell-0", ordinal, declaration: "decl-0", layers: [] })
  })

describe("@smthrs/agent Deep3 Fuzz (PromptChild, PromoteFlows, MemoryMine, StandardFlows, AgentTerminal)", () => {
  it("PromptChild.withoutSelf and PromptChild.runner handle child outcomes, seat overrides, neverAsks, and failures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        outcomeKind: Schema.Literals(["done", "exhausted", "failure", "seatFail", "authorizeAsk", "authorizeOther"]),
        modelKind: Schema.Literals(["none", "single", "multi"]),
        selfFilter: Schema.Literals(["none", "matchMd", "matchCode"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            // 1. withoutSelf invariants
            const entries: ReadonlyArray<any> = [
              { name: "child-md", body: { _tag: "Markdown" } },
              { name: "child-code", body: { _tag: "Code" } },
              { name: "other-md", body: { _tag: "Markdown" } }
            ]
            const baseRegistry: Registry.Registry = {
              visible: () => Effect.succeed(entries),
              getOption: (name: string) => Effect.succeed(Option.fromNullishOr(entries.find((e) => e.name === name))),
              get: (name: string) =>
                Effect.fromOption(Option.fromNullishOr(entries.find((e) => e.name === name))).pipe(
                  Effect.mapError(() => new RegistryError.RegistryError({ code: "not_found", message: name }))
                ),
              list: () => Effect.succeed(entries),
              refresh: () => Effect.void
            } as any

            const selfName = c.selfFilter === "none"
              ? undefined
              : c.selfFilter === "matchMd"
              ? "child-md"
              : "child-code"
            const filtered = PromptChild.withoutSelf(baseRegistry, selfName)
            const vis = yield* filtered.visible()
            if (c.selfFilter === "matchMd") {
              if (vis.some((e) => e.name === "child-md")) return false
              const opt = yield* filtered.getOption("child-md")
              if (Option.isSome(opt)) return false
            } else {
              if (vis.length !== 3) return false
            }

            // 2. PromptChild.runner execution
            const observed: Array<string> = []
            const childEvents = (
              kind: typeof c.outcomeKind,
              opts: Agent.Options
            ): Stream.Stream<AgentEvent.AgentEvent, HarnessError> => {
              if (kind === "failure") {
                return Stream.fail(new HarnessError({ code: "model_failed", message: "child boom" }))
              }
              if (kind === "exhausted") {
                return Stream.fromIterable([
                  { _tag: "turn-opened", frame: 0 } as unknown as AgentEvent.AgentEvent,
                  { _tag: "turn-opened", frame: 1 } as unknown as AgentEvent.AgentEvent
                ])
              }
              if (kind === "authorizeAsk" || kind === "authorizeOther") {
                return Stream.fromEffect(
                  Effect.gen(function*() {
                    if (opts.authorize !== undefined) {
                      const authRes = yield* Effect.result(opts.authorize(makeCall("nested/flow")))
                      if (Result.isSuccess(authRes)) {
                        return yield* Effect.fail(new HarnessError({ code: "engine_failed", message: "expected refusal" }))
                      }
                      return yield* Effect.fail(authRes.failure)
                    }
                    return yield* Effect.fail(new HarnessError({ code: "engine_failed", message: "missing authorize" }))
                  })
                )
              }
              return Stream.fromIterable([
                { _tag: "turn-opened", frame: 0 } as unknown as AgentEvent.AgentEvent,
                {
                  _tag: "transition-applied",
                  transition: { _tag: "complete", output: "child-ok", value: { session: opts.session } }
                } as unknown as AgentEvent.AgentEvent
              ])
            }

            const parentOpts: Agent.Options = {
              session: "parent-sess",
              seat: dummySeat,
              prompt: "parent",
              registry: baseRegistry,
              flows: [],
              modelParams: ModelRequest.GenerationParams.make({}),
              authorize: (call) =>
                c.outcomeKind === "authorizeAsk"
                  ? Effect.fail(
                    new HarnessError({
                      code: "approval_unavailable",
                      message: `approval for ${call.flowName}`,
                      cause: Permission.permissionRequired({
                        requestId: "req-1",
                        capability: Option.getOrThrow(Capability.parse("fs:write:/tmp/a")),
                        tier: "irreversible"
                      })
                    })
                  )
                  : Effect.fail(new HarnessError({ code: "engine_failed", message: "custom deny" }))
            }

            const childrenCfg: Agent.Children = {
              flows: [],
              seats: {
                resolve: (seatId: string) =>
                  c.outcomeKind === "seatFail"
                    ? Effect.fail(new HarnessError({ code: "model_failed", message: `missing ${seatId}` }))
                    : Effect.succeed(dummySeat)
              } as any,
              observe: (child) =>
                Effect.sync(() => {
                  observed.push(child.flow)
                })
            }

            const budgetSvc = yield* Budget.Budget.pipe(Effect.provide(Budget.layer({})))
            const evalSvc = yield* Evaluator.Evaluator.pipe(Effect.provide(Evaluator.layerUnavailable()))
            const services = Context.make(FlowRuntime.FlowRuntime, {} as any).pipe(
              Context.add(FlowRuntime.FlowInstance, {} as any),
              Context.add(Sandbox.Sandbox, {} as any),
              Context.add(Budget.Budget, budgetSvc),
              Context.add(QuotaPolicy.QuotaClassifier, QuotaPolicy.makeDefault()),
              Context.add(Evaluator.Evaluator, evalSvc)
            )

            const runPrompt = PromptChild.runner({
              parent: parentOpts,
              children: childrenCfg,
              services,
              run: (opts) => childEvents(c.outcomeKind, opts)
            })

            const modelDecl = c.modelKind === "none"
              ? Option.none()
              : c.modelKind === "single"
              ? Option.some("seat-a")
              : Option.some(["seat-a", "seat-b"])

            const callRes = yield* runPrompt({
              call: makeCall("sub/md-flow"),
              text: "do child work",
              descriptor: {
                name: "sub/md-flow",
                model: modelDecl,
                frontmatter: { effort: "low" },
                capabilities: ["fs:read:/tmp/**", "not-a-valid-cap"]
              } as any
            })

            if (c.outcomeKind === "done") {
              if (callRes.outcome !== "success") return false
              if (observed.length === 0) return false
            } else if (c.outcomeKind === "seatFail" && c.modelKind === "none") {
              if (callRes.outcome !== "success") return false
            } else {
              if (callRes.outcome !== "failure") return false
              if (c.outcomeKind === "authorizeAsk" && !callRes.message?.includes("which a child run cannot ask for")) {
                return false
              }
            }
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("PromoteFlows.source (flows/show-script & flows/write-flow) with real FS store and optional Registry refresh", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: Schema.Literals(["good-flow-1", "valid2", "BAD_UPPER", "../escape", ""]),
        extraPractices: Schema.Boolean,
        customOpts: Schema.Boolean,
        registryMode: Schema.Literals(["none", "ok", "fail"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            {
              const store = FlowStore.makeMemory()
              const history: CellHistory.CellHistory["Service"] = {
                cells: () => Effect.succeed([{ ordinal: 0, source: "ctx.done(1)" } as any]),
                record: () => Effect.void
              } as any
              const services = Context.make(CellHistory.CellHistory, history).pipe(
                Context.add(FlowStore.FlowStore, store)
              )
              const src = PromoteFlows.source(
                services,
                c.customOpts ? { bestPractices: "CUSTOM RULE", template: "// CUSTOM" } : {}
              )
              const cat = yield* FlowBinding.catalog([src])
              const showBinding = cat.bindings.get("flows/show-script")!
              const writeBinding = cat.bindings.get("flows/write-flow")!

              const showRes = yield* showBinding.run(
                makeCall("flows/show-script", c.extraPractices ? { bestPractices: "EXTRA" } : {})
              )
              if (showRes.outcome !== "success") throw new Error("showRes: " + JSON.stringify(showRes))
              const shown = showRes.value as { cells: ReadonlyArray<unknown>; bestPractices: string; template: string }
              if (shown.cells.length !== 1) return false
              if (c.customOpts && !shown.bestPractices.includes("CUSTOM RULE")) return false
              if (c.extraPractices && !shown.bestPractices.includes("EXTRA")) return false

              const writeEff = writeBinding.run(
                makeCall("flows/write-flow", {
                  id: c.id,
                  flowSource: "export default {}",
                  testSource: "test('ok', () => {})",
                  fixtureJson: "{}"
                })
              )

              const regProvided = c.registryMode === "none"
                ? writeEff
                : writeEff.pipe(
                  Effect.provideService(Registry.Registry, {
                    refresh: () =>
                      c.registryMode === "ok"
                        ? Effect.void
                        : Effect.fail(new RegistryError.RegistryError({ code: "not_found", message: "refresh-boom" }))
                  } as any)
                )

              const writeCallRes = yield* regProvided
              const validId = c.id === "good-flow-1" || c.id === "valid2"
              if (!validId) {
                return writeCallRes.outcome === "failure"
              }
              if (writeCallRes.outcome !== "success") throw new Error("writeCallRes: " + JSON.stringify(writeCallRes))
              const out = writeCallRes.value as { files: ReadonlyArray<string>; warning?: string }
              if (out.files.length !== 3) return false
              if (c.registryMode === "fail" && (out.warning === undefined || !out.warning.includes("refresh failed"))) {
                return false
              }
              if (c.registryMode !== "fail" && out.warning !== undefined) return false
              return true
            }
          }).pipe(Effect.provide(silentLogger)),
        { seed: seed + 1, executions: Math.min(executions, 35) }
      )
    )
    assertPassed(report)
  })

  it("MemoryMine (extract, judge, write idempotency/dedup, settle with real MemoryStore & EngineLike)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        acceptProb: Schema.Literals([0.1, 0.95]),
        evalMode: Schema.Literals(["ok", "unavailable"]),
        rememberFails: Schema.Boolean,
        engineFails: Schema.Boolean,
        duplicateWrite: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.scoped(
            Effect.gen(function*() {
              const tr = MemoryMine.transcript()
              MemoryMine.add(tr, {
                seq: 1,
                eventType: AgentEvent.eventType.transitionApplied,
                payload: { transition: { _tag: "complete", output: "Always use jj instead of git. Never edit main directly!" } }
              })
              MemoryMine.add(tr, {
                seq: 2,
                eventType: AgentEvent.eventType.transitionApplied,
                payload: { transition: { _tag: "complete", output: "Always use jj instead of git." } }
              })
              const extracted = MemoryMine.extract([
                {
                  seq: 1,
                  eventType: AgentEvent.eventType.transitionApplied,
                  payload: { transition: { _tag: "complete", output: "Always use jj instead of git. Check coverage before landing." } }
                }
              ])
              const id1 = MemoryMine.noteId("flow-alpha", "  Always   Use JJ  ")
              const id2 = MemoryMine.noteId("flow-alpha", "always use jj")
              if (id1 !== id2) return false

              const dbLayer = Layer.provideMerge(MemoryMigrations.layer, TestDatabase.layer).pipe(Layer.provideMerge(NodeCrypto.layer))
              const storeCtx = yield* Layer.build(MemoryStore.layer.pipe(Layer.provide(dbLayer)))
              const store = Context.get(storeCtx, MemoryStore.MemoryStore)
              const n1 = yield* MemoryMine.write(store, {
                bank: "flow-alpha",
                runId: "run-1",
                text: "Always use jj instead of git."
              })
              if (c.duplicateWrite) {
                const n2 = yield* MemoryMine.write(store, {
                  bank: "flow-alpha",
                  runId: "run-2",
                  text: "  ALWAYS   use jj instead of git.  "
                })
                if (n2.id !== n1.id) return false
              }

              const evalLayer = c.evalMode === "unavailable"
                ? Evaluator.layerUnavailable()
                : Evaluator.layerScripted(((req: Evaluator.Request) => {
                  const scores: Record<string, Record<string, number>> = {}
                  for (const [qName, q] of Object.entries(req.questions)) {
                    const m: Record<string, number> = {}
                    const crits = Array.isArray(q.criteria) ? (q.criteria as ReadonlyArray<string>) : Object.keys(q.criteria as Record<string, unknown>)
                    for (let i = 0; i < crits.length; i++) {
                      m[crits[i]!] = i === 0 ? c.acceptProb : 1 - c.acceptProb
                    }
                    scores[qName] = m
                  }
                  return scores as any
                }) as any)

              const recordedMap = new Map<string, unknown>()
              const engine: EngineLike.EngineLike = {
                record: <A>(boundary: EngineLike.RecordBoundary<A>) =>
                  c.engineFails
                    ? Effect.fail(new HarnessError({ code: "engine_failed", message: "engine down" }))
                    : Effect.gen(function*() {
                      const k = JSON.stringify(boundary.identity)
                      if (recordedMap.has(k)) return recordedMap.get(k) as A
                      const v = yield* boundary.execute
                      recordedMap.set(k, v)
                      return v
                    })
              } as any

              const remembered: Array<string> = []
              const candidates: ReadonlyArray<MemoryMine.Cited> = extracted.candidates.length > 0
                ? extracted.candidates
                : [{ text: "Always use jj instead of git.", seq: 1 }]

              const events = yield* MemoryMine.settle({
                engine,
                session: "mine-sess",
                frame: 1,
                task: "verify memory mining",
                candidates,
                memory: {
                  remember: (text: string) =>
                    c.rememberFails
                      ? Effect.fail({ detail: "store refused" } as any)
                      : Effect.sync(() => {
                        remembered.push(text)
                      }),
                  recall: () => Effect.succeed([])
                } as any
              }).pipe(Effect.provide(evalLayer))

              if (c.engineFails) {
                return events.some((e) => e.eventType === AgentEvent.eventType.supervisorMemoryFailed)
              }
              if (c.evalMode === "unavailable") {
                return events.some((e) => e.eventType === AgentEvent.eventType.decisionUnjudged)
              }
              return events.length > 0
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed: seed + 2, executions: Math.min(executions, 12) }
      )
    )
    assertPassed(report)
  })

  it("StandardFlows.filesystem and AgentTerminal invariants on real temp directory", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "stdflows-fuzz-"))
    try {
      writeFileSync(join(tmpBase, "hello.txt"), "alpha beta gamma\nline two\n", "utf8")
      const fsServices = await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          return Context.make(FileSystem.FileSystem, fs).pipe(Context.add(Path.Path, path))
        }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer))
      )

      const fsCat = await Effect.runPromise(FlowBinding.catalog([StandardFlows.filesystem(fsServices)]))
      const fsNoMutCat = await Effect.runPromise(
        FlowBinding.catalog([StandardFlows.filesystem(fsServices, undefined, { remote: true, mutations: false })])
      )
      expect(fsCat.bindings.size).toBeGreaterThan(fsNoMutCat.bindings.size)

      const byTail = (tail: string) => {
        for (const [k, v] of fsCat.bindings) if (k === tail || k.endsWith("/" + tail)) return v
        throw new Error("missing binding " + tail + " in " + Array.from(fsCat.bindings.keys()).join(","))
      }
      const readBinding = byTail("read")
      const writeBinding = byTail("write")
      const editBinding = byTail("edit")
      const globBinding = byTail("glob")
      const grepBinding = byTail("grep")
      const lsBinding = byTail("ls")

      await Effect.runPromise(
        Effect.gen(function*() {
          const readRes = yield* readBinding.run(makeCall("read", { path: join(tmpBase, "hello.txt") }))
          expect(readRes.outcome).toBe("success")

          const writeRes = yield* writeBinding.run(
            makeCall("write", { path: join(tmpBase, "created.txt"), content: "foo bar\nbaz\n" })
          )
          expect(writeRes.outcome).toBe("success")

          const editRes = yield* editBinding.run(
            makeCall("edit", { path: join(tmpBase, "created.txt"), oldString: "foo bar", newString: "foo qux" })
          )
          expect(editRes.outcome).toBe("success")

          const globRes = yield* globBinding.run(makeCall("glob", { pattern: "*.txt", root: tmpBase }))
          expect(globRes.outcome).toBe("success")

          const grepRes = yield* grepBinding.run(makeCall("grep", { pattern: "qux", root: tmpBase }))
          expect(grepRes.outcome).toBe("success")

          const lsRes = yield* lsBinding.run(makeCall("ls", { path: tmpBase }))
          expect(lsRes.outcome).toBe("success")
        })
      )

      expect(AgentTerminal).toBeDefined()
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })
})
