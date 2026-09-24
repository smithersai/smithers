/**
 * Local-first, remote-second, with write-back — the shape of Bazel's
 * `CombinedCache` (`com.google.devtools.build.lib.remote.CombinedCache`).
 */
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import { TestClock } from "effect/testing"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as ArtifactStoreMetrics from "../src/ArtifactStoreMetrics.ts"
import * as CombinedArtifacts from "../src/CombinedArtifacts.ts"
import * as RemoteArtifacts from "../src/RemoteArtifacts.ts"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"

const artifact = "an artifact that travels"
const digest = sha256(bytes(artifact))

/** A memory store with a call log, so tier routing is observable. */
const countingMemory = () => {
  const inner = ArtifactStore.makeMemory()
  const calls: Array<string> = []
  const store: ArtifactStore.Service = {
    put: (payload) => Effect.tap(inner.put(payload), () => Effect.sync(() => calls.push("put"))),
    get: (address) => Effect.tap(inner.get(address), () => Effect.sync(() => calls.push("get"))),
    has: (address) => Effect.tap(inner.has(address), () => Effect.sync(() => calls.push("has"))),
    findMissing: (addresses) =>
      Effect.tap(inner.findMissing(addresses), () => Effect.sync(() => calls.push("findMissing")))
  }
  return { calls, store, inner }
}

