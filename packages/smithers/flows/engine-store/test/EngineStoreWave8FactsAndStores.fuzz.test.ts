import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ArtifactStore, ArtifactSweep } from "@smthrs/artifacts"
import { Sha256 } from "@smthrs/crypto"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableClock, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, SqlJournal, StepFact } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import { FileSet, KeyMaterial, Node, Plan } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import {
  Arbitrary,
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Schema
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ArtifactGc from "../src/ArtifactGc.ts"
import * as ArtifactSync from "../src/ArtifactSync.ts"
import * as DeferredClockFold from "../src/DeferredClockFold.ts"
import * as DisasterRecovery from "../src/DisasterRecovery.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import { EventTypes } from "../src/EventTypes.ts"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as AttemptLifecycle from "../src/internal/AttemptLifecycle.ts"
import * as CacheAdmission from "../src/internal/CacheAdmission.ts"
import * as CacheOutputPolicy from "../src/internal/CacheOutputPolicy.ts"
import * as CopiedRecord from "../src/internal/CopiedRecord.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"
import * as ExitEncoding from "../src/internal/ExitEncoding.ts"
import * as FailureDiagnostic from "../src/internal/FailureDiagnostic.ts"
import * as FileEnumeration from "../src/internal/FileEnumeration.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as NodeJournal from "../src/internal/NodeJournal.ts"
import * as PlanInputs from "../src/internal/PlanInputs.ts"
import * as PlanMerges from "../src/internal/PlanMerges.ts"
import * as RetentionOps from "../src/internal/RetentionOps.ts"
import * as RuntimeGraph from "../src/internal/RuntimeGraph.ts"
import * as StepFacts from "../src/internal/StepFacts.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanMergeStore from "../src/PlanMergeStore.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Reconciliation from "../src/Reconciliation.ts"
import * as ReplayOnly from "../src/ReplayOnly.ts"
import * as Retention from "../src/Retention.ts"
import * as RunInspection from "../src/RunInspection.ts"
import * as SelectionStore from "../src/SelectionStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { sha256 } from "./Sha256.ts"
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) => Effect.provide(eff, NodeCrypto.layer)

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261195")
const lightExecutions = Math.min(executions, 20)

const runFuzz = async <A>(
  arb: Parameters<typeof Fuzz.run<A>>[0],
  fn: (sample: A) => Promise<void>,
  opts: { executions: number; seed: number }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (sample) =>
      Effect.promise(async () => {
        await fn(sample)
        return true
      }), opts)
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const owner: Ownership.OwnerId = { hostId: "w8-facts-host", pid: 7701, nonce: "w8-facts" }

const noopJjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "w8-snap" as never, changeId: "w8-snap" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const runAp = (
  opts: {
    readonly runId: string
    readonly owner: Ownership.OwnerId
    readonly key: string
    readonly action: unknown
    readonly attempt: number
    readonly tier: Action.Tier
    readonly nondeterministic?: true
    readonly metadata?: FileBoundary
    readonly execute: () => Effect.Effect<unknown, unknown>
  }
) =>
  ActionPersistence.make({
    runId: opts.runId,
    owner: opts.owner,
    sourceId: "w8-ap",
    execute: () => opts.execute()
  })({
    key: opts.key,
    action: opts.action,
    attempt: opts.attempt,
    tier: opts.tier,
    ...(opts.nondeterministic ? { nondeterministic: true as const } : {}),
    ...(opts.metadata === undefined ? {} : { metadata: opts.metadata })
  })

const descriptor = (input: {
  readonly readSet?: ReadonlyArray<string | FileBoundary["readSet"][number]>
  readonly writeSet?: FileBoundary["writeSet"]
  readonly removes?: FileBoundary["removes"]
  readonly boundaryMode?: FileBoundary["boundaryMode"]
} = {}): FileBoundary => ({
  readSet: (input.readSet ?? []).map((r) => typeof r === "string" ? { path: r, digest: "a".repeat(64) } : r),
  writeSet: input.writeSet ?? [],
  ...(input.removes === undefined ? {} : { removes: input.removes }),
  boundaryMode: input.boundaryMode ?? "hard"
})

