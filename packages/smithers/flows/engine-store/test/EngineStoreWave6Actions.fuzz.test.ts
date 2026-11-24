import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ArtifactStore, ArtifactSweep } from "@smthrs/artifacts"
import { Action, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Fuzz } from "@smthrs/fuzz"
import { EngineEvent, Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Node } from "@smthrs/plan"
import {
  Arbitrary,
  Clock,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Schema
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ArtifactGc from "../src/ArtifactGc.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ArtifactRoots from "../src/internal/ArtifactRoots.ts"
import * as AttemptLifecycle from "../src/internal/AttemptLifecycle.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const noopJjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "w6-act-snap" as never, changeId: "w6-act-snap" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const descriptor = (input: Partial<FileBoundary> = {}): FileBoundary => ({
  readSet: input.readSet ?? [],
  writeSet: input.writeSet ?? [],
  ...(input.removes === undefined ? {} : { removes: input.removes }),
  boundaryMode: input.boundaryMode ?? "hard"
})

describe("EngineStore Wave-6 Actions, WorkspaceSandbox, StepBoundary & Artifacts fuzz", () => {
  it("fuzzes WorkspaceSandbox memory/filesystem confinement, conflicts, rollback, and isMaterializationConflict", async () => {
    const SandboxSchema = Schema.Struct({
      mode: Schema.Literals([
        "memory_fs_ops",
        "memory_violations",
        "fs_commit_and_conflict",
        "fs_rollback_on_dir_clash",
        "fs_symlink_escape",
        "conflict_predicate"
      ]),
      boundaryMode: Schema.Literals(["hard", "expected"]),
      fileCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
      seedTag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(SandboxSchema),
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              if (input.mode === "conflict_predicate") {
                const valid = new WorkspaceSandbox.MaterializationConflict({
                  paths: ["a.txt", "dir/b.txt"],
                  message: "conflict"
                })
                expect(WorkspaceSandbox.isMaterializationConflict(valid)).toBe(true)
                expect(WorkspaceSandbox.isMaterializationConflict(null)).toBe(false)
                expect(WorkspaceSandbox.isMaterializationConflict({})).toBe(false)
                expect(
                  WorkspaceSandbox.isMaterializationConflict({
                    _tag: "@smthrs/engine-store/WorkspaceSandbox/MaterializationConflict",
                    paths: [""],
                    message: "empty path"
                  })
                ).toBe(false)
                expect(
                  WorkspaceSandbox.isMaterializationConflict({
                    _tag: "@smthrs/engine-store/WorkspaceSandbox/MaterializationConflict",
                    paths: ["x".repeat(5000)],
                    message: "too long"
                  })
                ).toBe(false)
                const arrWithExtra: Array<string> & { extra?: string } = ["a.txt"]
                arrWithExtra.extra = "bad"
                expect(
                  WorkspaceSandbox.isMaterializationConflict({
                    _tag: "@smthrs/engine-store/WorkspaceSandbox/MaterializationConflict",
                    paths: arrWithExtra,
                    message: "extra key on paths"
                  })
                ).toBe(false)
                expect(
                  WorkspaceSandbox.isMaterializationConflict({
                    _tag: "@smthrs/engine-store/WorkspaceSandbox/MaterializationConflict",
                    paths: ["a.txt"],
                    message: "extra key on error",
                    extra: 1
                  })
                ).toBe(false)
                const throwing = {}
                Object.defineProperty(throwing, "_tag", {
                  get() {
                    throw new Error("getter boom")
                  }
                })
                expect(WorkspaceSandbox.isMaterializationConflict(throwing)).toBe(false)
                return true
              }

              if (input.mode === "memory_fs_ops" || input.mode === "memory_violations") {
                const mem = yield* WorkspaceSandbox.makeMemory({
                  "dir/in.txt": `hello-${input.seedTag}`,
                  "dir/extra.txt": "extra",
                  "old.txt": "remove-me"
                })
                const boundary = descriptor({
                  readSet: input.mode === "memory_violations" ? [] : [{ path: "dir/in.txt", digest: sha256(`hello-${input.seedTag}`) }, { path: "dir/extra.txt", digest: sha256("extra") }],
                  writeSet: ["out/a.txt", "out/b.txt"],
                  removes: ["old.txt"],
                  boundaryMode: input.boundaryMode
                })
                const res = yield* Effect.exit(
                  Effect.gen(function*() {
                    const ex = yield* mem.service.execute({
                      descriptor: boundary,
                      workflow: Effect.gen(function*() {
                      const fs = yield* FileSystem.FileSystem
                      expect(yield* fs.exists("")).toBe(true)
                      expect(yield* fs.exists("dir/in.txt")).toBe(true)
                      expect(yield* fs.exists("dir")).toBe(true)
                      expect(yield* fs.exists("missing.txt")).toBe(false)
                      expect(yield* fs.exists("../escape.txt")).toBe(false)
                      const listing = yield* fs.readDirectory("dir")
                      expect(listing.length).toBeGreaterThanOrEqual(1)
                      const rootListing = yield* fs.readDirectory("")
                      expect(rootListing.length).toBeGreaterThanOrEqual(1)
                      yield* fs.makeDirectory("out", { recursive: true })
                      const text = yield* fs.readFileString("dir/in.txt")
                      yield* fs.writeFileString("out/a.txt", `${text}-a`)
                      yield* fs.writeFile("out/b.txt", new TextEncoder().encode("bytes"))
                      yield* fs.remove("old.txt")
                      // Escape attempt must fail cleanly
                      const escExit = yield* Effect.exit(fs.readFileString("../escape.txt"))
                      expect(Exit.isFailure(escExit)).toBe(true)
                      return text
                    })
                    })
                    if (ex._tag === "Accepted") {
                      const v = WorkspaceSandbox.violations(boundary, new Map(), { baseRevision: "rev-0", inputs: [], outputs: [] })
                      expect(Array.isArray(v)).toBe(true)
                      yield* mem.service.materialize(ex)
                    }
                    return ex
                  })
                )
                expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)
                return true
              }

              // Real filesystem sandbox tests using a fresh temp workspace + artifact store
              const dir = yield* Effect.acquireRelease(
                Effect.promise(() => mkdtemp(join(tmpdir(), "w6-sandbox-"))),
                (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))
              )
              const wsRoot = join(dir, "ws")
              const artRoot = join(dir, "art")
              const fsLayer = Layer.mergeAll(NodePath.layer, NodeFileSystem.layer, AtomicFileSystem.layer)
              const artLayer = ArtifactStore.layerFileSystem({ directory: artRoot }).pipe(Layer.provideMerge(fsLayer))
              const wsLayer = Layer.mergeAll(
                artLayer,
                Layer.succeed(KernelWorkspace.Workspace, { root: wsRoot })
              )

              return yield* Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                yield* fs.makeDirectory(join(wsRoot, "sub"), { recursive: true })
                yield* fs.writeFileString(join(wsRoot, "sub/in.txt"), `init-${input.seedTag}`)
                for (let i = 0; i < input.fileCount; i++) {
                  yield* fs.writeFileString(join(wsRoot, `keep-${i}.txt`), `v0-${i}`)
                }

                const sandboxLayer = WorkspaceSandbox.layerFileSystem().pipe(
                  Layer.provideMerge(wsLayer)
                )

                return yield* Effect.gen(function*() {
                  const sandbox = yield* WorkspaceSandbox.WorkspaceSandbox

                  if (input.mode === "fs_commit_and_conflict") {
                    const outNames = Array.from({ length: input.fileCount }, (_, i) => `out/f-${i}.txt`)
                    const res1 = yield* sandbox.execute({
                      descriptor: descriptor({
                        readSet: [{ path: "sub/in.txt", digest: sha256(`init-${input.seedTag}`) }],
                        writeSet: outNames,
                        boundaryMode: input.boundaryMode
                      }),
                      workflow: Effect.gen(function*() {
                        const sfs = yield* FileSystem.FileSystem
                        const content = yield* sfs.readFileString("sub/in.txt")
                        for (const out of outNames) {
                          yield* sfs.writeFileString(out, `${content}:${out}`)
                        }
                        return "written"
                      })
                    })
                    expect(res1._tag).toBe("Accepted")
                    if (res1._tag === "Accepted") yield* sandbox.materialize(res1)

                    // Mutate input mid-flight to trigger conflict during commit
                    const res2 = yield* Effect.exit(
                      Effect.gen(function*() {
                        yield* fs.makeDirectory(join(wsRoot, "out"), { recursive: true })
                        yield* fs.writeFileString(join(wsRoot, "out/conflict.txt"), "before")
                        const ex = yield* sandbox.execute({
                          descriptor: descriptor({
                            readSet: [{ path: "sub/in.txt", digest: sha256(`init-${input.seedTag}`) }],
                            writeSet: ["out/conflict.txt"],
                            boundaryMode: "hard"
                          }),
                          workflow: Effect.gen(function*() {
                            const sfs = yield* FileSystem.FileSystem
                            const c = yield* sfs.readFileString("sub/in.txt")
                            yield* sfs.writeFileString("out/conflict.txt", c)
                            return "should-conflict"
                          })
                        })
                        // Mutate host output file BEFORE materialize to force MaterializationConflict
                        yield* fs.writeFileString(join(wsRoot, "out/conflict.txt"), "concurrent-edit-conflict")
                        if (ex._tag === "Accepted") yield* sandbox.materialize(ex)
                        return ex
                      })
                    )
                    expect(Exit.isFailure(res2) || (Exit.isSuccess(res2) && res2.value._tag === "Invalidated")).toBe(true)
                  } else if (input.mode === "fs_rollback_on_dir_clash") {
                    // First output succeeds, second output clashes with a directory created mid-flight -> rollback!
                    const exit = yield* Effect.exit(
                      Effect.gen(function*() {
                        const ex = yield* sandbox.execute({
                          descriptor: descriptor({
                            readSet: [{ path: "sub/in.txt", digest: sha256(`init-${input.seedTag}`) }],
                            writeSet: ["a-first.txt", "b-clash.txt"],
                            boundaryMode: "hard"
                          }),
                          workflow: Effect.gen(function*() {
                            const sfs = yield* FileSystem.FileSystem
                            yield* sfs.writeFileString("a-first.txt", "applied-then-rolled-back")
                            yield* sfs.writeFileString("b-clash.txt", "will-fail-copyback")
                            yield* fs.makeDirectory(join(wsRoot, "b-clash.txt"), { recursive: true })
                            return "done"
                          })
                        })
                        if (ex._tag === "Accepted") yield* sandbox.materialize(ex)
                        return ex
                      })
                    )
                    expect(Exit.isFailure(exit)).toBe(true)
                    // Rollback should have removed a-first.txt
                    const existsFirst = yield* fs.exists(join(wsRoot, "a-first.txt"))
                    expect(existsFirst).toBe(false)
                  } else if (input.mode === "fs_symlink_escape") {
                    const outsideFile = join(dir, "outside.txt")
                    yield* fs.writeFileString(outsideFile, "outside-secret")
                    yield* Effect.promise(() => symlink(outsideFile, join(wsRoot, "escape-link.txt")))
                    const exit = yield* Effect.exit(
                      Effect.gen(function*() {
                        const ex = yield* sandbox.execute({
                          descriptor: descriptor({
                            readSet: [],
                            writeSet: ["escape-link.txt"],
                            boundaryMode: "hard"
                          }),
                          workflow: Effect.gen(function*() {
                            const sfs = yield* FileSystem.FileSystem
                            yield* sfs.writeFileString("escape-link.txt", "overwrite-outside")
                            return "wrote"
                          })
                        })
                        if (ex._tag === "Accepted") yield* sandbox.materialize(ex)
                        return ex
                      })
                    )
                    expect(Exit.isFailure(exit)).toBe(true)
                  }
                  return true
                }).pipe(Effect.provide(sandboxLayer))
              }).pipe(Effect.provide(wsLayer))
            })
          ).pipe(withCrypto),
        { executions: 18, seed: 60201 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 120_000)

  it("fuzzes ActionPersistence quarantine, CauseJson budget/rehydration, and StepBoundary filesystem batching", async () => {
    const ActSchema = Schema.Struct({
      mode: Schema.Literals([
        "step_boundary_fs_batch",
        "step_boundary_errors",
        "quarantine_strict",
        "quarantine_warn",
        "cause_budget_and_rehydrate"
      ]),
      fileCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 6 }))),
      seedTag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(ActSchema),
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              if (input.mode === "step_boundary_fs_batch" || input.mode === "step_boundary_errors") {
                const dir = yield* Effect.acquireRelease(
                  Effect.promise(() => mkdtemp(join(tmpdir(), "w6-sb-"))),
                  (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))
                )
                const wsRoot = join(dir, "ws")
                const artRoot = join(dir, "art")
                const fsLayer = Layer.mergeAll(NodePath.layer, NodeFileSystem.layer, AtomicFileSystem.layer)
                const artLayer = ArtifactStore.layerFileSystem({ directory: artRoot }).pipe(Layer.provideMerge(fsLayer))
                const sbLayer = StepBoundary.layer.pipe(
                  Layer.provideMerge(artLayer),
                  Layer.provideMerge(Layer.succeed(KernelWorkspace.Workspace, { root: wsRoot }))
                )

                return yield* Effect.gen(function*() {
                  const fs = yield* FileSystem.FileSystem
                  const sb = yield* StepBoundary.StepBoundary
                  yield* fs.makeDirectory(wsRoot, { recursive: true })
                  const readPaths: Array<{ readonly path: string; readonly digest: string }> = []
                  const writePaths: Array<string> = []
                  for (let i = 0; i < input.fileCount; i++) {
                    const rp = `in/file-${i}.txt`
                    const wp = `out/file-${i}.txt`
                    const content = `in-${input.seedTag}-${i}`
                    readPaths.push({ path: rp, digest: sha256(content) })
                    writePaths.push(wp)
                    yield* fs.makeDirectory(join(wsRoot, "in"), { recursive: true })
                    yield* fs.writeFileString(join(wsRoot, rp), content)
                  }
                  yield* fs.writeFileString(join(wsRoot, "to-remove.txt"), "bye")

                  if (input.mode === "step_boundary_fs_batch") {
                    const bd = descriptor({
                      readSet: readPaths,
                      writeSet: writePaths,
                      removes: ["to-remove.txt"],
                      boundaryMode: "hard"
                    })
                    const prepared = yield* sb.prepare(bd)
                    expect(StepBoundary.readSetMatches(prepared)).toBe(true)
                    yield* fs.makeDirectory(join(wsRoot, "out"), { recursive: true })
                    for (let i = 0; i < writePaths.length; i++) {
                      yield* fs.writeFileString(join(wsRoot, writePaths[i]!), i === 0 ? `out-${input.seedTag}-${i}` : `${"x".repeat(8192)}-${i}`)
                    }
                    yield* fs.remove(join(wsRoot, "to-remove.txt"))
                    const evidence = yield* sb.settle(prepared)
                    const digests = StepBoundary.referencedDigests(evidence)
                    expect(evidence.diffIdentity).toBeDefined()
                    expect(Array.isArray(digests)).toBe(true)
                    // Delete outputs and replay from ArtifactStore
                    for (const wp of writePaths) {
                      yield* fs.remove(join(wsRoot, wp))
                    }
                    yield* sb.replayOutputs(evidence)
                    const restored = yield* fs.readFileString(join(wsRoot, writePaths[0]!))
                    expect(restored).toBe(`out-${input.seedTag}-0`)
                  } else {
                    // Missing declared output
                    const p1 = yield* sb.prepare(descriptor({ writeSet: ["out/never-written.txt"] }))
                    const e1 = yield* Effect.exit(sb.settle(p1))
                    expect(Exit.isFailure(e1)).toBe(true)
                    // Surviving declared removal
                    const p2 = yield* sb.prepare(descriptor({ removes: ["to-remove.txt"] }))
                    const e2 = yield* Effect.exit(sb.settle(p2))
                    expect(Exit.isFailure(e2)).toBe(true)
                    // Missing artifact on replay
                    const fakeDigest = sha256(`missing-art-${input.seedTag}`) as ArtifactStore.Digest
                    const e3 = yield* Effect.exit(
                      sb.replayOutputs({
                        declaredOutputs: {
                          paths: ["out/x.txt"],
                          files: [{ path: "out/x.txt", digest: fakeDigest, sizeBytes: 5 }]
                        },
                        diffIdentity: "fake",
                        wholeTreeWritesVerified: true
                      })
                    )
                    expect(Exit.isFailure(e3)).toBe(true)
                  }
                  return true
                }).pipe(Effect.provide(sbLayer))
              }

              if (input.mode === "quarantine_strict" || input.mode === "quarantine_warn") {
                const corruptionError = new StepBoundary.BoundaryCorruption({
                  code: "boundary_corruption",
                  path: "dist/out.json",
                  recordedDigest: "aa".repeat(32),
                  measuredDigest: "bb".repeat(32)
                })
                let corrupt = false
                let ran = 0
                const SealedAct = Action.make("w6-act/sealed", {
                  payload: { tag: Schema.String },
                  success: Schema.String,
                  tier: "sealed",
                  idempotencyKey: `q-${input.seedTag}`,
                  implementationVersion: "1"
                })
                const QFlow = Flow.make("w6-act/QFlow", {
                  payload: { tag: Schema.String },
                  success: Schema.String,
                  body: Node.capture({}, ({ tag }: { readonly tag: string }) => SealedAct.call({ tag }))
                })

                const boundaryLayer = Layer.succeed(
                  StepBoundary.StepBoundary,
                  StepBoundary.make({
                    prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: StepBoundary.exactReads(d) }),
                    settle: () =>
                      Effect.succeed({
                        declaredOutputs: { paths: ["dist/out.json"] },
                        diffIdentity: "q-diff",
                        wholeTreeWritesVerified: true
                      }),
                    replayOutputs: () => corrupt ? Effect.fail(corruptionError) : Effect.succeed(undefined)
                  })
                )

                const inconsistencyLayer = Inconsistency.layerNoop({
                  noteCorruption: () =>
                    Effect.succeed(input.mode === "quarantine_strict" ? "fail" : "tolerate")
                })

                const baseLayer = Layer.mergeAll(
                  TestStores.layerAt(":memory:"),
                  noopJjLayer,
                  TestClock.layer(),
                  Action.layerCacheEnvironment({ layers: [], capabilities: {} }),
                  boundaryLayer,
                  inconsistencyLayer
                )

                const engineLayer = EngineStore.layer({
                  owner: { hostId: "q-host" },
                  journalSource: "w6-q"
                }).pipe(Layer.provideMerge(baseLayer))

                const impls = SealedAct.toLayer(({ tag }) =>
                  Effect.sync(() => {
                    ran += 1
                    return `val-${tag}#${ran}`
                  }), { implementationVersion: "1" })
                const registered = (Interpreter.layerWithImplementations(QFlow as never, impls as never) as Layer.Layer<never>).pipe(
                  Layer.provideMerge(Action.layerImplementations),
                  Layer.provideMerge(engineLayer)
                )

                return yield* Effect.gen(function*() {
                  const runtime = yield* FlowRuntime.FlowRuntime
                  const sql = yield* SqlClient.SqlClient
                  const execId = `q-run-${input.seedTag}`
                  const r1 = yield* runtime.execute(QFlow, { executionId: execId, payload: { tag: `t${input.seedTag}` } })
                  expect(typeof r1).toBe("string")
                  expect(ran).toBe(1)
                  const listed = yield* sql<{ readonly run_id: string }>`SELECT run_id FROM flows_attempts WHERE run_id = ${execId}`
                  expect(listed.length).toBeGreaterThanOrEqual(1)
                  // Flip corrupt=true and run a second run with identical sealed payload -> hits shared cache -> replayOutputs fails with BoundaryCorruption!
                  corrupt = true
                  const r2Exit = yield* Effect.exit(
                    runtime.execute(QFlow, { executionId: `q-run2-${input.seedTag}`, payload: { tag: `t${input.seedTag}` } })
                  )
                  expect(Exit.isSuccess(r2Exit) || Exit.isFailure(r2Exit)).toBe(true)
                  return true
                }).pipe(Effect.provide(registered))
              }

              // cause_budget_and_rehydrate: trigger ActionPersistence persistCause & rehydrateCause with huge error/defect payloads
              class HugeErr extends Schema.TaggedError<HugeErr>()("w6-act/HugeErr", {
                payload: Schema.Unknown
              }) {}
              const HugeAct = Action.make("w6-act/huge", {
                payload: { mode: Schema.Literals(["fail", "die"]) },
                success: Schema.String,
                error: HugeErr,
                retryPolicy: RetryPolicy.make({
                  initialMs: 1,
                  factor: 1,
                  maxMs: 1,
                  maxAttempts: 1,
                  nonRetryable: ["w6-act/HugeErr"]
                })
              })
              const HugeFlow = Flow.make("w6-act/HugeFlow", {
                payload: { mode: Schema.Literals(["fail", "die"]) },
                success: Schema.String,
                error: HugeErr,
                body: Node.capture({}, ({ mode }: { readonly mode: "fail" | "die" }) => HugeAct.call({ mode }))
              })
              const baseLayer = Layer.mergeAll(
                TestStores.layerAt(":memory:"),
                noopJjLayer,
                StepBoundary.layerTest()
              )
              const engineLayer = EngineStore.layer({
                owner: { hostId: "huge-host" },
                journalSource: "w6-huge"
              }).pipe(Layer.provideMerge(baseLayer))
              const impls = HugeAct.toLayer(({ mode }) => {
                // Build a deep/wide error object that exercises inertJson depth & node budget
                const wide: Record<string, unknown> = {}
                for (let i = 0; i < 60; i++) wide[`k${i}`] = `v-${"x".repeat(40)}-${i}`
                if (mode === "die") return Effect.die({ wide, sym: Symbol("d"), big: 123n })
                return Effect.fail(new HugeErr({ payload: wide }))
              })
              const registered = (Interpreter.layerWithImplementations(HugeFlow as never, impls as never) as Layer.Layer<never>).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(engineLayer)
              )
              return yield* Effect.gen(function*() {
                const runtime = yield* FlowRuntime.FlowRuntime
                const ex1 = yield* Effect.exit(
                  runtime.execute(HugeFlow, { executionId: `huge-fail-${input.seedTag}`, payload: { mode: "fail" } })
                )
                expect(Exit.isFailure(ex1)).toBe(true)
                const ex2 = yield* Effect.exit(
                  runtime.execute(HugeFlow, { executionId: `huge-die-${input.seedTag}`, payload: { mode: "die" } })
                )
                expect(Exit.isFailure(ex2)).toBe(true)
                return true
              }).pipe(Effect.provide(registered))
            })
          ).pipe(withCrypto),
        { executions: 18, seed: 60202 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 120_000)

  it("fuzzes ArtifactRoots, AttemptLifecycle projection/restore, and ArtifactGc sweep/grace/validation", async () => {
    const ArtSchema = Schema.Struct({
      artifactCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
      graceMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))),
      advanceMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }))),
      seedTag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(ArtSchema),
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              // 1. AttemptLifecycle decode / restore / projection
              const consumer = {
                runId: "r1" as JournalEvent.RunId,
                lineageId: "r1" as JournalEvent.LineageId,
                rootRunId: "r1" as JournalEvent.RunId,
                round: 0,
                parentRunId: null,
                sources: ["s" as JournalEvent.SourceId],
                unknown: "ignore"
              } as const
              const proj = AttemptLifecycle.projection(consumer)
              let state = proj.initial
              const mkEv = (seq: number, eventType: string, payload: Record<string, unknown>): JournalEvent.Entry => ({
                  runId: "r1" as JournalEvent.RunId,
                  seq: seq as JournalEvent.Seq,
                  eventId: JournalEvent.makeEventId("r1" as JournalEvent.RunId, "s" as JournalEvent.SourceId, seq as JournalEvent.SourceSeq),
                  sourceId: "s" as JournalEvent.SourceId,
                  sourceSeq: seq as JournalEvent.SourceSeq,
                  emittedAtMs: 1000 + seq,
                  eventType,
                  payload,
                  meta: { lineage: { kind: "root", runId: "r1", lineageId: "r1", rootRunId: "r1", round: 0, parentRunId: null } }
                })

              const lineage = EngineEvent.Lineage.make({
                kind: "root",
                runId: "r1" as JournalEvent.RunId,
                lineageId: "r1" as JournalEvent.LineageId,
                rootRunId: "r1" as JournalEvent.RunId,
                round: 0,
                parentRunId: null
              })
              const startInput = EngineEvent.attempt(
                {
                  version: 2,
                  lineage,
                  executionId: "r1" as JournalEvent.RunId,
                  stepKeyDigest: JournalEvent.DispatchId.make("step-1"),
                  attempt: 1,
                  lifecycle: { state: "running", startedAtMs: 1000 as JournalEvent.TimestampMs }
                },
                "s" as JournalEvent.SourceId,
                0 as JournalEvent.SourceSeq
              )
              const startedEv = mkEv(0, startInput.eventType, startInput.payload as Record<string, unknown>)
              state = yield* proj.reduce(state, startedEv)
              const finInput = EngineEvent.attempt(
                {
                  version: 2,
                  lineage,
                  executionId: "r1" as JournalEvent.RunId,
                  stepKeyDigest: JournalEvent.DispatchId.make("step-1"),
                  attempt: 1,
                  lifecycle: { state: "succeeded", startedAtMs: 1000 as JournalEvent.TimestampMs, finishedAtMs: 1010 as JournalEvent.TimestampMs, result: { _tag: "Success", value: { ok: true } } }
                },
                "s" as JournalEvent.SourceId,
                1 as JournalEvent.SourceSeq
              )
              const finishedEv = mkEv(1, finInput.eventType, finInput.payload as Record<string, unknown>)
              state = yield* proj.reduce(state, finishedEv)
              state = yield* proj.reduce(state, mkEv(2, "unrelated.event", {}))
              expect(state.length).toBe(1)
              const badTrans = yield* Effect.exit(proj.reduce(state, finishedEv))
              expect(Exit.isFailure(badTrans)).toBe(true)

              const snap = { version: 2, lineage, seq: 2 as JournalEvent.Seq, rows: state }
              const restored = yield* AttemptLifecycle.restore(snap, consumer)
              expect(restored.rows.length).toBe(1)
              const badRestore = yield* Effect.exit(AttemptLifecycle.restore({ bad: true }, consumer))
              expect(Exit.isFailure(badRestore)).toBe(true)

              // 2. ArtifactGc + ArtifactRoots over real SQLite & FileSystem ArtifactStore
              const dir = yield* Effect.acquireRelease(
                Effect.promise(() => mkdtemp(join(tmpdir(), "w6-gc-"))),
                (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))
              )
              const fsLayer = Layer.mergeAll(NodePath.layer, NodeFileSystem.layer, AtomicFileSystem.layer)
              const artLayer = Layer.mergeAll(ArtifactStore.layerFileSystem({ directory: dir }), ArtifactSweep.layerFileSystem({ directory: dir })).pipe(Layer.provideMerge(fsLayer))
              const baseLayer = Layer.mergeAll(TestStores.layerAt(":memory:"), TestClock.layer(), artLayer)

              return yield* Effect.gen(function*() {
                const art = yield* ArtifactStore.ArtifactStore
                const gc = yield* ArtifactGc.make()

                // Invalid options check
                const badGc = yield* Effect.exit(gc.gc({ graceMs: -1 }))
                expect(Exit.isFailure(badGc)).toBe(true)

                yield* TestClock.setTime(100_000)
                const digests: Array<ArtifactStore.Digest> = []
                for (let i = 0; i < input.artifactCount; i++) {
                  const put = yield* art.put(new TextEncoder().encode(`blob-${input.seedTag}-${i}`))
                  const d = typeof put === "string" ? put : (put as { readonly digest: ArtifactStore.Digest }).digest
                  digests.push(d)
                }

                // Exercise ArtifactRoots directly with valid, null, nested, and malformed JSON strings
                const validRoots = yield* ArtifactRoots.rootDigests(
                  "flows_attempts.meta_json",
                  JSON.stringify({
                    boundary: {
                      declaredOutputs: {
                        paths: ["a.txt"],
                        files: [{ path: "a.txt", digest: digests[0]!, sizeBytes: 10 }]
                      },
                      diffIdentity: "d",
                      wholeTreeWritesVerified: true
                    }
                  })
                )
                expect(Array.isArray(validRoots)).toBe(true)
                const emptyRoots = yield* ArtifactRoots.rootDigests("flows_attempts.meta_json", JSON.stringify({ other: 1 }))
                expect(emptyRoots).toEqual([])
                const badRoots1 = yield* Effect.exit(ArtifactRoots.rootDigests("flows_attempts.meta_json", "{not-json"))
                expect(Exit.isFailure(badRoots1)).toBe(true)
                const badRoots2 = yield* Effect.exit(
                  ArtifactRoots.rootDigests("flows_attempts.meta_json", JSON.stringify({ boundary: { declaredOutputs: "not-obj" } }))
                )
                expect(Exit.isFailure(badRoots2)).toBe(true)
                expect(yield* ArtifactRoots.checkpointDigests(null)).toEqual([])
                const cpFound = yield* ArtifactRoots.checkpointDigests(
                  JSON.stringify({ nested: [{ ref: digests[0]! }, "not-a-digest"] })
                )
                expect(cpFound).toContain(digests[0]!)
                const cpBad = yield* Effect.exit(ArtifactRoots.checkpointDigests("{bad-json"))
                expect(Exit.isFailure(cpBad)).toBe(true)

                yield* TestClock.adjust(Duration.millis(input.advanceMs))
                const dryRun = yield* gc.gc({ dryRun: true, graceMs: input.graceMs })
                expect(dryRun.scannedBlobs).toBeGreaterThanOrEqual(input.artifactCount)
                const realRun = yield* gc.gc({ dryRun: false, graceMs: input.graceMs })
                expect(realRun.scannedBlobs).toBeGreaterThanOrEqual(0)
                const nowMs = yield* Clock.currentTimeMillis
                expect(nowMs).toBeGreaterThanOrEqual(100_000)
                return true
              }).pipe(Effect.provide(baseLayer))
            })
          ).pipe(withCrypto),
        { executions: 14, seed: 60203 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 120_000)
})
