/**
 * A durable driver resolves a fork's copied attempt identity through
 * `actionReplayKey`. The engine hands the hook its canonical derivation and
 * dispatches under whatever key the hook answers, so a fork can reach the
 * attempt rows its ancestor recorded, and fresh fork work can refuse the
 * cross-run cache by asking for a run-scoped key. It also hands the hook the
 * dispatch's keys under every older key encoding, so a driver can replay a
 * record an earlier engine wrote.
 */
import { describe, expect } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { effect } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const flow = Flow.make("ActionReplayKey/flow", {
  payload: {},
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const charge = Action.make({
  name: "ActionReplayKey/charge",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

const lookup = Action.make({
  name: "ActionReplayKey/lookup",
  success: Schema.Void,
  idempotencyKey: "lookup-1",
  execute: Effect.void
})

/** A keyed sealed action whose success schema carries a brand: encodings 1 and 2 key it differently. */
const Done = Schema.Void.pipe(Schema.brand("ActionReplayKey/Done"))
const branded = Action.make({
  name: "ActionReplayKey/branded",
  success: Done,
  idempotencyKey: "branded-1",
  execute: Effect.sync(() => Done.make(undefined))
})

const environment: Action.CacheEnvironment = { layers: ["same-host"], capabilities: {} }

/** Dispatches `action` once in `executionId` and answers the key the driver received. */
const dispatchedKey = <Success extends Schema.Constraint>(
  action: Action.Action<Success, Schema.Never, never>,
  executionId: string,
  actionReplayKey?: FlowEngine.Encoded["actionReplayKey"],
  encoding?: FlowEngine.KeyEncoding
) => {
  const keys: Array<string> = []
  const engine = scriptedEngine({
    actionExecute: (input) =>
      Effect.sync(() => {
        keys.push(input.key)
        return new Flow.Complete({ exit: Exit.void })
      }),
    ...(actionReplayKey === undefined ? {} : { actionReplayKey })
  })
  return Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    yield* runtime.actionExecute(action, 1)
    expect(keys).toHaveLength(1)
    return keys[0]!
  }).pipe(
    Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, executionId)),
    Effect.provideService(Action.CurrentCacheEnvironment, environment),
    Effect.provideService(FlowEngine.ActionKeyEncoding, encoding ?? FlowEngine.keyEncodings[0]),
    Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
  )
}

/** The keys `legacy` answers for one dispatch of `action`, in order. */
const legacyKeys = <Success extends Schema.Constraint>(
  action: Action.Action<Success, Schema.Never, never>,
  encoding?: FlowEngine.KeyEncoding
) =>
  Effect.gen(function*() {
    const answered: Array<ReadonlyArray<string>> = []
    const key = yield* dispatchedKey(action, "run", (derive, legacy) =>
      Effect.gen(function*() {
        answered.push(yield* legacy("run", false), yield* legacy("run", true))
        return yield* derive("run", false)
      }), encoding)
    return { key, cached: answered[0]!, runScoped: answered[1]! }
  })

describe("actionReplayKey", () => {
  effect("dispatches a fork's action under the ancestor key the driver resolves", () =>
    Effect.gen(function*() {
      const ancestor = yield* dispatchedKey(charge, "ancestor-run")
      const own = yield* dispatchedKey(charge, "fork-run")
      let asks = 0
      const forked = yield* dispatchedKey(charge, "fork-run", (derive) => {
        asks++
        return derive("ancestor-run", false)
      })

      expect(own).not.toBe(ancestor)
      expect(forked).toBe(ancestor)
      expect(asks).toBe(1)
    }))

  effect("keys fresh fork work to its own run instead of the cross-run cache", () =>
    Effect.gen(function*() {
      const cached = yield* dispatchedKey(lookup, "fork-run")
      const cachedElsewhere = yield* dispatchedKey(lookup, "other-run")
      const fresh = yield* dispatchedKey(lookup, "fork-run", (derive) => derive("fork-run", true))
      const freshElsewhere = yield* dispatchedKey(lookup, "other-run", (derive) => derive("other-run", true))

      // Under a complete cache environment the ordinary key is shared by every
      // run, which is exactly what a fork's fresh work must not answer from.
      expect(cachedElsewhere).toBe(cached)
      expect(fresh).not.toBe(cached)
      expect(freshElsewhere).not.toBe(fresh)
    }))

  effect(
    "hands the hook a branded declaration's keys under every older encoding, newest first",
    () =>
      Effect.gen(function*() {
        const current = yield* legacyKeys(branded)
        const third = yield* dispatchedKey(branded, "run", undefined, 3)
        const second = yield* dispatchedKey(branded, "run", undefined, 2)
        const first = yield* dispatchedKey(branded, "run", undefined, 1)
        // Encoding 1 restores the brand encoding 2 omits, and encodings 3 and 4
        // name themselves, so all four key the same dispatch differently.
        expect(new Set([current.key, third, second, first]).size).toBe(4)
        expect(current.cached).toEqual([third, second, first])
        expect(current.runScoped).toHaveLength(3)
        const replayed = yield* dispatchedKey(branded, "run", (_derive, legacy) =>
          Effect.map(legacy("run", false), (keys) =>
            keys[2]!))
        expect(replayed).toBe(first)
      })
  )

  effect(
    "hands the hook each older key once, and none an encoding shares with the current one",
    () =>
      Effect.gen(function*() {
        // Encoding 3 names itself. Encodings 2 and 1 derive one key for a
        // brandless declaration: offered once.
        const lookupKeys = yield* legacyKeys(lookup)
        const unnamed = yield* dispatchedKey(lookup, "run", undefined, 2)
        expect(lookupKeys.cached).toEqual([yield* dispatchedKey(lookup, "run", undefined, 3), unnamed])
        expect(yield* dispatchedKey(lookup, "run", undefined, 1)).toBe(unnamed)
        // An unkeyed action's key and an engine already writing the oldest
        // encoding have nothing older to look under.
        expect(yield* legacyKeys(charge)).toMatchObject({ cached: [], runScoped: [] })
        expect(yield* legacyKeys(branded, 1)).toMatchObject({ cached: [], runScoped: [] })
      })
  )
})