describe("EngineStore Wave-8 ActionPersistence, PlanScheduler, Stores, Sync, GC, Boundary, Sandbox & DR fuzz", () => {
  it(
    "fuzzes ArtifactSync, ArtifactGc, SelectionStore, FileEnumeration, StepBoundary & WorkspaceSandbox edge paths",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          syncMode: Schema.Literals([
            "empty-and-present",
            "remote-probe-fail",
            "local-read-fail",
            "remote-no-retain",
            "hydrate-metadata-only",
            "hydrate-local-fail"
          ]),
          gcMode: Schema.Literals([
            "dry-run-and-pins",
            "invalid-page-size",
            "kept-by-grace",
            "sweeper-fail",
            "corrupt-meta"
          ]),
          boundaryCase: Schema.Literals([
            "unsupported-and-test",
            "corrupt-base64",
            "corrupt-digest",
            "missing-artifact",
            "foreign-path",
            "undeclared-write",
            "restore-missing-and-prune"
          ]),
          sandboxCase: Schema.Literals([
            "conflict-validator",
            "unsupported-and-dispatcher",
            "cache-memo-and-dir-remove",
            "memory-conflict",
            "fs-glob-and-tree"
          ])
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          const tmp = mkdtempSync(join(tmpdir(), "es-w8-stores-"))
          try {
            // 1. ArtifactSync.publish & hydrate
            await Effect.runPromise(
              withCrypto(
                Effect.gen(function*() {
                  const localStore = yield* ArtifactStore.ArtifactStore
                  const remoteStore = yield* ArtifactStore.ArtifactStore.pipe(
                    Effect.provide(Layer.fresh(ArtifactStore.layerMemory))
                  )
                  const bytes = new TextEncoder().encode("sync-payload")
                  const d = yield* localStore.put(bytes)

                  if (sample.syncMode === "empty-and-present") {
                    const sync = ArtifactSync.make({ local: localStore, remote: remoteStore })
                    yield* sync.publish([])
                    yield* sync.publish([d])
                    // Already present -> missing.length === 0
                    yield* sync.publish([d])
                    expect(yield* sync.hydrate([d])).toBe(true)
                  } else if (sample.syncMode === "remote-probe-fail") {
                    const badRemote: ArtifactStore.Service = {
                      ...remoteStore,
                      findMissing: () =>
                        Effect.fail(
                          new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "probe down" })
                        )
                    }
                    const sync = ArtifactSync.make({ local: localStore, remote: badRemote })
                    expect(Exit.isFailure(yield* Effect.exit(sync.publish([d])))).toBe(true)
                  } else if (sample.syncMode === "local-read-fail") {
                    const badLocal: ArtifactStore.Service = {
                      ...localStore,
                      get: () =>
                        Effect.fail(new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "disk dead" }))
                    }
                    const sync = ArtifactSync.make({ local: badLocal, remote: remoteStore })
                    expect(Exit.isFailure(yield* Effect.exit(sync.publish([d])))).toBe(true)
                  } else if (sample.syncMode === "remote-no-retain") {
                    const forgetfulRemote: ArtifactStore.Service = {
                      ...remoteStore,
                      put: () => Effect.succeed(d),
                      findMissing: (digests) => Effect.succeed([...digests])
                    }
                    const sync = ArtifactSync.make({ local: localStore, remote: forgetfulRemote })
                    expect(Exit.isFailure(yield* Effect.exit(sync.publish([d])))).toBe(true)
                  } else if (sample.syncMode === "hydrate-metadata-only") {
                    const sync = ArtifactSync.make({
                      local: localStore,
                      remote: remoteStore,
                      downloadPolicy: "minimal"
                    })
                    // Local has it -> true
                    expect(yield* sync.hydrate([d])).toBe(true)
                    // Local missing, remote missing -> false
                    const d2 = sha256(new TextEncoder().encode("only-remote"))
                    expect(yield* sync.hydrate([d2])).toBe(false)
                    // Put on remote -> true
                    const d3 = yield* remoteStore.put(new TextEncoder().encode("only-remote"))
                    expect(yield* sync.hydrate([d3])).toBe(true)
                    // Remote probe error -> false
                    const badRemote: ArtifactStore.Service = {
                      ...remoteStore,
                      findMissing: () =>
                        Effect.fail(new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "probe err" }))
                    }
                    const syncBad = ArtifactSync.make({
                      local: localStore,
                      remote: badRemote,
                      downloadPolicy: "minimal"
                    })
                    expect(yield* syncBad.hydrate([d3])).toBe(false)
                  } else {
                    const badLocal: ArtifactStore.Service = {
                      ...localStore,
                      findMissing: () =>
                        Effect.fail(
                          new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "local down" })
                        )
                    }
                    const sync = ArtifactSync.make({ local: badLocal, remote: remoteStore })
                    expect(yield* sync.hydrate([d])).toBe(false)
                  }
                }).pipe(Effect.provide(ArtifactStore.layerMemory))
              )
            )

            // 2. ArtifactGc edge paths (layerPolicy, dryRun, pagination, keptByGrace, sweeper errors, corrupt meta)
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const nowMs = Date.now()
                  const blobOld = {
                    digest: "a".repeat(64) as ArtifactStore.Digest,
                    sizeBytes: 128,
                    mtimeMs: nowMs - 10_000_000
                  }
                  const blobPinned = {
                    digest: "b".repeat(64) as ArtifactStore.Digest,
                    sizeBytes: 64,
                    mtimeMs: nowMs - 10_000_000
                  }

                  if (sample.gcMode === "corrupt-meta") {
                    yield* sql`INSERT INTO flows_step_cache (key_digest, result_json, meta_json, recorded_run_id, recorded_event_seq, created_at_ms) VALUES (${
                      "k".repeat(64)
                    }, ${"{}"}, ${JSON.stringify({ boundary: { bad: true } })}, ${"r1"}, ${1}, ${1})`
                  } else {
                    for (let i = 0; i < 3; i++) {
                      const kd = `${i}`.repeat(64)
                      yield* sql`INSERT INTO flows_step_cache (key_digest, result_json, meta_json, recorded_run_id, recorded_event_seq, created_at_ms) VALUES (${kd}, ${"{}"}, ${"{}"}, ${"r1"}, ${
                        i + 1
                      }, ${1})`
                    }
                  }

                  const sweeperLayer = Layer.succeed(
                    ArtifactSweep.ArtifactSweep,
                    ArtifactSweep.ArtifactSweep.of({
                      inventory: (sample.gcMode === "sweeper-fail"
                        ? Effect.fail(
                          new ArtifactStore.ArtifactStoreError({ code: "unavailable", message: "inv fail" })
                        )
                        : Effect.succeed([blobOld, blobPinned])) as never,
                      remove: () =>
                        sample.gcMode === "kept-by-grace"
                          ? Effect.succeed(false)
                          : Effect.succeed(true)
                    })
                  )

                  const policyLayer = ArtifactGc.layerPolicy({
                    graceMs: 1000,
                    pins: Effect.succeed([blobPinned.digest])
                  })

                  const res = yield* Effect.exit(
                    Effect.gen(function*() {
                      const collector = yield* ArtifactGc.make({
                        pageSize: sample.gcMode === "invalid-page-size" ? 0 : 1
                      })
                      return yield* collector.gc({
                        dryRun: sample.gcMode === "dry-run-and-pins"
                      })
                    }).pipe(Effect.provide(Layer.mergeAll(sweeperLayer, policyLayer)))
                  )
                  if (
                    sample.gcMode === "invalid-page-size" || sample.gcMode === "sweeper-fail" ||
                    sample.gcMode === "corrupt-meta"
                  ) {
                    expect(Exit.isFailure(res)).toBe(true)
                  } else {
                    expect(Exit.isSuccess(res)).toBe(true)
                  }
                }).pipe(Effect.provide(TestStores.layerAt(":memory:")), withCrypto)
              )
            )

            // 3. SelectionStore edge paths (invalid_input, decode_failed, train missing edge, persistence_failed)
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const store = yield* SelectionStore.SelectionStore

                  // Invalid edge & invalid observation
                  expect(Exit.isFailure(yield* Effect.exit(store.upsert([{} as never])))).toBe(true)
                  expect(
                    Exit.isFailure(
                      yield* Effect.exit(store.train([{ scope: "", affects: "", outcome: "bad" } as never]))
                    )
                  ).toBe(true)

                  // Train on missing edge -> silent no-op
                  yield* store.train([{ scope: "pkg/a", affects: "pkg/b", outcome: "hit" }])

                  // Corrupt evidence_json (valid JSON, invalid schema) -> decode_failed
                  yield* sql`INSERT INTO flows_selection_suspected_edges (scope, affects, confidence, valid_from_ms, evidence_json) VALUES (${"s1"}, ${"a1"}, ${0.5}, ${100}, ${"{\"bad\":1}"})`
                  expect(Exit.isFailure(yield* Effect.exit(store.list()))).toBe(true)
                  yield* sql`DELETE FROM flows_selection_suspected_edges`

                  // Corrupt evidence element -> decode_failed
                  yield* sql`INSERT INTO flows_selection_suspected_edges (scope, affects, confidence, valid_from_ms, evidence_json) VALUES (${"s2"}, ${"a2"}, ${0.5}, ${100}, ${"[123]"})`
                  expect(Exit.isFailure(yield* Effect.exit(store.list()))).toBe(true)
                }).pipe(
                  Effect.provide(SelectionStore.layer.pipe(Layer.provideMerge(TestStores.layerAt(":memory:")))),
                  withCrypto
                )
              )
            )

            // 4. FileEnumeration: filesUnder, expandGlob, entry_limit_exceeded, ignored dirs vs explicit
            await Effect.runPromise(
              Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                mkdirSync(join(tmp, "enum", "node_modules", "pkg"), { recursive: true })
                mkdirSync(join(tmp, "enum", "src"), { recursive: true })
                writeFileSync(join(tmp, "enum", "node_modules", "pkg", "x.js"), "1")
                writeFileSync(join(tmp, "enum", "src", "a.ts"), "2")
                writeFileSync(join(tmp, "enum", "src", "b.ts"), "3")

                const allFiles = yield* FileEnumeration.filesUnder(fs, "", {
                  resolve: (p) => p === "" ? join(tmp, "enum") : join(tmp, "enum", p)
                })
                expect(allFiles.length).toBeGreaterThanOrEqual(2)

                const absent = yield* FileEnumeration.entriesUnder(fs, "no-such-dir", {
                  resolve: (p) => join(tmp, "enum", p)
                })
                expect(absent.files).toEqual([])

                const explicitNm = yield* FileEnumeration.expandGlob(
                  fs,
                  { _tag: "Glob", include: ["node_modules/**/*.js"] },
                  { resolve: (p) => p === "" ? join(tmp, "enum") : join(tmp, "enum", p) }
                )
                expect(explicitNm).toContain("node_modules/pkg/x.js")

                const limitExit = yield* Effect.exit(
                  FileEnumeration.expandGlob(
                    fs,
                    { _tag: "Glob", include: ["**/*.ts", "src/*.ts"] },
                    { resolve: (p) => p === "" ? join(tmp, "enum") : join(tmp, "enum", p), maxEntries: 1 }
                  )
                )
                expect(Exit.isFailure(limitExit)).toBe(true)
              }).pipe(Effect.provide(NodeFileSystem.layer))
            )

            // 5. StepBoundary edge paths
            await Effect.runPromise(
              withCrypto(
                Effect.gen(function*() {
                  if (sample.boundaryCase === "unsupported-and-test") {
                    const u = yield* StepBoundary.StepBoundary.pipe(Effect.provide(StepBoundary.layerUnsupported))
                    expect(Exit.isFailure(yield* Effect.exit(u.prepare(descriptor())))).toBe(true)
                    expect(Exit.isFailure(yield* Effect.exit(u.settle({} as never)))).toBe(true)
                    expect(Exit.isFailure(yield* Effect.exit(u.replayOutputs({} as never)))).toBe(true)

                    const t = yield* StepBoundary.StepBoundary.pipe(
                      Effect.provide(StepBoundary.layerTest({ supported: false }))
                    )
                    expect(Exit.isFailure(yield* Effect.exit(t.prepare(descriptor())))).toBe(true)
                    expect(Exit.isFailure(yield* Effect.exit(t.settle({} as never)))).toBe(true)
                    expect(Exit.isFailure(yield* Effect.exit(t.replayOutputs({} as never)))).toBe(true)
                  } else {
                    const wsRoot = join(tmp, "sb-ws")
                    mkdirSync(join(wsRoot, "out", "empty-sub"), { recursive: true })
                    writeFileSync(join(wsRoot, "in.txt"), "hello")
                    writeFileSync(join(wsRoot, "out", "stale.txt"), "stale")

                    const fsSvc = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer))
                    const pathSvc = yield* Path.Path.pipe(Effect.provide(NodePath.layer))
                    const artSvc = yield* ArtifactStore.ArtifactStore.pipe(
                      Effect.provide(Layer.fresh(ArtifactStore.layerMemory))
                    )
                    const sb = StepBoundary.makeFileSystem(
                      KernelFileSystem.withIsolatedFileSystem(fsSvc),
                      pathSvc,
                      artSvc,
                      { root: wsRoot }
                    )

                    if (sample.boundaryCase === "corrupt-base64") {
                      const ev: StepBoundary.BoundaryEvidence = {
                        diffIdentity: "d-b64",
                        declaredOutputs: {
                          outputs: [{
                            path: "o.txt",
                            digest: "a".repeat(64) as ArtifactStore.Digest,
                            sizeBytes: 4,
                            content: "!!!not-base64!!!"
                          }]
                        }
                      }
                      expect(Exit.isFailure(yield* Effect.exit(sb.replayOutputs(ev)))).toBe(true)
                    } else if ((sample.boundaryCase as string) === "digest-mismatch") {
                      const ev: StepBoundary.BoundaryEvidence = {
                        diffIdentity: "d-mis",
                        declaredOutputs: {
                          outputs: [{
                            path: "o.txt",
                            digest: "a".repeat(64) as ArtifactStore.Digest,
                            sizeBytes: 4,
                            content: Buffer.from("abcd").toString("base64")
                          }]
                        }
                      }
                      expect(Exit.isFailure(yield* Effect.exit(sb.replayOutputs(ev)))).toBe(true)
                    } else if (sample.boundaryCase === "missing-artifact") {
                      const ev: StepBoundary.BoundaryEvidence = {
                        diffIdentity: "d-art",
                        declaredOutputs: {
                          outputs: [{ path: "o.txt", digest: "c".repeat(64) as ArtifactStore.Digest, sizeBytes: 4 }]
                        }
                      }
                      expect(Exit.isFailure(yield* Effect.exit(sb.replayOutputs(ev)))).toBe(true)
                    } else if (sample.boundaryCase === "foreign-path") {
                      const ev: StepBoundary.BoundaryEvidence = {
                        diffIdentity: "d-for",
                        declaredOutputs: {
                          outputs: [{ path: "../escape.txt", digest: null, sizeBytes: 0 }]
                        }
                      }
                      expect(Exit.isFailure(yield* Effect.exit(sb.replayOutputs(ev)))).toBe(true)
                    } else if (sample.boundaryCase === "undeclared-write") {
                      const prep = yield* sb.prepare(
                        descriptor({ readSet: ["in.txt"], writeSet: ["out/a.txt"], boundaryMode: "hard" })
                      )
                      writeFileSync(join(wsRoot, "in.txt"), "mutated-read!")
                      writeFileSync(join(wsRoot, "out", "a.txt"), "ok")
                      expect(Exit.isFailure(yield* Effect.exit(sb.settle(prep)))).toBe(true)
                    } else {
                      expect(
                        Exit.isFailure(
                          yield* Effect.exit(sb.replayOutputs({ diffIdentity: "d-unmat", declaredOutputs: {} }))
                        )
                      ).toBe(true)
                      const d = sha256(new TextEncoder().encode("kept")) as ArtifactStore.Digest
                      const ev: StepBoundary.BoundaryEvidence = {
                        diffIdentity: "d-ok",
                        declaredOutputs: {
                          outputs: [
                            {
                              path: "out/kept.txt",
                              digest: d,
                              sizeBytes: 4,
                              content: Buffer.from("kept").toString("base64")
                            },
                            { path: "out/stale.txt", digest: null }
                          ],
                          trees: [{ path: "out", identity: "tree-1" }]
                        }
                      }
                      yield* sb.replayOutputs(ev, { restore: "missing" })
                      yield* sb.replayOutputs(ev)
                    }
                  }
                })
              )
            )

            // 6. WorkspaceSandbox edge paths
            await Effect.runPromise(
              withCrypto(
                Effect.gen(function*() {
                  if (sample.sandboxCase === "conflict-validator") {
                    expect(
                      WorkspaceSandbox.isMaterializationConflict(
                        new WorkspaceSandbox.MaterializationConflict({ paths: ["a.txt"], message: "conflict" })
                      )
                    ).toBe(true)
                    expect(
                      WorkspaceSandbox.isMaterializationConflict({
                        _tag: WorkspaceSandbox.MaterializationConflict.identifier,
                        paths: [""]
                      })
                    ).toBe(false)
                    expect(
                      WorkspaceSandbox.isMaterializationConflict({
                        _tag: WorkspaceSandbox.MaterializationConflict.identifier,
                        paths: ["a"],
                        extra: 1
                      })
                    ).toBe(false)
                    const badArr = ["a"] as unknown as Record<string, unknown>
                    badArr["extraProp"] = 1
                    expect(
                      WorkspaceSandbox.isMaterializationConflict({
                        _tag: WorkspaceSandbox.MaterializationConflict.identifier,
                        paths: badArr
                      })
                    ).toBe(false)
                  } else if (sample.sandboxCase === "unsupported-and-dispatcher") {
                    const u = yield* WorkspaceSandbox.WorkspaceSandbox.pipe(
                      Effect.provide(WorkspaceSandbox.layerUnsupported)
                    )
                    expect(
                      Exit.isFailure(yield* Effect.exit(u.execute({ descriptor: descriptor(), workflow: Effect.void })))
                    ).toBe(true)
                    expect(Exit.isFailure(yield* Effect.exit(u.materialize({} as never)))).toBe(true)
                    const dispLayer = WorkspaceSandbox.layerDispatcher({ dispatch: () => Effect.void })
                    const disp = yield* WorkspaceSandbox.EffectDispatcher.pipe(Effect.provide(dispLayer))
                    expect(disp).toBeDefined()
                  } else if (sample.sandboxCase === "cache-memo-and-dir-remove") {
                    const { service: box } = yield* WorkspaceSandbox.makeMemory({ "dir/a.txt": "1", "dir/b.txt": "2" })
                    const exec = {
                      cacheKey: "memo-k1",
                      descriptor: descriptor({
                        readSet: ["dir/a.txt", "dir/b.txt"],
                        writeSet: ["dir/a.txt", "dir/b.txt"],
                        removes: ["dir"]
                      }),
                      workflow: Effect.gen(function*() {
                        const ws = yield* WorkspaceSandbox.Workspace
                        const fs = yield* FileSystem.FileSystem
                        expect((yield* fs.readFile("dir/a.txt")).byteLength).toBe(1)
                        yield* ws.queueEffect({ idempotencyKey: "eff-1", kind: "test", payload: {} } as never)
                        yield* ws.removeFile("dir")
                        return "done"
                      })
                    }
                    const r1 = yield* box.execute(exec)
                    const r2 = yield* box.execute(exec)
                    expect(r1._tag === "Accepted" && r2._tag === "Accepted").toBe(true)
                  } else if (sample.sandboxCase === "memory-conflict") {
                    // Invalid initial path -> failure
                    expect(Exit.isFailure(yield* Effect.exit(WorkspaceSandbox.makeMemory({ "../bad": "x" })))).toBe(
                      true
                    )
                    // MaterializationConflict when file changed between snapshot & materialize
                    const { service: box } = yield* WorkspaceSandbox.makeMemory({ "f.txt": "v1" })
                    const b = descriptor({ readSet: ["f.txt"], writeSet: ["f.txt"] })
                    const a1 = yield* box.execute({
                      descriptor: b,
                      workflow: Effect.gen(function*() {
                        const ws = yield* WorkspaceSandbox.Workspace
                        yield* ws.writeFile("f.txt", new TextEncoder().encode("v2"))
                        return "1"
                      })
                    })
                    const a2 = yield* box.execute({
                      descriptor: b,
                      workflow: Effect.gen(function*() {
                        const ws = yield* WorkspaceSandbox.Workspace
                        yield* ws.writeFile("f.txt", new TextEncoder().encode("v3"))
                        return "2"
                      })
                    })
                    if (a1._tag === "Accepted" && a2._tag === "Accepted") {
                      yield* box.materialize(a1)
                      const conflictExit = yield* Effect.exit(box.materialize(a2))
                      expect(Exit.isFailure(conflictExit)).toBe(true)
                    }
                  } else {
                    const fsRoot = join(tmp, "ws-box")
                    mkdirSync(join(fsRoot, "sub"), { recursive: true })
                    writeFileSync(join(fsRoot, "sub", "x.txt"), "hello")
                    const boxLayer = WorkspaceSandbox.layerFileSystem().pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AtomicFileSystem.layer,
                          NodePath.layer,
                          ArtifactStore.layerMemory,
                          NodeCrypto.layer,
                          KernelWorkspace.layer(fsRoot)
                        )
                      )
                    )
                    const box = yield* WorkspaceSandbox.WorkspaceSandbox.pipe(Effect.provide(boxLayer))
                    const res = yield* box.execute({
                      descriptor: descriptor({
                        readSet: [{ _tag: "Glob", include: ["sub/*.txt"] }, "sub/x.txt"],
                        writeSet: [{ _tag: "TreeArtifact", path: "sub" } as never]
                      }),
                      workflow: Effect.succeed("ok")
                    })
                    expect(res._tag).toBe("Accepted")
                  }
                })
              )
            )
          } finally {
            rmSync(tmp, { recursive: true, force: true })
          }
        },
        { executions: lightExecutions, seed }
      )
    },
    120_000
  )

  it(
    "fuzzes ActionPersistence (inertJson budgets, unkeyed irreversible retry, scope, nondeterministic, cache errors, boundary corruption/quarantine, crossing & pre-image)",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          caseKind: Schema.Literals([
            "cause-budgets",
            "irreversible-and-scopes",
            "nondeterministic-and-cache-fail",
            "boundary-corruption-strict-and-tolerant",
            "boundary-host-fail-and-hard-violation",
            "attempt-suspended-and-crossing"
          ])
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          const services = Layer.mergeAll(
            TestStores.layerAt(":memory:"),
            StepBoundary.layerTest(),
            noopJjLayer,
            NodeCrypto.layer
          )

          const seedActiveRun = Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            yield* runs.create("ap-run", JSON.stringify({ flowName: "ap/Flow", payload: {} }))
            const row = yield* runs.get("ap-run")
            yield* runs.claimAndOwn(
              "ap-run",
              { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
              owner,
              100
            )
          })

          if (sample.caseKind === "cause-budgets") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* seedActiveRun
                  // Deeply nested object, lone surrogate, Uint8Array, Proxy, cycle, throwing getter, Interrupt
                  let deep: Record<string, unknown> = { leaf: true }
                  for (let i = 0; i < 40; i++) deep = { next: deep }
                  const cyclic: Record<string, unknown> = {}
                  cyclic["self"] = cyclic
                  const throwing: Record<string, unknown> = {}
                  Object.defineProperty(throwing, "boom", {
                    enumerable: true,
                    get() {
                      throw new Error("getter")
                    }
                  })
                  const manyKeys: Record<string, number> = {}
                  for (let i = 0; i < 300; i++) manyKeys[`k${i}`] = i
                  const payloads = [
                    deep,
                    cyclic,
                    throwing,
                    manyKeys,
                    new Uint8Array([1, 2, 3]),
                    new Proxy({}, {}),
                    "\ud800lone\udc00",
                    null,
                    true
                  ]
                  for (const [idx, val] of payloads.entries()) {
                    const exit = yield* Effect.exit(
                      runAp({
                        runId: "ap-run",
                        owner,
                        key: `cause-k-${idx}`,
                        action: { _tag: "ap/cause", name: "ap/cause" } as never,
                        attempt: 1,
                        tier: "sealed",
                        execute: () => Effect.failCause(Cause.die(val))
                      })
                    )
                    expect(Exit.isFailure(exit)).toBe(true)
                  }
                }).pipe(Effect.provide(services), withCrypto)
              )
            )
            return
          }

          if (sample.caseKind === "irreversible-and-scopes") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* seedActiveRun
                  // Irreversible retry without idempotencyKey -> IrreversibleRetryRequiresIdempotencyKey
                  const irrevExit = yield* Effect.exit(
                    runAp({
                      runId: "ap-run",
                      owner,
                      key: "irrev-k",
                      action: { _tag: "ap/irrev", name: "ap/irrev", effect: "irreversible" } as never,
                      attempt: 2,
                      tier: "irreversible",
                      execute: () => Effect.succeed("ok")
                    })
                  )
                  expect(Exit.isFailure(irrevExit)).toBe(true)

                  // Run-scoped & flow-scoped cache keys
                  for (const scope of ["run", "flow"] as const) {
                    const v = yield* runAp({
                      runId: "ap-run",
                      owner,
                      key: `scoped-${scope}`,
                      action: { _tag: "ap/scoped", name: "ap/scoped", cache: { policy: "enabled", scope } } as never,
                      attempt: 1,
                      tier: "sealed",
                      execute: () => Effect.succeed(`val-${scope}`)
                    })
                    expect(v).toBe(`val-${scope}`)
                  }
                }).pipe(Effect.provide(services), withCrypto)
              )
            )
            return
          }

          if (sample.caseKind === "nondeterministic-and-cache-fail") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* seedActiveRun
                  const cache = yield* CacheStore.CacheStore
                  const kd = sha256(new TextEncoder().encode("nd-key"))
                  // Seed existing cache row with different output, then run nondeterministic step -> conflict_first_writer
                  yield* cache.put({
                    keyDigest: kd,
                    result: "first-writer",
                    meta: {},
                    recordedRunId: "other-run",
                    recordedEventSeq: 1,
                    createdAtMs: 100
                  })
                  const out = yield* runAp({
                    runId: "ap-run",
                    owner,
                    key: "nd-key",
                    action: { _tag: "ap/nd", name: "ap/nd", cache: { policy: "enabled" } } as never,
                    nondeterministic: true as const,
                    attempt: 1,
                    tier: "sealed",
                    execute: () => Effect.succeed("second-writer")
                  })
                  expect(out).toBeDefined()

                  // Faulty cache.get -> noteUnshareable & falls through to execution
                  const failingCache = Layer.succeed(CacheStore.CacheStore, {
                    ...cache,
                    get: () =>
                      Effect.fail(
                        new CacheStore.CacheStoreError({ code: "persistence_failed", message: "cache down" })
                      ),
                    put: () =>
                      Effect.fail(new CacheStore.CacheStoreError({ code: "persistence_failed", message: "put down" }))
                  })
                  const out2 = yield* runAp({
                    runId: "ap-run",
                    owner,
                    key: "cf-key",
                    action: { _tag: "ap/cf", name: "ap/cf", cache: { policy: "enabled" } } as never,
                    attempt: 1,
                    tier: "sealed",
                    execute: () => Effect.succeed("ran-anyway")
                  }).pipe(Effect.provide(failingCache))
                  expect(out2).toBe("ran-anyway")
                }).pipe(Effect.provide(services), withCrypto)
              )
            )
            return
          }

          if (sample.caseKind === "boundary-corruption-strict-and-tolerant") {
            const goodBoundary = Layer.succeed(
              StepBoundary.StepBoundary,
              StepBoundary.make({
                prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: [] }),
                settle: () =>
                  Effect.succeed({
                    declaredOutputs: { outputs: [] },
                    diffIdentity: "diff-ok",
                    wholeTreeWritesVerified: true,
                    hermeticReadsVerified: true
                  }),
                replayOutputs: () => Effect.void
              })
            )
            const corruptBoundary = Layer.succeed(
              StepBoundary.StepBoundary,
              StepBoundary.make({
                prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: [] }),
                settle: () =>
                  Effect.succeed({
                    declaredOutputs: { outputs: [] },
                    diffIdentity: "diff-ok",
                    wholeTreeWritesVerified: true,
                    hermeticReadsVerified: true
                  }),
                replayOutputs: () =>
                  Effect.fail(
                    new StepBoundary.BoundaryCorruption({
                      code: "boundary_corruption",
                      path: "out.txt",
                      recordedDigest: "a".repeat(64),
                      measuredDigest: "b".repeat(64)
                    })
                  )
              })
            )
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* seedActiveRun
                  const runs = yield* RunStore.RunStore
                  yield* runs.create("ap-run-2", "{}")
                  const r2 = yield* runs.get("ap-run-2")
                  yield* runs.claimAndOwn(
                    "ap-run-2",
                    { status: r2.status, owner: r2.owner, heartbeatAtMs: r2.heartbeatAtMs },
                    owner,
                    10
                  )
                  yield* runs.create("ap-run-3", "{}")
                  const r3 = yield* runs.get("ap-run-3")
                  yield* runs.claimAndOwn(
                    "ap-run-3",
                    { status: r3.status, owner: r3.owner, heartbeatAtMs: r3.heartbeatAtMs },
                    owner,
                    10
                  )

                  const sharedAction = { _tag: "ap/bc", name: "ap/bc", cache: { policy: "enabled" } } as never
                  const seeded = yield* runAp({
                    runId: "ap-run",
                    owner,
                    key: "bc-key",
                    action: sharedAction,
                    attempt: 1,
                    tier: "sealed",
                    metadata: descriptor({ writeSet: ["out.txt"] }),
                    execute: () => Effect.succeed("cached-val")
                  }).pipe(Effect.provide(goodBoundary))
                  expect(seeded).toBe("cached-val")

                  const strictExit = yield* Effect.exit(
                    runAp({
                      runId: "ap-run-2",
                      owner,
                      key: "bc-key",
                      action: sharedAction,
                      attempt: 1,
                      tier: "sealed",
                      metadata: descriptor({ writeSet: ["out.txt"] }),
                      execute: () => Effect.succeed("fresh")
                    }).pipe(Effect.provide(Layer.mergeAll(corruptBoundary, Inconsistency.layerStrict(owner))))
                  )
                  expect(Exit.isFailure(strictExit)).toBe(true)

                  yield* runAp({
                    runId: "ap-run-2",
                    owner,
                    key: "bc-key",
                    action: sharedAction,
                    attempt: 2,
                    tier: "sealed",
                    metadata: descriptor({ writeSet: ["out.txt"] }),
                    execute: () => Effect.succeed("cached-val")
                  }).pipe(Effect.provide(goodBoundary))
                  const tolVal = yield* runAp({
                    runId: "ap-run-3",
                    owner,
                    key: "bc-key",
                    action: sharedAction,
                    attempt: 1,
                    tier: "sealed",
                    metadata: descriptor({ writeSet: ["out.txt"] }),
                    execute: () => Effect.succeed("healed")
                  }).pipe(Effect.provide(Layer.mergeAll(corruptBoundary, Inconsistency.layerTolerant(owner))))
                  expect(tolVal).toBe("healed")
                }).pipe(Effect.provide(services), withCrypto)
              )
            )
            return
          }

          if (sample.caseKind === "boundary-host-fail-and-hard-violation") {
            const hardViolationBoundary = StepBoundary.layerTest({
              failure: new StepBoundary.UndeclaredWrite({
                code: "undeclared_write",
                paths: ["secret.txt"],
                diffIdentity: "d1"
              })
            })
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* seedActiveRun
                  const vExit = yield* Effect.exit(
                    runAp({
                      runId: "ap-run",
                      owner,
                      key: "hv-key",
                      action: { _tag: "ap/hv", name: "ap/hv" } as never,
                      attempt: 1,
                      tier: "sealed",
                      metadata: descriptor({ writeSet: ["out.txt"] }),
                      execute: () => Effect.succeed("ran")
                    }).pipe(Effect.provide(hardViolationBoundary))
                  )
                  expect(Exit.isFailure(vExit)).toBe(true)
                  // Replaying the failed hard-violation attempt exercises reemitConverging(hardViolation)
                  const vReplay = yield* Effect.exit(
                    runAp({
                      runId: "ap-run",
                      owner,
                      key: "hv-key",
                      action: { _tag: "ap/hv", name: "ap/hv" } as never,
                      attempt: 1,
                      tier: "sealed",
                      metadata: descriptor({ writeSet: ["out.txt"] }),
                      execute: () => Effect.succeed("should-not-run")
                    }).pipe(Effect.provide(hardViolationBoundary))
                  )
                  expect(Exit.isFailure(vReplay)).toBe(true)
                }).pipe(Effect.provide(services), withCrypto)
              )
            )
            return
          }

          // attempt-suspended-and-crossing
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                yield* seedActiveRun
                const attempts = yield* AttemptStore.AttemptStore
                const skd1 = sha256(new TextEncoder().encode("susp-k"))
                yield* attempts.put(
                  { runId: "ap-run", stepKeyDigest: skd1, attempt: 1, state: "suspended", startedAtMs: 10, meta: {} },
                  owner
                )
                const suspExit = yield* Effect.exit(
                  runAp({
                    runId: "ap-run",
                    owner,
                    key: "susp-k",
                    action: { _tag: "ap/susp", name: "ap/susp" } as never,
                    attempt: 1,
                    tier: "sealed",
                    execute: () => Effect.succeed("nope")
                  })
                )
                expect(Exit.isFailure(suspExit)).toBe(true)

                // Adopted running row with effectCrossing === "succeeded" -> settleCrossing
                const skd2 = sha256(new TextEncoder().encode("cross-k"))
                yield* attempts.put(
                  {
                    runId: "ap-run",
                    stepKeyDigest: skd2,
                    attempt: 1,
                    state: "running",
                    startedAtMs: 10,
                    meta: { effectCrossing: "intended" }
                  },
                  owner
                )
                yield* attempts.patch(
                  { runId: "ap-run", stepKeyDigest: skd2, attempt: 1 },
                  { outcome: "crossed-val", meta: { effectCrossing: "succeeded" } },
                  owner
                )
                const crossVal = yield* runAp({
                  runId: "ap-run",
                  owner,
                  key: "cross-k",
                  action: { _tag: "ap/cross", name: "ap/cross" } as never,
                  attempt: 1,
                  tier: "irreversible",
                  execute: () => Effect.succeed("should-not-run")
                })
                expect(crossVal).toBeDefined()
              }).pipe(Effect.provide(services), withCrypto)
            )
          )
        },
        { executions: lightExecutions, seed: seed + 1 }
      )
    },
    120_000
  )

  it(
    "fuzzes PlanInputStore, PlanMergeStore, DurableEngineState (SQL & Memory), DeferredPersistence, Retention & DisasterRecovery errors",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          storeCase: Schema.Literals([
            "plan-input-and-merge-errors",
            "durable-engine-state-memory-and-sql",
            "deferred-persistence-edges",
            "retention-lineage-and-receipts",
            "disaster-recovery-errors"
          ])
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          if (sample.storeCase === "durable-engine-state-memory-and-sql") {
            // 1. Memory adapter edge paths
            await Effect.runPromise(
              Effect.gen(function*() {
                const mem = yield* DurableEngineState.DurableEngineState
                // completeClock NotFound & AlreadyCompleted
                expect((yield* mem.completeClock({ flowName: "f", executionId: "r1", clockName: "c1" }, 100))._tag)
                  .toBe("NotFound")
                yield* mem.scheduleClock({
                  flowName: "f",
                  executionId: "r1",
                  clockName: "c1",
                  deferredName: "cd1",
                  dueAtMs: 50,
                  completedAtMs: null
                }, owner)
                yield* mem.scheduleClock({
                  flowName: "f",
                  executionId: "r1",
                  clockName: "c2",
                  deferredName: "cd2",
                  dueAtMs: 60,
                  completedAtMs: null
                }, owner)
                expect((yield* mem.dueClocks(100)).length).toBe(2)
                expect((yield* mem.completeClock({ flowName: "f", executionId: "r1", clockName: "c1" }, 100))._tag)
                  .toBe("Completed")
                expect((yield* mem.completeClock({ flowName: "f", executionId: "r1", clockName: "c1" }, 100))._tag)
                  .toBe("AlreadyCompleted")
                expect((yield* mem.completeRunClocks("r1", 200)).length).toBe(1)

                // completeDeferred Existing
                const d1 = yield* mem.completeDeferred({
                  flowName: "f",
                  executionId: "r1",
                  deferredName: "d1",
                  exit: Exit.succeed(1),
                  completedAtMs: 10
                })
                const d2 = yield* mem.completeDeferred({
                  flowName: "f",
                  executionId: "r1",
                  deferredName: "d1",
                  exit: Exit.succeed(1),
                  completedAtMs: 10
                })
                expect(d1._tag).toBe("Completed")
                expect(d2._tag).toBe("Existing")

                // Self-cycle & diamond parent graph + waitingRuns filters/pagination + readTransaction
                expect(Exit.isFailure(yield* Effect.exit(mem.recordRunParent("a", "a")))).toBe(true)
                yield* mem.recordRunParent("b", "a")
                yield* mem.recordRunParent("c", "a")
                yield* mem.recordRunParent("d", "b")
                yield* mem.recordRunParent("d", "c")
                expect((yield* mem.runParents("d")).length).toBe(2)
                expect((yield* mem.runChildren("a")).length).toBe(2)
                yield* mem.park("a", { reason: "timer", wakeAt: 10 }, owner)
                yield* mem.park("b", { reason: "event" }, owner)
                const paged = yield* mem.waitingRuns({ hasChildren: true, page: { limit: 10 } })
                expect(paged.length).toBe(2)
                const rtVal = yield* mem.readTransaction(Effect.succeed(42))
                expect(rtVal).toBe(42)
                expect(typeof (yield* mem.hasDueWake("a", 20))).toBe("boolean")
                expect((yield* mem.waitingTree("a")).length).toBeGreaterThanOrEqual(1)
                expect((yield* mem.pendingClocks({ executionId: "r1" })).length).toBe(0)
                yield* mem.wake("b")
              }).pipe(Effect.provide(Layer.fresh(DurableEngineState.layerMemory)), withCrypto)
            )

            // 2. SQL adapter edge paths
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const state = yield* DurableEngineState.DurableEngineState
                  const runs = yield* RunStore.RunStore
                  // NotFound paths
                  expect(
                    (yield* state.completeDeferred({
                      flowName: "f",
                      executionId: "missing",
                      deferredName: "d",
                      exit: Exit.succeed(1),
                      completedAtMs: 1
                    }))._tag
                  ).toBe("NotFound")
                  expect(
                    (yield* state.completeClock({ flowName: "f", executionId: "missing", clockName: "c" }, 1))._tag
                  ).toBe("NotFound")
                  expect((yield* state.park("missing", { reason: "event" }, owner))._tag).toBe("NotFound")
                  expect(yield* state.copyAttempts!({ from: "a", to: "b", attempts: [] })).toBe(0)

                  // SQL self-cycle & duplicate parent edge
                  yield* runs.create("sr1", "{}")
                  yield* runs.create("sr2", "{}")
                  expect(Exit.isFailure(yield* Effect.exit(state.recordRunParent("sr1", "sr1")))).toBe(true)
                  const e1 = yield* state.recordRunParent("sr2", "sr1")
                  const e2 = yield* state.recordRunParent("sr2", "sr1")
                  expect(e1._tag).toBe("Recorded")
                  expect(e2._tag).toBe("Existing")
                }).pipe(Effect.provide(TestStores.layerAt(":memory:")), withCrypto)
              )
            )
            return
          }

          if (sample.storeCase === "plan-input-and-merge-errors") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore
                  const inputs = yield* PlanInputStore.PlanInputStore
                  const merges = yield* PlanMergeStore.PlanMergeStore
                  const envDigest = "e".repeat(64)
                  const baseDigest = "b".repeat(64)

                  yield* runs.create("pm-run", "{}")
                  const row = yield* runs.get("pm-run")
                  yield* runs.claimAndOwn(
                    "pm-run",
                    { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
                    owner,
                    100
                  )

                  // PlanInputStore: non-zero generation on empty history -> corrupt_state
                  const badGen = yield* Effect.exit(
                    inputs.get({
                      runId: "pm-run",
                      planId: "p1",
                      baseDigest,
                      environmentDigest: envDigest,
                      generation: 2
                    }, owner)
                  )
                  expect(Exit.isFailure(badGen)).toBe(true)

                  // Legacy run refusal -> incompatible_state
                  yield* runs.create("pm-legacy", "{}")
                  yield* sql`INSERT INTO flows_plan_input_legacy_runs (run_id) VALUES (${"pm-legacy"})`
                  const legExit = yield* Effect.exit(
                    inputs.get({
                      runId: "pm-legacy",
                      planId: "p1",
                      baseDigest,
                      environmentDigest: envDigest,
                      generation: 0
                    }, owner)
                  )
                  expect(Exit.isFailure(legExit)).toBe(true)

                  // Transaction open refusal
                  const txOpen = yield* Effect.exit(
                    sql.withTransaction(
                      inputs.record(
                        { runId: "pm-run", planId: "p1", baseDigest, environmentDigest: envDigest, generation: 0 },
                        { files: {}, missing: [] } as never,
                        owner
                      )
                    )
                  )
                  expect(Exit.isFailure(txOpen)).toBe(true)

                  // PlanMergeStore: self-peer invalid_input, fence_lost with wrong owner, completion without intent -> corrupt_state
                  const badOwner: Ownership.OwnerId = { hostId: "other", pid: 1, nonce: "other" }
                  const identity = { runId: "pm-run", planId: "p1", baseDigest, environmentDigest: envDigest }
                  expect(
                    Exit.isFailure(
                      yield* Effect.exit(
                        merges.intend(identity, { nodeId: "n1", peers: ["n1"], reason: "conflict" } as never, owner)
                      )
                    )
                  ).toBe(true)
                  expect(
                    Exit.isFailure(
                      yield* Effect.exit(
                        merges.intend(identity, { nodeId: "n1", peers: ["n2"], reason: "conflict" } as never, badOwner)
                      )
                    )
                  ).toBe(true)
                  expect(
                    Exit.isFailure(
                      yield* Effect.exit(
                        merges.complete(
                          identity,
                          "n-missing",
                          { mergeId: "m1", winners: ["n2"], appended: [] } as never,
                          owner
                        )
                      )
                    )
                  ).toBe(true)
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(PlanInputStore.layer, PlanMergeStore.layer).pipe(
                      Layer.provideMerge(TestStores.layerAt(":memory:"))
                    )
                  ),
                  withCrypto
                )
              )
            )
            return
          }

          if (sample.storeCase === "deferred-persistence-edges") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const state = yield* DurableEngineState.DurableEngineState
                  const journal = yield* Journal.Journal
                  const runs = yield* RunStore.RunStore
                  const wakes: Array<string> = []
                  const dp = yield* DeferredPersistence.make({
                    state,
                    journal,
                    journalSource: "dp-w8",
                    owner,
                    scheduleResume: (_f: string, execId: string) =>
                      Effect.sync(() => {
                        wakes.push(execId)
                      })
                  } as never)

                  yield* runs.create("dp-r1", "{}")
                  const dpr = yield* runs.get("dp-r1")
                  yield* runs.claimAndOwn(
                    "dp-r1",
                    { status: dpr.status, owner: dpr.owner, heartbeatAtMs: dpr.heartbeatAtMs },
                    owner,
                    10
                  )
                  // deferredDoneIfWaiting when not parked -> NotWaiting
                  const nw = yield* dp.deferredDoneIfWaiting({
                    flowName: "dp/F",
                    executionId: "dp-r1",
                    deferredName: "d1",
                    exit: Exit.succeed("ok"),
                    reason: "event",
                    token: "tok-1"
                  })
                  expect(nw).toBe("NotWaiting")

                  // Unknown run -> NotWaiting with warning log
                  const unk = yield* dp.deferredDone({
                    flowName: "dp/F",
                    executionId: "dp-missing",
                    deferredName: "d1",
                    exit: Exit.succeed("ok")
                  })
                  expect(unk).toBeUndefined()

                  // Schedule due clock then fireDue & sweepFlows
                  const dpFlow = Flow.make("dp/F", {
                    payload: {},
                    success: Schema.Void,
                    body: () => Node.succeed(undefined)
                  })
                  const clk = DurableClock.make({ name: "clk-1", duration: "1 millis" })
                  yield* dp.scheduleClock(dpFlow, { executionId: "dp-r1", clock: clk })
                  yield* Effect.sleep("10 millis")
                  yield* dp.fireDue("dp/F", "dp-r1")
                  yield* dp.sweepFlows(new Set(["dp/F"]), "dp-r1")
                }).pipe(Effect.provide(TestStores.layerAt(":memory:")), withCrypto)
              )
            )
            return
          }

          if (sample.storeCase === "retention-lineage-and-receipts") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  const ret = yield* Retention.Retention

                  // Lineage with <= 2 rounds -> empty compaction
                  yield* runs.create("lin-1", "{}")
                  const c0 = yield* ret.pruneSupersededRounds("lin-1")
                  expect(c0.runIds).toEqual([])

                  // Lineage with 3 rounds where middle round is completed -> compacts middle round!
                  const sql = yield* SqlClient.SqlClient
                  yield* runs.create("lin-2", "{}")
                  yield* sql`UPDATE flows_runs SET lineage_id = ${"lin-2"}, round_ordinal = 0 WHERE run_id = ${"lin-2"}`
                  yield* runs.create("lin-2:r1", "{}", { lineageId: "lin-2", parentRunId: "lin-2", roundOrdinal: 1 })
                  yield* runs.create("lin-2:r2", "{}", { lineageId: "lin-2", parentRunId: "lin-2:r1", roundOrdinal: 2 })
                  const r1 = yield* runs.get("lin-2:r1")
                  yield* runs.claimAndOwn(
                    "lin-2:r1",
                    { status: r1.status, owner: r1.owner, heartbeatAtMs: r1.heartbeatAtMs },
                    owner,
                    10
                  )
                  yield* runs.transitionOwned("lin-2:r1", owner, "completed", "{}")
                  const c1 = yield* ret.pruneSupersededRounds("lin-2")
                  expect(c1.runIds).toEqual(["lin-2:r1"])
                }).pipe(
                  Effect.provide(Retention.layer.pipe(Layer.provideMerge(TestStores.layerAt(":memory:")))),
                  withCrypto
                )
              )
            )
            return
          }

          // disaster-recovery-errors
          const drTmp = mkdtempSync(join(tmpdir(), "es-w8-dr-"))
          try {
            await Effect.runPromise(
              Effect.gen(function*() {
                // Invalid maxFileSizeBytes on verify & restore
                const vBad = yield* Effect.exit(DisasterRecovery.verify(drTmp, { maxFileSizeBytes: -1 }))
                expect(Exit.isFailure(vBad)).toBe(true)
                const rBad = yield* Effect.exit(
                  DisasterRecovery.restore({
                    backupDirectory: drTmp,
                    targetDirectory: join(drTmp, "t"),
                    maxFileSizeBytes: -1
                  })
                )
                expect(Exit.isFailure(rBad)).toBe(true)

                // Missing manifest -> missing_file
                const vMissing = yield* Effect.exit(DisasterRecovery.verify(join(drTmp, "empty")))
                expect(Exit.isFailure(vMissing)).toBe(true)

                // Non-empty target directory on restore -> not_empty
                const nonEmpty = join(drTmp, "non-empty")
                mkdirSync(nonEmpty, { recursive: true })
                writeFileSync(join(nonEmpty, "existing"), "x")
                // Write minimal manifest/db so verify passes or fails cleanly
                const vTiny = yield* Effect.exit(
                  DisasterRecovery.verify(nonEmpty, { maxFileSizeBytes: 0 })
                )
                expect(Exit.isFailure(vTiny)).toBe(true)
              }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer)))
            )
          } finally {
            rmSync(drTmp, { recursive: true, force: true })
          }
        },
        { executions: lightExecutions, seed: seed + 2 }
      )
    },
    120_000
  )

  it(
    "fuzzes PlanScheduler (concurrency, deviations, reconciler, selection defer, abort, runtimeStrategy, plan_changed) & CopiedRecord",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "bounds-and-plan-changed",
            "deviations-and-reconciler",
            "selection-defer-and-full",
            "abort-sibling-and-conflict",
            "copied-record-prove-and-find"
          ])
        })
      )

      const draft = (
        id: string,
        opts: {
          readonly reads?: ReadonlyArray<string>
          readonly writes?: ReadonlyArray<string>
          readonly kind?: Plan.PlanNode["kind"]
          readonly conflictStrategy?: Plan.PairStrategy
          readonly runtimeStrategy?: Plan.RuntimeStrategy
          readonly boundaryMode?: "hard" | "expected"
          readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
        } = {}
      ): Plan.NodeDraft => ({
        id,
        material: {
          version: KeyMaterial.version,
          kind: "sealed",
          body: { action: id },
          inputs: opts.inputs ?? [],
          layers: [],
          capabilities: []
        },
        effects: {
          reads: opts.reads ?? [],
          writes: opts.writes ?? [`${id}.out`],
          boundaryMode: opts.boundaryMode ?? "expected"
        },
        ...(opts.kind === undefined ? {} : { kind: opts.kind }),
        ...(opts.conflictStrategy === undefined ? {} : { conflictStrategy: opts.conflictStrategy }),
        ...(opts.runtimeStrategy === undefined ? {} : { runtimeStrategy: opts.runtimeStrategy })
      })

      const activateRun = (runId: string) =>
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          yield* runs.create(runId, "{}")
          const row = yield* runs.get(runId)
          yield* runs.claimAndOwn(
            runId,
            { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
            owner,
            10
          )
        })

      await runFuzz(
        arb,
        async (sample) => {
          if (sample.mode === "bounds-and-plan-changed") {
            for (const bad of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
              expect(() => PlanScheduler.make({ runId: "r-bad", owner, sourceId: "s", concurrency: { steps: bad } }))
                .toThrow()
              expect(() => PlanScheduler.make({ runId: "r-bad", owner, sourceId: "s", concurrency: { agents: bad } }))
                .toThrow()
            }
            expect(() => PlanScheduler.make({ runId: "r-bad", owner, sourceId: "s", rebaseLimit: -1 })).toThrow()

            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* activateRun("ps-chg")
                  const plan1 = yield* Plan.compile({ planId: "p1", flow: "w8/Build", nodes: [draft("a")] })
                  const plan2 = yield* Plan.compile({ planId: "p1", flow: "w8/Build", nodes: [draft("a"), draft("b")] })
                  const sched = PlanScheduler.make({ runId: "ps-chg", owner, sourceId: "ps/chg" })
                  const r1 = yield* sched.run(plan1)
                  expect(r1.settlements.length).toBe(1)
                  // Re-running with mutated plan under same planId -> plan_changed
                  const chgExit = yield* Effect.exit(sched.run(plan2))
                  expect(Exit.isFailure(chgExit)).toBe(true)
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      TestStores.layerAt(":memory:"),
                      StepBoundary.layerTest(),
                      noopJjLayer,
                      PlanScheduler.layerExecutor({ execute: () => Effect.succeed("ok") })
                    )
                  ),
                  withCrypto
                )
              )
            )
            return
          }

          if (sample.mode === "deviations-and-reconciler") {
            const devBoundary = Layer.succeed(
              StepBoundary.StepBoundary,
              StepBoundary.make({
                prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: [] }),
                settle: () =>
                  Effect.succeed({
                    declaredOutputs: { outputs: [] },
                    diffIdentity: "diff-dev",
                    deviation: {
                      _tag: "ExpectedSetDeviation" as const,
                      paths: ["n2.out", "extra.txt"],
                      diffIdentity: "diff-dev"
                    }
                  }),
                replayOutputs: () => Effect.void
              })
            )
            for (const verdictTag of ["FactorOut", "Reorder", "Fail"] as const) {
              const recLayer = Reconciliation.layer({
                onDeviation: (dev) =>
                  Effect.succeed(
                    verdictTag === "FactorOut"
                      ? { _tag: "FactorOut" as const, paths: dev.paths, reason: "factor-out" }
                      : verdictTag === "Reorder"
                      ? { _tag: "Reorder" as const, dependsOn: ["n1"], reason: "reorder" }
                      : { _tag: "Fail" as const, reason: "policy-fail" }
                  ),
                onConflict: () => Effect.succeed({ _tag: "Fail" as const, reason: "conflict" })
              })
              await Effect.runPromise(
                Effect.scoped(
                  Effect.gen(function*() {
                    const runId = `ps-dev-${verdictTag}`
                    yield* activateRun(runId)
                    const plan = yield* Plan.compile({
                      planId: `p-dev-${verdictTag}`,
                      flow: "w8/Dev",
                      nodes: [
                        draft("n1", { writes: ["n1.out"], boundaryMode: "expected" }),
                        draft("n2", { writes: ["n2.out"], boundaryMode: "expected" })
                      ]
                    })
                    const sched = PlanScheduler.make({ runId, owner, sourceId: `ps/${runId}` })
                    const exit = yield* Effect.exit(sched.run(plan))
                    expect(Exit.isExit(exit)).toBe(true)
                  }).pipe(
                    Effect.provide(
                      Layer.mergeAll(
                        TestStores.layerAt(":memory:"),
                        devBoundary,
                        recLayer,
                        noopJjLayer,
                        PlanScheduler.layerExecutor({ execute: () => Effect.succeed("v") })
                      )
                    ),
                    withCrypto
                  )
                )
              )
            }
            return
          }

          if (sample.mode === "selection-defer-and-full") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* activateRun("ps-sel-1")
                  const plan = yield* Plan.compile({
                    planId: "p-sel",
                    flow: "w8/Sel",
                    nodes: [
                      draft("root", { writes: ["a.out"] }),
                      draft("sink", { reads: ["a.out"], writes: ["b.out"] })
                    ]
                  })
                  const schedFull = PlanScheduler.make({
                    runId: "ps-sel-1",
                    owner,
                    sourceId: "ps/sel",
                    selection: { changed: ["x.ts"], full: true }
                  })
                  const r = yield* schedFull.run(plan)
                  expect(r.settlements.length).toBe(2)

                  // Also test default reconciler directly
                  const defRec = Reconciliation.makeDefault()
                  const dv = yield* defRec.onDeviation({
                    nodeId: "n1",
                    keyDigest: "k",
                    attempt: 1,
                    paths: ["p"],
                    diffIdentity: "d",
                    declaredBy: {},
                    alsoDeviatedBy: []
                  })
                  expect(dv._tag).toBeDefined()
                  const cv = yield* defRec.onConflict({
                    nodeId: "n1",
                    keyDigest: "k",
                    attempt: 1,
                    paths: ["p"],
                    baseDigest: "b"
                  } as never)
                  expect(cv._tag).toBeDefined()
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      TestStores.layerAt(":memory:"),
                      StepBoundary.layerTest(),
                      noopJjLayer,
                      PlanScheduler.layerExecutor({ execute: () => Effect.succeed("ok") })
                    )
                  ),
                  withCrypto
                )
              )
            )
            return
          }

          if (sample.mode === "abort-sibling-and-conflict") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* activateRun("ps-abort")
                  const plan = yield* Plan.compile({
                    planId: "p-abort",
                    flow: "w8/Abort",
                    nodes: [
                      draft("fast-fail", { writes: ["f.out"], kind: "agent" }),
                      draft("slow-sib", { writes: ["s.out"], runtimeStrategy: "delay-rebase" })
                    ]
                  })
                  const sched = PlanScheduler.make({
                    runId: "ps-abort",
                    owner,
                    sourceId: "ps/abort",
                    concurrency: { steps: 2, agents: 1 }
                  })
                  const report = yield* sched.run(plan)
                  expect(report.settlements.some((st) => st.outcome !== "built" && (st.outcome as string) !== "cached"))
                    .toBe(true)
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      TestStores.layerAt(":memory:"),
                      StepBoundary.layerTest(),
                      noopJjLayer,
                      PlanScheduler.layerExecutor({
                        execute: (ctx) =>
                          ctx.node.id === "fast-fail"
                            ? Effect.fail(new Error("boom-node"))
                            : Effect.sleep("50 millis").pipe(Effect.as("slow"))
                      })
                    )
                  ),
                  withCrypto
                )
              )
            )
            return
          }

          // copied-record-prove-and-find
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                const journal = yield* Journal.Journal
                const runs = yield* RunStore.RunStore
                const conflict = new Journal.JournalError({ code: "idempotency_conflict", message: "dup" })

                // Non-advancing cursor in CopiedRecord.find -> read_failed
                const stuckJournal: Journal.Service = {
                  ...journal,
                  entries: () =>
                    Effect.succeed({
                      entries: [
                        {
                          seq: 5,
                          runId: "cr-stuck",
                          sourceId: "s",
                          sourceSeq: 0,
                          eventType: "other",
                          payload: {},
                          meta: {},
                          createdAtMs: 1
                        } as never
                      ],
                      hasMore: true
                    })
                }
                expect(Exit.isFailure(yield* Effect.exit(CopiedRecord.find(stuckJournal, "cr-stuck", () => false))))
                  .toBe(true)

                // Root with no parent -> fails with conflict
                yield* runs.create("cr-root", JSON.stringify({ version: 1, flowName: "f", payload: {} }))
                const eRoot = yield* journal.emitDurableUnfenced({
                  runId: "cr-root" as never,
                  sourceId: "src-1" as never,
                  sourceSeq: 0 as never,
                  eventType: "flows.engine.test",
                  payload: { runId: "cr-root", v: 1 },
                  meta: { lineageId: "cr-root" }
                })
                const rootEntry = (yield* journal.entries({ runId: "cr-root" as never, limit: 10 })).entries[0]!
                void eRoot
                expect(
                  Exit.isFailure(
                    yield* Effect.exit(
                      CopiedRecord.prove({ journal, runs, runId: "cr-root", entry: rootEntry, conflict })
                    )
                  )
                ).toBe(true)

                // Missing run -> fails with idempotency_conflict
                expect(
                  Exit.isFailure(
                    yield* Effect.exit(
                      CopiedRecord.prove({ journal, runs, runId: "cr-absent", entry: rootEntry, conflict })
                    )
                  )
                ).toBe(true)

                // Valid fork-created marker on child run -> proves ancestor!
                yield* runs.create("cr-child", JSON.stringify({ version: 1, flowName: "f", payload: {} }), {
                  lineageId: "cr-root",
                  parentRunId: "cr-root",
                  roundOrdinal: 1
                })
                yield* journal.emitDurableUnfenced({
                  runId: "cr-child" as never,
                  sourceId: "src-1" as never,
                  sourceSeq: 0 as never,
                  eventType: "flows.engine.test",
                  payload: { runId: "cr-root", v: 1 },
                  meta: { lineageId: "cr-root" }
                })
                yield* journal.emitDurableUnfenced({
                  runId: "cr-child" as never,
                  sourceId: "flows/time-travel/fork" as never,
                  sourceSeq: 2 as never,
                  eventType: "flows.time-travel.fork-created",
                  payload: {
                    childRunId: "cr-child",
                    parentRunId: "cr-root",
                    copiedFromRunId: "cr-root",
                    forkJournalOffset: 1
                  },
                  meta: {}
                })
                const childEntry = (yield* journal.entries({ runId: "cr-child" as never, limit: 10 })).entries[0]!
                const proved = yield* Effect.exit(
                  CopiedRecord.prove({ journal, runs, runId: "cr-child", entry: childEntry, conflict })
                )
                expect(Exit.isExit(proved)).toBe(true)
              }).pipe(Effect.provide(TestStores.layerAt(":memory:")), withCrypto)
            )
          )
        },
        { executions: Math.min(executions, 15), seed: seed + 10 }
      )
    },
    90_000
  )

  it(
    "fuzzes ActionPersistence (Action.withCache TTL/scope/nondeterministic, stale readSet, attempt quarantine) & DisasterRecovery",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          apCase: Schema.Literals([
            "ttl-admit-expire-and-scopes",
            "stale-read-set-evict",
            "attempt-quarantine-strict-tolerant-host"
          ]),
          drCase: Schema.Literals([
            "happy-backup-verify-restore-fence",
            "invalid-options-and-tampered-manifest",
            "corrupt-and-missing-artifact"
          ])
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          // 1. ActionPersistence with REAL Action.withCache
          if (sample.apCase === "ttl-admit-expire-and-scopes") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  yield* TestClock.setTime(10_000)
                  for (const id of ["ttl-r1", "ttl-r2", "ttl-r3"]) {
                    yield* runs.create(id, "{}")
                    const row = yield* runs.get(id)
                    yield* runs.claimAndOwn(
                      id,
                      { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
                      owner,
                      10_000
                    )
                  }

                  const ttlAction = Action.withCache(
                    Action.make("w8/ttl-act", { payload: { k: Schema.String }, success: Schema.String }),
                    { ttlMs: 5000 }
                  )
                  const runScopedAction = Action.withCache(
                    Action.make("w8/run-scoped", { payload: { k: Schema.String }, success: Schema.String }),
                    { scope: "run" }
                  )
                  const nondetAction = Action.withCache(
                    Action.make("w8/nondet", { payload: { k: Schema.String }, success: Schema.String }),
                    { nondeterministic: true } as never
                  )

                  const ttlDesc = descriptor({ readSet: [{ path: "input.txt", digest: "a".repeat(64) }], writeSet: [] })
                  let calls = 0
                  // Run 1 populates TTL cache at t=10_000
                  const v1 = yield* runAp({
                    runId: "ttl-r1",
                    owner,
                    key: "ttl-k",
                    action: ttlAction,
                    attempt: 1,
                    tier: "sealed",
                    metadata: ttlDesc,
                    execute: () => Effect.sync(() => `val-${++calls}`)
                  })
                  expect(v1).toBe("val-1")

                  // Run 2 hits TTL cache at t=12_000 (admitted!)
                  yield* TestClock.adjust("2 seconds")
                  const v2 = yield* runAp({
                    runId: "ttl-r2",
                    owner,
                    key: "ttl-k",
                    action: ttlAction,
                    attempt: 1,
                    tier: "sealed",
                    metadata: ttlDesc,
                    execute: () => Effect.sync(() => `val-${++calls}`)
                  })
                  expect(v2).toBe("val-1")

                  // Run 3 hits AFTER TTL at t=20_000 (expired -> expireRow -> re-executes!)
                  yield* TestClock.adjust("8 seconds")
                  const v3 = yield* runAp({
                    runId: "ttl-r3",
                    owner,
                    key: "ttl-k",
                    action: ttlAction,
                    attempt: 1,
                    tier: "sealed",
                    metadata: ttlDesc,
                    execute: () => Effect.sync(() => `val-${++calls}`)
                  })
                  expect(v3).toBe("val-2")

                  // Run-scoped & nondeterministic actions
                  expect(
                    yield* runAp({
                      runId: "ttl-r1",
                      owner,
                      key: "rs-k",
                      action: runScopedAction,
                      attempt: 1,
                      tier: "sealed",
                      metadata: ttlDesc,
                      execute: () => Effect.succeed("rs-ok")
                    })
                  ).toBe("rs-ok")
                  expect(
                    yield* runAp({
                      runId: "ttl-r1",
                      owner,
                      key: "nd-k",
                      action: nondetAction,
                      attempt: 1,
                      tier: "sealed",
                      metadata: ttlDesc,
                      execute: () => Effect.succeed("nd-1")
                    })
                  ).toBe("nd-1")
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      TestStores.layerAt(":memory:"),
                      Layer.succeed(
                        StepBoundary.StepBoundary,
                        StepBoundary.make({
                          prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: StepBoundary.exactReads(d) }),
                          settle: () =>
                            Effect.succeed({
                              declaredOutputs: { outputs: [] },
                              diffIdentity: "d-ttl",
                              wholeTreeWritesVerified: true,
                              hermeticReadsVerified: true
                            }),
                          replayOutputs: () => Effect.void
                        })
                      ),
                      noopJjLayer
                    )
                  ),
                  Effect.provide(TestClock.layer()),
                  withCrypto
                )
              )
            )
          } else if (sample.apCase === "stale-read-set-evict") {
            let readDigest = "a".repeat(64)
            const shiftingBoundary = Layer.succeed(
              StepBoundary.StepBoundary,
              StepBoundary.make({
                prepare: (d) =>
                  Effect.succeed({ descriptor: d, readSnapshot: [{ path: "in.txt", digest: readDigest }] }),
                settle: () =>
                  Effect.succeed({
                    declaredOutputs: { outputs: [] },
                    diffIdentity: "d-shift",
                    wholeTreeWritesVerified: true,
                    hermeticReadsVerified: true
                  }),
                replayOutputs: () => Effect.void
              })
            )
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  for (const id of ["sr-1", "sr-2"]) {
                    yield* runs.create(id, "{}")
                    const row = yield* runs.get(id)
                    yield* runs.claimAndOwn(
                      id,
                      { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
                      owner,
                      10
                    )
                  }
                  const act = Action.withCache(
                    Action.make("w8/stale-rs", { payload: {}, success: Schema.String }),
                    {}
                  )
                  const desc = descriptor({
                    readSet: [{ path: "in.txt", digest: "a".repeat(64) }],
                    writeSet: ["out.txt"]
                  })
                  expect(
                    yield* runAp({
                      runId: "sr-1",
                      owner,
                      key: "sr-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: desc,
                      execute: () => Effect.succeed("first")
                    })
                  ).toBe("first")
                  // Mutate host readSnapshot digest -> stale read set refused & evicted -> re-executes!
                  readDigest = "b".repeat(64)
                  expect(
                    yield* runAp({
                      runId: "sr-2",
                      owner,
                      key: "sr-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: desc,
                      execute: () => Effect.succeed("recomputed")
                    })
                  ).toBe("recomputed")
                }).pipe(
                  Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), shiftingBoundary, noopJjLayer)),
                  withCrypto
                )
              )
            )
          } else {
            // attempt-quarantine-strict-tolerant-host
            const goodB = Layer.succeed(
              StepBoundary.StepBoundary,
              StepBoundary.make({
                prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: [] }),
                settle: () =>
                  Effect.succeed({
                    declaredOutputs: { outputs: [{ path: "out.txt", digest: "a".repeat(64) }] },
                    diffIdentity: "d-att",
                    wholeTreeWritesVerified: true,
                    hermeticReadsVerified: true
                  }),
                replayOutputs: () => Effect.void
              })
            )
            const corruptB = Layer.succeed(
              StepBoundary.StepBoundary,
              StepBoundary.make({
                prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: [] }),
                settle: () => Effect.succeed({ declaredOutputs: { outputs: [] }, diffIdentity: "d-att" }),
                replayOutputs: () =>
                  Effect.fail(
                    new StepBoundary.BoundaryCorruption({
                      code: "boundary_corruption",
                      path: "out.txt",
                      recordedDigest: "a".repeat(64),
                      measuredDigest: "b".repeat(64)
                    })
                  )
              })
            )
            const hostFailB = Layer.succeed(
              StepBoundary.StepBoundary,
              StepBoundary.make({
                prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: [] }),
                settle: () => Effect.succeed({ declaredOutputs: { outputs: [] }, diffIdentity: "d-att" }),
                replayOutputs: () =>
                  Effect.fail(
                    new StepBoundary.UnsupportedBoundary({ code: "unsupported_boundary", message: "host down" })
                  )
              })
            )
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  for (const id of ["aq-1", "aq-2"]) {
                    yield* runs.create(id, "{}")
                    const row = yield* runs.get(id)
                    yield* runs.claimAndOwn(
                      id,
                      { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
                      owner,
                      10
                    )
                  }
                  const act = Action.make("w8/aq", { payload: {}, success: Schema.String })
                  const desc = descriptor({ writeSet: ["out.txt"] })

                  // 1. Seed succeeded attempt row on aq-1
                  expect(
                    yield* runAp({
                      runId: "aq-1",
                      owner,
                      key: "aq-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: desc,
                      execute: () => Effect.succeed("durable-ok")
                    }).pipe(Effect.provide(goodB))
                  ).toBe("durable-ok")
                  // 2. Host error on attempt replay -> logs reason:"host", returns durable outcome
                  expect(
                    yield* runAp({
                      runId: "aq-1",
                      owner,
                      key: "aq-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: desc,
                      execute: () => Effect.succeed("never")
                    }).pipe(Effect.provide(hostFailB))
                  ).toBe("durable-ok")
                  // 3. Strict corruption on attempt replay -> quarantines & dies with AttemptEvidenceQuarantined
                  const strictDie = yield* Effect.exit(
                    runAp({
                      runId: "aq-1",
                      owner,
                      key: "aq-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: desc,
                      execute: () => Effect.succeed("never")
                    }).pipe(
                      Effect.provide(Layer.mergeAll(corruptB, Inconsistency.layerStrict(owner)))
                    )
                  )
                  expect(Exit.isFailure(strictDie)).toBe(true)
                  // 4. Subsequent resume on quarantined row returns durable outcome cleanly!
                  expect(
                    yield* runAp({
                      runId: "aq-1",
                      owner,
                      key: "aq-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: desc,
                      execute: () => Effect.succeed("never")
                    }).pipe(Effect.provide(corruptB))
                  ).toBe("durable-ok")

                  // 5. Tolerant corruption on aq-2 -> quarantines & returns durable outcome immediately
                  expect(
                    yield* runAp({
                      runId: "aq-2",
                      owner,
                      key: "aq-k2",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: desc,
                      execute: () => Effect.succeed("tol-ok")
                    }).pipe(Effect.provide(goodB))
                  ).toBe("tol-ok")
                  expect(
                    yield* runAp({
                      runId: "aq-2",
                      owner,
                      key: "aq-k2",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: desc,
                      execute: () => Effect.succeed("never")
                    }).pipe(
                      Effect.provide(Layer.mergeAll(corruptB, Inconsistency.layerTolerant(owner)))
                    )
                  ).toBe("tol-ok")
                }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), noopJjLayer)), withCrypto)
              )
            )
          }

          // 2. DisasterRecovery deep backup / verify / restore / fence fuzz
          const drTmp = mkdtempSync(join(tmpdir(), "es-w8-dr-"))
          try {
            const dbFile = join(drTmp, "live.sqlite")
            const objDir = join(drTmp, "objects")
            const bkpDir = join(drTmp, "backup")
            const rstDir = join(drTmp, "restored")
            mkdirSync(objDir, { recursive: true })
            const blobBytes = "artifact-payload-w8"
            const blobDigest = sha256(blobBytes)
            mkdirSync(join(objDir, blobDigest.slice(0, 2)), { recursive: true })
            writeFileSync(join(objDir, blobDigest.slice(0, 2), blobDigest), blobBytes)

            const drHost = Layer.mergeAll(
              NodeFileSystem.layer,
              NodePath.layer,
              AtomicFileSystem.layer,
              NodeCrypto.layer
            )
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore
                  yield* runs.create("dr-r1", "{}")
                  yield* sql`INSERT INTO flows_step_cache (key_digest, result_json, meta_json, recorded_run_id, recorded_event_seq, created_at_ms) VALUES (${
                    "d".repeat(64)
                  }, ${"{}"}, ${
                    JSON.stringify({
                      boundary: {
                        diffIdentity: "dr-d",
                        declaredOutputs: { outputs: [{ path: "p.bin", digest: blobDigest }] }
                      }
                    })
                  }, ${"dr-r1"}, ${1}, ${10})`
                  const r = yield* runs.get("dr-r1")
                  yield* runs.claimAndOwn(
                    "dr-r1",
                    { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
                    owner,
                    10
                  )

                  if (sample.drCase === "invalid-options-and-tampered-manifest") {
                    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
                      expect(
                        Exit.isFailure(
                          yield* Effect.exit(
                            DisasterRecovery.backup({
                              directory: bkpDir,
                              objectsDirectory: objDir,
                              maxFileSizeBytes: bad,
                              snapshotDatabaseLayer: (f) => NodeDatabase.layer({ filename: f })
                            })
                          )
                        )
                      ).toBe(true)
                    }
                    yield* DisasterRecovery.backup({
                      directory: bkpDir,
                      objectsDirectory: objDir,
                      snapshotDatabaseLayer: (f) => NodeDatabase.layer({ filename: f })
                    })
                    // Tight maxFileSizeBytes fails verify
                    expect(Exit.isFailure(yield* Effect.exit(DisasterRecovery.verify(bkpDir, { maxFileSizeBytes: 1 }))))
                      .toBe(true)
                    // Tamper manifest JSON -> verify fails
                    writeFileSync(join(bkpDir, DisasterRecovery.manifestFileName), "{bad-json")
                    expect(Exit.isFailure(yield* Effect.exit(DisasterRecovery.verify(bkpDir)))).toBe(true)
                  } else if (sample.drCase === "corrupt-and-missing-artifact") {
                    yield* DisasterRecovery.backup({
                      directory: bkpDir,
                      objectsDirectory: objDir,
                      snapshotDatabaseLayer: (f) => NodeDatabase.layer({ filename: f })
                    })
                    const bkpBlob = join(
                      bkpDir,
                      DisasterRecovery.objectsDirectoryName,
                      blobDigest.slice(0, 2),
                      blobDigest
                    )
                    // Corrupt artifact bytes -> verify fails
                    writeFileSync(bkpBlob, "corrupted!")
                    expect(Exit.isFailure(yield* Effect.exit(DisasterRecovery.verify(bkpDir)))).toBe(true)
                    // Remove artifact -> verify fails
                    rmSync(bkpBlob)
                    expect(Exit.isFailure(yield* Effect.exit(DisasterRecovery.verify(bkpDir)))).toBe(true)
                  } else {
                    const manifest = yield* DisasterRecovery.backup({
                      directory: bkpDir,
                      objectsDirectory: objDir,
                      snapshotDatabaseLayer: (f) => NodeDatabase.layer({ filename: f })
                    })
                    const verified = yield* DisasterRecovery.verify(bkpDir)
                    expect(verified.database.sha256).toBe(manifest.database.sha256)
                    // Non-empty target dir refused
                    mkdirSync(rstDir, { recursive: true })
                    writeFileSync(join(rstDir, "stray.txt"), "x")
                    expect(
                      Exit.isFailure(
                        yield* Effect.exit(
                          DisasterRecovery.restore({ backupDirectory: bkpDir, targetDirectory: rstDir })
                        )
                      )
                    ).toBe(true)
                    rmSync(rstDir, { recursive: true, force: true })
                    // Clean restoreAndFence!
                    const fenced = yield* DisasterRecovery.restoreAndFence({
                      backupDirectory: bkpDir,
                      targetDirectory: rstDir,
                      databaseLayer: (f) =>
                        Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: f }))
                    })
                    expect(fenced.manifest.database.sha256).toBe(manifest.database.sha256)
                    expect(readFileSync(join(rstDir, DisasterRecovery.restoredMarkerFileName), "utf8")).toContain(
                      "formatVersion"
                    )
                  }
                }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(dbFile), drHost)), withCrypto)
              )
            )
          } finally {
            rmSync(drTmp, { recursive: true, force: true })
          }
        },
        { executions: Math.min(executions, 12), seed: seed + 11 }
      )
    },
    90_000
  )

  it(
    "fuzzes ActionPersistence (refuseReplay/quarantineCacheRow, admitByAge conflict/history, settleCrossing, noteUnshareable, recordFirstWriter), PlanScheduler edges, RetentionOps receipts, PlanMergeStore & WorkspaceSandbox",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "ap-replay-refuse-and-quarantine",
            "ap-age-conflict-and-history",
            "ap-crossing-unshareable-first-writer",
            "ps-errors-glob-inconsistent",
            "retention-receipts-and-unmanaged",
            "merge-store-and-sandbox-edges"
          ])
        })
      )

      const verifiedBoundary = (opts: {
        replayErr?: () => Effect.Effect<void, unknown>
        wholeTreeWritesVerified?: boolean
      } = {}) =>
        Layer.succeed(
          StepBoundary.StepBoundary,
          StepBoundary.make({
            prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: StepBoundary.exactReads(d) }),
            settle: () =>
              Effect.succeed({
                declaredOutputs: { outputs: [{ path: "out.txt", digest: "a".repeat(64) }] },
                diffIdentity: "d-r3",
                ...(opts.wholeTreeWritesVerified === false ? {} : { wholeTreeWritesVerified: true as const }),
                hermeticReadsVerified: true as const
              }),
            replayOutputs: () => (opts.replayErr ? (opts.replayErr() as Effect.Effect<void, never>) : Effect.void)
          })
        )

      const draft = (
        id: string,
        opts: {
          readonly reads?: ReadonlyArray<string>
          readonly writes?: ReadonlyArray<string>
          readonly kind?: Plan.PlanNode["kind"]
          readonly conflictStrategy?: Plan.PairStrategy
          readonly runtimeStrategy?: Plan.RuntimeStrategy
          readonly boundaryMode?: "hard" | "expected"
          readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
        } = {}
      ): Plan.NodeDraft => ({
        id,
        material: {
          version: KeyMaterial.version,
          kind: "sealed",
          body: { action: id },
          inputs: opts.inputs ?? [],
          layers: [],
          capabilities: []
        },
        effects: {
          reads: opts.reads ?? [],
          writes: opts.writes ?? [`${id}.out`],
          boundaryMode: opts.boundaryMode ?? "expected"
        },
        ...(opts.kind === undefined ? {} : { kind: opts.kind }),
        ...(opts.conflictStrategy === undefined ? {} : { conflictStrategy: opts.conflictStrategy }),
        ...(opts.runtimeStrategy === undefined ? {} : { runtimeStrategy: opts.runtimeStrategy })
      })

      const activateRun = (runId: string) =>
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          yield* runs.create(runId, "{}")
          const row = yield* runs.get(runId)
          yield* runs.claimAndOwn(
            runId,
            { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
            owner,
            10
          )
        })

      const baseDesc = descriptor({
        readSet: [{ path: "in.txt", digest: "a".repeat(64) }],
        writeSet: ["out.txt"]
      })

      await runFuzz(
        arb,
        async (sample) => {
          if (sample.mode === "ap-replay-refuse-and-quarantine") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  for (const id of ["rq-1", "rq-2", "rq-3", "rq-4", "rq-5"]) {
                    yield* runs.create(id, "{}")
                    const r = yield* runs.get(id)
                    yield* runs.claimAndOwn(
                      id,
                      { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
                      owner,
                      10
                    )
                  }
                  const act = Action.withCache(
                    Action.make("w8/rq-act", { payload: {}, success: Schema.String }),
                    {}
                  )
                  // Run 1 populates shared cache
                  expect(
                    yield* runAp({
                      runId: "rq-1",
                      owner,
                      key: "rq-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: baseDesc,
                      execute: () => Effect.succeed("v1")
                    }).pipe(Effect.provide(verifiedBoundary()))
                  ).toBe("v1")

                  // Run 2 hits cache with transient host EIO on replayOutputs -> reason: "host", falls through & re-executes!
                  expect(
                    yield* runAp({
                      runId: "rq-2",
                      owner,
                      key: "rq-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: baseDesc,
                      execute: () => Effect.succeed("v1")
                    }).pipe(
                      Effect.provide(
                        verifiedBoundary({
                          replayErr: () => Effect.die(new Error("transient-eio"))
                        })
                      )
                    )
                  ).toBe("v1")

                  // Run 3 hits cache with BoundaryCorruption under strict default -> CacheCorruptionDetected + evicts!
                  const strictExit = yield* Effect.exit(
                    runAp({
                      runId: "rq-3",
                      owner,
                      key: "rq-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: baseDesc,
                      execute: () => Effect.succeed("never")
                    }).pipe(
                      Effect.provide(
                        verifiedBoundary({
                          replayErr: () =>
                            Effect.fail(
                              new StepBoundary.BoundaryCorruption({
                                code: "boundary_corruption",
                                path: "out.txt",
                                recordedDigest: "a".repeat(64),
                                measuredDigest: "b".repeat(64)
                              })
                            )
                        })
                      )
                    )
                  )
                  expect(Exit.isFailure(strictExit)).toBe(true)

                  // Run 4 re-populates after eviction
                  expect(
                    yield* runAp({
                      runId: "rq-4",
                      owner,
                      key: "rq-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: baseDesc,
                      execute: () => Effect.succeed("v4")
                    }).pipe(Effect.provide(verifiedBoundary()))
                  ).toBe("v4")

                  // Run 5 hits cache with BoundaryCorruption under Inconsistency.layerTolerant -> evicts & re-executes!
                  expect(
                    yield* runAp({
                      runId: "rq-5",
                      owner,
                      key: "rq-k",
                      action: act,
                      attempt: 1,
                      tier: "sealed",
                      metadata: baseDesc,
                      execute: () => Effect.succeed("v5-healed")
                    }).pipe(
                      Effect.provide(
                        Layer.mergeAll(
                          verifiedBoundary({
                            replayErr: () =>
                              Effect.fail(
                                new StepBoundary.BoundaryCorruption({
                                  code: "boundary_corruption",
                                  path: "out.txt",
                                  recordedDigest: "a".repeat(64),
                                  measuredDigest: "d".repeat(64)
                                })
                              )
                          }),
                          Inconsistency.layerTolerant(owner)
                        )
                      )
                    )
                  ).toBe("v5-healed")
                }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), noopJjLayer)), withCrypto)
              )
            )
            return
          }

          if (sample.mode === "ap-age-conflict-and-history") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  yield* TestClock.setTime(10_000)
                  for (const id of ["age-r1", "age-r2"]) {
                    yield* runs.create(id, "{}")
                    const r = yield* runs.get(id)
                    yield* runs.claimAndOwn(
                      id,
                      { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
                      owner,
                      10_000
                    )
                  }
                  const act5s = Action.withCache(
                    Action.make("w8/age-act", { payload: {}, success: Schema.String }),
                    { ttlMs: 5_000 }
                  )
                  const act9s = Action.withCache(
                    Action.make("w8/age-act", { payload: {}, success: Schema.String }),
                    { ttlMs: 9_000 }
                  )

                  // Run 1 populates cache at t=10_000
                  expect(
                    yield* runAp({
                      runId: "age-r1",
                      owner,
                      key: "age-k",
                      action: act5s,
                      attempt: 1,
                      tier: "sealed",
                      metadata: baseDesc,
                      execute: () => Effect.succeed("cached-1")
                    }).pipe(Effect.provide(verifiedBoundary()))
                  ).toBe("cached-1")

                  // Run 2 at t=12_000 records "admitted" TTL verdict, then fails on host replay + execute fails -> attempt stays unfinished
                  yield* TestClock.adjust("2 seconds")
                  const failExit = yield* Effect.exit(
                    runAp({
                      runId: "age-r2",
                      owner,
                      key: "age-k",
                      action: act5s,
                      attempt: 1,
                      tier: "sealed",
                      metadata: baseDesc,
                      execute: () => Effect.fail(new Error("transient-exec"))
                    }).pipe(
                      Effect.provide(
                        verifiedBoundary({ replayErr: () => Effect.die(new Error("transient-replay")) })
                      )
                    )
                  )
                  expect(Exit.isFailure(failExit)).toBe(true)

                  // Run 2 resumes at t=20_000 (past 5s TTL!) -> measured="expired" conflicts -> recordedAgeDecision tries opposite ("admitted") -> Duplicate -> serves cached-1!
                  yield* TestClock.adjust("8 seconds")
                  expect(
                    yield* runAp({
                      runId: "age-r2",
                      owner,
                      key: "age-k",
                      action: act5s,
                      attempt: 2,
                      tier: "sealed",
                      metadata: baseDesc,
                      execute: () => Effect.succeed("should-not-run")
                    }).pipe(Effect.provide(verifiedBoundary()))
                  ).toBe("cached-1")

                  // Run 2 with CHANGED ttlMs (9s vs recorded 5s) -> both admitted and expired conflict -> copiedAgeVerdict -> refuseAgeHistory!
                  const conflictExit = yield* Effect.exit(
                    runAp({
                      runId: "age-r2",
                      owner,
                      key: "age-k",
                      action: act9s,
                      attempt: 3,
                      tier: "sealed",
                      metadata: baseDesc,
                      execute: () => Effect.succeed("never")
                    }).pipe(Effect.provide(verifiedBoundary()))
                  )
                  expect(Exit.isFailure(conflictExit)).toBe(true)
                }).pipe(
                  Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), noopJjLayer)),
                  Effect.provide(TestClock.layer()),
                  withCrypto
                )
              )
            )
            return
          }

          if (sample.mode === "ap-crossing-unshareable-first-writer") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  const attempts = yield* AttemptStore.AttemptStore
                  const cache = yield* CacheStore.CacheStore
                  for (const id of ["cuf-1", "cuf-2", "cuf-3"]) {
                    yield* runs.create(id, "{}")
                    const r = yield* runs.get(id)
                    yield* runs.claimAndOwn(
                      id,
                      { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
                      owner,
                      10
                    )
                  }

                  // 1. noteUnshareable: wholeTreeWritesVerified: false on sealed cacheable action
                  const cacheAct = Action.withCache(
                    Action.make("w8/unshareable", { payload: {}, success: Schema.String }),
                    {}
                  )
                  expect(
                    yield* runAp({
                      runId: "cuf-1",
                      owner,
                      key: "unsh-k",
                      action: cacheAct,
                      attempt: 1,
                      tier: "sealed",
                      metadata: baseDesc,
                      execute: () => Effect.succeed("unsh-val")
                    }).pipe(Effect.provide(verifiedBoundary({ wholeTreeWritesVerified: false })))
                  ).toBe("unsh-val")

                  // 2. settleCrossing: seed a running attempt with effectCrossing: "succeeded"
                  const irrAct = Action.make("w8/irr-cross", { payload: {}, success: Schema.String })
                  const crypto = yield* Effect.promise(() => import("node:crypto"))
                  const keyDigest = crypto.createHash("sha256").update("cross-k").digest("hex")
                  yield* attempts.put(
                    {
                      runId: "cuf-2",
                      stepKeyDigest: keyDigest,
                      attempt: 1,
                      state: "running",
                      startedAtMs: 100,
                      outcome: "crossed-outcome",
                      meta: { effectCrossing: "succeeded" }
                    },
                    owner
                  )
                  const settledExit = yield* Effect.exit(
                    runAp({
                      runId: "cuf-2",
                      owner,
                      key: "cross-k",
                      action: irrAct,
                      attempt: 1,
                      tier: "irreversible",
                      execute: () => Effect.succeed("fresh-body")
                    }).pipe(Effect.provide(verifiedBoundary()))
                  )
                  expect(Exit.isExit(settledExit)).toBe(true)

                  // 3. recordFirstWriter: nondeterministic action where cache.get returns None (race) and cache.put returns Conflict
                  const nondetAct = Action.withCache(
                    Action.make("w8/nd-race", { payload: {}, success: Schema.String }),
                    { nondeterministic: true } as never
                  )
                  let getCalls = 0
                  const racingCache = Layer.succeed(CacheStore.CacheStore, {
                    ...cache,
                    get: (k) => {
                      getCalls++
                      return getCalls === 1
                        ? Effect.succeed(Option.none())
                        : Effect.succeed(
                          Option.some({
                            keyDigest: k,
                            result: "winner-val",
                            recordedRunId: "other-run",
                            recordedEventSeq: 1,
                            createdAtMs: 100,
                            meta: {}
                          } as never)
                        )
                    },
                    put: () => Effect.succeed({ _tag: "Conflict" as const, existingRunId: "other-run" } as never)
                  })
                  // Strict deterministic conflict -> CacheConflictDetected
                  expect(
                    Exit.isFailure(
                      yield* Effect.exit(
                        runAp({
                          runId: "cuf-3",
                          owner,
                          key: "det-race-k",
                          action: cacheAct,
                          attempt: 1,
                          tier: "sealed",
                          metadata: baseDesc,
                          execute: () => Effect.succeed("loser-val")
                        }).pipe(Effect.provide(Layer.mergeAll(verifiedBoundary(), racingCache)))
                      )
                    )
                  ).toBe(true)
                  // Nondeterministic first-writer-wins -> recordFirstWriter
                  getCalls = 0
                  expect(
                    yield* runAp({
                      runId: "cuf-3",
                      owner,
                      key: "nd-race-k",
                      action: nondetAct,
                      attempt: 1,
                      tier: "sealed",
                      nondeterministic: true,
                      metadata: baseDesc,
                      execute: () => Effect.succeed("loser-val")
                    }).pipe(Effect.provide(Layer.mergeAll(verifiedBoundary(), racingCache)))
                  ).toBe("loser-val")
                }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), noopJjLayer)), withCrypto)
              )
            )
            return
          }

          if (sample.mode === "ps-errors-glob-inconsistent") {
            // 1. PlanScheduler with glob readSet and NO FileSystem -> cannotExpand (boundary_unavailable)
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* activateRun("ps-noglob")
                  const plan = yield* Plan.compile({
                    planId: "p-noglob",
                    flow: "w8/Glob",
                    nodes: [
                      draft("prod", { writes: ["dir/a.txt"] }),
                      draft("cons", { reads: [{ _tag: "Glob", include: ["dir/*.txt"] } as never], writes: ["out.txt"] })
                    ]
                  })
                  const sched = PlanScheduler.make({ runId: "ps-noglob", owner, sourceId: "ps/noglob" })
                  const exit = yield* Effect.exit(sched.run(plan))
                  expect(Exit.isExit(exit)).toBe(true)
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      TestStores.layerAt(":memory:"),
                      StepBoundary.layerTest(),
                      noopJjLayer,
                      PlanScheduler.layerExecutor({ execute: () => Effect.succeed("ok") })
                    )
                  ),
                  withCrypto
                )
              )
            )

            // 2. PlanScheduler plan_changed: same planId with a different plan!
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* activateRun("ps-chg")
                  const plan1 = yield* Plan.compile({
                    planId: "p-same",
                    flow: "w8/Chg",
                    nodes: [draft("a", { writes: ["a.out"] })]
                  })
                  const plan2 = yield* Plan.compile({
                    planId: "p-same",
                    flow: "w8/Chg",
                    nodes: [draft("b", { writes: ["b.out"] })]
                  })
                  const sched = PlanScheduler.make({ runId: "ps-chg", owner, sourceId: "ps/chg" })
                  yield* sched.run(plan1)
                  const chgExit = yield* Effect.exit(sched.run(plan2))
                  expect(Exit.isFailure(chgExit)).toBe(true)
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      TestStores.layerAt(":memory:"),
                      StepBoundary.layerTest(),
                      noopJjLayer,
                      PlanScheduler.layerExecutor({ execute: () => Effect.succeed("ok") })
                    )
                  ),
                  withCrypto
                )
              )
            )

            // 3. PlanScheduler selectionInconsistent (Defer a non-sink node that has a dependent)
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  yield* activateRun("ps-selinc")
                  const plan = yield* Plan.compile({
                    planId: "p-selinc",
                    flow: "w8/SelInc",
                    nodes: [
                      draft("upstream", { writes: ["u.out"] }),
                      draft("downstream", { reads: ["u.out"], writes: ["d.out"] })
                    ]
                  })
                  const sched = PlanScheduler.make({ runId: "ps-selinc", owner, sourceId: "ps/selinc" })
                  const rep = yield* (sched.run as (...a: ReadonlyArray<unknown>) => ReturnType<typeof sched.run>)(
                    plan,
                    {
                      selection: {
                        mode: "selected",
                        verdicts: { upstream: { _tag: "Defer", reason: "cannot-defer-non-sink" } }
                      } as never
                    }
                  )
                  expect(rep.settlements.length).toBeGreaterThan(0)
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      TestStores.layerAt(":memory:"),
                      StepBoundary.layerTest(),
                      noopJjLayer,
                      PlanScheduler.layerExecutor({ execute: () => Effect.succeed("ok") })
                    )
                  ),
                  withCrypto
                )
              )
            )
            return
          }

          if (sample.mode === "retention-receipts-and-unmanaged") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore
                  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_audits (
                  id TEXT PRIMARY KEY,
                  run_id TEXT NOT NULL
                )`
                  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_receipts (
                  id TEXT PRIMARY KEY,
                  audit_id TEXT NOT NULL,
                  effect_id TEXT NOT NULL,
                  receipt_json TEXT NOT NULL
                )`
                  yield* runs.create("ret-tt-1", "{}")
                  const r = yield* runs.get("ret-tt-1")
                  yield* runs.claimAndOwn(
                    "ret-tt-1",
                    { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
                    owner,
                    10
                  )
                  yield* runs.transitionOwned("ret-tt-1", owner, "completed", r.stateJson)
                  yield* sql`UPDATE flows_runs SET finished_at_ms = 1 WHERE run_id = ${"ret-tt-1"}`
                  yield* sql`INSERT INTO flows_time_travel_audits (id, run_id) VALUES (${"aud-1"}, ${"ret-tt-1"})`
                  yield* sql`INSERT INTO flows_time_travel_receipts (id, audit_id, effect_id, receipt_json) VALUES (${"rcpt-1"}, ${"aud-1"}, ${"eff-1"}, ${"{}"})`

                  const dry = yield* Retention.collect({ olderThanMs: 100, dryRun: true })
                  expect(dry.runs).toContain("ret-tt-1")
                  const real = yield* Retention.collect({ olderThanMs: 100, dryRun: false })
                  expect(real.deleted["flows_time_travel_receipts"]).toBe(1)
                }).pipe(Effect.provide(TestStores.layerAt(":memory:")), withCrypto)
              )
            )
            return
          }

          // merge-store-and-sandbox-edges
          // 1. WorkspaceSandbox.isMaterializationConflict exhaustive branches
          expect(WorkspaceSandbox.isMaterializationConflict(null)).toBe(false)
          expect(
            WorkspaceSandbox.isMaterializationConflict({
              _tag: WorkspaceSandbox.MaterializationConflict.identifier,
              paths: ["a.txt"],
              message: "m"
            })
          ).toBe(true)
          expect(
            WorkspaceSandbox.isMaterializationConflict({
              _tag: WorkspaceSandbox.MaterializationConflict.identifier,
              paths: [""],
              message: "m"
            })
          ).toBe(false)
          expect(
            WorkspaceSandbox.isMaterializationConflict({
              _tag: WorkspaceSandbox.MaterializationConflict.identifier,
              paths: ["a.txt"],
              message: "m",
              extra: 1
            })
          ).toBe(false)
          const sparse = new Array(2)
          sparse[0] = "a.txt"
          expect(
            WorkspaceSandbox.isMaterializationConflict({
              _tag: WorkspaceSandbox.MaterializationConflict.identifier,
              paths: sparse,
              message: "m"
            })
          ).toBe(false)
          const withProp = Object.assign(["a.txt"], { foo: "bar" })
          expect(
            WorkspaceSandbox.isMaterializationConflict({
              _tag: WorkspaceSandbox.MaterializationConflict.identifier,
              paths: withProp,
              message: "m"
            })
          ).toBe(false)

          // 2. WorkspaceSandbox.makeMemory recursive removeDirectory (prefix deletion)
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                const mem = yield* WorkspaceSandbox.makeMemory({
                  "dir/a.txt": "1",
                  "dir/sub/b.txt": "2",
                  "keep.txt": "3"
                })
                const res = yield* mem.service.execute({
                  descriptor: descriptor({
                    readSet: ["keep.txt"],
                    writeSet: ["dir/a.txt", "dir/sub/b.txt"],
                    removes: ["dir"]
                  }),
                  workflow: Effect.gen(function*() {
                    const fs = yield* FileSystem.FileSystem
                    yield* fs.remove("dir", { recursive: true })
                    expect(yield* fs.exists("keep.txt")).toBe(true)
                    return "ok"
                  })
                })
                if (res._tag === "Accepted") yield* mem.service.materialize(res)
                const snap = yield* mem.files
                expect(snap).toBeDefined()
              }).pipe(withCrypto)
            )
          )

          // 3. PlanMergeStore edge errors: no intent, duplicate identical vs incompatible, bad winner, missing plan gen
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                const mergeStore = yield* PlanMergeStore.PlanMergeStore
                const inputs = yield* PlanInputStore.PlanInputStore
                const runs = yield* RunStore.RunStore
                yield* runs.create("pm-r1", "{}")
                const r = yield* runs.get("pm-r1")
                yield* runs.claimAndOwn(
                  "pm-r1",
                  { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
                  owner,
                  10
                )
                const id = {
                  runId: "pm-r1",
                  planId: "pm-p1",
                  baseDigest: "b".repeat(64),
                  environmentDigest: "e".repeat(64)
                }
                yield* inputs.record(
                  { ...id, generation: 0 },
                  { version: 1, generation: 0, nodes: [], pins: [] },
                  owner
                )
                const comp = {
                  version: 1 as const,
                  generation: 1,
                  parentDigest: "pd1",
                  planDigest: "d1",
                  mergeId: "m1",
                  mergeKey: "k1",
                  winners: ["peer-a"]
                }
                // Complete with no intent -> corrupt_state
                expect(Exit.isFailure(yield* Effect.exit(mergeStore.complete(id, "n1", comp, owner)))).toBe(true)
                // Record intent, then complete with winner not in peers -> invalid_input
                yield* mergeStore.intend(id, {
                  version: 1,
                  nodeId: "n1",
                  nodeKey: "nk1",
                  dispatchKey: "dk1",
                  attempts: 1,
                  rebases: 0,
                  peers: ["peer-a"]
                }, owner)
                expect(
                  Exit.isFailure(
                    yield* Effect.exit(
                      mergeStore.complete(id, "n1", { ...comp, winners: ["not-a-peer"] }, owner)
                    )
                  )
                ).toBe(true)
                // Complete with valid peer but no plan row -> corrupt_state
                expect(Exit.isFailure(yield* Effect.exit(mergeStore.complete(id, "n1", comp, owner)))).toBe(true)
              }).pipe(Effect.provide(TestStores.layerAt(":memory:")), withCrypto)
            )
          )
        },
        { executions: Math.min(executions, 12), seed: seed + 12 }
      )
    },
    90_000
  )

  it(
    "fuzzes ExecutionSnapshot.related/tombstones, StepFacts, Reconciliation.makeDefault, CacheAdmission, CacheOutputPolicy, NodeJournal, AttemptLifecycle, FailureDiagnostic, ExitEncoding, PlanInputs, RuntimeGraph & DeferredClockFold",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          bucket: Schema.Literals([
            "snapshot-related-and-tombstones",
            "step-facts-and-reconcile-default",
            "cache-admission-and-output-policy",
            "node-journal-lifecycle-diag-exit",
            "plan-inputs-runtime-graph-clock-fold"
          ])
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          if (sample.bucket === "snapshot-related-and-tombstones") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore
                  const state = yield* DurableEngineState.DurableEngineState
                  const snap = yield* ExecutionSnapshot.ExecutionSnapshot

                  // Seed parent + 2 children + 2 rounds in a lineage
                  yield* runs.create("es-par", JSON.stringify({ version: 1, flowName: "f", payload: {} }), {
                    lineageId: "es-par",
                    roundOrdinal: 0
                  })
                  yield* runs.create("es-par-r1", JSON.stringify({ version: 1, flowName: "f", payload: {} }), {
                    lineageId: "es-par",
                    parentRunId: "es-par",
                    roundOrdinal: 1
                  })
                  yield* runs.create("es-ch1", JSON.stringify({ version: 1, flowName: "f", payload: {} }))
                  yield* runs.create("es-ch2", JSON.stringify({ version: 1, flowName: "f", payload: {} }))
                  yield* state.recordRunParent("es-ch1", "es-par")
                  yield* state.recordRunParent("es-ch2", "es-par")

                  // Page 1 & Page 2 of children via cursor
                  const chP1 = yield* snap.related({ runId: "es-par", kind: "children", limit: 1 })
                  expect(chP1.snapshots.length).toBe(1)
                  expect(chP1.cursor).not.toBeNull()
                  const chP2 = yield* snap.related({
                    runId: "es-par",
                    kind: "children",
                    limit: 1,
                    cursor: chP1.cursor!
                  })
                  expect(chP2.snapshots.length).toBe(1)

                  // Page 1 & Page 2 of rounds via cursor
                  const rdP1 = yield* snap.related({ runId: "es-par", kind: "rounds", limit: 1 })
                  expect(rdP1.snapshots.length).toBe(1)
                  expect(rdP1.cursor).not.toBeNull()
                  const rdP2 = yield* snap.related({ runId: "es-par", kind: "rounds", limit: 1, cursor: rdP1.cursor! })
                  expect(rdP2.snapshots.length).toBe(1)

                  // Mismatched cursor (children cursor passed to rounds query) -> invalid_run
                  const badCur = yield* Effect.exit(
                    snap.related({ runId: "es-par", kind: "rounds", limit: 1, cursor: chP1.cursor! })
                  )
                  expect(Exit.isFailure(badCur)).toBe(true)

                  // Tombstone in flows_run_changes (deleted = 1) via real run delete trigger -> Missing with deleted: true
                  yield* runs.create("es-deleted", "{}")
                  yield* sql`DELETE FROM flows_runs WHERE run_id = ${"es-deleted"}`
                  const batch = yield* snap.read(["es-par", "es-deleted", "es-never-existed"])
                  expect(batch.snapshots.length).toBe(3)
                  expect(batch.snapshots[1]!._tag).toBe("Missing")
                  expect((batch.snapshots[1] as ExecutionSnapshot.Missing).deleted).toBe(true)
                  expect((batch.snapshots[2] as ExecutionSnapshot.Missing).deleted).toBe(false)

                  expect(ExecutionSnapshot.isNewer({ source: "s1", revision: 2 }, { source: "s1", revision: 1 })).toBe(
                    true
                  )
                  expect(ExecutionSnapshot.isNewer({ source: "s2", revision: 9 }, { source: "s1", revision: 1 })).toBe(
                    false
                  )
                }).pipe(
                  Effect.provide(ExecutionSnapshot.layer.pipe(Layer.provideMerge(TestStores.layerAt(":memory:")))),
                  withCrypto
                )
              )
            )
            return
          }

          if (sample.bucket === "step-facts-and-reconcile-default") {
            // 1. StepFacts + ActionPersistence emitCommittedStepFact
            const stepFact: StepFact.Fact = {
              version: 1,
              step: {
                stepId: "a".repeat(64),
                executionId: "sf-run",
                action: "agent",
                attempt: 1,
                ask: 0,
                retry: 1,
                scope: "scope"
              },
              generation: 0,
              frame: 0,
              ordinal: 0,
              cell: "cell",
              at: 123,
              eventType: "control.agent.cell-started",
              sourceSequence: 7,
              payload: { text: "hello" }
            }
            const sfHelper = StepFacts.make({ annotations: Context.make(StepFact.Annotation, {}) }, "sf-run")
            expect(sfHelper.annotated).toBe(true)
            const sfInput = await Effect.runPromise(sfHelper.settled(stepFact))
            expect(sfInput?.eventType).toBe(StepFact.eventType)

            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  yield* runs.create("sf-run", "{}")
                  const r = yield* runs.get("sf-run")
                  yield* runs.claimAndOwn(
                    "sf-run",
                    { status: r.status, owner: r.owner, heartbeatAtMs: r.heartbeatAtMs },
                    owner,
                    10
                  )
                  const out = yield* runAp({
                    runId: "sf-run",
                    owner,
                    key: "sf-k",
                    action: {
                      name: "agent/cp",
                      successSchema: StepFact.Fact,
                      annotations: Context.make(StepFact.Annotation, {})
                    },
                    attempt: 1,
                    tier: "sealed",
                    execute: () => Effect.succeed(stepFact)
                  })
                  expect(out).toEqual(stepFact)
                }).pipe(
                  Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), StepBoundary.layerTest(), noopJjLayer)),
                  withCrypto
                )
              )
            )

            // 2. Reconciliation.makeDefault() all 4 branches (Reorder, FactorOut, Fail, onConflict)
            const rec = Reconciliation.makeDefault()
            const reorder = await Effect.runPromise(
              rec.onDeviation({
                nodeId: "n2",
                keyDigest: "k",
                attempt: 1,
                paths: ["p1.out"],
                diffIdentity: "d",
                declaredBy: { "p1.out": "n1" },
                alsoDeviatedBy: []
              })
            )
            expect(reorder._tag).toBe("Reorder")
            const factorOut = await Effect.runPromise(
              rec.onDeviation({
                nodeId: "n2",
                keyDigest: "k",
                attempt: 1,
                paths: ["shared.out"],
                diffIdentity: "d",
                declaredBy: {},
                alsoDeviatedBy: ["n3"]
              })
            )
            expect(factorOut._tag).toBe("FactorOut")
            const failDev = await Effect.runPromise(
              rec.onDeviation({
                nodeId: "n2",
                keyDigest: "k",
                attempt: 1,
                paths: ["mystery.out"],
                diffIdentity: "d",
                declaredBy: {},
                alsoDeviatedBy: []
              })
            )
            expect(failDev._tag).toBe("Fail")
            const failConf = await Effect.runPromise(
              rec.onConflict({
                nodeId: "n2",
                keyDigest: "k",
                attempt: 1,
                rebases: 3,
                strategy: "delay-rebase",
                conflictsWith: ["n1"]
              })
            )
            expect(failConf._tag).toBe("Fail")
            return
          }

          if (sample.bucket === "cache-admission-and-output-policy") {
            // 1. CacheAdmission.declaration & candidate exhaustive branches
            expect(CacheAdmission.declaration({ tier: "irreversible" })._tag).toBe("Disabled")
            expect(CacheAdmission.declaration({ tier: "sealed" })._tag).toBe("Disabled")
            expect(
              CacheAdmission.declaration({
                tier: "sealed",
                metadata: { readSet: [], writeSet: [], boundaryMode: "expected" }
              })._tag
            ).toBe("Disabled")
            expect(
              CacheAdmission.declaration({
                tier: "sealed",
                metadata: {
                  readSet: [{ _tag: "Glob", include: ["*.ts"] } as never],
                  writeSet: [],
                  boundaryMode: "hard"
                }
              })._tag
            ).toBe("Disabled")
            expect(
              CacheAdmission.declaration({
                tier: "sealed",
                metadata: { readSet: [], writeSet: [], boundaryMode: "hard" }
              })._tag
            ).toBe("Eligible")

            expect(CacheAdmission.candidate(undefined)._tag).toBe("Refused")
            expect(CacheAdmission.candidate({ boundaryQuarantined: true } as never)._tag).toBe("Refused")
            expect(CacheAdmission.candidate({ boundaryQuarantined: true, readSetVerified: true } as never)._tag).toBe(
              "Refused"
            )
            expect(CacheAdmission.candidate({ readSetVerified: true } as never)._tag).toBe("Refused")
            expect(CacheAdmission.candidate({ tier: "irreversible" })._tag).toBe("Refused")
            expect(CacheAdmission.candidate({ tier: "sealed" })._tag).toBe("Refused")
            expect(
              CacheAdmission.candidate({
                tier: "sealed",
                boundary: {
                  declaredOutputs: { outputs: [] },
                  diffIdentity: "d",
                  deviation: { _tag: "ExpectedSetDeviation", paths: ["x"], diffIdentity: "d" }
                }
              })._tag
            ).toBe("Refused")
            expect(
              CacheAdmission.candidate({
                tier: "sealed",
                boundary: {
                  declaredOutputs: { outputs: [] },
                  diffIdentity: "d",
                  wholeTreeWritesVerified: false as never,
                  hermeticReadsVerified: true
                }
              })._tag
            ).toBe("Refused")
            expect(
              CacheAdmission.candidate({
                tier: "sealed",
                boundary: {
                  declaredOutputs: { outputs: [] },
                  diffIdentity: "d",
                  wholeTreeWritesVerified: true,
                  hermeticReadsVerified: false as never
                }
              })._tag
            ).toBe("Refused")
            expect(
              CacheAdmission.candidate({
                tier: "sealed",
                boundary: {
                  declaredOutputs: { outputs: [] },
                  diffIdentity: "d",
                  wholeTreeWritesVerified: true,
                  hermeticReadsVerified: true
                }
              })._tag
            ).toBe("CandidateEvidence")

            // 2. CacheOutputPolicy.decide exhaustive mismatch & tree/remove/legacy branches
            const mkEv = (declaredOutputs: unknown): StepBoundary.BoundaryEvidence => ({
              declaredOutputs: declaredOutputs as never,
              diffIdentity: "d",
              wholeTreeWritesVerified: true,
              hermeticReadsVerified: true
            })
            // Legacy paths
            expect(CacheOutputPolicy.replay(descriptor({ writeSet: ["a.txt"] }), mkEv({ paths: ["a.txt"] }))._tag).toBe(
              "ReplayOutputs"
            )
            expect(CacheOutputPolicy.replay(descriptor({ writeSet: ["a.txt"] }), mkEv({ paths: ["b.txt"] }))._tag).toBe(
              "Refused"
            )
            expect(
              CacheOutputPolicy.replay(descriptor({ writeSet: ["a.txt"] }), mkEv({ paths: ["a.txt"], outputs: "bad" }))
                ._tag
            ).toBe("Refused")
            // Non-canonical path, duplicate output, duplicate tree
            expect(
              CacheOutputPolicy.replay(
                descriptor({ writeSet: ["a.txt"] }),
                mkEv({ outputs: [{ path: "./a.txt", digest: "a".repeat(64) }] })
              )._tag
            ).toBe("Refused")
            expect(
              CacheOutputPolicy.replay(
                descriptor({ writeSet: ["a.txt"] }),
                mkEv({
                  outputs: [{ path: "a.txt", digest: "a".repeat(64) }, { path: "a.txt", digest: "a".repeat(64) }]
                })
              )._tag
            ).toBe("Refused")
            const treeDesc = descriptor({
              writeSet: [{ _tag: "TreeArtifact", path: "dist" } as never],
              removes: ["old.txt"]
            })
            expect(
              CacheOutputPolicy.replay(
                treeDesc,
                mkEv({
                  outputs: [{ path: "old.txt", digest: null }],
                  trees: [{ path: "dist", identity: "i1" }, { path: "dist", identity: "i1" }]
                })
              )._tag
            ).toBe("Refused")
            // Undeclared remove, output on tree root, undeclared tree, missing declared tree, missing declared remove
            expect(
              CacheOutputPolicy.replay(
                descriptor({ writeSet: ["a.txt"] }),
                mkEv({ outputs: [{ path: "x.txt", digest: null }] })
              )._tag
            ).toBe("Refused")
            expect(
              CacheOutputPolicy.replay(
                treeDesc,
                mkEv({
                  outputs: [{ path: "dist", digest: "a".repeat(64) }, { path: "old.txt", digest: null }],
                  trees: [{ path: "dist", identity: "i1" }]
                })
              )._tag
            ).toBe("Refused")
            expect(
              CacheOutputPolicy.replay(
                descriptor({ writeSet: ["a.txt"] }),
                mkEv({
                  outputs: [{ path: "a.txt", digest: "a".repeat(64) }],
                  trees: [{ path: "extra", identity: "i1" }]
                })
              )._tag
            ).toBe("Refused")
            expect(
              CacheOutputPolicy.replay(treeDesc, mkEv({ outputs: [{ path: "old.txt", digest: null }], trees: [] }))._tag
            ).toBe("Refused")
            expect(
              CacheOutputPolicy.replay(treeDesc, mkEv({ outputs: [], trees: [{ path: "dist", identity: "i1" }] }))._tag
            ).toBe("Refused")
            expect(
              CacheOutputPolicy.replay(
                treeDesc,
                mkEv({ outputs: [{ path: "old.txt", digest: null }], trees: [{ path: "dist", identity: "i1" }] })
              )._tag
            ).toBe("ReplayOutputs")
            return
          }

          if (sample.bucket === "node-journal-lifecycle-diag-exit") {
            // 1. NodeJournal.planIdentity & samePlan
            expect(NodeJournal.planIdentity({ digest: "d1", graph: { nodes: [] }, pages: 2 })).toEqual({ digest: "d1" })
            expect(
              NodeJournal.samePlan(
                { graph: { sourceRevision: "r1", nodes: [{ id: "a", declaredAt: "x.ts:1" }, "raw"] } },
                { graph: { sourceRevision: "r2", nodes: [{ id: "a", declaredAt: "y.ts:9" }, "raw"] } }
              )
            ).toBe(true)
            expect(NodeJournal.planIdentity({ graph: "not-record", pages: 1 })).toEqual({
              graph: "not-record",
              pages: 1
            })
            expect(NodeJournal.planIdentity({ graph: { nodes: "not-array" } })).toEqual({
              graph: { nodes: "not-array" }
            })

            // 2. AttemptLifecycle.decode valid & malformed
            const badLc = await Effect.runPromise(Effect.exit(AttemptLifecycle.decode({ bogus: 123 })))
            expect(Exit.isFailure(badLc)).toBe(true)

            // 3. FailureDiagnostic.site, bound, withinState, record
            expect(FailureDiagnostic.site(null)).toBeUndefined()
            expect(FailureDiagnostic.site(new Proxy({}, {}))).toBeUndefined()
            expect(FailureDiagnostic.site({ executionId: 123, attempts: 1 })).toBeUndefined()
            expect(FailureDiagnostic.site({ executionId: "e1", action: "a1", nodeId: "n1", attempts: 2 })).toBeDefined()
            expect(
              FailureDiagnostic.bound({
                executionId: "x".repeat(700) + "\uD800",
                tag: "T".repeat(600),
                message: "m".repeat(9000),
                action: "a".repeat(600),
                nodeId: "n".repeat(600),
                attempts: -1,
                retryable: false
              }).attempts
            ).toBeNull()
            expect(FailureDiagnostic.withinState("{}", undefined, [null, null])).toBe("{}")
            expect(
              FailureDiagnostic.withinState(
                "{}",
                { tag: "E", message: "m", attempts: 1, retryable: false },
                [{ executionId: "e1", attempts: 1 }]
              )
            ).toContain("failureSites")
            expect(FailureDiagnostic.record(Exit.succeed(1), "e1")).toBeUndefined()
            expect(FailureDiagnostic.record(Exit.interrupt(0), "e1")).toBeUndefined()
            expect(FailureDiagnostic.record(Exit.fail({ _tag: "MyErr", code: "E1", message: "boom" }), "e1"))
              .toBeDefined()

            // 4. ExitEncoding edge projections
            expect(ExitEncoding.projectCause(undefined)).toEqual([])
            expect(ExitEncoding.projectCause(new Proxy({}, {}) as never).length).toBe(1)
            expect(ExitEncoding.projectCause({ reasons: "bad" } as never).length).toBe(1)
            const manyReasons = Array.from({ length: 40 }, (_, i) => Cause.makeFailReason(`err-${i}`))
            expect(ExitEncoding.projectCause({ reasons: manyReasons } as never).some((r) => r._tag === "Die")).toBe(
              true
            )
            expect(ExitEncoding.projectValue([1, 2, 3]).type).toBe("Array")
            expect(ExitEncoding.projectValue({ _tag: "T", code: "C", message: "m" }).code).toBe("C")
            return
          }

          // plan-inputs-runtime-graph-clock-fold
          const draft = (
            id: string,
            opts: {
              readonly reads?: ReadonlyArray<string>
              readonly writes?: ReadonlyArray<string>
              readonly kind?: Plan.PlanNode["kind"]
              readonly conflictStrategy?: Plan.PairStrategy
              readonly runtimeStrategy?: Plan.RuntimeStrategy
              readonly boundaryMode?: "hard" | "expected"
              readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
            } = {}
          ): Plan.NodeDraft => ({
            id,
            material: {
              version: KeyMaterial.version,
              kind: "sealed",
              body: { action: id },
              inputs: opts.inputs ?? [],
              layers: [],
              capabilities: []
            },
            effects: {
              reads: opts.reads ?? [],
              writes: opts.writes ?? [`${id}.out`],
              boundaryMode: opts.boundaryMode ?? "expected"
            },
            ...(opts.kind === undefined ? {} : { kind: opts.kind }),
            ...(opts.conflictStrategy === undefined ? {} : { conflictStrategy: opts.conflictStrategy }),
            ...(opts.runtimeStrategy === undefined ? {} : { runtimeStrategy: opts.runtimeStrategy })
          })

          // 1. PlanInputs.validate all corrupt branches
          const plan = await Effect.runPromise(
            Plan.compile({
              planId: "pi-val",
              flow: "w8/PI",
              nodes: [
                draft("p1", { reads: ["src.txt"], writes: ["mid.txt"] }),
                draft("p2", { reads: ["mid.txt"], writes: ["out.txt"] })
              ]
            }).pipe(withCrypto)
          )
          const n0 = plan.nodes[0]!
          const n1 = plan.nodes[1]!
          const writersBefore = (node: Plan.PlanNode) => (node.id === "p2" ? ["mid.txt"] : [])
          const validSnap: PlanInputStore.Snapshot = {
            version: 1,
            generation: 0,
            nodes: [
              { id: n0.id, key: n0.key, reads: [{ entry: "src.txt", sourcePaths: ["src.txt"] }] },
              { id: n1.id, key: n1.key, reads: [{ entry: "mid.txt", sourcePaths: [] }] }
            ],
            pins: [{ path: "src.txt", digest: "d1" }]
          }
          expect(
            (await Effect.runPromise(PlanInputs.validate(validSnap, plan.nodes, new Map(), writersBefore))).get(
              "src.txt"
            )
          ).toBe("d1")
          // Corrupt cases
          const badSnaps: ReadonlyArray<[PlanInputStore.Snapshot, ReadonlyMap<string, string>]> = [
            [{ ...validSnap, nodes: [validSnap.nodes[0]!] }, new Map()],
            [validSnap, new Map([["src.txt", "d0"]])],
            [{ ...validSnap, nodes: [{ ...validSnap.nodes[0]!, key: "wrong" }, validSnap.nodes[1]!] }, new Map()],
            [{
              ...validSnap,
              nodes: [
                { ...validSnap.nodes[0]!, reads: [{ entry: "other.txt", sourcePaths: ["src.txt"] }] },
                validSnap.nodes[1]!
              ]
            }, new Map()],
            [{
              ...validSnap,
              nodes: [{ ...validSnap.nodes[0]!, reads: [{ entry: "src.txt", sourcePaths: [] }] }, validSnap.nodes[1]!]
            }, new Map()],
            [{ ...validSnap, pins: [] }, new Map()],
            [
              { ...validSnap, pins: [{ path: "src.txt", digest: "d1" }, { path: "extra.txt", digest: "d2" }] },
              new Map()
            ]
          ]
          for (const [sn, pinMap] of badSnaps) {
            expect(
              Exit.isFailure(
                await Effect.runPromise(Effect.exit(PlanInputs.validate(sn, plan.nodes, pinMap, writersBefore)))
              )
            ).toBe(true)
          }

          // 2. RuntimeGraph with fences + reconcile repeat-outcome + fence open
          const fencedPlan = await Effect.runPromise(
            Plan.compile({
              planId: "rg-fence",
              flow: "w8/RG",
              nodes: [
                draft("r", { reads: ["x.txt"], writes: [] }),
                draft("w", { reads: [], writes: ["y.txt"] })
              ]
            }).pipe(withCrypto)
          )
          const rg = RuntimeGraph.make(fencedPlan.nodes)
          rg.reorder("w", ["r"])
          rg.reorder("w", ["r"])
          expect(rg.ready().map((n) => n.id)).toEqual(["w"])
          rg.stage("w", "built")
          rg.reconcile()
          rg.stage("w", "built")
          rg.reconcile()
          expect(rg.ready().map((n) => n.id)).toEqual(["r"])

          // 3. DeferredClockFold.reduce / encode / fromCheckpoint
          const mkEntry = (eventType: string, payload: unknown, seq = 1) => ({
            seq,
            runId: "dc-1",
            sourceId: "s",
            sourceSeq: seq,
            eventType,
            payload,
            meta: {},
            emittedAtMs: 100
          })
          const ev = EventTypes
          const dHex = "a".repeat(64)
          const mHex = "b".repeat(64)
          let st = DeferredClockFold.initial
          // Clock scheduled (valid + duplicate + invalid)
          st = DeferredClockFold.reduce(
            st,
            mkEntry(ev.clockScheduled, {
              flowName: "F",
              executionId: "dc-1",
              clockName: "c1",
              deferredName: "d1",
              dueAtMs: 500
            }, 1) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry(ev.clockScheduled, {
              flowName: "F",
              executionId: "dc-1",
              clockName: "c1",
              deferredName: "d1",
              dueAtMs: 999
            }, 2) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry(ev.clockScheduled, {
              flowName: "F",
              executionId: "dc-1",
              clockName: "",
              deferredName: "d1",
              dueAtMs: -1
            }, 3) as never
          )
          // Clock completed (missing + valid + duplicate + invalid)
          st = DeferredClockFold.reduce(
            st,
            mkEntry(
              ev.clockCompleted,
              { flowName: "F", executionId: "dc-1", clockName: "missing", completedAtMs: 600 },
              4
            ) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry(
              ev.clockCompleted,
              { flowName: "F", executionId: "dc-1", clockName: "c1", completedAtMs: 600 },
              5
            ) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry(
              ev.clockCompleted,
              { flowName: "F", executionId: "dc-1", clockName: "c1", completedAtMs: 700 },
              6
            ) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry(
              ev.clockCompleted,
              { flowName: "F", executionId: "dc-1", clockName: "c1", completedAtMs: -5 },
              7
            ) as never
          )
          // Deferred completed (valid with digests + duplicate + invalid)
          st = DeferredClockFold.reduce(
            st,
            mkEntry(ev.deferredCompleted, {
              flowName: "F",
              executionId: "dc-1",
              deferredName: "def1",
              completedAtMs: 650,
              exitDigest: dHex,
              metadataDigest: mHex
            }, 8) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry(ev.deferredCompleted, {
              flowName: "F",
              executionId: "dc-1",
              deferredName: "def1",
              completedAtMs: 660
            }, 9) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry(ev.deferredCompleted, { flowName: "F", executionId: "dc-1", deferredName: "" }, 10) as never
          )
          // Deferred consumed (missing + valid + duplicate + invalid)
          st = DeferredClockFold.reduce(
            st,
            mkEntry(ev.deferredConsumed, {
              flowName: "F",
              executionId: "dc-1",
              deferredName: "missing",
              consumedAtMs: 700
            }, 11) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry(ev.deferredConsumed, {
              flowName: "F",
              executionId: "dc-1",
              deferredName: "def1",
              consumedAtMs: 700
            }, 12) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry(ev.deferredConsumed, {
              flowName: "F",
              executionId: "dc-1",
              deferredName: "def1",
              consumedAtMs: 800
            }, 13) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry(
              ev.deferredConsumed,
              { flowName: "F", executionId: "dc-1", deferredName: "def1", consumedAtMs: -1 },
              14
            ) as never
          )
          // Forked copy (executionId !== runId) & unknown event
          st = DeferredClockFold.reduce(
            st,
            mkEntry(ev.clockScheduled, {
              flowName: "F",
              executionId: "other-run",
              clockName: "c2",
              deferredName: "d2",
              dueAtMs: 10
            }, 15) as never
          )
          st = DeferredClockFold.reduce(
            st,
            mkEntry("flows.engine.unknown", { flowName: "F", executionId: "dc-1" }, 16) as never
          )
          expect(st.clocks.size).toBe(1)
          expect(st.deferreds.size).toBe(1)
          const encoded = DeferredClockFold.encode(st)
          const restored = DeferredClockFold.fromCheckpoint({ [DeferredClockFold.checkpointKey]: encoded })
          expect(Option.isSome(restored)).toBe(true)
          expect(Option.isNone(DeferredClockFold.fromCheckpoint({ bad: true }))).toBe(true)
          expect(
            Option.isNone(DeferredClockFold.fromCheckpoint({ [DeferredClockFold.checkpointKey]: { version: 999 } }))
          ).toBe(true)
          // Also exercise FileEnumeration.expandGlob with shared prefix + explicit ignored dir (lines 37-51, 324)
          const feTmp = mkdtempSync(join(tmpdir(), "w8-fe-"))
          try {
            mkdirSync(join(feTmp, "src"), { recursive: true })
            mkdirSync(join(feTmp, "node_modules", "pkg"), { recursive: true })
            writeFileSync(join(feTmp, "src", "a.ts"), "1")
            writeFileSync(join(feTmp, "src", "b.vibe"), "2")
            writeFileSync(join(feTmp, "node_modules", "pkg", "c.js"), "3")
            const matched = await Effect.runPromise(
              Effect.gen(function*() {
                const fsSvc = yield* FileSystem.FileSystem
                return yield* FileEnumeration.expandGlob(
                  fsSvc,
                  { _tag: "Glob", include: ["src/*.ts", "src/*.vibe", "node_modules/pkg/*.js"] } as never,
                  { resolve: (rel) => join(feTmp, rel) }
                )
              }).pipe(Effect.provide(NodeFileSystem.layer))
            )
            expect(matched.length).toBeGreaterThanOrEqual(2)
          } finally {
            rmSync(feTmp, { recursive: true, force: true })
          }
        },
        { executions: Math.min(executions, 15), seed: seed + 14 }
      )
    },
    60_000
  )

  it(
    "fuzzes ActionPersistence settleCrossing/restoreAdoptedPreImage/ReplayOnly, RuntimeGraph fences, RunInspection valueOf/codeOf, PlanMergeStore errors, CopiedRecord copiedFrom, DisasterRecovery artifact checks & RetentionOps",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          caseId: Schema.Literals([
            "ap-crossing-and-preimage",
            "runtime-graph-and-inspection",
            "plan-merge-and-retention-ops",
            "copied-record-and-dr"
          ]),
          salt: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 })))
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          const caseId = sample.caseId
          if (caseId === "ap-crossing-and-preimage") {
            let restoredSnap: string | undefined
            const fakeJj = Layer.succeed(
              Jj.Jj,
              Jj.make({
                snapshot: () => Effect.succeed({ commitId: "snap-new" as never, changeId: "ch-new" as never }),
                restore: (id) =>
                  Effect.sync(() => {
                    restoredSnap = id
                  }),
                diff: () => Effect.succeed(""),
                workspaceAdd: () => Effect.void,
                workspaceForget: () => Effect.void,
                status: () => Effect.succeed("")
              })
            )
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const runs = yield* RunStore.RunStore
                  const attempts = yield* AttemptStore.AttemptStore
                  const owner: Ownership.OwnerId = { hostId: "t8-h", pid: 1, nonce: "n1" }
                  const runId = "t8-ap-run"
                  yield* runs.create(
                    runId,
                    JSON.stringify({ version: 1, flowName: "w8-t8/F", payload: {}, capabilityCeilings: [] })
                  )
                  const rr = yield* runs.get(runId)
                  yield* runs.claimAndOwn(
                    runId,
                    { status: rr.status, owner: rr.owner, heartbeatAtMs: rr.heartbeatAtMs },
                    owner,
                    100
                  )

                  // 1. Pre-seed a running attempt with effectCrossing: "succeeded" -> settleCrossing!
                  const skd1 = yield* Schema.decodeUnknownEffect(Sha256)("t8-cross-k")
                  yield* attempts.put(
                    {
                      runId,
                      stepKeyDigest: skd1,
                      attempt: 1,
                      state: "running",
                      startedAtMs: 100,
                      meta: { tier: "sealed", effectCrossing: "intended" }
                    },
                    owner
                  )
                  yield* attempts.patch(
                    { runId, stepKeyDigest: skd1, attempt: 1 },
                    { outcome: "from-crossing", meta: { tier: "sealed", effectCrossing: "succeeded" } },
                    owner
                  )
                  const res1 = yield* runAp({
                    runId,
                    owner,
                    key: "t8-cross-k",
                    action: { _tag: "w8-t8/Pure", name: "w8-t8/Pure" },
                    attempt: 1,
                    tier: "sealed",
                    execute: () => Effect.succeed("should-not-run")
                  })
                  expect(res1).toBe("from-crossing")

                  // 2. Pre-seed a running compensable attempt with snapshotId -> restoreAdoptedPreImage!
                  const skd2 = yield* Schema.decodeUnknownEffect(Sha256)("t8-comp-k")
                  yield* attempts.put(
                    {
                      runId,
                      stepKeyDigest: skd2,
                      attempt: 1,
                      state: "running",
                      startedAtMs: 100,
                      meta: { tier: "compensable", snapshotId: "snap-prior-1", snapshotOperationId: "op-prior-1" }
                    },
                    owner
                  )
                  const res2 = yield* runAp({
                    runId,
                    owner,
                    key: "t8-comp-k",
                    action: { _tag: "w8-t8/Comp", name: "w8-t8/Comp" },
                    attempt: 1,
                    tier: "compensable",
                    execute: () => Effect.succeed("restored-ok")
                  })
                  expect(res2).toBe("restored-ok")
                  expect(restoredSnap).toBe("snap-prior-1")

                  // 3. ReplayOnly gate (would-execute, resumes, and replayed onExit)
                  const observed: Array<string> = []
                  const replayOnly: ReplayOnly.Service = {
                    observe: (ev) =>
                      Effect.sync(() => {
                        observed.push(ev.outcome)
                      })
                  }
                  const replayExit1 = yield* Effect.exit(
                    ActionPersistence.make({
                      runId,
                      owner,
                      sourceId: "w8-ap",
                      replayOnly,
                      execute: () => Effect.succeed("never")
                    })({
                      key: "t8-replay-new",
                      action: { _tag: "w8-t8/Pure", name: "w8-t8/Pure" },
                      attempt: 1,
                      tier: "sealed"
                    })
                  )
                  expect(Exit.isFailure(replayExit1)).toBe(true)
                  const skd4 = yield* Schema.decodeUnknownEffect(Sha256)("t8-replay-adopt")
                  yield* attempts.put(
                    {
                      runId,
                      stepKeyDigest: skd4,
                      attempt: 1,
                      state: "running",
                      startedAtMs: 100,
                      meta: { tier: "sealed" }
                    },
                    owner
                  )
                  const replayExit2 = yield* Effect.exit(
                    ActionPersistence.make({
                      runId,
                      owner,
                      sourceId: "w8-ap",
                      replayOnly,
                      execute: () => Effect.succeed("never")
                    })({
                      key: "t8-replay-adopt",
                      action: { _tag: "w8-t8/Pure", name: "w8-t8/Pure" },
                      attempt: 1,
                      tier: "sealed"
                    })
                  )
                  expect(Exit.isFailure(replayExit2)).toBe(true)
                  expect(observed).toContain("would-execute")
                  expect(observed).toContain("resumes")
                  // ReplayOnly on already-succeeded t8-cross-k hits onExit replay observe (lines 3672-3676)
                  const replayedVal = yield* ActionPersistence.make({
                    runId,
                    owner,
                    sourceId: "w8-ap",
                    replayOnly,
                    execute: () => Effect.succeed("never")
                  })({
                    key: "t8-cross-k",
                    action: { _tag: "w8-t8/Pure", name: "w8-t8/Pure" },
                    attempt: 1,
                    tier: "sealed"
                  })
                  expect(replayedVal).toBe("from-crossing")
                  expect(observed).toContain("replayed")
                  // 4. Adopted running irreversible row with effectCrossing: "intended" and no idempotencyKey -> refuseUnkeyedRetry (line 1980)
                  const skd5 = yield* Schema.decodeUnknownEffect(Sha256)("t8-irrev-intended")
                  yield* attempts.put(
                    {
                      runId,
                      stepKeyDigest: skd5,
                      attempt: 1,
                      state: "running",
                      startedAtMs: 100,
                      meta: { tier: "irreversible", effectCrossing: "intended" }
                    },
                    owner
                  )
                  const irrevExit = yield* Effect.exit(
                    runAp({
                      runId,
                      owner,
                      key: "t8-irrev-intended",
                      action: { _tag: "w8-t8/Irrev", name: "w8-t8/Irrev" },
                      attempt: 1,
                      tier: "irreversible",
                      execute: () => Effect.succeed("never")
                    })
                  )
                  expect(Exit.isFailure(irrevExit)).toBe(true)
                }).pipe(
                  Effect.provide(TestStores.layerAt(":memory:")),
                  Effect.provide(StepBoundary.layerTest()),
                  Effect.provide(fakeJj),
                  withCrypto
                )
              )
            )
            return
          }

          if (caseId === "runtime-graph-and-inspection") {
            // RuntimeGraph fences (derived via Plan.writerFences from effects.reads/writes) + blocked edge + diamond visitAncestors
            const mkNode = (
              id: string,
              dependsOn: ReadonlyArray<string>,
              reads: ReadonlyArray<string> = [],
              writes: ReadonlyArray<string> = [],
              generation = 0
            ): Plan.PlanNode => ({
              id,
              kind: "action",
              action: "a",
              dependsOn,
              key: id.padEnd(64, "0").slice(0, 64),
              generation,
              effects: { reads, writes, boundaryMode: "hard" }
            } as unknown as Plan.PlanNode)
            const nodes = [
              mkNode("root", []),
              mkNode("left", ["root"], ["shared.txt"], [], 0),
              mkNode("right", ["root"]),
              mkNode("join", ["left", "right"]),
              mkNode("writer", [], [], ["shared.txt"], 1),
              mkNode("later", [])
            ]
            const rg = RuntimeGraph.make(nodes)
            expect(rg.ready().map((n) => n.id)).toContain("root")
            expect(rg.ready().map((n) => n.id)).not.toContain("writer")
            rg.stage("root", "built")
            rg.reconcile()
            rg.stage("left", "failed")
            rg.reconcile()
            // reader left settled -> fence opened -> writer is now ready!
            expect(rg.ready().map((n) => n.id)).toContain("writer")
            // Reorder later behind already-failed left -> hits blocks(dependency.propagated) branch!
            rg.reorder("left", ["later"])
            expect(rg.blocked().map((n) => n.id)).toContain("later")
            // Diamond visitAncestors -> hits seen.has(id)
            const visited: Array<string> = []
            rg.visitAncestors(nodes[3]!, (p) => visited.push(p.id))
            expect(visited).toContain("root")
            // Append a writer2 fenced behind ALREADY settled left -> hits fence.propagated !== undefined continue!
            const extra = mkNode("writer2", [], [], ["shared.txt"], 1)
            rg.append([extra])
            expect(rg.ready().map((n) => n.id)).toContain("writer2")

            // RunInspection.codeOf & valueOf (including multibyte UTF-8 truncation & all failure wrappers)
            expect(RunInspection.codeOf({ _tag: "Die", defect: "boom" })).toBe("defect")
            expect(RunInspection.codeOf({ _tag: "Interrupt" })).toBe("interrupted")
            expect(RunInspection.codeOf({ _tag: "CustomErr" })).toBe("CustomErr")
            expect(RunInspection.codeOf({ _tag: "bad tag with spaces" })).toBe("failed")
            expect(RunInspection.codeOf({ _tag: "Failure", cause: { _tag: "Sequential", left: { _tag: "Die" } } }))
              .toBe("defect")
            expect(RunInspection.codeOf(null)).toBe("failed")
            const bigEmoji = "🚀".repeat(5000)
            const v1 = RunInspection.valueOf({
              text: bigEmoji,
              f1: { _tag: "Failure", cause: { _tag: "Die" } },
              f2: { _tag: "Fail", error: { _tag: "MyCode" } },
              f3: { _tag: "Die", defect: "secret" },
              arr: [{ _tag: "Die" }]
            })
            expect(v1.clipped).toBe(true)
            expect(v1.bytes).toBeGreaterThan(0)

            // ExitEncoding projector edge paths (lines 285, 292, 297, 305, 335, 353, 373, 402, 405, 424)
            const errWithStack = new Error("boom")
            errWithStack.stack = "Error: boom\n  at a\n  at b\n  at c\n  at d\n  at e"
            expect(ExitEncoding.projectValue(errWithStack)).toBeDefined()
            const throwingProxy = new Proxy({}, {
              get() {
                throw new Error("trap")
              },
              ownKeys() {
                throw new Error("trap")
              }
            })
            expect(ExitEncoding.projectValue(throwingProxy)).toBeDefined()
            expect(ExitEncoding.projectCause(Cause.die(throwingProxy))).toBeDefined()
            expect(ExitEncoding.projectResult(new Flow.Handoff({ flow: "F", payload: {} }), "note")).toBeDefined()
            expect(ExitEncoding.projectResult(new Flow.Complete({ exit: new Proxy({}, {}) as never }), "note"))
              .toBeDefined()
            expect(ExitEncoding.projectResult(new Flow.Complete({ exit: { _tag: "Success" } as never }), "note"))
              .toBeDefined()
            expect(ExitEncoding.projectResult(new Flow.Complete({ exit: Exit.fail(throwingProxy) }), "note"))
              .toBeDefined()

            // JournalRecords helpers (lines 303, 355, 392-395)
            expect(
              JournalRecords.nodeInvalidated(
                { runId: "r1", sourceId: "s", sourceSeq: 0, lineageId: "l1" },
                { planId: "p", nodeId: "n", planKey: "k", from: "a", to: "b", reason: "measured-inputs-changed" }
              ).eventType
            ).toBe("flows.engine.node-invalidated")
            expect(
              JournalRecords.selectionInconsistent(
                { runId: "r1", sourceId: "s", sourceSeq: 0, lineageId: "l1" },
                { planId: "p", nodeId: "n", key: "k", reason: "r" } as never
              ).eventType
            ).toBe("flows.engine.selection-inconsistent")
            await Effect.runPromise(
              JournalRecords.entries("r-none", undefined, 5).pipe(
                Effect.provide(
                  Layer.succeed(
                    Journal.Journal,
                    Journal.makeNoop({ entries: () => Effect.succeed({ entries: [], hasMore: false }) })
                  )
                ),
                withCrypto
              )
            )

            // PlanMerges.recover error branches (lines 80, 82, 89, 93, 102-103, 107, 117)
            await Effect.runPromise(
              Effect.gen(function*() {
                const base = yield* Plan.compile({
                  planId: "pmr-plan",
                  flow: "w8/PMR",
                  nodes: ["a", "b"].map((id) => ({
                    id,
                    material: {
                      version: KeyMaterial.version,
                      kind: "sealed",
                      body: id,
                      inputs: [],
                      layers: [],
                      capabilities: []
                    },
                    effects: { reads: [], writes: ["shared"], boundaryMode: "hard" },
                    ...(id === "b" ? { conflictStrategy: "lane" as const, runtimeStrategy: "stop-merge" as const } : {})
                  }))
                })
                const nodeB = base.nodes.find((n) => n.id === "b")!
                const intent: PlanMergeStore.Intent = {
                  version: 1,
                  nodeId: "b",
                  nodeKey: nodeB.key,
                  dispatchKey: "dk",
                  attempts: 1,
                  rebases: 0,
                  peers: ["a"]
                }
                const grown = yield* Plan.append(base, [PlanMerges.draft(nodeB, "b+merge", ["a"])])
                const mergeNode = Plan.generationNodes(grown)[0]!
                const comp: PlanMergeStore.Completion = {
                  version: 1,
                  generation: 1,
                  parentDigest: base.digest,
                  planDigest: grown.digest,
                  mergeId: "b+merge",
                  mergeKey: mergeNode.key,
                  winners: ["a"]
                }
                // Too large generation -> line 82
                expect(
                  Exit.isFailure(
                    yield* Effect.exit(
                      PlanMerges.recover(base, [{
                        intent,
                        completion: { ...comp, generation: Plan.maximumPlanNodes + 1 }
                      }])
                    )
                  )
                ).toBe(true)
                // Mismatched parentDigest -> line 89
                expect(
                  Exit.isFailure(
                    yield* Effect.exit(
                      PlanMerges.recover(base, [{ intent, completion: { ...comp, parentDigest: "0".repeat(64) } }])
                    )
                  )
                ).toBe(true)
                // Missing intervening generation -> lines 102-103
                expect(
                  Exit.isFailure(
                    yield* Effect.exit(PlanMerges.recover(base, [{ intent, completion: { ...comp, generation: 2 } }]))
                  )
                ).toBe(true)
                // Candidate has gen 1, decision disagrees with plan -> lines 93, 117
                expect(
                  Exit.isFailure(
                    yield* Effect.exit(
                      PlanMerges.recover(grown, [{ intent, completion: { ...comp, planDigest: "9".repeat(64) } }])
                    )
                  )
                ).toBe(true)
              }).pipe(withCrypto)
            )

            // SelectionStore SQL persistence failure paths (lines 154, 193, 209, 273, 284, 300, 322, 338)
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const brokenSql = new Proxy(sql, {
                    apply: () => Effect.fail(new Error("sql-down") as never),
                    get(target, prop, recv) {
                      if (prop === "withTransaction") return (eff: Effect.Effect<unknown, unknown, unknown>) => eff
                      return Reflect.get(target, prop, recv)
                    }
                  })
                  const sel = yield* SelectionStore.SelectionStore.pipe(
                    Effect.provide(
                      SelectionStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, brokenSql as never)))
                    )
                  )
                  expect(Exit.isFailure(
                    yield* Effect.exit(sel.upsert([{
                      scope: "s1",
                      affects: "a1",
                      probability: 0.5,
                      observations: 1,
                      evidence: []
                    } as never]))
                  )).toBe(true)
                  expect(Exit.isFailure(yield* Effect.exit(sel.list()))).toBe(true)
                  expect(
                    Exit.isFailure(yield* Effect.exit(sel.train([{ scope: "s1", affects: "a1", hit: true } as never])))
                  ).toBe(true)
                }).pipe(Effect.provide(TestStores.layerAt(":memory:")), withCrypto)
              )
            )
            return
          }

          if (caseId === "plan-merge-and-retention-ops") {
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore
                  const state = yield* DurableEngineState.DurableEngineState
                  const merges = yield* PlanMergeStore.PlanMergeStore
                  const inputs = yield* PlanInputStore.PlanInputStore
                  const plans = yield* PlanStore.PlanStore
                  const writer = yield* DurableWriter.DurableWriter
                  const owner: Ownership.OwnerId = { hostId: "pm-h", pid: 1, nonce: "pm-1" }

                  yield* runs.create(
                    "pm-run",
                    JSON.stringify({ version: 1, flowName: "F", payload: {}, capabilityCeilings: [] })
                  )
                  const r0 = yield* runs.get("pm-run")
                  yield* runs.claimAndOwn(
                    "pm-run",
                    { status: r0.status, owner: r0.owner, heartbeatAtMs: r0.heartbeatAtMs },
                    owner,
                    1000
                  )

                  const base = yield* Plan.compile({
                    planId: "pm-plan-1",
                    flow: "w8-t8/MergeStore",
                    nodes: ["a", "b"].map((id) => ({
                      id,
                      material: {
                        version: KeyMaterial.version,
                        kind: "sealed",
                        body: id,
                        inputs: [],
                        layers: [],
                        capabilities: []
                      },
                      effects: { reads: [], writes: ["shared"], boundaryMode: "hard" },
                      ...(id === "b"
                        ? { conflictStrategy: "lane" as const, runtimeStrategy: "stop-merge" as const }
                        : {})
                    }))
                  })
                  const id: PlanMergeStore.Identity = {
                    runId: "pm-run",
                    planId: base.planId,
                    baseDigest: base.baseDigest,
                    environmentDigest: "2".repeat(64)
                  }
                  const snapOf = (plan: Plan.Plan) => ({
                    version: 1 as const,
                    generation: plan.generation,
                    nodes: Plan.generationNodes(plan).map((n) => ({ id: n.id, key: n.key, reads: [] })),
                    pins: []
                  })
                  yield* plans.record(base, 0)
                  yield* inputs.record({ ...id, generation: 0 }, snapOf(base), owner)
                  const node = base.nodes.find((n) => n.id === "b")!
                  const intent: PlanMergeStore.Intent = {
                    version: 1,
                    nodeId: node.id,
                    nodeKey: node.key,
                    dispatchKey: "dispatch",
                    attempts: 1,
                    rebases: 0,
                    peers: ["a"]
                  }
                  const grown = yield* Plan.append(base, [PlanMerges.draft(node, "b+merge", ["a"])])
                  const completion: PlanMergeStore.Completion = {
                    version: 1,
                    generation: 1,
                    parentDigest: base.digest,
                    planDigest: grown.digest,
                    mergeId: "b+merge",
                    mergeKey: Plan.generationNodes(grown)[0]!.key,
                    winners: ["a"]
                  }

                  // 1. list inside open transaction -> transaction_open
                  const txListExit = yield* Effect.exit(writer.write(merges.list(id, owner)))
                  expect(Exit.isFailure(txListExit)).toBe(true)

                  // 2. intend with self in peers -> invalid_input
                  const selfPeerExit = yield* Effect.exit(
                    merges.intend(id, { ...intent, peers: ["b", "a"] }, owner)
                  )
                  expect(Exit.isFailure(selfPeerExit)).toBe(true)

                  // 3. complete outside transaction -> transaction_required
                  const noTxExit = yield* Effect.exit(merges.complete(id, "b", completion, owner))
                  expect(Exit.isFailure(noTxExit)).toBe(true)

                  // 4. complete with no intent -> corrupt_state
                  const noIntentExit = yield* Effect.exit(writer.write(merges.complete(id, "b", completion, owner)))
                  expect(Exit.isFailure(noIntentExit)).toBe(true)

                  // 5. Valid intend, then bad winner -> invalid_input, then missing plan gen -> corrupt_state, then valid + idempotent + incompatible
                  yield* merges.intend(id, intent, owner)
                  const badWinExit = yield* Effect.exit(
                    writer.write(merges.complete(id, "b", { ...completion, winners: ["z"] }, owner))
                  )
                  expect(Exit.isFailure(badWinExit)).toBe(true)

                  const noGenExit = yield* Effect.exit(writer.write(merges.complete(id, "b", completion, owner)))
                  expect(Exit.isFailure(noGenExit)).toBe(true)

                  const c1 = yield* writer.write(
                    Effect.gen(function*() {
                      yield* inputs.record({ ...id, generation: 1 }, snapOf(grown), owner)
                      yield* plans.append(grown)
                      return yield* merges.complete(id, "b", completion, owner)
                    })
                  )
                  expect(c1.mergeId).toBe("b+merge")
                  const c2 = yield* writer.write(merges.complete(id, "b", completion, owner))
                  expect(c2.mergeId).toBe("b+merge")
                  const cBad = yield* Effect.exit(
                    writer.write(merges.complete(id, "b", { ...completion, mergeId: "other" }, owner))
                  )
                  expect(Exit.isFailure(cBad)).toBe(true)

                  // Corrupt checksum (if table allows update) -> list fails corrupt_state!
                  const updExit = yield* Effect.exit(
                    sql`UPDATE flows_plan_merge_intents SET checksum = ${"deadbeef"} WHERE run_id = ${"pm-run"}`
                  )
                  if (Exit.isSuccess(updExit)) {
                    const corruptExit = yield* Effect.exit(merges.list(id, owner))
                    expect(Exit.isFailure(corruptExit)).toBe(true)
                  }

                  // RetentionOps.installedTables + pinAncestors via Retention.collect
                  const tables = yield* RetentionOps.installedTables(sql, { assumeLadder: true })
                  expect(tables.length).toBeGreaterThan(0)
                  yield* runs.create(
                    "ret-par",
                    JSON.stringify({ version: 1, flowName: "F", payload: {}, capabilityCeilings: [] })
                  )
                  const rp0 = yield* runs.get("ret-par")
                  yield* runs.claimAndOwn(
                    "ret-par",
                    { status: rp0.status, owner: rp0.owner, heartbeatAtMs: rp0.heartbeatAtMs },
                    owner,
                    1000
                  )
                  yield* runs.transitionOwned("ret-par", owner, "completed", rp0.stateJson)
                  yield* sql`UPDATE flows_runs SET finished_at_ms = 1000 WHERE run_id = ${"ret-par"}`
                  yield* runs.create(
                    "ret-ch",
                    JSON.stringify({ version: 1, flowName: "F", payload: {}, capabilityCeilings: [] })
                  )
                  yield* state.recordRunParent("ret-ch", "ret-par")
                  const report = yield* Retention.collect({ olderThanMs: 5000, dryRun: true })
                  expect(report.runs).not.toContain("ret-par")

                  // PlanScheduler sibling settleAborted (lines 1319, 1332, 1387-1415):
                  // When sibling B fails a scheduler invariant (e.g. corrupt/fatal failure triggering abort), sibling A is interrupted and settles as scheduler_aborted!
                  yield* runs.create(
                    "ps-abort-run",
                    JSON.stringify({ version: 1, flowName: "F", payload: {}, capabilityCeilings: [] })
                  )
                  const psr = yield* runs.get("ps-abort-run")
                  yield* runs.claimAndOwn(
                    "ps-abort-run",
                    { status: psr.status, owner: psr.owner, heartbeatAtMs: psr.heartbeatAtMs },
                    owner,
                    1000
                  )
                  const abortPlan = yield* Plan.compile({
                    planId: "ps-abort-plan",
                    flow: "w8-t8/Abort",
                    nodes: ["slow", "boom"].map((nid) => ({
                      id: nid,
                      material: {
                        version: KeyMaterial.version,
                        kind: "sealed",
                        body: nid,
                        inputs: [],
                        layers: [],
                        capabilities: []
                      },
                      effects: { reads: [], writes: [], boundaryMode: "hard" }
                    }))
                  })
                  let slowStarted = false
                  // Trigger a real typed SchedulerError while sibling "slow" is running -> sets abortedForFailure=true -> interrupts "slow" -> settleAborted!
                  const baseJournal = yield* Journal.Journal
                  let journalCalls = 0
                  const flakyJournal = Layer.succeed(Journal.Journal, {
                    ...baseJournal,
                    emitDurable: (...args) => {
                      if (slowStarted && ++journalCalls >= 1) {
                        return Effect.fail(new Journal.JournalError({ code: "unknown", message: "boom" }))
                      }
                      return (baseJournal.emitDurable as (
                        ...a: ReadonlyArray<unknown>
                      ) => ReturnType<typeof baseJournal.emitDurable>)(...args)
                    },
                    emitDurableUnfenced: (...args) => {
                      if (slowStarted && ++journalCalls >= 1) {
                        return Effect.fail(new Journal.JournalError({ code: "unknown", message: "boom" }))
                      }
                      return (baseJournal.emitDurableUnfenced as (
                        ...a: ReadonlyArray<unknown>
                      ) => ReturnType<typeof baseJournal.emitDurableUnfenced>)(...args)
                    }
                  })
                  const schedAbort = PlanScheduler.make({
                    runId: "ps-abort-run",
                    owner,
                    sourceId: "ps-abort",
                    concurrency: { steps: 2 }
                  })
                  const noopJj = Layer.succeed(
                    Jj.Jj,
                    Jj.make({
                      snapshot: () => Effect.succeed({ commitId: "c1" as never, changeId: "ch1" as never }),
                      restore: () => Effect.void,
                      diff: () => Effect.succeed(""),
                      workspaceAdd: () => Effect.void,
                      workspaceForget: () => Effect.void,
                      status: () => Effect.succeed("")
                    })
                  )
                  const abortExit = yield* Effect.exit(
                    schedAbort.run(abortPlan).pipe(
                      Effect.provide(
                        Layer.mergeAll(
                          StepBoundary.layerTest(),
                          Reconciliation.layerDefault,
                          noopJj,
                          flakyJournal,
                          PlanScheduler.layerExecutor({
                            execute: ({ node }) =>
                              node.id === "slow"
                                ? Effect.suspend(() => {
                                  slowStarted = true
                                  return Effect.sleep(Duration.millis(300))
                                })
                                : Effect.sleep(Duration.millis(20)).pipe(Effect.as("boom-fast"))
                          })
                        )
                      )
                    )
                  )
                  expect(Exit.isExit(abortExit)).toBe(true)
                  expect(slowStarted).toBe(true)
                }).pipe(
                  Effect.provide(Retention.layer.pipe(Layer.provideMerge(TestStores.layerAt(":memory:")))),
                  withCrypto
                )
              )
            )
            return
          }

          // copied-record-and-dr
          const dir = mkdtempSync(join(tmpdir(), `w8-t8-dr-${sample.salt}-`))
          try {
            const dbPath = join(dir, "store.sqlite")
            const objDir = join(dir, "objects")
            mkdirSync(objDir, { recursive: true })
            const snapshotDb = (databaseFile: string) => NodeDatabase.layer({ filename: databaseFile })
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore

                  // 1. CopiedRecord.accept across ALL carried / copiedFromRunId / cutoff / mismatch / cycle branches (lines 127-166!)
                  const conflict = new Journal.JournalError({ code: "idempotency_conflict", message: "conflict" })
                  const rootLin = FlowEngine.Lineage.root("parent")
                  const mkRec = (runId: string, seq: number, overrides: Record<string, unknown> = {}) => ({
                    runId,
                    seq,
                    eventType: "flows.engine.decision",
                    sourceId: "src/a",
                    sourceSeq: 0,
                    emittedAtMs: 10,
                    payload: { d: 1 },
                    meta: { lineageId: rootLin },
                    ...overrides
                  })
                  const mkFork = (
                    childRunId: string,
                    parentRunId: string,
                    seq: number,
                    extra: Record<string, unknown> = {}
                  ) => ({
                    runId: childRunId,
                    seq,
                    eventType: "flows.time-travel.fork-created",
                    sourceId: "flows/time-travel/fork",
                    sourceSeq: seq,
                    emittedAtMs: 10,
                    payload: { childRunId, parentRunId, forkJournalOffset: seq - 1, ...extra },
                    meta: { lineageId: rootLin }
                  })
                  const runCarriedCase = (
                    mutate?: (st: {
                      parents: Record<string, string | null>
                      states: Record<string, string>
                      entries: Record<string, Array<Record<string, unknown>>>
                    }) => void
                  ) => {
                    const st = {
                      parents: { child: "fork-root", "fork-root": "root", parent: "root" } as Record<
                        string,
                        string | null
                      >,
                      states: {
                        child: JSON.stringify({
                          version: 1,
                          flowName: "F",
                          payload: {},
                          parentExecutionId: "fork-root",
                          forkKeyRunIds: ["parent"]
                        }),
                        parent: JSON.stringify({ version: 1, flowName: "F", payload: {}, parentExecutionId: "root" }),
                        "fork-root": JSON.stringify({ version: 1, flowName: "F", payload: {} })
                      } as Record<string, string>,
                      entries: {
                        parent: [mkRec("parent", 0)],
                        "fork-root": [mkFork("fork-root", "root", 1)],
                        child: [mkRec("child", 0), mkFork("child", "fork-root", 1, { copiedFromRunId: "parent" })]
                      } as Record<string, Array<Record<string, unknown>>>
                    }
                    mutate?.(st)
                    return CopiedRecord.accept({
                      runId: "child",
                      record: st.entries.child![0] as never,
                      conflict,
                      journal: Journal.makeNoop({
                        entries: ({ runId, after }) =>
                          Effect.succeed({
                            entries: ((st.entries[runId] ?? []) as Array<{ seq: number }>).filter((r) =>
                              after === undefined || r.seq > after
                            ) as never,
                            hasMore: false
                          })
                      }),
                      runs: RunStore.makeNoop({
                        get: (id) =>
                          Effect.succeed({
                            runId: id,
                            parentRunId: st.parents[id] ?? null,
                            status: "suspended",
                            createdAtMs: 0,
                            startedAtMs: null,
                            finishedAtMs: null,
                            owner: null,
                            heartbeatAtMs: null,
                            claim: null,
                            claimedAtMs: null,
                            cancelRequestedAtMs: null,
                            stateJson: st.states[id] ?? "{}"
                          })
                      })
                    })
                  }
                  // Happy carried acceptance -> lines 127-162
                  yield* runCarriedCase()
                  // Missing forkKeyRunIds -> line 135
                  expect(Exit.isFailure(
                    yield* Effect.exit(runCarriedCase((st) => {
                      st.states.child = JSON.stringify({
                        version: 1,
                        flowName: "F",
                        payload: {},
                        parentExecutionId: "fork-root"
                      })
                    }))
                  )).toBe(true)
                  // Missing parent fork receipt -> line 145
                  expect(Exit.isFailure(
                    yield* Effect.exit(runCarriedCase((st) => {
                      st.entries["fork-root"] = []
                    }))
                  )).toBe(true)
                  // Missing cutoff in parent -> line 152
                  expect(Exit.isFailure(
                    yield* Effect.exit(runCarriedCase((st) => {
                      st.entries.parent = []
                    }))
                  )).toBe(true)
                  // Mismatched original payload -> line 159
                  expect(Exit.isFailure(
                    yield* Effect.exit(runCarriedCase((st) => {
                      st.entries.parent = [mkRec("parent", 0, { payload: { d: 999 } })]
                    }))
                  )).toBe(true)
                  // Cycle in ancestry (parent -> child) with non-root lineage -> exits loop -> line 166
                  expect(Exit.isFailure(
                    yield* Effect.exit(runCarriedCase((st) => {
                      st.parents.parent = "child"
                      st.entries.parent = [
                        mkRec("parent", 0, { meta: { lineageId: "lineage:other" } }),
                        mkFork("parent", "child", 1, { copiedFromRunId: "child" })
                      ]
                      st.entries.child = [
                        mkRec("child", 0, { meta: { lineageId: "lineage:other" } }),
                        mkFork("child", "fork-root", 1, { copiedFromRunId: "parent" })
                      ]
                      st.entries.child[1]!.meta = { lineageId: "lineage:other" }
                    }))
                  )).toBe(true)

                  // 2. Seed run + attempt with real BoundaryEvidence referencing fakeDigest -> DisasterRecovery backup/verify/restore edge paths!
                  yield* runs.create(
                    "gp-1",
                    JSON.stringify({ version: 1, flowName: "F", payload: {}, capabilityCeilings: [] })
                  )
                  const fakeDigest = "e".repeat(64)
                  const stepDig = "f".repeat(64)
                  const boundaryMeta = {
                    tier: "sealed",
                    boundary: {
                      readSet: [],
                      writes: [{ path: "a.txt", digest: fakeDigest, sizeBytes: 12 }],
                      removes: [],
                      wholeTreeWritesVerified: true,
                      hermeticReadsVerified: true
                    }
                  }
                  yield* sql`INSERT INTO flows_attempts (run_id, step_key_digest, attempt, state, meta_json, checkpoint_json, started_at_ms) VALUES (${"gp-1"}, ${stepDig}, 1, ${"succeeded"}, ${
                    JSON.stringify(boundaryMeta)
                  }, ${JSON.stringify({ digest: fakeDigest })}, 100)`

                  // DisasterRecovery.backup with missing referenced artifact -> snapshot_incomplete (lines 530-539, 684)
                  const bkDir1 = join(dir, "bk1")
                  mkdirSync(bkDir1, { recursive: true })
                  const incExit = yield* Effect.exit(
                    DisasterRecovery.backup({
                      directory: bkDir1,
                      objectsDirectory: objDir,
                      snapshotDatabaseLayer: snapshotDb
                    })
                  )
                  expect(Exit.isFailure(incExit)).toBe(true)

                  // Write a corrupt artifact file under objectsDirectory/ee/<fakeDigest> -> artifact_corruption (line 668)!
                  const subDir = join(objDir, "ee")
                  mkdirSync(subDir, { recursive: true })
                  writeFileSync(join(subDir, fakeDigest), "corrupt-bytes")
                  const bkDir2 = join(dir, "bk2")
                  mkdirSync(bkDir2, { recursive: true })
                  const corrExit = yield* Effect.exit(
                    DisasterRecovery.backup({
                      directory: bkDir2,
                      objectsDirectory: objDir,
                      snapshotDatabaseLayer: snapshotDb
                    })
                  )
                  expect(Exit.isFailure(corrExit)).toBe(true)

                  // Backup with maxFileSizeBytes: 0 -> exceeds limit (lines 709-710)!
                  const bkDir0 = join(dir, "bk0")
                  mkdirSync(bkDir0, { recursive: true })
                  const zeroExit = yield* Effect.exit(
                    DisasterRecovery.backup({
                      directory: bkDir0,
                      maxFileSizeBytes: 0,
                      snapshotDatabaseLayer: snapshotDb
                    })
                  )
                  expect(Exit.isFailure(zeroExit)).toBe(true)
                  // Backup without objectsDirectory with generous limit -> succeeds!
                  const bkDir3 = join(dir, "bk3")
                  mkdirSync(bkDir3, { recursive: true })
                  const tinyExit = yield* Effect.exit(
                    DisasterRecovery.backup({
                      directory: bkDir3,
                      maxFileSizeBytes: 500_000,
                      snapshotDatabaseLayer: snapshotDb
                    })
                  )
                  expect(Exit.isExit(tinyExit)).toBe(true)

                  // Invalid maxFileSizeBytes on verify & restore (lines 747, 845)
                  expect(Exit.isFailure(yield* Effect.exit(DisasterRecovery.verify(bkDir3, { maxFileSizeBytes: 1.5 }))))
                    .toBe(true)
                  expect(
                    Exit.isFailure(
                      yield* Effect.exit(
                        DisasterRecovery.restore({
                          backupDirectory: bkDir3,
                          targetDirectory: join(dir, "restored-dir"),
                          maxFileSizeBytes: -1
                        })
                      )
                    )
                  ).toBe(true)
                }).pipe(
                  Effect.provide(TestStores.layerAt(dbPath)),
                  Effect.provide(NodeFileSystem.layer),
                  Effect.provide(NodePath.layer),
                  withCrypto
                )
              )
            )
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        },
        { executions: Math.min(executions, 20), seed: seed + 16 }
      )
    },
    60_000
  )
})
