/**
 * The two-tier step-cache protocol at the dispatch seam (issue #172).
 *
 * Two properties, both taken from Bazel's remote cache:
 *
 * - **Blobs before metadata.** `UploadManifest.java:630-633`: the action result
 *   is uploaded LAST, after every blob it references, because "action results
 *   may fail to validate server-side if they are accessed before all blobs they
 *   refer to are present". A publication that cannot make the artifacts durable
 *   must not publish the entry — and must not fail the run over it either: the
 *   result is already durable on this host, and a shared cache is an
 *   accelerator, so the refusal is journalled and the local row stands.
 * - **Lazy download.** A shared row is routinely recorded on a machine whose
 *   artifacts this one has never seen, so "the blob is not here" is the normal
 *   first answer. The dispatch fetches, retries the replay ONCE, and otherwise
 *   falls through to a real execution rather than looping.
 */
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as CombinedArtifacts from "@smthrs/artifacts/CombinedArtifacts"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ArtifactSync from "../src/ArtifactSync.ts"
import * as CacheSync from "../src/CacheSync.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "remote-cache-host", pid: 42, nonce: "remote-cache-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "input.txt", digest: "D1" }],
  writeSet: ["artifact.bin"],
  boundaryMode: "hard"
}

const encoder = new TextEncoder()
const payload = encoder.encode("a referenced artifact")
const digest = sha256(payload)

const evidence: StepBoundary.BoundaryEvidence = {
  declaredOutputs: { outputs: [{ path: "artifact.bin", digest, sizeBytes: payload.length }] },
  diffIdentity: "remote-cache-diff",
  wholeTreeWritesVerified: true,
  hermeticReadsVerified: true
}

/**
 * A boundary that always verifies its read set and always settles with the
 * digest-referencing evidence above, so the only variable under test is what
 * `replayOutputs` does.
 */
const boundaryLayer = (replayOutputs: StepBoundary.Service["replayOutputs"]) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
      settle: () => Effect.succeed(evidence),
      replayOutputs
    })
  )

const missingArtifact = Effect.fail(
  new StepBoundary.MissingArtifact({ code: "missing_artifact", path: "artifact.bin", digest })
)

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({ commitId: "remote-cache-snapshot" as never, changeId: "remote-cache-snapshot" as never }),
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
  ActionPersistence.make({ runId, owner, sourceId: `remote-cache-${runId}`, execute })({
    action: {},
    attempt: 1,
    key,
    tier: "sealed",
    metadata: declared
  })

/**
 * The `unpublished` provenance records a run journalled — the explanation for
 * a result that stayed local because a shared tier refused it.
 */
const unpublishedRecords = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 50 })
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.cache-provenance")
      .map((entry) => entry.payload as { readonly action?: string; readonly stage?: string; readonly message?: string })
      .filter((payload) => payload.action === "unpublished")
  })

