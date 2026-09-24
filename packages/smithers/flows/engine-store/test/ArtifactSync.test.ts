/**
 * The two-tier artifact protocol: publish before the entry, fetch on demand
 * after it (issue #172).
 *
 * The ordering is Bazel's REAPI constraint
 * (`reference/bazel/.../remote/UploadManifest.java:630-633`): every blob a
 * result references must be present before the result itself is published, or
 * a sibling machine gets a hit it cannot materialize.
 */
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as CombinedArtifacts from "@smthrs/artifacts/CombinedArtifacts"
import type * as RemoteArtifacts from "@smthrs/artifacts/RemoteArtifacts"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as ArtifactSync from "../src/ArtifactSync.ts"
import * as CachePublication from "../src/internal/CachePublication.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const encoder = new TextEncoder()
const payload = encoder.encode("a referenced artifact")
const digest = sha256(payload)

const evidenceFor = (outputs: unknown): StepBoundary.BoundaryEvidence => ({
  declaredOutputs: outputs,
  diffIdentity: "diff"
})

const referenced = evidenceFor({ outputs: [{ path: "artifact.bin", digest, sizeBytes: payload.length }] })

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown }).error
}

/** Runs `effect` and returns its value with every warning it logged. */
const warningsOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const warnings: Array<string> = []
    const capture = Logger.make((options) => {
      if (options.logLevel === "Warn") warnings.push(String(options.message))
    })
    const value = yield* effect.pipe(Effect.provide(Logger.layer([capture])))
    return { value, warnings }
  })

describe("referencedDigests", () => {
  it("names the digests evidence references rather than inlines", () => {
    expect(StepBoundary.referencedDigests(referenced)).toEqual([digest])
  })

  it("ignores inline payloads and removals", () => {
    // An inline row carries its bytes with it, a null digest records a removal,
    // neither references the artifact store.
    const mixed = evidenceFor({
      outputs: [
        { path: "inline.txt", digest: sha256(encoder.encode("small")), content: "c21hbGw=" },
        { path: "removed.txt", digest: null },
        { path: "artifact.bin", digest, sizeBytes: payload.length }
      ]
    })
    expect(StepBoundary.referencedDigests(mixed)).toEqual([digest])
  })

  it("names nothing for evidence carrying a malformed digest reference", () => {
    // One malformed address makes the whole row undecodable, so publication
    // names no digests at all rather than shipping a bogus address to the sync
    // RPC; such evidence is unusable for replay either way.
    const tampered = evidenceFor({
      outputs: [
        { path: "bad.bin", digest: "beef", sizeBytes: 4 },
        { path: "artifact.bin", digest, sizeBytes: payload.length }
      ]
    })
    expect(StepBoundary.referencedDigests(tampered)).toEqual([])
  })

  it("names nothing for evidence recorded by a foreign boundary", () => {
    expect(StepBoundary.referencedDigests(evidenceFor({ paths: ["output.txt"] }))).toEqual([])
  })
})

describe("makeLocal", () => {
  it.effect("publishes nothing and fetches nothing", () =>
    Effect.gen(function*() {
      const local = ArtifactSync.makeLocal()
      yield* withCrypto(local.publish([digest]))
      expect(yield* withCrypto(local.hydrate([digest]))).toBe(false)
      // Nothing to fetch is trivially satisfied.
      expect(yield* withCrypto(local.hydrate([]))).toBe(true)
    }))
})