describe("reads", () => {
  it.effect("answers from the local tier without touching the remote one", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = countingMemory()
      const combined = yield* CombinedArtifacts.make({ local: local.store, remote: remote.store })
      yield* withCrypto(local.store.put(bytes(artifact)))
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(remote.calls).toEqual([])
    }))

  it.effect("falls through to the remote tier and writes back locally", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = countingMemory()
      const combined = yield* CombinedArtifacts.make({ local: local.store, remote: remote.store })
      yield* withCrypto(remote.store.put(bytes(artifact)))
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      // The write-back means the next read is local.
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
      const remoteReads = remote.calls.filter((call) => call === "get").length
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(remote.calls.filter((call) => call === "get")).toHaveLength(remoteReads)
    }))

  it.effect("heals a corrupt local address from the remote tier", () =>
    Effect.gen(function*() {
      // Local corruption falls through exactly like a miss: the write-back hands
      // the correct bytes to `local.put`, whose own verification finds the
      // mismatched blob and rewrites it.
      const corrupt = ArtifactStore.makeNoop({
        get: () =>
          Effect.fail(
            new ArtifactStore.ArtifactCorruption({
              code: "artifact_corruption",
              recordedDigest: digest,
              measuredDigest: sha256(bytes("torn"))
            })
          ),
        put: ArtifactStore.makeMemory().put
      })
      const remote = countingMemory()
      yield* withCrypto(remote.store.put(bytes(artifact)))
      const combined = yield* CombinedArtifacts.make({ local: corrupt, remote: remote.store })
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
    }))

  it.effect("serves the remote bytes when the local write-back fails", () =>
    Effect.gen(function*() {
      // The bytes are already in hand and digest-verified. A local tier that
      // cannot store them — a full disk, a read-only mount, a refused sync —
      // costs the next read a round trip, never this read's answer.
      const remote = countingMemory()
      yield* withCrypto(remote.store.put(bytes(artifact)))
      const local = ArtifactStore.makeNoop({
        get: () => Effect.fail(new ArtifactStore.ArtifactMissing({ code: "artifact_missing", digest }))
      })
      const combined = yield* CombinedArtifacts.make({ local, remote: remote.store })
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
    }))

  it.effect.each(["default", "configured", "layer"] as const)(
    "interrupts a stalled local write-back and serves the remote bytes after the %s deadline",
    (mode) =>
      Effect.gen(function*() {
        const remote = countingMemory()
        yield* withCrypto(remote.store.put(bytes(artifact)))
        const started = yield* Deferred.make<void>()
        let interrupted = false
        const local = ArtifactStore.makeNoop({
          get: () => Effect.fail(new ArtifactStore.ArtifactMissing({ code: "artifact_missing", digest })),
          put: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true
                })
              )
            )
        })
        const writeBackTimeout = mode === "default" ? undefined : "50 millis"
        const read = mode === "layer"
          ? Effect.flatMap(ArtifactStore.ArtifactStore, (store) => store.get(digest)).pipe(
            Effect.provide(CombinedArtifacts.layer({
              local: Effect.succeed(local),
              remote: Effect.succeed(remote.store),
              writeBackTimeout
            }))
          )
          : Effect.flatMap(
            CombinedArtifacts.make({ local, remote: remote.store, writeBackTimeout }),
            (store) => store.get(digest)
          )
        const running = yield* withCrypto(read).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* TestClock.adjust(mode === "default" ? "59999 millis" : "49 millis")
        expect(interrupted).toBe(false)
        expect(running.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 milli")
        expect(interrupted).toBe(true)
        expect(text(yield* Fiber.join(running))).toBe(artifact)
      })
  )

  it.effect.each(["not a duration", "Infinity", "0 millis", "-1 millis", Symbol("invalid")])(
    "rejects invalid writeBackTimeout %s during construction",
    (writeBackTimeout) =>
      Effect.gen(function*() {
        const exit = yield* CombinedArtifacts.make({
          local: ArtifactStore.makeMemory(),
          remote: ArtifactStore.makeMemory(),
          writeBackTimeout: writeBackTimeout as never
        }).pipe(Effect.exit)
        expect(exit).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { code: "invalid_configuration" } }] }
        })
      })
  )

  it.effect("refuses a read the local tier refused, instead of paying the network for it", () =>
    Effect.gen(function*() {
      // Only a miss and a corrupt address fall through. A host that refused the
      // read answered nothing, and hiding that behind a working shared tier
      // would turn a broken local store into a silent per-read network cost.
      const remote = countingMemory()
      yield* withCrypto(remote.store.put(bytes(artifact)))
      const combined = yield* CombinedArtifacts.make({ local: ArtifactStore.makeNoop(), remote: remote.store })
      const exit = yield* withCrypto(combined.get(digest).pipe(Effect.exit))
      expect(exit).toMatchObject({ _tag: "Failure", cause: { reasons: [{ error: { code: "unavailable" } }] } })
      expect(remote.calls.filter((call) => call === "get")).toEqual([])
    }))

  it.effect("propagates a remote miss", () =>
    Effect.gen(function*() {
      const combined = yield* CombinedArtifacts.make({
        local: ArtifactStore.makeMemory(),
        remote: ArtifactStore.makeMemory()
      })
      const exit = yield* withCrypto(combined.get(digest).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("writes", () => {
  it.effect("stores locally and uploads to the shared tier", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = countingMemory()
      const combined = yield* CombinedArtifacts.make({ local: local.store, remote: remote.store })
      expect(yield* withCrypto(combined.put(bytes(artifact)))).toBe(digest)
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
      expect(yield* withCrypto(remote.store.has(digest))).toBe(true)
    }))

  it.effect("records the artifact locally even when the shared tier refuses the upload", () =>
    Effect.gen(function*() {
      // Failing here would fail whatever produced the bytes — a step's `settle`,
      // say — because a cache was unreachable. The artifact is recorded where
      // this machine's replays resolve it, and the publication protocol's
      // findMissing → upload → confirm is what actually gates a shared entry.
      const local = countingMemory()
      const combined = yield* CombinedArtifacts.make({ local: local.store, remote: ArtifactStore.makeNoop() })
      expect(yield* withCrypto(combined.put(bytes(artifact)))).toBe(digest)
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
    }))

  it.effect("counts every dropped transfer and warns once per operation", () =>
    Effect.gen(function*() {
      const count = (operation: "put" | "write_back") =>
        Effect.map(Metric.value(ArtifactStoreMetrics.remoteFailure[operation]), (state) => state.count)
      const messages: Array<unknown> = []
      const capture = Logger.layer([Logger.make<unknown, void>(({ message }) => messages.push(message))])
      const putsBefore = yield* count("put")
      const writeBacksBefore = yield* count("write_back")
      const remote = countingMemory()
      yield* withCrypto(remote.store.put(bytes(artifact)))
      const refusingLocal = ArtifactStore.makeNoop({
        get: () => Effect.fail(new ArtifactStore.ArtifactMissing({ code: "artifact_missing", digest })),
        put: ArtifactStore.makeMemory().put
      })
      const refusingRemote = CombinedArtifacts.make({ local: countingMemory().store, remote: ArtifactStore.makeNoop() })
      const uploads = yield* refusingRemote
      yield* withCrypto(uploads.put(bytes(artifact))).pipe(Effect.provide(capture))
      yield* withCrypto(uploads.put(bytes("another artifact"))).pipe(Effect.provide(capture))
      const readsThrough = yield* CombinedArtifacts.make({
        local: ArtifactStore.makeNoop({ get: refusingLocal.get }),
        remote: remote.store
      })
      yield* withCrypto(readsThrough.get(digest)).pipe(Effect.provide(capture))
      expect((yield* count("put")) - putsBefore).toBe(2)
      expect((yield* count("write_back")) - writeBacksBefore).toBe(1)
      expect(messages.flat().filter((message) => message === "Combined artifact transfer dropped")).toHaveLength(2)
    }))

  it.effect("deduplicates concurrent uploads of one digest", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const uploads: Array<string> = []
      const gate = yield* (Deferred.make<void>())
      const remote = ArtifactStore.makeNoop({
        put: (payload) =>
          Effect.gen(function*() {
            uploads.push("put")
            yield* Deferred.await(gate)
            return yield* ArtifactStore.makeMemory().put(payload)
          })
      })
      const combined = yield* CombinedArtifacts.make({ local: local.store, remote })
      const running = yield* Effect.forkChild(
        withCrypto(
          Effect.all([combined.put(bytes(artifact)), combined.put(bytes(artifact))], { concurrency: 2 })
        ),
        { startImmediately: true }
      )
      yield* (Deferred.succeed(gate, undefined))
      expect(yield* Fiber.join(running)).toEqual([digest, digest])
      // The second caller joined the first upload instead of repeating it.
      expect(uploads).toHaveLength(1)
    }))

  it.effect("starts a fresh upload after an interrupted one, instead of joining a dead deferred", () =>
    Effect.gen(function*() {
      // Interruption striking mid-upload — the deadline firing, the caller's
      // scope closing — must not orphan the shared deferred: on the defective
      // code the entry stayed registered forever and every later put of the
      // digest joined a deferred nobody would ever complete.
      const uploads: Array<string> = []
      const gate = yield* (Deferred.make<void>())
      const started = yield* (Deferred.make<void>())
      const remote = ArtifactStore.makeNoop({
        put: (payload) =>
          Effect.gen(function*() {
            uploads.push("put")
            if (uploads.length === 1) {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
            }
            return yield* ArtifactStore.makeMemory().put(payload)
          })
      })
      const combined = yield* CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote })
      const published = yield* withCrypto(
        Effect.gen(function*() {
          const leader = yield* combined.put(bytes(artifact)).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(leader)
          return yield* combined.put(bytes(artifact)).pipe(Effect.timeout("2 seconds"))
        })
      )
      expect(published).toBe(digest)
      expect(uploads).toHaveLength(2)
    }))

  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("releases a joined waiter when the shared upload is interrupted", () =>
    Effect.gen(function*() {
      // The waiter joined the leader's deferred; the leader's interruption must
      // resolve it — as the typed refusal `put` already drops — rather than
      // leave the waiter parked on it forever.
      const uploads: Array<string> = []
      const gate = yield* (Deferred.make<void>())
      const started = yield* (Deferred.make<void>())
      const remote = ArtifactStore.makeNoop({
        put: (payload) =>
          Effect.gen(function*() {
            uploads.push("put")
            if (uploads.length === 1) {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
            }
            return yield* ArtifactStore.makeMemory().put(payload)
          })
      })
      const combined = yield* CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote })
      const published = yield* withCrypto(
        Effect.gen(function*() {
          const leader = yield* combined.put(bytes(artifact)).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(started)
          const waiter = yield* combined.put(bytes(artifact)).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.sleep("20 millis")
          yield* Fiber.interrupt(leader)
          return yield* Fiber.join(waiter).pipe(Effect.timeout("2 seconds"))
        })
      )
      expect(published).toBe(digest)
    }))

  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("bounds the opportunistic upload with the configured deadline", () =>
    Effect.gen(function*() {
      // A remote that stalls instead of refusing must not hold the local answer
      // hostage: the upload is abandoned at the deadline like any refusal, and
      // the put answers with the local digest it already holds.
      const gate = yield* (Deferred.make<void>())
      const remote = ArtifactStore.makeNoop({
        put: (payload) => Effect.andThen(Deferred.await(gate), ArtifactStore.makeMemory().put(payload))
      })
      const local = countingMemory()
      const combined = yield* CombinedArtifacts.make({ local: local.store, remote, uploadTimeout: "50 millis" })
      expect(yield* withCrypto(combined.put(bytes(artifact)))).toBe(digest)
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
    }))

  it.effect("starts a fresh upload once the in-flight one has settled", () =>
    Effect.gen(function*() {
      const uploads: Array<string> = []
      const remote = ArtifactStore.makeNoop({
        put: (payload) =>
          Effect.gen(function*() {
            uploads.push("put")
            return yield* ArtifactStore.makeMemory().put(payload)
          })
      })
      const combined = yield* CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote })
      yield* withCrypto(combined.put(bytes(artifact)))
      yield* withCrypto(combined.put(bytes(artifact)))
      expect(uploads).toHaveLength(2)
    }))

  it.effect("snapshots the caller's bytes before either tier can yield", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const localBacking = ArtifactStore.makeMemory()
      const local = ArtifactStore.makeNoop({
        put: (payload) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(localBacking.put(payload))
          ),
        get: localBacking.get,
        has: localBacking.has,
        findMissing: localBacking.findMissing
      })
      const remote = ArtifactStore.makeMemory()
      const combined = yield* CombinedArtifacts.make({ local, remote })
      const input = bytes(artifact)
      const running = yield* withCrypto(combined.put(input)).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      input.fill(0)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(running)).toBe(digest)
      expect(text(yield* withCrypto(localBacking.get(digest)))).toBe(artifact)
      expect(text(yield* withCrypto(remote.get(digest)))).toBe(artifact)
    }))

  it.effect.each(["not a duration", "Infinity", "0 millis", "-1 millis"])(
    "rejects invalid uploadTimeout %s during construction",
    (uploadTimeout) =>
      Effect.gen(function*() {
        const exit = yield* CombinedArtifacts.make({
          local: ArtifactStore.makeMemory(),
          remote: ArtifactStore.makeMemory(),
          uploadTimeout: uploadTimeout as never
        }).pipe(Effect.exit)
        expect(exit).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { code: "invalid_configuration" } }] }
        })
      })
  )

  it.effect("normalizes a duration parser throw into invalid_configuration", () =>
    Effect.gen(function*() {
      const exit = yield* CombinedArtifacts.make({
        local: ArtifactStore.makeMemory(),
        remote: ArtifactStore.makeMemory(),
        uploadTimeout: Symbol("invalid") as never
      }).pipe(Effect.exit)
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { code: "invalid_configuration" } }] }
      })
    }))

  it.effect("rejects an unsupported download policy during construction", () =>
    Effect.gen(function*() {
      const exit = yield* CombinedArtifacts.make({
        local: ArtifactStore.makeMemory(),
        remote: ArtifactStore.makeMemory(),
        downloadPolicy: "everything" as never
      }).pipe(Effect.exit)
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { code: "invalid_configuration" } }] }
      })
    }))
})