describe("blobs before metadata", () => {
  it.effect("publishes every referenced artifact before the entry is recorded", () =>
    Effect.gen(function*() {
      const key = "remote-cache/publish"
      const local = ArtifactStore.makeMemory()
      const remote = ArtifactStore.makeMemory()
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* local.put(payload)
          yield* activate("publish-run")
          yield* dispatch("publish-run", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(boundaryLayer(() => Effect.void))
          )
          return {
            entry: yield* cache.get(sha256(key)),
            published: yield* remote.has(digest)
          }
        }).pipe(
          Effect.provideService(ArtifactSync.ArtifactSync, ArtifactSync.make({ local, remote })),
          Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
          Effect.scoped
        )
      )
      expect(Option.isSome(outcome.entry)).toBe(true)
      expect(outcome.published).toBe(true)
    }))

  it.effect("publishes the entry to the shared tier only after its artifacts, and only outside the transaction", () =>
    Effect.gen(function*() {
      const key = "remote-cache/publish-entry"
      const local = ArtifactStore.makeMemory()
      const remote = ArtifactStore.makeMemory()
      const order: Array<string> = []
      const sharedRows = new Map<string, CacheStore.CacheEntry>()
      const sharedCache: CacheStore.Service = {
        get: (keyDigest) =>
          Effect.sync(() => {
            const row = sharedRows.get(keyDigest)
            return row === undefined ? Option.none() : Option.some(row)
          }),
        put: (entry) =>
          Effect.sync(() => {
            order.push("entry")
            sharedRows.set(entry.keyDigest, entry)
            return { _tag: "Inserted" } as const
          }),
        evict: () => Effect.succeed(false),
        sweepExpired: () => Effect.succeed(0)
      }
      yield* withCrypto(
        Effect.gen(function*() {
          yield* local.put(payload)
          yield* activate("publish-entry-run")
          yield* dispatch("publish-entry-run", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(boundaryLayer(() => Effect.void))
          )
        }).pipe(
          Effect.provideService(
            ArtifactSync.ArtifactSync,
            ArtifactSync.make({
              local,
              remote: {
                ...remote,
                put: (bytes) => Effect.tap(remote.put(bytes), () => Effect.sync(() => order.push("blob")))
              }
            })
          ),
          Effect.provideService(CacheSync.CacheSync, CacheSync.make({ remote: sharedCache })),
          Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
          Effect.scoped
        )
      )
      // Bazel's ordering, end to end: every blob lands before the action result.
      expect(order).toEqual(["blob", "entry"])
      expect(sharedRows.get(sha256(key))?.result).toBe("recorded")
    }))

  it.effect("withholds the shared entry — but not the local row, and not the run — when an artifact cannot be published", () =>
    Effect.gen(function*() {
      // The entry must never become observable while an artifact it references
      // is missing: a sibling machine would get a hit it cannot materialize. That
      // is a reason to withhold the SHARED entry, never a reason to throw away a
      // completed run's durable result because an optional accelerator is down.
      const key = "remote-cache/publish-refused"
      const shared: Array<string> = []
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate("publish-refused-run")
          const result = yield* dispatch("publish-refused-run", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(boundaryLayer(() => Effect.void))
          )
          return {
            result,
            entry: yield* cache.get(sha256(key)),
            unpublished: yield* unpublishedRecords("publish-refused-run")
          }
        }).pipe(
          Effect.provideService(
            ArtifactSync.ArtifactSync,
            // The local tier holds nothing, so the artifact this host claims to
            // have recorded cannot be read back and publication refuses.
            ArtifactSync.make({ local: ArtifactStore.makeMemory(), remote: ArtifactStore.makeMemory() })
          ),
          Effect.provideService(
            CacheSync.CacheSync,
            CacheSync.make({
              remote: {
                get: () => Effect.succeed(Option.none()),
                put: (entry) => Effect.sync(() => (shared.push(entry.keyDigest), { _tag: "Inserted" } as const)),
                evict: () => Effect.succeed(false),
                sweepExpired: () => Effect.succeed(0)
              }
            })
          ),
          Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
          Effect.scoped
        )
      )
      expect(outcome.result).toBe("recorded")
      // Local row: recorded. Shared entry: withheld, because its blob is not
      // durable in the shared tier.
      expect(Option.isSome(outcome.entry)).toBe(true)
      expect(shared).toEqual([])
      // Visible, not silent: the missing shared entry is explainable from the
      // journal rather than inferred from its absence.
      expect(outcome.unpublished.map((record) => record.stage)).toEqual(["artifacts"])
    }))

  it.effect("journals a shared tier that refuses the entry itself, and still returns the result", () =>
    Effect.gen(function*() {
      const key = "remote-cache/entry-refused"
      const local = ArtifactStore.makeMemory()
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* local.put(payload)
          yield* activate("entry-refused-run")
          const result = yield* dispatch("entry-refused-run", key, () => Effect.succeed("recorded")).pipe(
            Effect.provide(boundaryLayer(() => Effect.void))
          )
          return {
            result,
            entry: yield* cache.get(sha256(key)),
            unpublished: yield* unpublishedRecords("entry-refused-run")
          }
        }).pipe(
          Effect.provideService(
            ArtifactSync.ArtifactSync,
            ArtifactSync.make({ local, remote: ArtifactStore.makeMemory() })
          ),
          Effect.provideService(
            CacheSync.CacheSync,
            CacheSync.make({
              remote: {
                get: () => Effect.succeed(Option.none()),
                put: () =>
                  Effect.fail(
                    new CacheStore.CacheStoreError({ code: "persistence_failed", message: "the shared tier is down" })
                  ),
                evict: () => Effect.succeed(false),
                sweepExpired: () => Effect.succeed(0)
              }
            })
          ),
          Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
          Effect.scoped
        )
      )
      expect(outcome.result).toBe("recorded")
      expect(Option.isSome(outcome.entry)).toBe(true)
      expect(outcome.unpublished.map((record) => record.stage)).toEqual(["entry"])
      expect(outcome.unpublished[0]!.message).toContain("the shared tier is down")
    }))
})

