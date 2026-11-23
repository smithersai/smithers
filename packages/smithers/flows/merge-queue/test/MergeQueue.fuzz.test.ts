import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Fiber, FileSystem, Layer, Result, Schema, Stream } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  Ci,
  CommandCi,
  CommandFixer,
  type Config,
  cut,
  Driver,
  empty,
  Endings,
  eta,
  type Event,
  FileEndings,
  FileHandover,
  FileInbox,
  Fixer,
  fresh,
  green,
  Handover,
  Inbox,
  JjRepository,
  plan,
  pruned,
  QueueFlow,
  QueueSchema,
  remaining,
  runPruned,
  samePart,
  sameTree,
  schedule,
  settled,
  settlePruned,
  type State,
  step,
  Target,
  tree,
  Unavailable
} from "../src/index.ts"
import { estimate, samples } from "../src/Predict.ts"
import { apply as applyTrace, initialConfig, parseLine, renderEvent, renderState, replay } from "../src/Trace.ts"
import { makeWorld, statusesOf } from "./support/World.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "150"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const tempRoot = mkdtempSync(join(tmpdir(), "merge-queue-fuzz-"))
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }))

const nodeHost = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, NodePath.layer)
)

const RawEvent = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("enqueue"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
    priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("withdraw"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("result"),
    run: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
    check: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
    verdict: Schema.Literals(["pass", "fail"]),
    duration: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("fixed"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
    attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("gaveUp"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
    attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
    detail: Schema.Literal("unfixable")
  }),
  Schema.Struct({
    _tag: Schema.Literal("foreign"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("start"),
    count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("push"),
    run: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("probe"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("land"),
    run: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("blame"),
    run: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("cancel"),
    run: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }))
  })
])

const config: Config = {
  required: [1, 2],
  maxAttempts: 2,
  maxBatch: 3,
  maxRuns: 3,
  window: 5,
  defaultDuration: 100
}

const makeFakeHandle = (stdoutText: string, exitCode: number): ChildProcessSpawner.ChildProcessHandle =>
  ({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Stream.empty as never,
    stdout: Stream.make(new TextEncoder().encode(stdoutText)),
    stderr: Stream.empty,
    all: Stream.make(new TextEncoder().encode(stdoutText)),
    getInputFd: () => ({} as never),
    getOutputFd: () => Stream.empty
  }) as unknown as ChildProcessSpawner.ChildProcessHandle