describe("probes", () => {
  it.effect("answers `has` locally, then remotely", () =>
    Effect.gen(function*() {
      const remote = countingMemory()
      yield* withCrypto(remote.store.put(bytes(artifact)))
      const combined = yield* CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote: remote.store })
      expect(yield* withCrypto(combined.has(digest))).toBe(true)
      const local = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(bytes(artifact)))
      const localFirst = yield* CombinedArtifacts.make({ local, remote: remote.store })
      const before = remote.calls.length
      expect(yield* withCrypto(localFirst.has(digest))).toBe(true)
      expect(remote.calls).toHaveLength(before)
    }))

  it.effect("probes the remote tier only about what the local tier lacks", () =>
    Effect.gen(function*() {
      const other = sha256(bytes("another artifact"))
      const local = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(bytes(artifact)))
      const remote = countingMemory()
      yield* withCrypto(remote.store.put(bytes("another artifact")))
      const combined = yield* CombinedArtifacts.make({ local, remote: remote.store })
      expect(yield* withCrypto(combined.findMissing([digest, other]))).toEqual([])
    }))

  it.effect("skips the remote round trip when the local tier holds everything", () =>
    Effect.gen(function*() {
      const local = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(bytes(artifact)))
      const remote = countingMemory()
      const combined = yield* CombinedArtifacts.make({ local, remote: remote.store })
      expect(yield* withCrypto(combined.findMissing([digest]))).toEqual([])
      expect(remote.calls).toEqual([])
    }))

  it.effect("reports what neither tier holds", () =>
    Effect.gen(function*() {
      const combined = yield* CombinedArtifacts.make({
        local: ArtifactStore.makeMemory(),
        remote: ArtifactStore.makeMemory()
      })
      expect(yield* withCrypto(combined.findMissing([digest]))).toEqual([digest])
    }))
})

