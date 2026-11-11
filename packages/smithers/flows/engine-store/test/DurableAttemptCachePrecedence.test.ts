import { describe, expect, it } from "@effect/vitest"
import { AttemptStore, type Ownership } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, boundary, descriptor, jj, owner } from "./CachePolicyFixtures.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const layer = Layer.mergeAll(TestStores.layer(), boundary(), jj)
const stepKeyDigest = sha256("cache-precedence")
const deadOwner: Ownership.OwnerId = { hostId: "cache-policy", pid: 9, nonce: "killed" }

/**
 * What a SIGKILL during the body leaves in a run the sweep then hands to
 * `owner`: an attempt row still `running`, admitted by the dead incarnation.
 */
const orphan = (runId: string, meta: AttemptStore.JsonValue, outcome?: string) =>
  Effect.gen(function*() {
    yield* activate(runId)
    const attempts = yield* AttemptStore.AttemptStore
    const put = yield* attempts.put({
      runId,
      stepKeyDigest,
      attempt: 1,
      state: "running",
      startedAtMs: 0,
      meta,
      ...(outcome === undefined ? {} : { outcome })
    }, owner)
    expect(put._tag).toBe("Inserted")
  })
const attemptOf = (runId: string) =>
  Effect.flatMap(
    AttemptStore.AttemptStore,
    (attempts) => Effect.map(attempts.get({ runId, stepKeyDigest, attempt: 1 }), Option.getOrThrow)
  )
const dispatch = (runId: string, execute: ActionPersistence.Dependencies["execute"]) =>
  ActionPersistence.make({ runId, owner, sourceId: "cache-precedence", execute })({
    action: {},
    key: "cache-precedence",
    attempt: 1,
    tier: "sealed",
    nondeterministic: true,
    metadata: descriptor
  })

