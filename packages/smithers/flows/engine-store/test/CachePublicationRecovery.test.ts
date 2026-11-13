import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Journal } from "@smthrs/journal"
import { AttemptStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ArtifactSync from "../src/ArtifactSync.ts"
import * as CacheSync from "../src/CacheSync.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, descriptor, evidence, jj, owner } from "./CachePolicyFixtures.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const bytes = new TextEncoder().encode("durable artifact")
const digest = sha256(bytes)
const recorded = { ...evidence, declaredOutputs: { outputs: [{ path: "artifact", digest, sizeBytes: bytes.length }] } }
const boundary = Layer.succeed(
  StepBoundary.StepBoundary,
  StepBoundary.make({
    prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: [] }),
    settle: () => Effect.succeed(recorded),
    replayOutputs: () => Effect.void
  })
)
const dispatch = (execute: ActionPersistence.Dependencies["execute"]) =>
  ActionPersistence.make({ runId: "publication", owner, sourceId: "publication", execute })({
    action: {},
    attempt: 1,
    key: "publication",
    tier: "sealed",
    metadata: { ...descriptor, writeSet: ["artifact"] }
  })

describe("artifact and entry publication frontiers", () => {
  it("reopens a published attempt without repeating publication or its write transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "cache-publication-replay-"))
    const db = join(root, "engine.sqlite")
    const local = ArtifactStore.makeMemory()
    const remote = ArtifactStore.makeMemory()
    const counts = { artifacts: 0, entries: 0, puts: 0, transactions: 0, bodies: 0 }
    const sync = ArtifactSync.make({ local, remote })
    const entries = CacheSync.makeLocal()
    let original: Option.Option<CacheStore.CacheEntry> = Option.none()
    try {
      for (let drive = 0; drive < 3; drive++) {
        await Effect.runPromise(withCrypto(
          Effect.gen(function*() {
            const cache = yield* CacheStore.CacheStore
            const journal = yield* Journal.Journal
            if (drive === 0) {
              yield* activate("publication")
              yield* local.put(bytes)
            } else {
              yield* journal.recall!("publication" as never)
            }
            const before = { ...counts }
            let reads = 0
            const result = yield* dispatch(() =>
              Effect.sync(() => {
                counts.bodies++
                return "settled"
              })
            ).pipe(
              Effect.provideService(ArtifactSync.ArtifactSync, {
                ...sync,
                publish: (digests) =>
                  Effect.suspend(() => {
                    counts.artifacts++
                    return sync.publish(digests)
                  })
              }),
              Effect.provideService(CacheSync.CacheSync, {
                publishEntry: (entry) =>
                  Effect.suspend(() => {
                    counts.entries++
                    return entries.publishEntry(entry)
                  })
              }),
              Effect.provideService(CacheStore.CacheStore, {
                ...cache,
                get: (key, options) =>
                  Effect.suspend(() => {
                    reads++
                    return cache.get(key, options)
                  }),
                put: (entry) =>
                  Effect.suspend(() => {
                    counts.puts++
                    return cache.put(entry)
                  })
              }),
              Effect.provideService(Journal.Journal, {
                ...journal,
                transact: (effect) =>
                  Effect.suspend(() => {
                    counts.transactions++
                    return journal.transact(effect)
                  })
              })
            )
            expect(result).toBe("settled")
            expect(reads).toBe(1)
            const head = yield* cache.get(sha256("publication"))
            if (drive === 0) {
              original = head
              expect(Option.isSome(head)).toBe(true)
              expect(counts).toMatchObject({ artifacts: 1, entries: 1, puts: 1, bodies: 1 })
              expect(counts.transactions).toBeGreaterThan(0)
            } else {
              expect(counts).toEqual(before)
              expect(head).toEqual(original)
            }
            expect(yield* remote.findMissing([digest])).toEqual([])
          }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(db), jj, boundary)), Effect.scoped)
        ))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  for (const head of ["missing", "foreign", "different-result", "different-meta"] as const) {
    it.effect(`still converges or reports divergence for a ${head} cache head`, () =>
      withCrypto(
        Effect.gen(function*() {
          yield* activate("publication")
          const cache = yield* CacheStore.CacheStore
          yield* dispatch(() => Effect.succeed("settled"))
          const original = Option.getOrThrow(yield* cache.get(sha256("publication")))
          yield* cache.evict(original.keyDigest)
          if (head !== "missing") {
            yield* cache.put({
              ...original,
              recordedRunId: head === "foreign" ? "another-run" : original.recordedRunId,
              recordedEventSeq: original.recordedEventSeq + 1,
              result: head === "different-result" ? "divergent" : original.result,
              meta: head === "different-meta" ? { ...original.meta as object, diff: "divergent" } : original.meta
            })
          }
          const before = yield* cache.get(original.keyDigest)
          let puts = 0
          const result = yield* dispatch(() => Effect.die("body repeated")).pipe(
            Effect.provideService(CacheStore.CacheStore, {
              ...cache,
              put: (entry) =>
                Effect.suspend(() => {
                  puts++
                  return cache.put(entry)
                })
            }),
            Effect.exit
          )
          expect(puts).toBe(1)
          if (head === "different-result") {
            expect(result).toMatchObject({
              _tag: "Failure",
              cause: {
                reasons: [{
                  _tag: "Fail",
                  error: {
                    _tag: "@smthrs/engine-store/CacheConflictDetected",
                    code: "cache_conflict_detected",
                    keyDigest: original.keyDigest,
                    recordedRunId: "publication"
                  }
                }]
              }
            })
          } else {
            expect(result).toEqual(Exit.succeed("settled"))
          }
          expect(yield* cache.get(original.keyDigest)).toEqual(head === "missing" ? Option.some(original) : before)
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jj, boundary)), Effect.scoped)
      ))
  }

  for (
    const fault of [
      "terminal-before-artifacts",
      "artifacts-before-local",
      "local-before-remote",
      "remote-failure",
      "artifact-failure",
      "local-failure"
    ] as const
  ) {
    it(`reopens after ${fault}, preserving success and artifact ordering`, async () => {
      const root = mkdtempSync(join(tmpdir(), "cache-publication-"))
      const db = join(root, "engine.sqlite")
      const local = ArtifactStore.makeMemory()
      const remote = ArtifactStore.makeMemory()
      const advertised: Array<CacheStore.CacheEntry> = []
      let bodies = 0
      const body = () =>
        Effect.sync(() => {
          bodies++
          return "settled"
        })
      let fail = true
      try {
        const drive = (first: boolean) =>
          Effect.gen(function*() {
            const cache = yield* CacheStore.CacheStore
            const attempts = yield* AttemptStore.AttemptStore
            const journal = yield* Journal.Journal
            if (first) {
              yield* local.put(bytes)
              yield* activate("publication")
            }
            const sync = ArtifactSync.make({
              local,
              remote: {
                ...remote,
                put: (value) =>
                  fail && fault === "artifact-failure"
                    ? Effect.fail(
                      new ArtifactStore.ArtifactStoreError({
                        code: "transport_failed",
                        message: "injected upload refusal"
                      })
                    )
                    : remote.put(value)
              }
            })
            const result = yield* dispatch(body).pipe(
              Effect.provideService(ArtifactSync.ArtifactSync, {
                ...sync,
                publish: (digests) =>
                  Effect.gen(function*() {
                    // Every optional publication begins after terminal success.
                    const row = Option.getOrThrow(
                      yield* attempts.get({ runId: "publication", stepKeyDigest: sha256("publication"), attempt: 1 })
                        .pipe(Effect.orDie)
                    )
                    expect(row.state).toBe("succeeded")
                    expect(row.outcome).toBe("settled")
                    if (fail && fault === "terminal-before-artifacts") return yield* Effect.die("injected crash")
                    yield* sync.publish(digests)
                    if (fail && fault === "artifacts-before-local") return yield* Effect.die("injected crash")
                  })
              }),
              Effect.provideService(CacheStore.CacheStore, {
                ...cache,
                put: (entry) =>
                  fail && fault === "local-failure"
                    ? Effect.fail(
                      new CacheStore.CacheStoreError({
                        code: "persistence_failed",
                        message: "injected local row failure"
                      })
                    )
                    : cache.put(entry)
              }),
              Effect.provideService(CacheSync.CacheSync, {
                publishEntry: (entry) =>
                  Effect.gen(function*() {
                    expect(yield* remote.findMissing([digest])).toEqual([])
                    expect(Option.isSome(yield* cache.get(entry.keyDigest))).toBe(true)
                    if (fail && fault === "local-before-remote") return yield* Effect.die("injected crash")
                    if (fail && fault === "remote-failure") {
                      return Option.some(
                        new CacheStore.CacheStoreError({
                          code: "persistence_failed",
                          message: "injected remote refusal"
                        })
                      )
                    }
                    advertised.push(entry)
                    return Option.none()
                  })
              }),
              Effect.exit
            )
            const terminal = Option.getOrThrow(
              yield* attempts.get({ runId: "publication", stepKeyDigest: sha256("publication"), attempt: 1 })
            )
            expect(terminal.state).toBe("succeeded")
            expect(terminal.outcome).toBe("settled")
            if (first) {
              const crash = fault === "terminal-before-artifacts" || fault === "artifacts-before-local" ||
                fault === "local-before-remote"
              expect(Exit.isFailure(result)).toBe(crash)
              if (!crash) expect(result).toEqual(Exit.succeed("settled"))
              const hasRow = fault === "local-before-remote" || fault === "remote-failure" ||
                fault === "artifact-failure"
              expect(Option.isSome(yield* cache.get(sha256("publication")))).toBe(hasRow)
              expect(advertised).toEqual([])
              const page = yield* journal.entries({ runId: "publication" as never, limit: 50 })
              const publications = page.entries.filter((entry) =>
                (entry.payload as { action?: string }).action === "recorded"
              )
              expect(publications.length).toBe(hasRow ? 1 : 0)
              if (!crash) {
                expect(page.entries.some((entry) => (entry.payload as { action?: string }).action === "unpublished"))
                  .toBe(true)
              }
            } else {
              expect(result).toEqual(Exit.succeed("settled"))
              expect(Option.isSome(yield* cache.get(sha256("publication")))).toBe(true)
            }
          })
        await Effect.runPromise(
          withCrypto(
            drive(true).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(db), jj, boundary)), Effect.scoped)
          )
        )
        fail = false
        await Effect.runPromise(
          withCrypto(
            drive(false).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(db), jj, boundary)), Effect.scoped)
          )
        )
        expect(bodies).toBe(1)
        // Before-row crashes converge the cache from the independently reopened terminal row.
        if (fault === "terminal-before-artifacts" || fault === "artifacts-before-local" || fault === "local-failure") {
          expect(advertised).toHaveLength(1)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it.effect("an unavailable cache lookup or local publication cannot erase durable success", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("publication")
        const cache = yield* CacheStore.CacheStore
        expect(yield* dispatch(() => Effect.succeed("settled"))).toBe("settled")
        const broken = new CacheStore.CacheStoreError({ code: "persistence_failed", message: "cache unavailable" })
        expect(
          yield* dispatch(() => Effect.die("body repeated")).pipe(Effect.provideService(CacheStore.CacheStore, {
            ...cache,
            get: () => Effect.fail(broken),
            put: () => Effect.fail(broken)
          }))
        ).toBe("settled")
      }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jj, boundary)), Effect.scoped)
    ))

  it.effect("a transient host refusal preserves a legacy completion without a finish timestamp", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("publication")
        const cache = yield* CacheStore.CacheStore
        const attempts = yield* AttemptStore.AttemptStore
        const journal = yield* Journal.Journal
        const sql = yield* SqlClient.SqlClient
        const host = yield* StepBoundary.StepBoundary
        const meta = { tier: "sealed", boundary: recorded, readSetVerified: true }
        yield* sql`INSERT INTO flows_attempts
          (run_id, step_key_digest, attempt, state, started_at_ms, outcome_json, meta_json)
          VALUES ('publication', ${sha256("publication")}, 1, 'succeeded', 0, '"settled"', ${JSON.stringify(meta)})`
        const id = { runId: "publication", stepKeyDigest: sha256("publication"), attempt: 1 }
        const before = yield* attempts.get(id)
        yield* TestClock.adjust("2000 millis")
        const originalCause = new Error("temporary host failure")
        let replays = 0
        expect(
          yield* dispatch(() => Effect.die("body repeated")).pipe(
            Effect.provideService(
              StepBoundary.StepBoundary,
              StepBoundary.make({
                ...host,
                replayOutputs: () =>
                  Effect.suspend(() => {
                    replays++
                    return Effect.fail(
                      new StepBoundary.UnsupportedBoundary({
                        code: "unsupported_boundary",
                        message: "temporary host refusal",
                        cause: originalCause
                      })
                    )
                  })
              })
            )
          )
        ).toBe("settled")
        expect(replays).toBe(1)
        expect(yield* attempts.get(id)).toEqual(before)
        expect(Option.getOrThrow(yield* cache.get(sha256("publication")))).toMatchObject({
          result: "settled",
          createdAtMs: 2000
        })
        const page = yield* journal.entries({ runId: "publication" as never, limit: 50 })
        expect(
          page.entries.filter((entry) => (entry.payload as { action?: string }).action === "replay_failed")
            .map((entry) => entry.payload)
        ).toEqual([
          { keyDigest: sha256("publication"), action: "replay_failed", reason: "host" }
        ])
      }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), jj, boundary)), Effect.scoped)
    ))

  it.effect("retries missing-artifact replay once, including when the retry still refuses", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("publication")
        let bodies = 0
        const body = () =>
          Effect.sync(() => {
            bodies++
            return "settled"
          })
        yield* dispatch(body)
        let replays = 0
        let hydrations = 0
        const cache = yield* CacheStore.CacheStore
        // A separate consumer has no durable outcome to hide a retry loop.
        yield* activate("consumer")
        const result = yield* ActionPersistence.make({ runId: "consumer", owner, sourceId: "consumer", execute: body })(
          {
            action: {},
            key: "publication",
            attempt: 1,
            tier: "sealed",
            metadata: { ...descriptor, writeSet: ["artifact"] }
          }
        ).pipe(
          Effect.provideService(StepBoundary.StepBoundary, {
            prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: [] }),
            settle: () => Effect.succeed(recorded),
            replayOutputs: () =>
              Effect.suspend(() => {
                replays++
                return Effect.fail(
                  new StepBoundary.MissingArtifact({ code: "missing_artifact", path: "artifact", digest })
                )
              })
          }),
          Effect.provideService(ArtifactSync.ArtifactSync, {
            publish: () => Effect.void,
            hydrate: () =>
              Effect.sync(() => {
                hydrations++
                return true
              })
          })
        )
        expect(result).toBe("settled")
        expect(bodies).toBe(2)
        expect(replays).toBe(2)
        expect(hydrations).toBe(1)
        expect(Option.isSome(yield* cache.get(sha256("publication")))).toBe(true)
      }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jj, boundary)), Effect.scoped)
    ))
})
