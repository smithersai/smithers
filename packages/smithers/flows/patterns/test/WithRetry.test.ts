/**
 * `WithRetry` on `@smthrs/flow` declarations.
 *
 * Every assertion is the one it was: the composed name, what the declaration
 * does NOT add to the graph, which bounds are refused, and what
 * {@link WithRetry.retryEffect} spends at run time. Two readings moved:
 * `@smthrs/core`'s `flow.name` is `@smthrs/flow`'s `flow._tag`, and its
 * `flow.implementation` is the body's `Node.functionIdentity`, because a
 * `@smthrs/flow` flow's body IS its declaration.
 */
import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import * as Effects from "@smthrs/plan/Effects"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { expect, expectTypeOf } from "vitest"
import type * as Pattern from "../src/Pattern.ts"
import * as WithRetry from "../src/WithRetry.ts"

const sealed = Effects.make({
  reads: [],
  writes: [],
  mode: "hermetic",
  onConflict: "serialize",
  tier: "sealed"
})

/** The one step a retried flow wraps: an action, which is opaque work. */
const search = Action.make("withRetry/search", {
  payload: { query: Schema.String },
  success: Schema.String,
  error: Schema.Never
})

const flowOf = (
  tag: string,
  options?: {
    readonly effects?: Effects.Declaration | undefined
    readonly description?: string | undefined
  }
): Flow.Any =>
  Flow.make(tag, {
    ...(options?.description === undefined ? {} : { description: options.description }),
    payload: { query: Schema.String },
    success: Schema.String,
    error: Schema.Never,
    ...(options?.effects === undefined ? {} : { effects: options.effects }),
    body: Node.capture({ tag }, ({ query }: { readonly query: string }) => search.call({ query }))
  }) as unknown as Flow.Any

/** Everything a built graph keys on, which is what `/keys` hashes. */
const keyMaterial = (flow: Flow.Any): ReadonlyArray<unknown> =>
  Graph.nodes(Graph.build(flow, { query: "file" })).map((node) => node.draft.material)

/** The body digest `@smthrs/core` published as `flow.implementation`. */
const identity = (flow: Flow.Any): unknown => Node.functionIdentity(flow.body)