describe("publish", () => {
  const tiers = () => {
    const local = ArtifactStore.makeMemory()
    const remote = ArtifactStore.makeMemory()
    return { local, remote, sync: ArtifactSync.make({ local, remote }) }
  }

  it.effect("does nothing when the evidence references nothing", () =>
    Effect.gen(function*() {
      const { remote, sync } = tiers()
      yield* withCrypto(sync.publish([]))
      expect(yield* withCrypto(remote.findMissing([digest]))).toEqual([digest])
    }))

  it.effect("probes, uploads what is missing, and confirms", () =>
    Effect.gen(function*() {
      const { local, remote, sync } = tiers()
      yield* withCrypto(local.put(payload))
      yield* withCrypto(sync.publish([digest]))
      expect(yield* withCrypto(remote.has(digest))).toBe(true)
    }))

  it.effect("uploads nothing the shared tier already holds", () =>
    Effect.gen(function*() {
      const local = ArtifactStore.makeMemory()
      const uploads: Array<string> = []
      const inner = ArtifactStore.makeMemory()
      yield* withCrypto(inner.put(payload))
      const remote = ArtifactStore.makeNoop({
        findMissing: inner.findMissing,
        put: (bytes) => {
          uploads.push("put")
          return inner.put(bytes)
        }
      })
      yield* withCrypto(ArtifactSync.make({ local, remote }).publish([digest]))
      expect(uploads).toEqual([])
    }))

  it.effect("fails when the shared tier cannot be probed", () =>
    Effect.gen(function*() {
      const sync = ArtifactSync.make({ local: ArtifactStore.makeMemory(), remote: ArtifactStore.makeNoop() })
      const exit = yield* withCrypto(sync.publish([digest]).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactSync.ArtifactPublicationFailed).code).toBe("artifact_publication_failed")
    }))

  it.effect("fails when this host cannot read the artifact it recorded", () =>
    Effect.gen(function*() {
      const { remote } = tiers()
      const sync = ArtifactSync.make({ local: ArtifactStore.makeMemory(), remote })
      const exit = yield* withCrypto(sync.publish([digest]).pipe(Effect.exit))
      const failure = errorOf(exit) as ArtifactSync.ArtifactPublicationFailed
      expect(failure.message).toContain("cannot read the artifact it recorded")
      expect(failure.digests).toEqual([digest])
      expect(failure.cause).toBeInstanceOf(ArtifactStore.ArtifactMissing)
    }))

  it.effect("fails when the shared tier refuses the upload", () =>
    Effect.gen(function*() {
      const local = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(payload))
      const remote = ArtifactStore.makeNoop({ findMissing: (digests) => Effect.succeed([...digests]) })
      const exit = yield* withCrypto(ArtifactSync.make({ local, remote }).publish([digest]).pipe(Effect.exit))
      const failure = errorOf(exit) as ArtifactSync.ArtifactPublicationFailed
      expect(failure.message).toContain("refused an upload")
      expect(failure.cause).toBeInstanceOf(ArtifactStore.ArtifactStoreError)
    }))

  it.effect("fails when the confirming re-probe cannot be made", () =>
    Effect.gen(function*() {
      const local = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(payload))
      let probes = 0
      const remote = ArtifactStore.makeNoop({
        findMissing: (digests) =>
          Effect.suspend(() => {
            probes++
            // The upload probe answers; the confirming re-probe does not.
            return probes === 1
              ? Effect.succeed([...digests])
              : Effect.fail(
                new ArtifactStore.ArtifactStoreError({ code: "transport_failed", message: "gateway timeout" })
              )
          }),
        put: () => Effect.succeed(digest as never)
      })
      const exit = yield* withCrypto(ArtifactSync.make({ local, remote }).publish([digest]).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactSync.ArtifactPublicationFailed).message).toContain("refused a probe")
    }))

  it.effect("fails when the shared tier did not retain what it accepted", () =>
    Effect.gen(function*() {
      // A tier that accepts an upload but does not durably store it is exactly
      // the state that makes a published entry unreplayable, so the confirming
      // re-probe is not paranoia.
      const local = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(payload))
      const remote = ArtifactStore.makeNoop({
        findMissing: (digests) => Effect.succeed([...digests]),
        put: () => Effect.succeed(digest as never)
      })
      const exit = yield* withCrypto(ArtifactSync.make({ local, remote }).publish([digest]).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactSync.ArtifactPublicationFailed).message).toContain("did not retain")
    }))
})

describe("hydrate", () => {
  it.effect("reports satisfaction when everything is already local", () =>
    Effect.gen(function*() {
      const local = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(payload))
      const sync = ArtifactSync.make({ local, remote: ArtifactStore.makeNoop() })
      expect(yield* withCrypto(sync.hydrate([digest]))).toBe(true)
    }))

  it.effect("fetches what is missing and writes it back locally", () =>
    Effect.gen(function*() {
      const local = ArtifactStore.makeMemory()
      const remote = ArtifactStore.makeMemory()
      yield* withCrypto(remote.put(payload))
      expect(yield* withCrypto(ArtifactSync.make({ local, remote }).hydrate([digest]))).toBe(true)
      expect(yield* withCrypto(local.has(digest))).toBe(true)
    }))

  it.effect("reports failure — never fails the run — when the shared tier cannot serve it", () =>
    Effect.gen(function*() {
      const sync = ArtifactSync.make({
        local: ArtifactStore.makeMemory(),
        remote: ArtifactStore.makeMemory()
      })
      const { value, warnings } = yield* warningsOf(withCrypto(sync.hydrate([digest])))
      expect(value).toBe(false)
      // A replay that silently re-executes is the only symptom of a broken
      // shared tier, so the fallback says why.
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(digest)
    }))

  it.effect("reports failure when the local tier cannot even be probed", () =>
    Effect.gen(function*() {
      const sync = ArtifactSync.make({ local: ArtifactStore.makeNoop(), remote: ArtifactStore.makeMemory() })
      const { value, warnings } = yield* warningsOf(withCrypto(sync.hydrate([digest])))
      expect(value).toBe(false)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("local")
    }))
})