describe("the single-tier default", () => {
  it.effect("publishes nothing and journals nothing when no shared step-result tier is configured", () =>
    Effect.gen(function*() {
      // A purely local composition must not pay for — or notice — any of this.
      const refusal = yield* withCrypto(
        CacheSync.makeLocal().publishEntry({
          keyDigest: "irrelevant",
          result: null,
          meta: null,
          createdAtMs: 0,
          recordedRunId: "run",
          recordedEventSeq: 0
        })
      )
      expect(Option.isNone(refusal)).toBe(true)
    }))

  it.effect("provides that default as a layer", () =>
    Effect.gen(function*() {
      const service = yield* withCrypto(
        Effect.flatMap(CacheSync.CacheSync, (sync) => Effect.succeed(sync)).pipe(
          Effect.provide(CacheSync.layerLocal)
        )
      )
      expect(typeof service.publishEntry).toBe("function")
    }))

  it.effect("builds the shared publisher from an effect", () =>
    Effect.gen(function*() {
      const rows: Array<string> = []
      const published = yield* withCrypto(
        Effect.flatMap(CacheSync.CacheSync, (sync) =>
          sync.publishEntry({
            keyDigest: "layer-key",
            result: null,
            meta: null,
            createdAtMs: 0,
            recordedRunId: "run",
            recordedEventSeq: 0
          })).pipe(
            Effect.provide(
              CacheSync.layer(
                Effect.succeed<CacheStore.Service>({
                  get: () => Effect.succeed(Option.none()),
                  put: (entry) => Effect.sync(() => (rows.push(entry.keyDigest), { _tag: "Inserted" } as const)),
                  evict: () => Effect.succeed(false),
                  sweepExpired: () => Effect.succeed(0)
                })
              )
            )
          )
      )
      expect(Option.isNone(published)).toBe(true)
      expect(rows).toEqual(["layer-key"])
    }))
})

describe("lazy download", () => {
  it.effect("fetches a locally-missing artifact and retries the replay once", () =>
    Effect.gen(function*() {
      const key = "remote-cache/hydrate"
      const local = ArtifactStore.makeMemory()
      const remote = ArtifactStore.makeMemory()
      let executions = 0
      let replays = 0
      const body = () =>
        Effect.sync(() => {
          executions++
          return "recorded"
        })
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* local.put(payload)
          // The recording run publishes the artifact into the shared tier.
          yield* activate("hydrate-producer")
          yield* dispatch("hydrate-producer", key, body).pipe(Effect.provide(boundaryLayer(() => Effect.void)))
          // The consuming run's host has never seen the artifact: the first
          // replay refuses, hydration fetches it, and the retry succeeds.
          yield* activate("hydrate-consumer")
          const result = yield* dispatch("hydrate-consumer", key, body).pipe(
            Effect.provide(
              boundaryLayer(() =>
                Effect.suspend(() => {
                  replays++
                  return replays === 1 ? missingArtifact : Effect.void
                })
              )
            )
          )
          return result
        }).pipe(
          Effect.provideService(ArtifactSync.ArtifactSync, ArtifactSync.make({ local, remote })),
          Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
          Effect.scoped
        )
      )
      expect(outcome).toBe("recorded")
      // The consuming run was a cache hit: its body never ran.
      expect(executions).toBe(1)
      expect(replays).toBe(2)
    }))

  it.effect("falls through to a real execution when the shared tier cannot serve the artifact either", () =>
    Effect.gen(function*() {
      const key = "remote-cache/hydrate-exhausted"
      let executions = 0
      let replays = 0
      const body = () =>
        Effect.sync(() => {
          executions++
          return "recorded"
        })
      // A shared tier that already holds the artifact — so publication is
      // trivially satisfied — but cannot serve it back.
      const remote = ArtifactStore.makeNoop({ findMissing: () => Effect.succeed([]) })
      yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("exhausted-producer")
          yield* dispatch("exhausted-producer", key, body).pipe(Effect.provide(boundaryLayer(() => Effect.void)))
          yield* activate("exhausted-consumer")
          yield* dispatch("exhausted-consumer", key, body).pipe(
            Effect.provide(
              boundaryLayer(() =>
                Effect.suspend(() => {
                  replays++
                  return missingArtifact
                })
              )
            )
          )
        }).pipe(
          Effect.provideService(
            ArtifactSync.ArtifactSync,
            // Hydration reports failure rather than failing the run, and the
            // dispatch does the work for real.
            ArtifactSync.make({ local: ArtifactStore.makeMemory(), remote })
          ),
          Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)),
          Effect.scoped
        )
      )
      expect(executions).toBe(2)
      // Exactly one refusal: hydration failed, so the replay is never retried.
      expect(replays).toBe(1)
    }))
})

/**
 * The download policy, through the dispatch.
 *
 * `packages/smithers/flows/engine-store/test/ArtifactSync.test.ts` proves what each of the
 * three values does to `hydrate` and to the combined read seam, by calling
 * them. This is the claim those calls stand in for: a step whose evidence
 * references an artifact, recorded once and replayed on a host that has never
 * seen the bytes, is ADMITTED under `minimal` without the shared tier serving
 * a single byte — and the bytes arrive later, on the first read that actually
 * wants them.
 */
