/**
 * Issue #107: neither call site of `boundary.replayOutputs` caught its
 * failure, so unreplayable boundary evidence on a verified cache hit — or on
 * a succeeded-attempt replay — failed the dispatch while the row survived,
 * repeating the refuse→fail cycle forever (the exact permanent-failure loop
 * issue #99 fixed, one branch earlier). The failure was reachable in
 * practice because the production `replayOutputs` wrote outputs without
 * creating parent directories, so any output inside a directory the original
 * body created died ENOENT on a fresh workspace.
 *
 * A transient host or materialization failure is a retryable host
 * condition, never a permanent run failure: the cache-hit path falls back to
 * a real execution, the succeeded-attempt path returns the durable outcome
 * with the refusal journalled, and the production layer mkdirs parents
 * before materializing. Integrity failures are not covered here: under the
 * strict default a corrupt cache hit fails with `CacheCorruptionDetected` and
 * corrupt succeeded-attempt evidence is quarantined with
 * `AttemptEvidenceQuarantined`; see ReplayCorruptionClassification.test.ts.
 */
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

/**
 * The production boundary now needs an `ArtifactStore` as well as a
 * `FileSystem`: blob mechanics moved to `@smthrs/artifacts`.
 */
const hostLayer = (fs: FileSystem.FileSystem) =>
  ArtifactStore.layerFileSystem().pipe(Layer.provideMerge(Layer.succeed(FileSystem.FileSystem)(fs)))
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "replay-fallback-host", pid: 51, nonce: "replay-fallback-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["dist/manifest.json"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "replay-fallback-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const dispatch = (runId: string, key: string, execute: () => Effect.Effect<unknown, unknown>) =>
  ActionPersistence.make({ runId, owner, sourceId: `replay-fallback-${runId}`, execute })({
    action: {},
    attempt: 1,
    key,
    tier: "sealed",
    metadata: declared
  })

/** A boundary that verifies the read set but cannot materialize outputs. */
const unreplayable = (options: { readonly onPrepare?: () => void } = {}) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) =>
        Effect.sync(() => {
          options.onPrepare?.()
          return { descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }
        }),
      settle: () =>
        Effect.succeed({
          declaredOutputs: { outputs: [] },
          diffIdentity: "replay-fallback-diff",
          wholeTreeWritesVerified: true,
          hermeticReadsVerified: true
        }),
      replayOutputs: () =>
        Effect.fail(
          new StepBoundary.UnsupportedBoundary({
            code: "unsupported_boundary",
            message: "the recorded boundary evidence carries no materializable outputs"
          })
        )
    })
  )

const provenance = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 50 })
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.cache-provenance")
      .map((entry) => entry.payload as { readonly action?: string })
  })

describe("unreplayable evidence on a verified cache hit (issue #107)", () => {
  it.effect("falls back to a real execution instead of failing every run forever", () =>
    Effect.gen(function*() {
      const key = "replay-fallback/cache-hit"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          let executions = 0
          const body = () =>
            Effect.sync(() => {
              executions++
              return "recorded"
            })
          yield* activate("replay-fallback-first")
          yield* dispatch("replay-fallback-first", key, body).pipe(Effect.provide(unreplayable()))
          // Runs 2 and 3: the hit verifies, materialization fails — each run
          // must re-execute for real rather than fail, and keep succeeding.
          yield* activate("replay-fallback-second")
          const second = yield* dispatch("replay-fallback-second", key, body).pipe(Effect.provide(unreplayable()))
          yield* activate("replay-fallback-third")
          const third = yield* dispatch("replay-fallback-third", key, body).pipe(Effect.provide(unreplayable()))
          const records = yield* provenance("replay-fallback-second")
          return { executions, second, third, records }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.second).toBe("recorded")
      expect(outcome.third).toBe("recorded")
      expect(outcome.executions).toBe(3)
      // The refusal is visible, not silent.
      expect(outcome.records.map((record) => record.action)).toContain("replay_failed")
    }))

  it.effect("returns the durable outcome when a succeeded attempt's evidence cannot re-materialize", () =>
    Effect.gen(function*() {
      const key = "replay-fallback/succeeded-row"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("replay-fallback-row")
          yield* dispatch("replay-fallback-row", key, () => Effect.succeed("durable-outcome")).pipe(
            Effect.provide(unreplayable())
          )
          // The cache row is evicted so the re-dispatch reaches the succeeded
          // attempt row's replay branch rather than the cache-hit gate.
          yield* cache.evict(sha256(key))
          const replayed = yield* dispatch("replay-fallback-row", key, () => Effect.die("must not re-execute")).pipe(
            Effect.provide(unreplayable())
          )
          const records = yield* provenance("replay-fallback-row")
          return { replayed, records }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // The attempt durably succeeded: its outcome is the truth, and failing
      // the run over a best-effort materialization recreated the #99 loop.
      expect(outcome.replayed).toBe("durable-outcome")
      expect(outcome.records.map((record) => record.action)).toContain("replay_failed")
    }))
})

describe("the production replayOutputs creates parent directories (issue #107)", () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  /**
   * A filesystem with Node semantics: `writeFile` fails ENOENT unless the
   * parent directory exists; `makeDirectory` creates it. The in-memory Map
   * filesystems used elsewhere accept any path, which is exactly how the
   * missing-mkdir defect stayed invisible.
   */
  const nodeLikeFs = (seed: Record<string, string>) => {
    const files = new Map<string, Uint8Array>(
      Object.entries(seed).map(([path, content]) => [path, encoder.encode(content)])
    )
    const directories = new Set<string>([""])
    const parent = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
    const fs = FileSystem.makeNoop({
      exists: ((path: string) => Effect.succeed(files.has(path))) as never,
      readFile: ((path: string) =>
        files.has(path)
          ? Effect.succeed(files.get(path)!)
          : Effect.fail(new Error(`ENOENT: ${path}`))) as never,
      makeDirectory: ((path: string) =>
        Effect.sync(() => {
          const segments = path.split("/")
          for (let index = 1; index <= segments.length; index++) {
            directories.add(segments.slice(0, index).join("/"))
          }
        })) as never,
      writeFile: ((path: string, bytes: Uint8Array) =>
        directories.has(parent(path))
          ? Effect.sync(() => {
            files.set(path, bytes)
          })
          : Effect.fail(new Error(`ENOENT: no such directory ${parent(path)}`))) as never,
      remove: ((path: string) =>
        Effect.sync(() => {
          files.delete(path)
        })) as never
    })
    return { files, layer: StepBoundary.layer.pipe(Layer.provide(hostLayer(fs))) }
  }

  it.effect("materializes an output whose parent directory the original body created", () =>
    Effect.gen(function*() {
      // The producer's body mkdirs dist/ itself; the evidence must replay on
      // a fresh clone that has no dist/ directory.
      const producer = nodeLikeFs({ "input.txt": "original" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            readSet: [{ path: "input.txt", digest: sha256("original") }],
            writeSet: ["dist/manifest.json"],
            boundaryMode: "hard"
          })
          producer.files.set("dist/manifest.json", encoder.encode("{\"artifact\":true}"))
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(producer.layer))
      )

      const fresh = nodeLikeFs({})
      yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          yield* boundary.replayOutputs(evidence)
        }).pipe(Effect.provide(fresh.layer))
      )
      expect(decoder.decode(fresh.files.get("dist/manifest.json"))).toBe("{\"artifact\":true}")
    }))
})
