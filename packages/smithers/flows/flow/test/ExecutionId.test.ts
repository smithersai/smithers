import type * as SecureRandom from "effect/crypto/SecureRandom"
// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import { effect } from "./Harness.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const Echo = Action.make("ExecutionId/echo", {
  payload: { value: Schema.String },
  success: Schema.String
})

const Idempotent = Flow.make("ExecutionId/Idempotent", {
  payload: { value: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ value }) => `key:${value}`,
  body: ({ value }) => Echo.call({ value })
})

const IdempotentLayer = layerWired(
  Layer.mergeAll(
    Echo.toLayer(({ value }) => Effect.succeed(value)),
    Interpreter.layer(Idempotent)
  )
)

/** A flow that declares no key: identity comes from the ambient source. */
const Anonymous = Flow.make("ExecutionId/Anonymous", {
  payload: { value: Schema.String },
  success: Schema.String,
  body: ({ value }) => Echo.call({ value })
})

/** The same declaration under another tag, to prove the tag is derived on. */
const Twin = Flow.make("ExecutionId/Twin", {
  payload: { value: Schema.String },
  success: Schema.String,
  body: ({ value }) => Echo.call({ value })
})

const AnonymousLayer = layerWired(
  Layer.mergeAll(
    Echo.toLayer(({ value }) => Effect.succeed(value)),
    Interpreter.layer(Anonymous)
  )
)

/** A host source that answers every flow with one id. */
const fixed = (executionId: string) => Flow.layerExecutionIds({ mint: () => Effect.succeed(executionId) })

const keyedFlow = (tag: string, key: string) =>
  Flow.make(tag, {
    payload: {},
    success: Schema.String,
    idempotencyKey: () => key,
    body: () => Echo.call({ value: "unused" })
  })

const ambientFlow = (tag: string) =>
  Flow.make(tag, {
    payload: { value: Schema.String },
    success: Schema.String,
    body: ({ value }) => Echo.call({ value })
  })

describe("Flow execution identities", () => {
  effect("an explicit execution id wins over the idempotency key", () =>
    Effect.gen(function*() {
      const executionId = yield* Idempotent.execute(
        { value: "same" },
        { discard: true, executionId: "caller-selected" }
      )
      expect(executionId).toBe("caller-selected")
    }).pipe(Effect.provide(IdempotentLayer)))

  effect("derives a stable deterministic id from an opt-in idempotency key", () =>
    Effect.gen(function*() {
      const first = yield* Idempotent.executionId({ value: "stable" })
      const second = yield* Idempotent.executionId({ value: "stable" })
      const other = yield* Idempotent.executionId({ value: "other" })
      expect(first).toBe(second)
      expect(first).not.toBe(other)
    }))

  effect("frames a declared flow tag and key instead of delimiter-splicing them", () =>
    Effect.gen(function*() {
      const left = keyedFlow("a-b", "c")
      const right = keyedFlow("a", "b-c")

      expect(`${left._tag}-c`).toBe(`${right._tag}-b-c`)
      const leftId = yield* left.executionId({})
      const rightId = yield* right.executionId({})
      expect(leftId).not.toBe(rightId)
      expect(leftId).toBe("a9504b44f8b6649d0d41a006af6f902532eb78b43e4a673efbc580621cb62e96")
    }))

  effect("frames the derived source's tag and canonical payload key", () =>
    Effect.gen(function*() {
      const left = ambientFlow("a-b")
      const right = ambientFlow("a")

      expect(`${left._tag}-c`).toBe(`${right._tag}-b-c`)
      expect(yield* left.executionId({ value: "c" })).not.toBe(
        yield* right.executionId({ value: "b-c" })
      )
    }).pipe(Effect.provide(Flow.layerExecutionIds(Flow.derived))))

  effect("frames empty keys without absorbing a neighboring member", () =>
    Effect.gen(function*() {
      const emptyKey = yield* keyedFlow("a-b", "").executionId({})
      const neighborKey = yield* keyedFlow("a", "b-").executionId({})

      expect(emptyKey).not.toBe(neighborKey)
    }))

  effect("hashes non-ASCII tags and keys exactly without Unicode normalization", () =>
    Effect.gen(function*() {
      const composed = keyedFlow("caf\u00e9", "cl\u00e9")
      const decomposed = keyedFlow("cafe\u0301", "cle\u0301")
      const first = yield* composed.executionId({})

      expect(yield* composed.executionId({})).toBe(first)
      expect(yield* decomposed.executionId({})).not.toBe(first)
      expect(first).toMatch(/^[0-9a-f]{64}$/)
    }))

  effect("an explicit execution id wins over the ambient source", () =>
    Effect.gen(function*() {
      const executionId = yield* Anonymous.execute(
        { value: "same" },
        { discard: true, executionId: "caller-selected" }
      )
      expect(executionId).toBe("caller-selected")
    }).pipe(Effect.provide(AnonymousLayer), Effect.provide(fixed("ambient-id"))))

  effect("a declared idempotency key wins over the ambient source", () =>
    Effect.gen(function*() {
      const derived = yield* Idempotent.executionId({ value: "same" })
      const executionId = yield* Idempotent.execute({ value: "same" }, { discard: true })
      expect(executionId).toBe(derived)
      expect(executionId).not.toBe("ambient-id")
    }).pipe(Effect.provide(IdempotentLayer), Effect.provide(fixed("ambient-id"))))

  effect("the ambient source names an execution the caller and the flow left unnamed", () =>
    Effect.gen(function*() {
      const executionId = yield* Anonymous.execute({ value: "same" }, { discard: true })
      expect(executionId).toBe("ambient-id")
    }).pipe(Effect.provide(AnonymousLayer), Effect.provide(fixed("ambient-id"))))

  effect("runs under an empty id when the host source mints one", () =>
    Effect.gen(function*() {
      const executionId = yield* Anonymous.execute({ value: "empty" }, { discard: true })
      expect(executionId).toBe("")
    }).pipe(Effect.provide(AnonymousLayer), Effect.provide(fixed(""))))

  effect(
    "refuses a host source reusing another flow's execution id",
    () =>
      Effect.gen(function*() {
        expect(yield* Anonymous.execute({ value: "left" })).toBe("left")
        const failure = yield* Effect.flip(Twin.execute({ value: "right" }))
        expect(failure).toBeInstanceOf(FlowRuntime.ExecutionIdentityConflict)
        expect(failure).toMatchObject({
          code: "execution_identity_conflict",
          executionId: "collided-id",
          field: "flow",
          expected: Anonymous._tag,
          actual: Twin._tag
        })
        expect(yield* Anonymous.execute({ value: "left" })).toBe("left")
      }).pipe(
        Effect.provide(
          layerWired(
            Layer.mergeAll(
              Echo.toLayer(({ value }) => Effect.succeed(value)),
              Interpreter.layer(Anonymous),
              Interpreter.layer(Twin)
            )
          )
        ),
        Effect.provide(fixed("collided-id"))
      )
  )
})