describe("WithRetry", () => {
  it("does not encode retries as success continuations", () => {
    const inner = flowOf("search", { effects: sealed })
    const retried = WithRetry.withRetry(inner, { attempts: 3 })
    const graph = Graph.build(retried, { query: "query" })

    expect(retried._tag).toBe("withRetry(search, attempts=3)")
    // One step, whatever the attempt count says, and exactly one `AndThen`:
    // the decorator marker `Pattern.decorate` records. A retry encoded as a
    // success chain would add one node per attempt.
    expect(Graph.nodes(graph).filter((node) => node.kind === "ActionCall")).toHaveLength(1)
    expect(Graph.nodes(graph).filter((node) => node.kind === "AndThen")).toHaveLength(1)
    expect(Graph.nodes(Graph.build(WithRetry.withRetry(inner, { attempts: 9 }), { query: "query" })))
      .toHaveLength(Graph.nodes(graph).length)
  })

  it("folds attempts into stable declaration identity", () => {
    const inner = flowOf("search", { effects: sealed })
    const twice = WithRetry.withRetry(inner, { attempts: 2 })
    const twiceAgain = WithRetry.withRetry(inner, { attempts: 2 })
    const three = WithRetry.withRetry(inner, { attempts: 3 })

    expect(keyMaterial(twice)).toEqual(keyMaterial(twiceAgain))
    expect(identity(twice)).not.toEqual(identity(three))
    expect(keyMaterial(twice)).not.toEqual(keyMaterial(three))
  })

  it("rejects invalid attempt bounds", () => {
    const inner = flowOf("bounded", { effects: sealed })

    expect(() => WithRetry.withRetry(inner, { attempts: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry attempts must be a positive safe integer, received 0"
      })
    )
    expect(() => WithRetry.withRetry(inner, { attempts: Number.POSITIVE_INFINITY })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry attempts must be a positive safe integer, received Infinity"
      })
    )
    expect(() => WithRetry.retryEffect(Effect.succeed("unused"), { attempts: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry attempts must be a positive safe integer, received 0"
      })
    )
  })

  it.effect("retries typed failures and propagates fiber interruption", () =>
    Effect.gen(function*() {
      let attempts = 0
      const value = yield* WithRetry.retryEffect(
        Effect.suspend(() => {
          attempts++
          return attempts < 3 ? Effect.fail("retry") : Effect.succeed("ok")
        }),
        { attempts: 3 }
      )
      expect(value).toBe("ok")
      expect(attempts).toBe(3)

      const exit = yield* Effect.exit(
        WithRetry.retryEffect(Effect.failCause(Cause.interrupt()), { attempts: 4 })
      )
      expect(exit._tag).toBe("Failure")
      expect(attempts).toBe(3)
    }))

  it("folds backoff and non-retryable tags into the name and identity", () => {
    const inner = flowOf("search", { effects: sealed })
    const plain = WithRetry.withRetry(inner, { attempts: 4 })
    const backoff = WithRetry.withRetry(inner, {
      attempts: 4,
      backoff: { initialMs: 100, factor: 2, maxMs: 250 }
    })
    const slower = WithRetry.withRetry(inner, {
      attempts: 4,
      backoff: { initialMs: 100, factor: 3, maxMs: 250 }
    })
    const guarded = WithRetry.withRetry(inner, { attempts: 4, nonRetryable: ["patterns/Fatal"] })

    expect(backoff._tag).toBe("withRetry(search, attempts=4, backoff=100x2<=250)")
    expect(guarded._tag).toBe("withRetry(search, attempts=4, nonRetryable=patterns/Fatal)")
    expect(keyMaterial(backoff)).not.toEqual(keyMaterial(plain))
    expect(keyMaterial(backoff)).not.toEqual(keyMaterial(slower))
    expect(keyMaterial(guarded)).not.toEqual(keyMaterial(plain))
  })

  it("names an unnamed inner flow anonymous", () => {
    const retried = WithRetry.withRetry(flowOf(""), { attempts: 2 })

    expect(retried._tag).toBe("withRetry(anonymous, attempts=2)")
  })

  it("carries the wrapped flow's description, and states none when it has none", () => {
    const described = WithRetry.withRetry(flowOf("search", { description: "Search the index." }), { attempts: 2 })

    expect(described.description).toBe("Search the index.")
    expect(WithRetry.withRetry(flowOf("search"), { attempts: 2 }).description).toBeUndefined()
  })

  it("rejects an invalid backoff", () => {
    const inner = flowOf("bounded", { effects: sealed })

    expect(() => WithRetry.withRetry(inner, { attempts: 2, backoff: { initialMs: 0, factor: 2, maxMs: 10 } }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry backoff initialMs must be a positive finite number, received 0"
      }))
    expect(() => WithRetry.withRetry(inner, { attempts: 2, backoff: { initialMs: 10, factor: 0.5, maxMs: 10 } }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry backoff factor must be at least 1, received 0.5"
      }))
    expect(() => WithRetry.withRetry(inner, { attempts: 2, backoff: { initialMs: 10, factor: 2, maxMs: 5 } }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry backoff maxMs must be at least initialMs, received 5"
      }))
    expect(() => WithRetry.withRetry(inner, { attempts: 2, backoff: { initialMs: Number.NaN, factor: 2, maxMs: 10 } }))
      .toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: "Retry backoff initialMs must be a positive finite number, received NaN"
      }))
  })

  it.effect("returns a single-attempt effect without retrying it", () =>
    Effect.gen(function*() {
      let attempts = 0
      const value = yield* WithRetry.retryEffect(
        Effect.sync(() => {
          attempts += 1
          return "once"
        }),
        { attempts: 1 }
      )

      expect(value).toBe("once")
      expect(attempts).toBe(1)
    }))

  // The bound on `initialMs` is "positive and finite", not "at least one
  // millisecond": the ladder is a `Duration`, which carries sub-millisecond
  // waits, and a fast test schedule is a legitimate declaration.
  it("accepts a sub-millisecond initial delay and folds it into the name", () => {
    const fast = WithRetry.withRetry(flowOf("search", { effects: sealed }), {
      attempts: 2,
      backoff: { initialMs: 0.5, factor: 2, maxMs: 10 }
    })

    expect(fast._tag).toBe("withRetry(search, attempts=2, backoff=0.5x2<=10)")
  })

  it("spaces attempts by a capped exponential backoff", () =>
    Effect.gen(function*() {
      let attempts = 0
      const fiber = yield* WithRetry.retryEffect(
        Effect.suspend(() => {
          attempts = attempts + 1
          return Effect.fail("retry")
        }),
        { attempts: 4, backoff: { initialMs: 100, factor: 2, maxMs: 250 } }
      ).pipe(Effect.forkChild({ startImmediately: true }))

      expect(attempts).toBe(1)
      yield* TestClock.adjust("99 millis")
      expect(attempts).toBe(1)
      yield* TestClock.adjust("1 millis")
      expect(attempts).toBe(2)
      yield* TestClock.adjust("199 millis")
      expect(attempts).toBe(2)
      yield* TestClock.adjust("1 millis")
      expect(attempts).toBe(3)
      yield* TestClock.adjust("249 millis")
      expect(attempts).toBe(3)
      yield* TestClock.adjust("1 millis")
      expect(attempts).toBe(4)

      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  it.effect("attempts a non-retryable failure exactly once", () =>
    Effect.gen(function*() {
      let attempts = 0
      const exit = yield* Effect.exit(
        WithRetry.retryEffect(
          Effect.suspend(() => {
            attempts = attempts + 1
            return Effect.fail({ _tag: "patterns/Fatal" })
          }),
          { attempts: 4, nonRetryable: ["patterns/Fatal"] }
        )
      )

      expect(exit._tag).toBe("Failure")
      expect(attempts).toBe(1)
    }))

  it.effect("still retries a failure whose tag is not listed", () =>
    Effect.gen(function*() {
      let attempts = 0
      const value = yield* WithRetry.retryEffect(
        Effect.suspend(() => {
          attempts = attempts + 1
          return attempts < 3 ? Effect.fail({ _tag: "patterns/Transient" }) : Effect.succeed("ok")
        }),
        { attempts: 4, nonRetryable: ["patterns/Fatal"] }
      )

      expect(value).toBe("ok")
      expect(attempts).toBe(3)
    }))

  it.effect("still retries an untagged failure when non-retryable tags are configured", () =>
    Effect.gen(function*() {
      let attempts = 0
      const value = yield* WithRetry.retryEffect(
        Effect.suspend(() => {
          attempts += 1
          return attempts === 1 ? Effect.fail("transient") : Effect.succeed("ok")
        }),
        { attempts: 2, nonRetryable: ["patterns/Fatal"] }
      )

      expect(value).toBe("ok")
      expect(attempts).toBe(2)
    }))

  it("declares the retry surface without an attempt-count type parameter", () => {
    // An attempt literal cannot reach a caller: every constructor erases it to
    // `Pattern.Decorator` or `Flow.Any`. These identities fail to compile if a
    // type parameter is threaded back through the public signatures.
    expectTypeOf(WithRetry.make).toEqualTypeOf<(options: WithRetry.Options) => Pattern.Decorator>()
    expectTypeOf(WithRetry.withRetry).toEqualTypeOf<(inner: Flow.Any, options: WithRetry.Options) => Flow.Any>()
  })
})