describe("layers", () => {
  it.effect("layerLocal provides the single-tier protocol", () =>
    Effect.gen(function*() {
      expect(
        yield* withCrypto(
          Effect.flatMap(ArtifactSync.ArtifactSync, (sync) => sync.hydrate([digest])).pipe(
            Effect.provide(ArtifactSync.layerLocal)
          )
        )
      ).toBe(false)
    }))

  it.effect("layer takes the local tier from the ArtifactStore tag", () =>
    Effect.gen(function*() {
      const remote = ArtifactStore.makeMemory()
      yield* withCrypto(remote.put(payload))
      const hydrated = yield* withCrypto(
        Effect.flatMap(ArtifactSync.ArtifactSync, (sync) => sync.hydrate([digest])).pipe(
          Effect.provide(ArtifactSync.layer(Effect.succeed(remote))),
          Effect.provide(ArtifactStore.layerMemory)
        )
      )
      expect(hydrated).toBe(true)
    }))
})

describe("CachePublication", () => {
  it.effect("publishes nothing for absent evidence and for evidence that references nothing", () =>
    Effect.gen(function*() {
      yield* withCrypto(CachePublication.publishArtifacts(undefined))
      yield* withCrypto(CachePublication.publishArtifacts(evidenceFor({ paths: [] })))
    }))

  it.effect("defaults to the single-tier protocol when no ArtifactSync is configured", () =>
    Effect.gen(function*() {
      // This is what keeps a purely local composition free of remote-cache
      // machinery: publishing is a no-op and hydration reports nothing arrived.
      yield* withCrypto(CachePublication.publishArtifacts(referenced))
      expect(yield* withCrypto(CachePublication.hydrateArtifacts(referenced))).toBe(false)
    }))

  it.effect("routes referenced digests to the configured protocol", () =>
    Effect.gen(function*() {
      const local = ArtifactStore.makeMemory()
      const remote = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(payload))
      yield* withCrypto(
        CachePublication.publishArtifacts(referenced).pipe(
          Effect.provideService(ArtifactSync.ArtifactSync, ArtifactSync.make({ local, remote }))
        )
      )
      expect(yield* withCrypto(remote.has(digest))).toBe(true)
    }))

  it.effect("hydrates through the configured protocol", () =>
    Effect.gen(function*() {
      const local = ArtifactStore.makeMemory()
      const remote = ArtifactStore.makeMemory()
      yield* withCrypto(remote.put(payload))
      const hydrated = yield* withCrypto(
        CachePublication.hydrateArtifacts(referenced).pipe(
          Effect.provideService(ArtifactSync.ArtifactSync, ArtifactSync.make({ local, remote }))
        )
      )
      expect(hydrated).toBe(true)
    }))

  it.effect("reports nothing to hydrate for evidence that references nothing", () =>
    Effect.gen(function*() {
      expect(yield* withCrypto(CachePublication.hydrateArtifacts(evidenceFor({ paths: [] })))).toBe(false)
    }))

  it("classifies only a missing artifact as fetchable", () => {
    const missing = new StepBoundary.MissingArtifact({ code: "missing_artifact", path: "a.bin", digest })
    expect(CachePublication.replayMissingArtifact(Cause.fail(missing))).toBe(missing)
    expect(
      CachePublication.replayMissingArtifact(
        Cause.fail(new StepBoundary.UnsupportedBoundary({ code: "unsupported_boundary", message: "EIO" }))
      )
    ).toBeUndefined()
    expect(CachePublication.replayMissingArtifact(Cause.die("boom"))).toBeUndefined()
  })
})

/**
 * The download policy: whether a replay materializes the bytes it will need
 * eagerly, or only records that the shared tier can serve them and leaves the
 * fetch to the first read.
 */
