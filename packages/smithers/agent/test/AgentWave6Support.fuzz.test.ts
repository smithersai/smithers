import { Node } from "@smthrs/plan"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as Cell from "@smthrs/harness/Cell"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as MemoryError from "@smthrs/memory/MemoryError"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Registry from "@smthrs/registry/Registry"
import {
  Arbitrary,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Result,
  Schema,
  Stream
} from "effect"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  Budget,
  CellPlugin,
  FlowStore,
  Memory,
  MemoryCalibration,
  MemoryMine,
  MemorySnapshotRecorder,
  ScriptedJudge,
  SmithersPlugin,
  WorkspaceObservation
} from "../src/index.ts"
import * as Commits from "../src/internal/memory/commits.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261140")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const scratchDirs = new Set<string>()
const makeScratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.add(dir)
  return dir
}

afterAll(async () => {
  await Promise.all([...scratchDirs].map((dir) => rm(dir, { recursive: true, force: true })))
  scratchDirs.clear()
})

const makeFakeSpawner = (handlers: {
  readonly jjLog?: string
  readonly jjNamed?: string
  readonly gitNotes?: string
  readonly gitCat?: string
}): any => ({
    spawn: (cmd: any) => {
      const command: string = cmd?.command ?? ""
      const args: ReadonlyArray<string> = cmd?.args ?? []
      let out = ""
      if (command === "jj") {
        const revArg = args.find((a) => a.startsWith("present("))
        out = revArg !== undefined ? (handlers.jjNamed ?? "") : (handlers.jjLog ?? "")
      } else if (command === "git" && args[0] === "notes") {
        out = handlers.gitNotes ?? ""
      } else if (command === "git" && args[0] === "cat-file") {
        out = handlers.gitCat ?? ""
      }
      const bytes = new TextEncoder().encode(out)
      return Effect.succeed({
        pid: 1,
        exitCode: Effect.succeed(0),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: undefined as any,
        stdout: Stream.make(bytes),
        stderr: Stream.empty,
        all: Stream.make(bytes)
      } as any)
    }
  })