describe("durable attempts precede shared cache acceleration", () => {
  it.effect("preserves a succeeded run's own result after another producer replaces the evicted cache entry", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("original")
        expect(yield* dispatch("original", () => Effect.succeed("original-result"))).toBe("original-result")
        const cache = yield* CacheStore.CacheStore
        yield* cache.evict(sha256("cache-precedence"))
        yield* activate("replacement")
        expect(yield* dispatch("replacement", () => Effect.succeed("replacement-result"))).toBe("replacement-result")
        expect(yield* dispatch("original", () => Effect.die("body must not repeat"))).toBe("original-result")
        expect(Option.getOrThrow(yield* cache.get(sha256("cache-precedence"))).result).toBe("replacement-result")
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))

  it.effect("rethrows a persisted failure even when another run has since published a cache hit", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("failed")
        expect(yield* dispatch("failed", () => Effect.fail("original-failure")).pipe(Effect.flip))
          .toBe("original-failure")
        yield* activate("replacement")
        yield* dispatch("replacement", () => Effect.succeed("replacement-result"))
        expect(yield* dispatch("failed", () => Effect.die("body must not repeat")).pipe(Effect.flip))
          .toBe("original-failure")
        const attempts = yield* AttemptStore.AttemptStore
        expect(
          Option.getOrThrow(
            yield* attempts.get({
              runId: "failed",
              stepKeyDigest: sha256("cache-precedence"),
              attempt: 1
            })
          ).state
        ).toBe("failed")
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))

  it.effect("answers an orphaned running attempt from another run's verified row and closes it (issue #3898)", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("recorder")
        expect(yield* dispatch("recorder", () => Effect.succeed("recorded-result"))).toBe("recorded-result")
        yield* orphan("reclaimed", { tier: "sealed", keyed: true, admittedBy: deadOwner })
        expect(yield* dispatch("reclaimed", () => Effect.die("body must not repeat"))).toBe("recorded-result")
        const settled = yield* attemptOf("reclaimed")
        expect(settled.state).toBe("succeeded")
        expect(settled.outcome).toBe("recorded-result")
        // The row names the incarnation that closed it and claims no boundary
        // evidence it never measured, so it is never published back.
        expect(settled.meta).toEqual({ tier: "sealed", keyed: true, nondeterministic: true, admittedBy: owner })
        // A later re-drive replays the closed row without the cache.
        const cache = yield* CacheStore.CacheStore
        yield* cache.evict(sha256("cache-precedence"))
        expect(yield* dispatch("reclaimed", () => Effect.die("body must not repeat"))).toBe("recorded-result")
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))

  it.effect("records the attempt a cache hit answered, so a re-drive never re-runs its body (issue #4763)", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("recorder")
        expect(yield* dispatch("recorder", () => Effect.succeed("recorded-result"))).toBe("recorded-result")
        yield* activate("served")
        expect(yield* dispatch("served", () => Effect.die("body must not run"))).toBe("recorded-result")
        const served = yield* attemptOf("served")
        expect(served.state).toBe("succeeded")
        expect(served.outcome).toBe("recorded-result")
        // Like a closed orphan, the row claims no boundary evidence it never
        // measured, so it is never published back.
        expect(served.meta).toEqual({ tier: "sealed", nondeterministic: true, admittedBy: owner })
        // The shared head is mutable. Once it is gone, the run's own row
        // answers the step it already consumed.
        const cache = yield* CacheStore.CacheStore
        yield* cache.evict(sha256("cache-precedence"))
        expect(yield* dispatch("served", () => Effect.succeed("re-executed"))).toBe("recorded-result")
        expect(Option.isNone(yield* cache.get(sha256("cache-precedence")))).toBe(true)
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))

  it.effect("answers an orphaned attempt whose metadata no longer decodes (issue #3898)", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("recorder")
        yield* dispatch("recorder", () => Effect.succeed("recorded-result"))
        yield* orphan("legacy", { admittedBy: deadOwner })
        expect(yield* dispatch("legacy", () => Effect.die("body must not repeat"))).toBe("recorded-result")
        expect((yield* attemptOf("legacy")).meta).toEqual({ tier: "sealed", nondeterministic: true, admittedBy: owner })
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))

  it.effect("re-executes an orphaned attempt when no run has recorded its key", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* orphan("alone", { tier: "sealed", admittedBy: deadOwner })
        expect(yield* dispatch("alone", () => Effect.succeed("re-executed"))).toBe("re-executed")
        expect((yield* attemptOf("alone")).outcome).toBe("re-executed")
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))

  it.effect("settles an orphan from its own succeeded crossing, not from another run's row", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("recorder")
        yield* dispatch("recorder", () => Effect.succeed("recorded-result"))
        yield* orphan("crossed", { tier: "sealed", effectCrossing: "succeeded", admittedBy: deadOwner }, "own-result")
        expect(yield* dispatch("crossed", () => Effect.die("body must not repeat"))).toBe("own-result")
        expect((yield* attemptOf("crossed")).state).toBe("succeeded")
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))

  it.effect("re-executes an orphan whose declaration is not cache-eligible, whatever the cache holds", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("recorder")
        yield* dispatch("recorder", () => Effect.succeed("recorded-result"))
        yield* orphan("unbounded", { tier: "sealed", admittedBy: deadOwner })
        // No boundary descriptor: the declaration is not eligible, so the row
        // under this key is never consulted and the attempt re-executes.
        const result = yield* ActionPersistence.make({
          runId: "unbounded",
          owner,
          sourceId: "cache-precedence",
          execute: () => Effect.succeed("re-executed")
        })({ action: {}, key: "cache-precedence", attempt: 1, tier: "sealed" })
        expect(result).toBe("re-executed")
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))

  it.effect("stops when the orphan's run is lost before the served result is recorded", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("recorder")
        yield* dispatch("recorder", () => Effect.succeed("recorded-result"))
        yield* orphan("fenced", { tier: "sealed", admittedBy: deadOwner })
        const attempts = yield* AttemptStore.AttemptStore
        let bodies = 0
        const exit = yield* dispatch("fenced", () =>
          Effect.sync(() => {
            bodies++
            return "re-executed"
          })).pipe(
            Effect.provideService(AttemptStore.AttemptStore, {
              ...attempts,
              finish: () => Effect.succeed({ _tag: "FenceLost" } as const)
            }),
            Effect.exit
          )
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(bodies).toBe(0)
        expect((yield* attemptOf("fenced")).state).toBe("running")
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))
})