describe("the download policy", () => {
  /** Counts the GETs a tier serves, so "zero downloads" is an assertion. */
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

  it.effect("all downloads eagerly, which is the default", () =>
    Effect.gen(function*() {
      const backing = ArtifactStore.makeMemory()
      yield* withCrypto(backing.put(payload))
      const remote = countingRemote(backing)
      const local = ArtifactStore.makeMemory()
      const sync = ArtifactSync.make({ local, remote: remote.service, downloadPolicy: "all" })
      expect(yield* withCrypto(sync.hydrate([digest]))).toBe(true)
      expect(remote.gets).toEqual([digest])
      expect(yield* withCrypto(local.has(digest))).toBe(true)
    }))

  it.effect("minimal admits the replay with no download at all", () =>
    Effect.gen(function*() {
      const backing = ArtifactStore.makeMemory()
      yield* withCrypto(backing.put(payload))
      const remote = countingRemote(backing)
      const local = ArtifactStore.makeMemory()
      const sync = ArtifactSync.make({ local, remote: remote.service, downloadPolicy: "minimal" })
      expect(yield* withCrypto(sync.hydrate([digest]))).toBe(true)
      // The digest is recorded as resolvable, not materialized: the read-through
      // tier fetches it the first time something actually reads it.
      expect(remote.gets).toEqual([])
      expect(yield* withCrypto(local.has(digest))).toBe(false)
    }))

  it.effect("toplevel prefetches nothing and leaves the transfer to the first read", () =>
    Effect.gen(function*() {
      const backing = ArtifactStore.makeMemory()
      yield* withCrypto(backing.put(payload))
      const remote = countingRemote(backing)
      const local = ArtifactStore.makeMemory()
      const sync = ArtifactSync.make({ local, remote: remote.service, downloadPolicy: "toplevel" })
      expect(yield* withCrypto(sync.hydrate([digest]))).toBe(true)
      expect(remote.gets).toEqual([])
      // `toplevel` differs from `minimal` at the combined read seam, not here:
      // both admit the replay without a download, and the combined store then
      // writes the blob back under `toplevel` and does not under `minimal`.
      const combined = yield* CombinedArtifacts.make({ local, remote: remote.service, downloadPolicy: "toplevel" })
      expect(yield* withCrypto(combined.get(digest))).toBeDefined()
      expect(remote.gets).toEqual([digest])
      expect(yield* withCrypto(local.has(digest))).toBe(true)
    }))

  it.effect("takes the policy the shared tier declares", () =>
    Effect.gen(function*() {
      const backing = ArtifactStore.makeMemory()
      yield* withCrypto(backing.put(payload))
      const remote = countingRemote(backing)
      const local = ArtifactStore.makeMemory()
      // The tier states its own policy, the way `RemoteArtifacts.make` does, so
      // one deployment setting reaches both seams without being threaded twice.
      const declaring: RemoteArtifacts.Service = { ...remote.service, downloadPolicy: "minimal" }
      const sync = ArtifactSync.make({ local, remote: declaring })
      expect(yield* withCrypto(sync.hydrate([digest]))).toBe(true)
      expect(remote.gets).toEqual([])
    }))

  it.effect("minimal refuses the replay when the shared tier cannot serve it either", () =>
    Effect.gen(function*() {
      const remote = countingRemote(ArtifactStore.makeMemory())
      const sync = ArtifactSync.make({
        local: ArtifactStore.makeMemory(),
        remote: remote.service,
        downloadPolicy: "minimal"
      })
      expect(yield* withCrypto(sync.hydrate([digest]))).toBe(false)
      expect(remote.gets).toEqual([])
    }))

  it.effect("minimal refuses the replay when a tier cannot be probed", () =>
    Effect.gen(function*() {
      const sync = ArtifactSync.make({
        local: ArtifactStore.makeMemory(),
        remote: ArtifactStore.makeNoop(),
        downloadPolicy: "minimal"
      })
      const { value, warnings } = yield* warningsOf(withCrypto(sync.hydrate([digest])))
      expect(value).toBe(false)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("shared")
    }))

  it.effect("layer carries the declared policy through to hydrate", () =>
    Effect.gen(function*() {
      const backing = ArtifactStore.makeMemory()
      yield* withCrypto(backing.put(payload))
      const remote = countingRemote(backing)
      const satisfied = yield* withCrypto(
        Effect.flatMap(ArtifactSync.ArtifactSync, (sync) => sync.hydrate([digest])).pipe(
          Effect.provide(
            ArtifactSync.layer(Effect.succeed(remote.service), { downloadPolicy: "minimal" })
          ),
          Effect.provide(Layer.succeed(ArtifactStore.ArtifactStore)(ArtifactStore.makeMemory()))
        )
      )
      expect(satisfied).toBe(true)
      expect(remote.gets).toEqual([])
    }))

  it.effect("minimal asks nothing of either tier when nothing is referenced", () =>
    Effect.gen(function*() {
      const remote = countingRemote(ArtifactStore.makeMemory())
      const sync = ArtifactSync.make({
        local: ArtifactStore.makeMemory(),
        remote: remote.service,
        downloadPolicy: "minimal"
      })
      expect(yield* withCrypto(sync.hydrate([]))).toBe(true)
      expect(remote.gets).toEqual([])
    }))
})