describe("layer", () => {
  it.effect("builds both tiers from effects and provides one tag", () =>
    Effect.gen(function*() {
      const remote = ArtifactStore.makeMemory()
      const published = yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (store) => store.put(bytes(artifact))).pipe(
          Effect.provide(
            CombinedArtifacts.layer({
              local: Effect.sync(ArtifactStore.makeMemory),
              remote: Effect.succeed(remote)
            })
          )
        )
      )
      expect(published).toBe(digest)
      expect(yield* withCrypto(remote.has(digest))).toBe(true)
    }))

  it.effect("forwards an explicit download policy override", () =>
    Effect.gen(function*() {
      const policy = yield* Effect.map(
        ArtifactStore.ArtifactStore,
        RemoteArtifacts.downloadPolicyOf
      ).pipe(
        Effect.provide(CombinedArtifacts.layer({
          local: Effect.succeed(ArtifactStore.makeMemory()),
          remote: Effect.succeed(ArtifactStore.makeMemory()),
          downloadPolicy: "minimal"
        }))
      )
      expect(policy).toBe("minimal")
    }))
})

describe("the download policy", () => {
  /** A remote tier that declares a policy, the way `RemoteArtifacts.make` does. */
  const declaring = (downloadPolicy: RemoteArtifacts.DownloadPolicy) => {
    const counting = countingMemory()
    return { ...counting, store: { ...counting.store, downloadPolicy } }
  }

  it.effect("defaults to all, which writes a fetched blob back locally", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = countingMemory()
      const combined = yield* CombinedArtifacts.make({ local: local.store, remote: remote.store })
      expect(combined.downloadPolicy).toBe("all")
      yield* withCrypto(remote.store.put(bytes(artifact)))
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
    }))

  it.effect("takes the policy the remote tier declares", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = declaring("minimal")
      const combined = yield* CombinedArtifacts.make({ local: local.store, remote: remote.store })
      expect(combined.downloadPolicy).toBe("minimal")
      yield* withCrypto(remote.store.put(bytes(artifact)))

      // The bytes are served, and the local tier is exactly as empty as before.
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(yield* withCrypto(local.store.has(digest))).toBe(false)
      expect(local.calls.filter((call) => call === "put")).toHaveLength(0)

      // Which means the second read pays the network again, on purpose.
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(remote.calls.filter((call) => call === "get")).toHaveLength(2)
    }))

  it.effect("repairs a corrupt local address under minimal, which reports it as present", () =>
    Effect.gen(function*() {
      // `minimal` withholds materialization so the local tier never grows. A
      // corrupt blob is not growth: the address is already claimed, `has` and
      // `findMissing` already report it as present, and without the repair the
      // tier keeps promising bytes it can never serve.
      const backing = ArtifactStore.makeMemory()
      let corrupt = true
      const local: ArtifactStore.Service = {
        ...backing,
        get: (address) =>
          corrupt
            ? Effect.fail(
              new ArtifactStore.ArtifactCorruption({
                code: "artifact_corruption",
                recordedDigest: digest,
                measuredDigest: sha256(bytes("torn"))
              })
            )
            : backing.get(address),
        has: () => Effect.succeed(true),
        put: (payload) =>
          Effect.tap(backing.put(payload), () =>
            Effect.sync(() => {
              corrupt = false
            }))
      }
      const remote = declaring("minimal")
      yield* withCrypto(remote.store.put(bytes(artifact)))
      const combined = yield* CombinedArtifacts.make({ local, remote: remote.store })
      expect(combined.downloadPolicy).toBe("minimal")
      expect(yield* withCrypto(combined.has(digest))).toBe(true)

      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(text(yield* withCrypto(backing.get(digest)))).toBe(artifact)
      // Repaired, so the second read is local and the shared tier is spared.
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(remote.calls.filter((call) => call === "get")).toHaveLength(1)
    }))

  it.effect("materializes on first read under toplevel", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = declaring("toplevel")
      const combined = yield* CombinedArtifacts.make({ local: local.store, remote: remote.store })
      expect(combined.downloadPolicy).toBe("toplevel")
      yield* withCrypto(remote.store.put(bytes(artifact)))
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
      // Materialized once: the second read never reaches the shared tier.
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(remote.calls.filter((call) => call === "get")).toHaveLength(1)
    }))

  it.effect("lets the composition override the tier's declaration", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = declaring("minimal")
      const combined = yield* CombinedArtifacts.make({
        local: local.store,
        remote: remote.store,
        downloadPolicy: "all"
      })
      expect(combined.downloadPolicy).toBe("all")
      yield* withCrypto(remote.store.put(bytes(artifact)))
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
    }))

  it.effect("ignores a declaration that is not a policy", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = countingMemory()
      const combined = yield* CombinedArtifacts.make({
        local: local.store,
        remote: { ...remote.store, downloadPolicy: "everything" } as never
      })
      expect(combined.downloadPolicy).toBe("all")
    }))
})