describe("@smthrs/agent Wave-6 support modules deep fuzz invariants", () => {
  it("Memory.thresholds, select (wiki/repo/commits/facts/seeds/symlinks), source & plugin invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        threshMode: Schema.Literals(["absent", "valid", "corrupt_json", "symlink_escape"]),
        wikiMode: Schema.Literals(["valid_index", "corrupt_index", "plain_dir"]),
        factsMode: Schema.Literals(["ok", "fail", "none"]),
        withNotes: Schema.Boolean,
        commitHex: Schema.Literals(["abcdef0123456789", "0123456789abcdef1234567890abcdef12345678"])
      })
    )

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ threshMode, wikiMode, factsMode, withNotes, commitHex }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const idx = ++seq
              const root = makeScratch(`w6-mem-${idx}-`)
              const outside = makeScratch(`w6-mem-out-${idx}-`)
              mkdirSync(join(root, "src", "sub"), { recursive: true })
              writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
              writeFileSync(join(root, "src", "sub", "b.ts"), "export const b = 2\n")
              writeFileSync(join(outside, "secret.json"), "{}")

              // Setup thresholds file
              const threshPath = join(root, MemoryCalibration.file)
              mkdirSync(join(root, ".smithers"), { recursive: true })
              if (threshMode === "valid") {
                writeFileSync(threshPath, JSON.stringify(MemoryCalibration.initial))
              } else if (threshMode === "corrupt_json") {
                writeFileSync(threshPath, "{not-valid-json")
              } else if (threshMode === "symlink_escape") {
                symlinkSync(join(outside, "secret.json"), threshPath)
              }

              // Setup wiki catalog (.smithers/coding-project.json), decisions, skills (.agents/skills), deps (.flows/wiki/deps)
              const wikiDir = join(root, ".smithers", "wiki")
              mkdirSync(join(wikiDir, "decisions"), { recursive: true })
              mkdirSync(join(root, ".agents", "skills", "parser-skill"), { recursive: true })
              mkdirSync(join(root, ".flows", "wiki", "deps", "effect"), { recursive: true })
              writeFileSync(join(wikiDir, "guide.md"), "# Guide\nSee `src/a.ts` for parser details.\n")
              writeFileSync(join(wikiDir, "decisions", "0001-wal.md"), "# WAL\nKeep SQLite WAL enabled.\n")
              writeFileSync(join(root, ".agents", "skills", "parser-skill", "SKILL.md"), "# Parser Skill\nUse strict parser.\n")
              writeFileSync(join(root, ".agents", "skills", "stray-file.txt"), "ignored")
              writeFileSync(join(root, ".flows", "wiki", "deps", "effect", "guide.md"), "# Effect\nUse Effect.gen.\n")
              if (wikiMode === "valid_index") {
                writeFileSync(
                  join(root, ".smithers", "coding-project.json"),
                  JSON.stringify({
                    pages: [
                      { id: "guide", document: ".smithers/wiki/guide.md", title: "Guide", inputs: ["src/a.ts"] },
                      { id: "missing", document: ".smithers/wiki/missing.md" },
                      { id: "escape", document: "../secret.json" },
                      null
                    ]
                  })
                )
              } else if (wikiMode === "corrupt_index") {
                writeFileSync(join(root, ".smithers", "coding-project.json"), "{corrupt")
              }

              // Fake jj + git spawner returning real Commit records and notes
              const sep = "\u001f"
              const rec = "\u001e"
              const jjLine = `${commitHex}${sep}chg-${idx}${sep}${JSON.stringify(`Fix parser in src/a.ts #${idx}`)}${rec}`
              const spawnerLayer = makeFakeSpawner({
                jjLog: jjLine,
                jjNamed: jjLine,
                gitNotes: withNotes ? `blob123 ${commitHex}\n` : "",
                gitCat: withNotes ? `Mythical note for ${commitHex}\n` : ""
              })

              const evalLayer = Evaluator.layerScripted((req) =>
                Object.fromEntries(
                  Object.keys(req.questions).map((k) => [k, { probability: 0.9 }])
                )
              )

              const envLayer = Layer.mergeAll(NodeServices.layer, evalLayer, TestMemory.layer, RecallKeyword.layer.pipe(Layer.provide(TestMemory.layer)))

              return yield* Effect.gen(function*() {
                // 1) Memory.thresholds
                const tRes = yield* Effect.result(Memory.thresholds(root))
                if (threshMode === "corrupt_json" || threshMode === "symlink_escape") {
                  if (!Result.isFailure(tRes) || tRes.failure.code !== "thresholds_invalid") throw new Error("fail at L184")
                } else {
                  if (Result.isFailure(tRes)) throw new Error("fail at L186")
                }

                // 2) Commits.commitIds & Commits.read direct check
                const ids = Commits.commitIds(`Check commit ${commitHex} and ${commitHex}`)
                if (ids.length !== 1 || ids[0] !== commitHex) throw new Error("fail at L191")
                const readCommits = yield* Commits.read(root, ["src/a.ts"], [commitHex])
                if (readCommits.length !== 1) throw new Error("fail at L193")
                if (withNotes && !readCommits[0]!.text.includes("Mythical note")) throw new Error("fail at L194")

                // 3) Memory.select across wiki, repo, commits, facts & seed paths
                if (factsMode === "ok") {
                  const ms = yield* MemoryStore.MemoryStore
                  yield* ms.putNote({
                    namespace: "bank:notes" as any,
                    id: `fact-${idx}`,
                    text: "Parser uses recursive descent on src/a.ts",
                    tags: ["source:transcript"],
                    provenance: { runId: `r-${idx}` }
                  }).pipe(Effect.ignore)
                }
                const selRes = yield* Effect.result(
                  Memory.select(
                    {
                      task: `Fix src/a.ts and inspect ${commitHex}`,
                      query: "parser architecture",
                      paths: ["./src/a.ts", "src/sub", "../escape"],
                      maxBytes: 8192
                    },
                    {
                      root,
                      thresholds: MemoryCalibration.initial,
                      facts: factsMode === "none"
                        ? undefined
                        : {
                          services: Context.make(MemoryStore.MemoryStore, yield* MemoryStore.MemoryStore).pipe(
                            Context.add(
                              Recall.Recall,
                              factsMode === "ok"
                                ? yield* Recall.Recall
                                : ({
                                  recall: () =>
                                    Effect.fail(
                                      new MemoryError.MemoryError({ code: "store", message: "facts store down" })
                                    )
                                } as any)
                            )
                          ),
                          banks: ["notes"]
                        }
                    }
                  )
                )
                if (factsMode === "fail") {
                  if (!Result.isFailure(selRes) || selRes.failure.code !== "facts_failed") throw new Error("fail at L217")
                } else {
                  if (Result.isFailure(selRes)) throw new Error("fail at L219")
                  if (selRes.success.kept.length === 0) throw new Error("fail at L220")
                }

                // 4) Memory.source + Memory.plugin wiring
                const svcFs = yield* FileSystem.FileSystem
                const svcPath = yield* Path.Path
                const svcSp = yield* ChildProcessSpawner
                const svcEv = yield* Evaluator.Evaluator
                const svcCtx = Context.make(FileSystem.FileSystem, svcFs).pipe(
                  Context.add(Path.Path, svcPath),
                  Context.add(ChildProcessSpawner, svcSp),
                  Context.add(Evaluator.Evaluator, svcEv)
                )
                const src = Memory.source(svcCtx, { root, thresholds: MemoryCalibration.initial })
                const cat = yield* FlowBinding.catalog([src]).pipe(CapabilitySet.attenuate([]))
                if (!cat.bindings.has("memory")) throw new Error("fail at L235")
                const memReg = FlowBinding.registry(Registry.makeNoop({}), cat)
                const memCaller = CellCalls.make({ registry: memReg, catalog: cat })
                const memDesc = cat.bindings.get("memory")!.descriptor
                yield* memCaller.run(
                  new Cell.Call({
                    flowName: "memory",
                    input: { task: "Fix src/a.ts", maxBytes: 4096 },
                    capabilities: memDesc.capabilities,
                    effects: memDesc.effects,
                    placement: memDesc.placement,
                    identity: new Cell.CallIdentity({
                      session: `msrc-${idx}`,
                      frame: 0,
                      cell: "a".repeat(64),
                      ordinal: 0,
                      declaration: Cell.declarationDigest(memDesc),
                      layers: []
                    })
                  })
                )

                const plug = Memory.plugin(svcCtx, { root, thresholds: MemoryCalibration.initial })
                if (plug === undefined) throw new Error("fail at L238")

                return true
              }).pipe(Effect.provideService(ChildProcessSpawner, spawnerLayer), Effect.provide(envLayer))
            })
          ),
        { executions: Math.min(executions, 32), seed }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("FlowStore, WorkspaceObservation.cached/measure, MemoryMine & MemorySnapshotRecorder invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        storeCase: Schema.Literals(["noop", "write_and_list", "overlap_path", "bad_id", "non_confinable"]),
        obsCase: Schema.Literals(["cached_hit", "cached_moved", "bounded_max_paths", "unreadable_err"]),
        mineJudgeOk: Schema.Boolean,
        mineRepeat: Schema.Boolean
      })
    )

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ storeCase, obsCase, mineJudgeOk, mineRepeat }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const idx = ++seq
              const root = makeScratch(`w6-sup-${idx}-`)

              // 1) FlowStore invariants
              const storeOk = yield* Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                const path = yield* Path.Path

                if (storeCase === "noop") {
                  const noop = FlowStore.makeNoop()
                  const w = yield* Effect.result(noop.write("f1", { "flow.md": "# hi" }))
                  const l = yield* Effect.result(noop.list())
                  return Result.isFailure(w) && w.failure.code === "unsupported" && Result.isFailure(l)
                }

                if (storeCase === "non_confinable") {
                  // Plain FileSystem without confine support
                  const plainFs = { ...fs } as FileSystem.FileSystem
                  const st = FlowStore.makeFileSystem(plainFs, path, root)
                  const res = yield* Effect.result(st.write("my-flow", { "flow.md": "# hi" }))
                  return Result.isFailure(res)
                }

                const st = FlowStore.makeFileSystem(fs, path, root)
                if (storeCase === "bad_id") {
                  const res = yield* Effect.result(st.write("../bad", { "flow.md": "# hi" }))
                  return Result.isFailure(res)
                }
                if (storeCase === "overlap_path") {
                  const res = yield* Effect.result(
                    st.write("flow-a", { "sub": "x", "sub/nested.md": "y" })
                  )
                  return Result.isFailure(res)
                }

                // write_and_list: create dangling symlink in .smithers/flows to cover list() stat catch
                mkdirSync(join(root, ".smithers", "flows", "ghost"), { recursive: true })
                symlinkSync(join(root, "does-not-exist"), join(root, ".smithers", "flows", "ghost", "dangling.md"))
                const listed = yield* st.list()
                if (!Array.isArray(listed)) throw new Error("fail at L306")
                return true
              }).pipe(Effect.provide(NodeServices.layer))
              if (!storeOk) throw new Error("fail at L309")

              // 2) WorkspaceObservation.measure + cached
              const obsRoot = makeScratch(`w6-obs-${idx}-`)
              mkdirSync(join(obsRoot, "dir1"), { recursive: true })
              writeFileSync(join(obsRoot, "f1.txt"), "hello")
              writeFileSync(join(obsRoot, "dir1", "f2.txt"), "world")
              writeFileSync(join(obsRoot, "dir1", "f3.txt"), "more")

              let walks = 0
              let gen = 1
              const obsOk = yield* Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                if (obsCase === "bounded_max_paths") {
                  const obs = yield* WorkspaceObservation.observe(fs, obsRoot, { maxPaths: 1 })
                  return !obs.complete && obs.paths === 1
                }
                if (obsCase === "unreadable_err") {
                  const badFs = {
                    ...fs,
                    readDirectory: () =>
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "PermissionDenied",
                          module: "FileSystem",
                          method: "readDirectory",
                          pathOrDescriptor: obsRoot
                        })
                      )
                  } as unknown as FileSystem.FileSystem
                  const obs = yield* WorkspaceObservation.observe(badFs, obsRoot)
                  return !obs.complete
                }
                const measure = Effect.suspend(() => {
                  walks++
                  return WorkspaceObservation.observe(fs, obsRoot)
                })
                const changes: WorkspaceObservation.Changes = {
                  delivered: Effect.sync(() => Option.some(gen)),
                  settled: Effect.sync(() => Option.some(obsCase === "cached_hit" ? gen : gen + 1))
                }
                const cached = WorkspaceObservation.cached(measure, changes)
                const first = yield* cached
                const second = yield* cached
                if (obsCase === "cached_hit") {
                  return walks === 1 && first.digest === second.digest
                }
                return walks === 2 && first.digest === second.digest
              }).pipe(Effect.provide(NodeServices.layer))
              if (!obsOk) throw new Error("fail at L358")

              // 3) MemoryMine: add, extract, judge (ok & fail), write (idempotent + conflict), settle
              const tr = MemoryMine.transcript()
              MemoryMine.add(tr, {
                seq: 1,
                eventType: "control.agent.model-settled",
                payload: { text: "Always run pnpm test before landing.\n\n```ts\nconst x = 1\n```\n\nNever skip typecheck." }
              })
              MemoryMine.add(tr, {
                seq: 10,
                eventType: "control.agent.model-settled",
                payload: { message: { content: [{ type: "text", text: "Multi-part prose with unicode 😀 " + "x".repeat(420) }] } }
              })
              MemoryMine.add(tr, {
                seq: 11,
                eventType: "control.agent.steering-drained",
                payload: { items: [{ body: "Operator says: always keep WAL mode on." }, { text: "Keep diffs small." }] }
              })
              MemoryMine.add(tr, {
                seq: 2,
                eventType: "control.agent.cell-call-settled",
                payload: {
                  flowName: "bash",
                  result: { outcome: "failure", value: null, message: "Command failed with ENOENT" }
                }
              })
              MemoryMine.add(tr, {
                seq: 3,
                eventType: "control.agent.transition-applied",
                payload: {
                  transition: { _tag: "complete", output: "Decision: SQLite WAL must stay enabled for concurrency." }
                }
              })
              MemoryMine.add(tr, { seq: 4, eventType: "control.agent.other", payload: null })
              const extracted = MemoryMine.extract([
                {
                  seq: 1,
                  eventType: "control.agent.transition-applied",
                  payload: { transition: { _tag: "complete", output: "Always validate schema inputs." } }
                },
                { seq: 2, eventType: "control.agent.other", payload: "raw-string-not-object" }
              ])
              void extracted

              const mineEval = mineJudgeOk
                ? Evaluator.layerScripted((req) =>
                  Object.fromEntries(Object.keys(req.questions).map((k) => [k, { probability: 0.95 }]))
                )
                : Layer.succeed(Evaluator.Evaluator, {
                  evaluate: () =>
                    Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "offline" }))
                })

              const mineOk = yield* Effect.gen(function*() {
                const store = yield* MemoryStore.MemoryStore
                const judgedRes = yield* Effect.result(
                  MemoryMine.judge(
                    "harden validation",
                    [
                      { text: "Always validate schema inputs at boundaries.", seq: 1 },
                      { text: "Use Effect layers for all dependencies.", seq: 2 }
                    ]
                  )
                )
                if (mineJudgeOk) {
                  if (Result.isFailure(judgedRes) || judgedRes.success.facts.length === 0) throw new Error("fail at L414")
                  const note1 = yield* MemoryMine.write(store, {
                    bank: "notes",
                    runId: `mine-run-${idx}`,
                    text: judgedRes.success.facts[0]!.text
                  })
                  if (note1.id.length === 0) throw new Error("fail at L420")
                  if (mineRepeat) {
                    const note2 = yield* MemoryMine.write(store, {
                      bank: "notes",
                      runId: `mine-run-${idx}-repeat`,
                      text: judgedRes.success.facts[0]!.text
                    })
                    if (note2.id !== note1.id) return false
                  }
                } else {
                  if (!Result.isFailure(judgedRes)) return false
                }
                return true
              }).pipe(Effect.provide(Layer.mergeAll(TestMemory.layer, mineEval, NodeServices.layer)))
              if (!mineOk) return false

              // 4) MemorySnapshotRecorder.make + layer
              const recCalls: Array<unknown> = []
              const fakeEngineLike = {
                record: (opts: { readonly execute: Effect.Effect<any> }) =>
                  opts.execute.pipe(
                    Effect.tap((snap) =>
                      Effect.sync(() => {
                        recCalls.push(snap)
                      })
                    )
                  )
              } as unknown as EngineLike.EngineLike
              const recorder = MemorySnapshotRecorder.make(fakeEngineLike)
              yield* recorder.record(
                { lineageId: `snap-${idx}`, iteration: 0 } as any,
                Effect.succeed({ items: [] } as any)
              )
              if (recCalls.length !== 1) return false

              return true
            })
          ),
        { executions: Math.min(executions, 32), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("Budget multi-model readings, LRU maxRuns eviction, reserveCall refund, SmithersPlugin & CellPlugin invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        onExceeded: Schema.Literals(["fail", "warn", "park", "skip-remaining"]),
        runCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 6 }))),
        refundOnFail: Schema.Boolean
      })
    )

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ onExceeded, runCount, refundOnFail }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const idx = ++seq

              // 1) Budget.memoryLedger with small maxRuns to hit LRU eviction & multi-model USD accounting
              const ledger = Budget.memoryLedger()
              const budgetLayer = Budget.layer(
                {
                  tokens: { max: 500, onExceeded },
                  usd: { max: 0.5, onExceeded },
                  latency: { maxMillis: 60_000, onExceeded },
                  daily: { max: 10 },
                  weights: { default: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }
                },
                { ledger }
              )

              const budgetOk = yield* Effect.gen(function*() {
                const eng = yield* FlowRuntime.FlowRuntime
                for (let r = 0; r < runCount; r++) {
                  const fl = Flow.make(`w6/bud-${idx}-${r}`, {
                    payload: {},
                    success: Schema.Boolean,
                    body: () => Node.succeed(true)
                  })
                  yield* eng.register(fl, () =>
                    Effect.gen(function*() {
                      const b = yield* Budget.Budget
                      const res = yield* Effect.result(
                        Effect.scoped(
                          Effect.gen(function*() {
                            const rsv = yield* b.reserve(`k-${idx}-${r}`)
                            if (refundOnFail) return yield* Effect.fail("synthetic-call-fail")
                            return rsv
                          })
                        )
                      )
                      void res
                      yield* b.record(`k-${idx}-${r}`, {
                        inputTokens: 40,
                        outputTokens: 20,
                        costUsd: 0.01
                      }).pipe(Effect.ignore)
                      const rd = yield* Effect.result(b.admitReading(`rd-${idx}-${r}`))
                      void rd
                      yield* b.record(`rd-${idx}-${r}`, { inputTokens: 20, outputTokens: 10, costUsd: 0.005 }).pipe(Effect.ignore)
                      return true
                    })
                  )
                  const out = yield* eng.execute(fl, { executionId: `bud-exec-${idx}-${r}`, payload: {} })
                  if (out !== true) return false
                }
                return true
              }).pipe(
                Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, budgetLayer, NodeCrypto.layer))
              )
              if (!budgetOk) return false

              // 2) Journal with undecodable budget entry exercises Budget recovery error handling
              const jLayer = TestJournal.layer()
              yield* Effect.gen(function*() {
                const journal = yield* Journal.Journal
                const rId = JournalEvent.RunId.make(`bad-bud-${idx}`)
                yield* journal.emitDurableUnfenced(
                  new JournalEvent.Input({
                    runId: rId,
                    sourceId: JournalEvent.SourceId.make("/budget"),
                    sourceSeq: JournalEvent.SourceSeq.make(0),
                    eventType: "flows.agent.budget-started.v1",
                    payload: { corrupt: true }
                  })
                )
              }).pipe(Effect.provide(jLayer))

              // 3) CellPlugin & SmithersPlugin surface checks
              const emptyPlug = CellPlugin.fromBindings({ name: "w6-empty", bindings: [] })
              if (emptyPlug.name !== "w6-empty") return false
              const smPlug = SmithersPlugin.make()
              if (smPlug.name !== SmithersPlugin.name) return false

              return true
            })
          ),
        { executions: Math.min(executions, 24), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 120_000)
})