describe("@smthrs/merge-queue fuzz invariants", () => {
  it("main is strictly append-only and only green runs ever land across arbitrary adversarial event sequences", async () => {
    const arb = Arbitrary.schema(Schema.Array(RawEvent))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (events) => {
          let state: State = empty
          for (const ev of events.slice(0, 40) as ReadonlyArray<Event>) {
            const prevMain = state.main
            const prevLanded = state.landed.length
            const next = step(config, state, ev)

            if (next.main.length < prevMain.length) return false
            for (let i = 0; i < prevMain.length; i++) {
              if (!samePart(prevMain[i]!, next.main[i]!)) return false
            }

            if (ev._tag !== "foreign" && next.landed.length > prevLanded) {
              const newLandings = next.landed.slice(prevLanded)
              for (const landing of newLandings) {
                const run = state.runs.find((r) => r.id === landing.run)
                if (run === undefined) return false
                if (!green(config, run.results)) return false
                const runTree = tree(run)
                if (next.main.length !== runTree.length) return false
              }
            }

            const planned = plan(config, next)
            if (planned !== undefined) {
              const afterPlan = step(config, next, planned)
              if (afterPlan.main.length < next.main.length) return false
              for (let i = 0; i < next.main.length; i++) {
                if (!samePart(next.main[i]!, afterPlan.main[i]!)) return false
              }
            }

            state = next
          }
          return true
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Compact (pruned/cut/settlePruned), Predict, Trace round-trip/replay, and QueueSchema obey algebraic laws", async () => {
    const arb = Arbitrary.schema(Schema.Array(RawEvent))
    const encodeState = Schema.encodeSync(QueueSchema.State)
    const decodeState = Schema.decodeUnknownSync(QueueSchema.State)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (rawEvents) => {
          // Ensure fresh IDs for enqueue/foreign to test compaction theorem
          let nextId = 1
          let full: State = empty
          let compact: State = empty
          const traceLines: Array<string> = [
            "config required=1,2 maxAttempts=2 maxBatch=3 maxRuns=3 window=5 defaultDuration=100"
          ]
          const freshEvents: Array<Event> = []

          for (const raw of rawEvents.slice(0, 24) as ReadonlyArray<Event>) {
            const ev: Event = raw._tag === "enqueue"
              ? { _tag: "enqueue", id: nextId++, priority: raw.priority }
              : raw._tag === "foreign"
              ? { _tag: "foreign", id: nextId++ }
              : raw
            if (!fresh(full, ev)) continue
            freshEvents.push(ev)

            // Trace event round-trip
            const rendered = renderEvent(ev)
            const parsed = parseLine(rendered)
            if (parsed === undefined || parsed._tag !== "event" || renderEvent(parsed.event) !== rendered) {
              return false
            }
            traceLines.push(rendered)

            full = step(config, full, ev)
            compact = runPruned(config, compact, [ev])

            // Pruned state has identical plan decision as full state!
            const pFull = plan(config, full)
            const pCompact = plan(config, compact)
            if ((pFull === undefined) !== (pCompact === undefined)) return false
            if (pFull !== undefined && pCompact !== undefined && renderEvent(pFull) !== renderEvent(pCompact)) {
              return false
            }
            if (renderState(config, pruned(full)) !== renderState(config, compact)) return false

            // Settle + cut preservation
            const s = settled(compact)
            if (s > compact.main.length) return false
            const cutState = cut(compact, s)
            if (cutState.main.length !== compact.main.length - s) return false
            const pCut = plan(config, cutState)
            if ((pCut === undefined) !== (pCompact === undefined)) return false
            if (pCut !== undefined && pCompact !== undefined && renderEvent(pCut) !== renderEvent(pCompact)) {
              return false
            }
          }

          // Settle both full and compact
          const settledCompact = settlePruned(config, 32, compact)
          if (settledCompact.landed.length !== 0) return false

          // Predict laws
          for (const check of config.required) {
            const ds = samples(full.history, check)
            const est = estimate(config, full.history, check)
            if (ds.length === 0 && est !== config.defaultDuration) return false
            if (ds.length > 0 && (est < Math.min(...ds) || est > Math.max(...ds))) return false
          }
          const sched = schedule(config, full.history)
          for (let i = 1; i < sched.length; i++) {
            if (estimate(config, full.history, sched[i - 1]!) < estimate(config, full.history, sched[i]!)) {
              return false
            }
          }
          const remEmpty = remaining(config, full.history, [])
          if (remEmpty.length !== config.required.length) return false
          const allPassed = config.required.map((check) => ({ check, verdict: "pass" as const }))
          if (eta(config, full.history, allPassed) !== 0) return false

          // Trace replay & apply + comments/bad lines
          traceLines.push("# comment", "", "plan")
          const replayed = replay(traceLines)
          if (replayed.length < 1) return false
          const [cfgAfter, stAfter] = applyTrace(initialConfig, empty, { _tag: "plan" })
          if (cfgAfter.required.length !== initialConfig.required.length || stAfter.main.length !== 0) return false
          if (parseLine("not-a-valid-line") !== undefined) return false

          // QueueSchema round-trip
          const rt = decodeState(encodeState(full))
          return renderState(config, rt) === renderState(config, full)
        },
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Driver and QueueFlow drain randomized worlds with failures, fixers, withdrawals, foreign commits, and lineage handovers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        changes: Schema.Array(
          Schema.Struct({
            priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
            failCheck: Schema.Literals([0, 1, 2]),
            fixable: Schema.Boolean,
            withdraw: Schema.Boolean
          })
        ),
        addForeign: Schema.Boolean,
        injectTransientFault: Schema.Boolean,
        useQueueFlow: Schema.Boolean,
        rewriteTarget: Schema.Boolean
      })
    )
    const memoryEngine = Layer.provideMerge(FlowEngine.layerMemory, NodeCrypto.layer)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ changes, addForeign, injectTransientFault, useQueueFlow, rewriteTarget }) =>
          Effect.gen(function*() {
            const specs = changes.slice(0, 5)
            const failingMap = new Map<number, number>()
            const fixableSet = new Set<number>()
            specs.forEach((s, i) => {
              const id = i + 1
              if (s.failCheck > 0) failingMap.set(id, s.failCheck)
              if (s.fixable) fixableSet.add(id)
            })

            const world = makeWorld(config, {
              failing: (part) => {
                const fc = failingMap.get(part.id)
                if (fc === undefined) return []
                // Fixed on rev >= 1 if fixable
                if (part.rev >= 1 && fixableSet.has(part.id)) return []
                return [fc]
              },
              fix: (brief) =>
                fixableSet.has(brief.id)
                  ? { _tag: "fixed" }
                  : { _tag: "gaveUp", detail: "cannot fix" }
            })

            specs.forEach((s, i) => {
              const id = i + 1
              world.enqueue(id, s.priority)
              if (s.withdraw) world.withdraw(id)
            })
            if (addForeign) world.foreign(900)
            world.close()

            if (rewriteTarget && !useQueueFlow) {
              // Rewrite target history when state already has a landed part -> must produce TargetDiverged
              world.rewrite([{ id: 777, rev: 0 }])
              const diverged = yield* Effect.result(
                Driver.round(config, {
                  state: { ...empty, main: [{ id: 888, rev: 0 }] },
                  cursor: 0,
                  closed: true,
                  ended: [],
                  settled: 0
                }).pipe(Effect.provide(world.layer))
              )
              return Result.isFailure(diverged) && diverged.failure._tag === "@smthrs/merge-queue/TargetDiverged"
            }

            if (useQueueFlow) {
              const flowLayer = Layer.mergeAll(QueueFlow.layer, Interpreter.layer(QueueFlow.Queue)).pipe(
                Layer.provideMerge(world.layer),
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(memoryEngine)
              ) as Layer.Layer<any, never, never>

              let startPayload: typeof QueueFlow.Payload.Type = {
                config,
                state: empty,
                cursor: 0,
                closed: false,
                ended: [],
                settled: 0,
                round: 0,
                lineage: 4
              }
              let steps = 0
              while (steps < 20) {
                steps++
                const end = yield* QueueFlow.Queue.execute(startPayload, {
                  executionId: `mq-fuzz-${steps}-${Math.random()}`
                }).pipe(Effect.provide(flowLayer), Effect.scoped) as Effect.Effect<typeof QueueFlow.End.Type>
                if (end.done) {
                  if (!Driver.drained(end.position.state)) return false
                  break
                }
                startPayload = end.position
              }
              if (steps >= 20) return false
            } else {
              if (injectTransientFault) world.failNext("ci", 1)
              let pos: Driver.Position = { state: empty, cursor: 0, closed: false, ended: [], settled: 0 }
              let rounds = 0
              while (rounds < 60) {
                rounds++
                const res = yield* Effect.result(
                  Driver.round(config, pos).pipe(Effect.provide(world.layer))
                )
                if (Result.isFailure(res)) {
                  if (res.failure._tag !== "@smthrs/merge-queue/Unavailable") return false
                  continue
                }
                pos = res.success
                if (res.success.done) break
              }
              if (rounds >= 60 || !Driver.drained(pos.state)) return false
              const st = statusesOf(world, { state: pos.state })
              for (let i = 0; i < specs.length; i++) {
                const id = i + 1
                if (st[id] === undefined) return false
              }
            }

            // Safety: every tree the queue pushed to target MUST truly pass all required checks!
            for (const pushedTree of world.pushed) {
              if (!world.passes(pushedTree)) return false
            }
            return true
          }),
        { seed: seed + 2, executions: Math.min(executions, 35) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("FileInbox, FileEndings, and FileHandover persist, deduplicate, skip garbage, and survive reloads", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(
          Schema.Union([
            Schema.Struct({
              _tag: Schema.Literal("enqueue"),
              id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
              priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
              withCommit: Schema.Boolean
            }),
            Schema.Struct({
              _tag: Schema.Literal("withdraw"),
              id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))
            }),
            Schema.Struct({ _tag: Schema.Literal("garbage") }),
            Schema.Struct({ _tag: Schema.Literal("close") })
          ])
        ),
        endingKind: Schema.Literals(["merged", "withdrawn", "unmergeable"])
      })
    )
    let iter = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ops, endingKind }) =>
          Effect.gen(function*() {
            const dir = join(tempRoot, `files-${iter++}`)
            const inboxPath = join(dir, "inbox.jsonl")
            const endingsPath = join(dir, "endings.jsonl")
            const handoverPath = join(dir, "handover.json")
            const fs = yield* FileSystem.FileSystem
            yield* fs.makeDirectory(dir, { recursive: true })

            // Initially missing files
            if ((yield* FileInbox.lines(inboxPath)).length !== 0) return false
            if ((yield* FileEndings.read(endingsPath)).length !== 0) return false
            if ((yield* FileHandover.read(handoverPath)) !== undefined) return false

            const registered = new Map<number, string>()
            const inboxLayer = FileInbox.layer({
              path: inboxPath,
              poll: "5 millis",
              register: (id, commit) =>
                Effect.sync(() => {
                  registered.set(id, commit)
                })
            })
            const endingsLayer = FileEndings.layer({ path: endingsPath })
            const handoverLayer = FileHandover.layer({ path: handoverPath })

            const bounded = ops.slice(0, 12)
            for (const op of bounded) {
              if (op._tag === "garbage") {
                yield* fs.writeFileString(inboxPath, "not-json\n\n", { flag: "a" })
              } else if (op._tag === "enqueue") {
                yield* FileInbox.append(inboxPath, {
                  _tag: "enqueue",
                  id: op.id,
                  priority: op.priority,
                  ...(op.withCommit ? { commit: `c-${op.id}` } : {})
                })
              } else {
                yield* FileInbox.append(inboxPath, op)
              }
            }

            const letters = yield* Effect.gen(function*() {
              const inbox = yield* Inbox
              return yield* inbox.since(0)
            }).pipe(Effect.provide(inboxLayer))

            if (letters.length !== bounded.length) return false
            // Verify duplicate enqueues are turned into skip
            const seenEnq = new Set<number>()
            for (let i = 0; i < bounded.length; i++) {
              const op = bounded[i]!
              const got = letters[i]!
              if (op._tag === "garbage") {
                if (got._tag !== "skip") return false
              } else if (op._tag === "enqueue") {
                if (seenEnq.has(op.id)) {
                  if (got._tag !== "skip") return false
                } else {
                  seenEnq.add(op.id)
                  if (got._tag !== "event" || got.event._tag !== "enqueue" || got.event.id !== op.id) return false
                  if (op.withCommit && registered.get(op.id) !== `c-${op.id}`) return false
                }
              } else if (op._tag === "close") {
                if (got._tag !== "close") return false
              }
            }

            // Exercise FileInbox.wait waking when a new line arrives
            const waitFiber = yield* Effect.forkChild(
              Effect.gen(function*() {
                const inbox = yield* Inbox
                yield* inbox.wait(letters.length)
              }).pipe(Effect.provide(inboxLayer))
            )
            yield* FileInbox.append(inboxPath, { _tag: "close" })
            yield* Fiber.join(waitFiber)

            // FileEndings record + read + layer
            const ending: typeof QueueSchema.Ending.Type = endingKind === "merged"
              ? {
                id: 1,
                rev: 0,
                attempts: 0,
                status: { _tag: "merged" },
                landing: { run: 1, results: [{ check: 1, verdict: "pass" }], foreign: false }
              }
              : endingKind === "withdrawn"
              ? { id: 2, rev: 0, attempts: 0, status: { _tag: "withdrawn" }, landing: null }
              : {
                id: 3,
                rev: 1,
                attempts: 1,
                status: {
                  _tag: "unmergeable",
                  reason: { kind: "attemptsExhausted", failures: [1], attempts: 1, detail: "boom" }
                },
                landing: null
              }
            yield* Effect.gen(function*() {
              const svc = yield* Endings
              yield* svc.record([ending, ending])
              // Recording an already-recorded id is idempotent
              yield* svc.record([ending])
            }).pipe(Effect.provide(endingsLayer))
            const readEndings = yield* FileEndings.read(endingsPath)
            if (readEndings.length !== 1 || readEndings[0]!.id !== ending.id) return false

            // FileHandover save + read + layer + corrupt JSON -> Unavailable
            yield* Effect.gen(function*() {
              const svc = yield* Handover
              yield* svc.save({ done: true, position: { cursor: letters.length } })
            }).pipe(Effect.provide(handoverLayer))
            const doc = yield* FileHandover.read(handoverPath)
            if (doc === undefined || !doc.done) return false

            yield* fs.writeFileString(handoverPath, "{corrupt")
            const badDoc = yield* Effect.result(FileHandover.read(handoverPath))
            if (Result.isSuccess(badDoc)) return false

            return true
          }).pipe(Effect.provide(NodeFileSystem.layer)),
        { seed: seed + 3, executions: Math.min(executions, 30) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("CommandCi (per-check & streamed) and CommandFixer obey verdict/loss/reconcile/registration contracts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        candidateMode: Schema.Literals(["built", "conflict", "stale", "unavailable"]),
        check1Pass: Schema.Boolean,
        check2Pass: Schema.Boolean,
        streamIncomplete: Schema.Boolean,
        fixerAnswer: Schema.Literals(["fixed", "gaveUp"])
      })
    )
    let iter = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ candidateMode, check1Pass, check2Pass, streamIncomplete, fixerAnswer }) =>
          Effect.gen(function*() {
            const registered: Array<{ part: { id: number; rev: number }; commit: string }> = []
            const fakeRepo: JjRepository.Repository = {
              register: (part, commit) =>
                Effect.sync(() => {
                  registered.push({ part, commit })
                }),
              settle: () => Effect.void,
              tip: Effect.succeed([]),
              candidate: () => {
                if (candidateMode === "conflict") return Effect.succeed({ _tag: "conflict", part: { id: 1, rev: 0 } })
                if (candidateMode === "stale") return Effect.succeed({ _tag: "stale" })
                if (candidateMode === "unavailable") {
                  return Effect.fail(new Unavailable({ service: "target", detail: "down" }))
                }
                return Effect.succeed({ _tag: "built", commit: "commit-abc" })
              },
              advance: () => Effect.void
            }

            const job = { run: 1, tree: [{ id: 1, rev: 0 }], from: 0, checks: [1, 2], eta: 10 }

            // 1. CommandCi.layer (one process per check)
            const spawnerPerCheck = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((cmd) => {
                const args = cmd._tag === "StandardCommand" ? cmd.args : []
                const checkId = Number(args[0] ?? "1")
                const pass = checkId === 1 ? check1Pass : check2Pass
                return Effect.succeed(makeFakeHandle("", pass ? 0 : 1))
              })
            )
            const ci1 = yield* Effect.scoped(
              Effect.gen(function*() {
                const svc = yield* Ci
                yield* svc.reconcile([job])
                yield* svc.wait([{ run: 1, finished: 0 }])
                yield* Effect.sleep("10 millis")
                const res = yield* svc.progress(1)
                yield* svc.reconcile([])
                return res
              }).pipe(
                Effect.provide(
                  CommandCi.layer({
                    repository: fakeRepo,
                    command: (check, commit) => ({ command: "check", args: [String(check), commit] }),
                    poll: "5 millis"
                  }).pipe(Layer.provide(spawnerPerCheck))
                )
              )
            )
            if (candidateMode === "stale" || candidateMode === "unavailable") {
              if (ci1._tag !== "lost") return false
            } else if (candidateMode === "conflict") {
              if (
                ci1._tag !== "running" || ci1.finished.length !== 2 || !ci1.finished.every((f) => f.verdict === "fail")
              ) return false
            } else {
              if (ci1._tag !== "running") return false
              const v1 = ci1.finished.find((f) => f.check === 1)?.verdict
              const v2 = ci1.finished.find((f) => f.check === 2)?.verdict
              if (v1 !== (check1Pass ? "pass" : "fail") || v2 !== (check2Pass ? "pass" : "fail")) return false
            }

            // 2. CommandCi.streamed
            const streamOut = streamIncomplete
              ? `noise line\n1 ${check1Pass ? "pass" : "fail"} 3\n`
              : `noise\n1 ${check1Pass ? "pass" : "fail"} 3\n2 ${check2Pass ? "pass" : "fail"}\n`
            const spawnerStreamed = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => Effect.succeed(makeFakeHandle(streamOut, 0)))
            )
            const ci2 = yield* Effect.scoped(
              Effect.gen(function*() {
                const svc = yield* Ci
                yield* svc.reconcile([job])
                yield* svc.wait([{ run: 1, finished: 0 }])
                yield* Effect.sleep("10 millis")
                const res = yield* svc.progress(1)
                yield* svc.reconcile([])
                return res
              }).pipe(
                Effect.provide(
                  CommandCi.streamed({
                    repository: fakeRepo,
                    command: (checks, commit) => ({ command: "ci", args: [checks.join(","), commit] }),
                    poll: "5 millis"
                  }).pipe(Layer.provide(spawnerStreamed))
                )
              )
            )
            if (candidateMode === "built" && streamIncomplete && ci2._tag !== "lost") return false
            if (
              candidateMode === "built" && !streamIncomplete && (ci2._tag !== "running" || ci2.finished.length !== 2)
            ) return false

            // 3. CommandFixer.layer
            const fixDir = join(tempRoot, `fixer-${iter++}`)
            const fs = yield* FileSystem.FileSystem
            yield* fs.makeDirectory(fixDir, { recursive: true })
            const spawnerFixer = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((cmd) =>
                Effect.sync(() => {
                  const args = cmd._tag === "StandardCommand" ? cmd.args : []
                  const ansPath = String(args[1]!)
                  const payload = fixerAnswer === "fixed"
                    ? { _tag: "fixed", commit: "fixed-commit-rev1" }
                    : { _tag: "gaveUp", detail: "no luck" }
                  writeFileSync(ansPath, JSON.stringify(payload) + "\n")
                  return makeFakeHandle("", 0)
                })
              )
            )
            const fixAns = yield* Effect.scoped(
              Effect.gen(function*() {
                const svc = yield* Fixer
                const brief = { id: 1, rev: 0, attempt: 1, run: 1, failures: [1], ahead: [] }
                yield* svc.reconcile([brief])
                yield* svc.wait([{ id: 1, attempt: 1 }])
                const ans = yield* svc.answer(1, 1)
                // Reconcile with updated failures & then empty
                yield* svc.reconcile([{ ...brief, failures: [1, 2] }])
                yield* svc.reconcile([])
                return ans
              }).pipe(
                Effect.provide(
                  CommandFixer.layer({
                    repository: fakeRepo,
                    directory: fixDir,
                    command: (brief, answer) => ({ command: "fix", args: [brief, answer] }),
                    poll: "5 millis"
                  }).pipe(Layer.provide(Layer.merge(spawnerFixer, NodeFileSystem.layer)))
                )
              )
            )
            if (fixAns === undefined || fixAns._tag !== fixerAnswer) return false
            if (fixerAnswer === "fixed") {
              if (!registered.some((r) => r.part.id === 1 && r.part.rev === 1 && r.commit === "fixed-commit-rev1")) {
                return false
              }
            }
            return true
          }).pipe(Effect.provide(NodeFileSystem.layer)),
        { seed: seed + 4, executions: Math.min(executions, 25) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it(
    "JjRepository preserves append-only main, CAS advance, conflict detection, foreign commits, and settle across real jj repos",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          conflictSecond: Schema.Boolean,
          addForeignCommit: Schema.Boolean,
          settleAfterLand: Schema.Boolean,
          staleAdvance: Schema.Boolean
        })
      )
      let repoCounter = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ conflictSecond, addForeignCommit, settleAfterLand, staleAdvance }) =>
            Effect.gen(function*() {
              const repoId = repoCounter++
              const repoDir = join(tempRoot, `jj-repo-${repoId}`)
              const ledgerPath = join(tempRoot, `jj-ledger-${repoId}.json`)
              const jj = (...args: ReadonlyArray<string>): string =>
                execFileSync(
                  "jj",
                  [
                    "--config",
                    "user.name=Fuzz",
                    "--config",
                    "user.email=fuzz@example.test",
                    "--no-pager",
                    "--color=never",
                    ...args
                  ],
                  { cwd: repoDir, encoding: "utf8" }
                ).trim()

              const fs = yield* FileSystem.FileSystem
              yield* fs.makeDirectory(repoDir, { recursive: true })
              jj("git", "init")
              writeFileSync(join(repoDir, "shared.txt"), "base\n")
              jj("commit", "-m", "base")
              jj("bookmark", "create", "main", "-r", "@-")
              const baseId = jj("log", "--no-graph", "-r", "main", "-T", "commit_id")

              // Change 1: touches shared.txt + f1.txt
              jj("new", baseId)
              writeFileSync(join(repoDir, "shared.txt"), "from-change-1\n")
              writeFileSync(join(repoDir, "f1.txt"), "1\n")
              const c1 = jj("log", "--no-graph", "-r", "@", "-T", "commit_id")

              // Change 2: either conflicts on shared.txt or touches disjoint f2.txt
              jj("new", baseId)
              if (conflictSecond) {
                writeFileSync(join(repoDir, "shared.txt"), "from-change-2-conflict\n")
              } else {
                writeFileSync(join(repoDir, "f2.txt"), "2\n")
              }
              const c2 = jj("log", "--no-graph", "-r", "@", "-T", "commit_id")

              const repo = yield* JjRepository.make({
                path: repoDir,
                bookmark: "main",
                ledger: ledgerPath,
                poll: "10 millis"
              })

              const initialTip = yield* repo.tip
              if (initialTip.length !== 0) return false

              yield* repo.register({ id: 1, rev: 0 }, c1)
              yield* repo.register({ id: 2, rev: 0 }, c2)

              // Candidate for [1] must build cleanly
              const cand1 = yield* repo.candidate([{ id: 1, rev: 0 }], 0)
              if (cand1._tag !== "built") return false
              // Cached reuse returns identical commit
              const cand1Again = yield* repo.candidate([{ id: 1, rev: 0 }], 0)
              if (cand1Again._tag !== "built" || cand1Again.commit !== cand1.commit) return false

              // Candidate for [1, 2] conflicts iff conflictSecond
              const cand12 = yield* repo.candidate([{ id: 1, rev: 0 }, { id: 2, rev: 0 }], 0)
              if (conflictSecond) {
                if (cand12._tag !== "conflict" || cand12.part.id !== 2) return false
              } else {
                if (cand12._tag !== "built") return false
              }

              // Advance main to [1]
              yield* repo.advance([], [{ id: 1, rev: 0 }])
              const tipAfter1 = yield* repo.tip
              if (!sameTree(tipAfter1, [{ id: 1, rev: 0 }])) return false

              // Stale CAS advance from [] is an idempotent no-op leaving tip unchanged; stale candidate returns stale
              if (staleAdvance) {
                const staleCand = yield* repo.candidate([{ id: 2, rev: 0 }], 0)
                if (staleCand._tag !== "stale") return false
                yield* repo.advance([], [{ id: 1, rev: 0 }])
                const tipUnchanged = yield* repo.tip
                if (!sameTree(tipUnchanged, tipAfter1)) return false
              }

              // Advance to [1, 2] when non-conflicting
              if (!conflictSecond) {
                yield* repo.advance([{ id: 1, rev: 0 }], [{ id: 1, rev: 0 }, { id: 2, rev: 0 }])
                const tipAfter2 = yield* repo.tip
                if (!sameTree(tipAfter2, [{ id: 1, rev: 0 }, { id: 2, rev: 0 }])) return false
              }

              // Foreign commit on main
              if (addForeignCommit) {
                jj("new", "main")
                writeFileSync(join(repoDir, "foreign.txt"), "ext\n")
                jj("commit", "-m", "foreign")
                jj("bookmark", "set", "main", "-r", "@-")
                const tipWithForeign = yield* repo.tip
                const last = tipWithForeign[tipWithForeign.length - 1]
                if (last === undefined || last.id < JjRepository.firstForeign) return false
              }

              // Settle & reload via Target layer
              if (settleAfterLand) {
                const targetLayer = JjRepository.target(repo, "10 millis")
                yield* Effect.gen(function*() {
                  const t = yield* Target
                  yield* t.settle(1)
                  const afterSettle = yield* t.tip
                  if (afterSettle.some((p) => p.id === 1)) {
                    return yield* Effect.fail(new Unavailable({ service: "target", detail: "not settled" }))
                  }
                }).pipe(Effect.provide(targetLayer))
              }

              return true
            }).pipe(Effect.provide(nodeHost)),
          { seed: seed + 5, executions: Math.min(executions, 8) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    }, 90_000)
})