describe("the download policy at the dispatch seam", () => {
  /** Counts the GETs the shared tier serves, so "zero downloads" is an assertion. */
  const countingRemote = (backing: ArtifactStore.Service) => {
    const gets: Array<string> = []
    return {
      gets,
      service: {
        ...backing,
        get: (requested: string) => {
          gets.push(requested)
          return backing.get(requested)
        }
      } satisfies ArtifactStore.Service
    }
  }

  it.effect("admits a replay under minimal with no download, and materializes on the first read", () =>
    Effect.gen(function*() {
      const key = "remote-cache/minimal-admission"
      // The producing host's own store, and the shared tier it publishes into.
      const producer = ArtifactStore.makeMemory()
      const remote = countingRemote(ArtifactStore.makeMemory())
      // The consuming host: a different machine, so it holds nothing.
      const consumer = ArtifactStore.makeMemory()
      let executions = 0
      let replays = 0
      const body = () =>
        Effect.sync(() => {
          executions++
          return "recorded"
        })

      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* producer.put(payload)
          yield* activate("minimal-producer")
          yield* dispatch("minimal-producer", key, body).pipe(
            Effect.provide(boundaryLayer(() => Effect.void)),
            Effect.provideService(
              ArtifactSync.ArtifactSync,
              ArtifactSync.make({ local: producer, remote: remote.service, downloadPolicy: "minimal" })
            )
          )

          // The consuming dispatch. Its host cannot resolve the blob locally,
          // so the first replay refuses; hydration answers "the shared tier can
          // serve this" from one batched probe and no transfer; the retried
          // replay records the digest it will read rather than fetching it,
          // which is what a metadata-only replay is.
          yield* activate("minimal-consumer")
          return yield* dispatch("minimal-consumer", key, body).pipe(
            Effect.provide(
              boundaryLayer(() =>
                Effect.suspend(() => {
                  replays++
                  return replays === 1 ? missingArtifact : Effect.void
                })
              )
            ),
            Effect.provideService(
              ArtifactSync.ArtifactSync,
              ArtifactSync.make({ local: consumer, remote: remote.service, downloadPolicy: "minimal" })
            )
          )
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )

      // A cache hit: the consuming run never ran the body.
      expect(outcome).toBe("recorded")
      expect(executions).toBe(1)
      expect(replays).toBe(2)
      // ZERO downloads at admission, which is the whole of what `minimal` buys.
      expect(remote.gets).toEqual([])
      expect(yield* withCrypto(consumer.has(digest))).toBe(false)

      // The first read that actually wants the bytes gets them, from the shared
      // tier, one GET. `minimal` serves without writing back, so a host that
      // must not accumulate other machines' artifacts still does not.
      const combined = yield* CombinedArtifacts.make({
        local: consumer,
        remote: remote.service,
        downloadPolicy: "minimal"
      })
      expect(yield* withCrypto(combined.get(digest))).toEqual(payload)
      expect(remote.gets).toEqual([digest])
      expect(yield* withCrypto(consumer.has(digest))).toBe(false)
    }))

  it.effect("downloads at admission under the default policy, which is the contrast", () =>
    Effect.gen(function*() {
      const key = "remote-cache/all-admission"
      const producer = ArtifactStore.makeMemory()
      const remote = countingRemote(ArtifactStore.makeMemory())
      const consumer = ArtifactStore.makeMemory()
      let replays = 0
      const body = () => Effect.succeed("recorded")

      yield* withCrypto(
        Effect.gen(function*() {
          yield* producer.put(payload)
          yield* activate("all-producer")
          yield* dispatch("all-producer", key, body).pipe(
            Effect.provide(boundaryLayer(() => Effect.void)),
            Effect.provideService(
              ArtifactSync.ArtifactSync,
              ArtifactSync.make({ local: producer, remote: remote.service })
            )
          )
          yield* activate("all-consumer")
          yield* dispatch("all-consumer", key, body).pipe(
            Effect.provide(
              boundaryLayer(() =>
                Effect.suspend(() => {
                  replays++
                  return replays === 1 ? missingArtifact : Effect.void
                })
              )
            ),
            Effect.provideService(
              ArtifactSync.ArtifactSync,
              ArtifactSync.make({ local: consumer, remote: remote.service })
            )
          )
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )

      // `all` prefetches: the transfer happens at admission and the blob is on
      // this host afterwards, which is what `minimal` declines to do.
      expect(remote.gets).toEqual([digest])
      expect(yield* withCrypto(consumer.has(digest))).toBe(true)
    }))
})