describe("the explicit payload-derived execution-id source", () => {
  const derivedEffect = (
    name: string,
    body: () => Effect.Effect<void, unknown, (EffectDigest.Digest | SecureRandom.SecureRandom)>
  ) => effect(name, () => body().pipe(Effect.provide(Flow.layerExecutionIds(Flow.derived))))
  derivedEffect("runs a flow that named no identity at all, and answers with its value", () =>
    Effect.gen(function*() {
      // The whole point: this is `yield* F.execute(payload)`, with no
      // executionId, no idempotencyKey, and no layer wiring identity.
      const value = yield* Anonymous.execute({ value: "unnamed" })
      expect(value).toBe("unnamed")
    }).pipe(Effect.provide(AnonymousLayer)))

  derivedEffect("derives one stable id per (flow tag, payload) pair", () =>
    Effect.gen(function*() {
      const first = yield* Anonymous.executionId({ value: "stable" })
      const second = yield* Anonymous.executionId({ value: "stable" })
      const otherPayload = yield* Anonymous.executionId({ value: "other" })
      const otherFlow = yield* Twin.executionId({ value: "stable" })
      expect(first).toBe(second)
      expect(first).not.toBe(otherPayload)
      // The tag is part of the derivation, so two flows of the same shape do
      // not share an execution.
      expect(first).not.toBe(otherFlow)
    }).pipe(Effect.provide(Flow.layerExecutionIds(Flow.derived))))

  effect("joins equal payloads when the derived source is explicitly installed", () => {
    let invoked = 0
    const layer = layerWired(
      Layer.mergeAll(
        Echo.toLayer(({ value }) =>
          Effect.sync(() => {
            invoked++
            return value
          })
        ),
        Interpreter.layer(Anonymous)
      )
    )

    return Effect.gen(function*() {
      expect(yield* Anonymous.execute({ value: "Ada" })).toBe("Ada")
      expect(yield* Anonymous.execute({ value: "Ada" })).toBe("Ada")
      expect(invoked).toBe(1)
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Flow.layerExecutionIds(Flow.derived))
    )
  })

  effect("keeps equal payloads distinct when the caller supplies execution ids", () => {
    let invoked = 0
    const layer = layerWired(
      Layer.mergeAll(
        Echo.toLayer(({ value }) =>
          Effect.sync(() => {
            invoked++
            return value
          })
        ),
        Interpreter.layer(Anonymous)
      )
    )

    return Effect.gen(function*() {
      expect(yield* Anonymous.execute({ value: "Ada" }, { executionId: "ada-1" })).toBe("Ada")
      expect(yield* Anonymous.execute({ value: "Ada" }, { executionId: "ada-2" })).toBe("Ada")
      expect(invoked).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  derivedEffect("agrees with the id execute runs under", () =>
    Effect.gen(function*() {
      const predicted = yield* Anonymous.executionId({ value: "agreed" })
      const executionId = yield* Anonymous.execute({ value: "agreed" }, { discard: true })
      expect(executionId).toBe(predicted)
    }).pipe(
      Effect.provide(AnonymousLayer),
      Effect.provide(Flow.layerExecutionIds(Flow.derived))
    ))

  /** VIP-44: a payload whose sets and maps differ only in insertion order. */
  const Release = Flow.make("ExecutionId/Release", {
    payload: {
      tags: Schema.ReadonlySet(Schema.String),
      owners: Schema.ReadonlyMap(Schema.String, Schema.ReadonlySet(Schema.String))
    },
    success: Schema.String,
    body: ({ tags }) => Echo.call({ value: [...tags].join(",") })
  })

  derivedEffect("derives one id for equal sets and maps whatever their insertion order", () =>
    Effect.gen(function*() {
      const first = yield* Release.executionId({
        tags: new Set(["a", "b"]),
        owners: new Map([["x", new Set(["1", "2"])], ["y", new Set(["3"])]])
      })
      const reordered = yield* Release.executionId({
        tags: new Set(["b", "a"]),
        owners: new Map([["y", new Set(["3"])], ["x", new Set(["2", "1"])]])
      })
      const different = yield* Release.executionId({
        tags: new Set(["a"]),
        owners: new Map([["x", new Set(["1", "2"])], ["y", new Set(["3"])]])
      })
      expect(reordered).toBe(first)
      expect(different).not.toBe(first)
    }))

  derivedEffect("keeps the id of a payload that holds no collection", () =>
    Effect.gen(function*() {
      // Pinned before VIP-44 added the sort: ids of collection-free payloads are unchanged.
      expect(yield* Anonymous.executionId({ value: "stable" })).toBe(
        "4e0ce36c0f8b5b0df75d428f7e2213ef1d093230f2fe17289ccc89e5a956e5e4"
      )
    }))

  effect("joins equal sets in one run under the derived source", () => {
    let invoked = 0
    const layer = layerWired(
      Layer.mergeAll(
        Echo.toLayer(({ value }) =>
          Effect.sync(() => {
            invoked++
            return value
          })
        ),
        Interpreter.layer(Release)
      )
    )
    return Effect.gen(function*() {
      expect(yield* Release.execute({ tags: new Set(["a", "b"]), owners: new Map() })).toBe("a,b")
      expect(yield* Release.execute({ tags: new Set(["b", "a"]), owners: new Map() })).toBe("a,b")
      expect(invoked).toBe(1)
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Flow.layerExecutionIds(Flow.derived))
    )
  })

  derivedEffect("dies before engine invocation when the payload has no canonical form", () => {
    const Unreached = Action.make("ExecutionId/unreached", {
      payload: { value: Schema.String },
      success: Schema.String
    })
    const Uncanonical = Flow.make("ExecutionId/Uncanonical", {
      payload: { value: Schema.String },
      success: Schema.String,
      body: ({ value }) => Unreached.call({ value })
    })
    let invoked = 0
    const layer = layerWired(
      Layer.mergeAll(
        Unreached.toLayer(({ value }) =>
          Effect.sync(() => {
            invoked++
            return value
          })
        ),
        Interpreter.layer(Uncanonical)
      )
    )

    return Effect.gen(function*() {
      // RFC 8785 has no form for a lone surrogate, so this invocation has no
      // derivable identity and must not open a run under a guessed one.
      const exit = yield* Uncanonical.execute({ value: "\uD800" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("ExecutionIdRequired")
      expect(invoked).toBe(0)
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Flow.layerExecutionIds(Flow.derived))
    )
  })
})
