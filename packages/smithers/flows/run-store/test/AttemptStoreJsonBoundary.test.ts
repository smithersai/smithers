import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Fiber, Layer, Option } from "effect"
import * as AttemptStore from "../src/AttemptStore.vibe"
import * as Migrations from "../src/Migrations.vibe"
import type { OwnerId } from "../src/Ownership.ts"
import * as RunStore from "../src/RunStore.vibe"

const owner: OwnerId = { hostId: "json-host", pid: 1, nonce: "json-owner" }
const layer = Layer.mergeAll(RunStore.layer, AttemptStore.layer).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

const migrated = <A, E>(
  effect: Effect.Effect<A, E, RunStore.RunStore | AttemptStore.AttemptStore>
) => effect.pipe(Effect.provide(layer), Effect.scoped)

const prepare = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  yield* runs.create("json-run", "{}")
  yield* runs.claimAndOwn(
    "json-run",
    { status: "pending", owner: null, heartbeatAtMs: null },
    owner,
    1
  )
  return yield* AttemptStore.AttemptStore
})

const candidate = (meta: unknown, attempt = 0) => ({
  runId: "json-run",
  stepKeyDigest: "json-step",
  attempt,
  state: "running",
  startedAtMs: 1,
  meta
})

describe("AttemptStore JSON boundary", () => {
  it.effect("rejects executable and non-JSON values without invoking value hooks", () =>
    migrated(Effect.gen(function*() {
      const store = yield* prepare
      let getterCalls = 0
      let toJsonCalls = 0
      let proxyGets = 0
      const accessor = Object.defineProperty({}, "value", {
        enumerable: true,
        get: () => {
          getterCalls++
          return "secret"
        }
      })
      const withToJson = {
        value: 1,
        toJSON: () => {
          toJsonCalls++
          return { value: 1 }
        }
      }
      const cycle: Record<string, unknown> = {}
      cycle.self = cycle
      const sparse = new Array(1)
      const proxy = new Proxy({ value: 1 }, {
        get: (target, key, receiver) => {
          proxyGets++
          return Reflect.get(target, key, receiver)
        }
      })
      const failures = yield* Effect.forEach(
        [undefined, Number.NaN, Number.POSITIVE_INFINITY, BigInt(1), new Date(), accessor, withToJson, cycle, sparse],
        (value, index) => Effect.flip(store.put(candidate(value, index) as never, owner))
      )
      expect(failures.every((failure) => failure.code === "invalid_attempt")).toBe(true)
      expect(failures.every((failure) => failure.cause === undefined)).toBe(true)
      expect(getterCalls).toBe(0)
      expect(toJsonCalls).toBe(0)

      expect(yield* store.put(candidate(proxy, 100) as never, owner)).toEqual({ _tag: "Inserted" })
      expect(proxyGets).toBe(0)
    })))

  it.effect("takes a detached immutable snapshot before persistence yields", () =>
    migrated(Effect.gen(function*() {
      const store = yield* prepare
      const nested = { value: "before" }
      const meta = { nested }
      const running = yield* store.put(candidate(meta) as never, owner).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      nested.value = "after"
      Object.defineProperty(meta, "late", { value: true, enumerable: true })
      expect(yield* Fiber.join(running)).toEqual({ _tag: "Inserted" })

      const stored = Option.getOrThrow(
        yield* store.get({
          runId: "json-run",
          stepKeyDigest: "json-step",
          attempt: 0
        })
      )
      expect(stored.meta).toEqual({ nested: { value: "before" } })
      expect(Object.isFrozen(stored)).toBe(true)
      expect(Object.isFrozen(stored.meta)).toBe(true)
      expect(Object.isFrozen((stored.meta as { readonly nested: object }).nested)).toBe(true)
    })))

  it.effect("enforces the durable JSON depth limit", () =>
    migrated(Effect.gen(function*() {
      const store = yield* prepare
      const nested = (depth: number): unknown => {
        let value: unknown = 0
        for (let index = 0; index < depth; index++) value = [value]
        return value
      }
      expect(yield* store.put(candidate(nested(AttemptStore.maximumJsonDepth), 0) as never, owner)).toEqual({
        _tag: "Inserted"
      })
      const failure = yield* Effect.flip(
        store.put(candidate(nested(AttemptStore.maximumJsonDepth + 1), 1) as never, owner)
      )
      expect(failure).toMatchObject({ code: "invalid_attempt" })
    })))
})
