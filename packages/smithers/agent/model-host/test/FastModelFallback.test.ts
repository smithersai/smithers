import { ModelError, type ModelEvent, ModelRequest } from "@smthrs/model"
import { Deferred, Effect, Fiber, Metric, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import { fastModelFallback } from "../src/FastModelFallback.ts"
import { fixtureRoute, inFlow } from "./fixtures/durable.ts"

const request = new ModelRequest.ModelRequest({ modelId: "gateway", system: [], messages: [], tools: [], params: {} })
const settlement = { type: "settle", stopReason: "stop" } as const
const answer = { type: "text-delta", id: "text", text: "answer" } as const

test.each(
  ["authentication", "rate_limited", "quota_exceeded", "transport", "call_timeout", "provider_internal"] as const
)("%s falls through gateway, team and coding with each source's model", async (code) => {
  const seen: string[] = []
  const fail = (modelId: string) => ({
    modelId,
    route: fixtureRoute,
    model: {
      stream: (input: ModelRequest.ModelRequest) => {
        seen.push(input.modelId)
        return Stream.fail(new ModelError.ModelError({ code, message: "fixture" }))
      }
    }
  })
  const model = fastModelFallback([fail("gateway"), fail("team"), {
    route: fixtureRoute,
    modelId: "coding",
    model: {
      stream: (input) => {
        seen.push(input.modelId)
        return Stream.fromIterable([answer, settlement])
      }
    }
  }])
  expect(await Effect.runPromise(inFlow(Stream.runCollect(model.stream(request))))).toEqual([answer, settlement])
  expect(seen).toEqual(["gateway", "team", "coding"])
})
test.each(["invalid_request", "context_overflow", "content_policy", "invalid_provider_output"] as const)(
  "%s keeps its own failure",
  async (code) => {
    let backup = false
    const error = new ModelError.ModelError({ code, message: "fixture" })
    const model = fastModelFallback([{
      route: fixtureRoute,
      modelId: "gateway",
      model: { stream: () => Stream.fail(error) }
    }, {
      route: fixtureRoute,
      modelId: "team",
      model: {
        stream: () => {
          backup = true
          return Stream.fromIterable([answer, settlement])
        }
      }
    }])
    await expect(Effect.runPromise(inFlow(Stream.runCollect(model.stream(request))))).rejects.toThrow("fixture")
    expect(backup).toBe(false)
  }
)
test("partial output is never replayed on another source", async () => {
  let backup = false
  const seen: ModelEvent.ModelEvent[] = []
  const model = fastModelFallback([{
    route: fixtureRoute,
    modelId: "gateway",
    model: {
      stream: () =>
        Stream.concat(
          Stream.succeed(answer),
          Stream.fail(new ModelError.ModelError({ code: "transport", message: "disconnected" }))
        )
    }
  }, {
    route: fixtureRoute,
    modelId: "coding",
    model: {
      stream: () => {
        backup = true
        return Stream.fromIterable([answer, settlement])
      }
    }
  }])
  await expect(Effect.runPromise(inFlow(
    Stream.runForEach(model.stream(request), (event) =>
      Effect.sync(() => {
        seen.push(event)
      }))
  ))).rejects.toThrow("disconnected")
  expect(seen).toEqual([answer])
  expect(backup).toBe(false)
})
test("the first delta reaches the sink while the provider is still open", async () => {
  await Effect.runPromise(
    inFlow(
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const seen: ModelEvent.ModelEvent[] = []
        let backup = false
        const model = fastModelFallback([{
          route: fixtureRoute,
          modelId: "gateway",
          model: {
            stream: () =>
              Stream.concat(
                Stream.succeed(answer),
                Stream.fromEffect(Effect.gen(function*() {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                  return settlement
                }))
              )
          }
        }, {
          route: fixtureRoute,
          modelId: "backup",
          model: {
            stream: () => {
              backup = true
              return Stream.fromIterable([answer, settlement])
            }
          }
        }])
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(model.stream(request), (event) =>
            Effect.sync(() => {
              seen.push(event)
            }))
        )
        yield* Deferred.await(entered)
        yield* TestClock.adjust(1000)
        expect(seen).toEqual([answer])
        expect(backup).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(fiber)
        expect(seen).toEqual([answer, settlement])
        expect(backup).toBe(false)
      }).pipe(Effect.provide(TestClock.layer()))
    )
  )
})
test("a primary answer does not spend fallback keys and calls reset independently", async () => {
  let count = 0, backup = false
  const model = fastModelFallback([{
    route: fixtureRoute,
    modelId: "gateway",
    model: {
      stream: () => {
        count++
        return Stream.fromIterable([answer, settlement])
      }
    }
  }, {
    route: fixtureRoute,
    modelId: "coding",
    model: {
      stream: () => {
        backup = true
        return Stream.fromIterable([answer, settlement])
      }
    }
  }])
  for (let i = 0; i < 2; i++) {
    expect(await Effect.runPromise(inFlow(Stream.runCollect(model.stream(request))))).toEqual([answer, settlement])
  }
  expect(count).toBe(2)
  expect(backup).toBe(false)
})

test("a ChatGPT fallback omits its unsupported output limit", async () => {
  let params: unknown
  const model = fastModelFallback([{
    route: fixtureRoute,
    modelId: "gateway",
    model: { stream: () => Stream.fail(new ModelError.ModelError({ code: "transport", message: "down" })) }
  }, {
    route: fixtureRoute,
    modelId: "chatgpt",
    outputTokenLimitSupported: false,
    model: {
      stream: (input) => {
        params = input.params
        return Stream.fromIterable([answer, settlement])
      }
    }
  }])
  await Effect.runPromise(inFlow(
    Stream.runCollect(
      model.stream(new ModelRequest.ModelRequest({ ...request, params: { maxTokens: 4096, temperature: 0.2 } }))
    )
  ))
  expect(params).toEqual({ temperature: 0.2 })
})
test("an empty host source list refuses as a missing route", async () => {
  await expect(Effect.runPromise(inFlow(Stream.runCollect(fastModelFallback([]).stream(request))))).rejects.toThrow(
    "Fast model unavailable"
  )
})

test("an unanswered fallback notification cannot hold the next model attempt", async () => {
  await Effect.runPromise(
    inFlow(
      Effect.gen(function*() {
        const metric = Metric.counter("smithers_model_host_fallback_notification_timeouts")
        const before = yield* Metric.value(metric)
        const entered = yield* Deferred.make<void>()
        let cancelled = false
        const model = fastModelFallback([
          {
            route: fixtureRoute,
            modelId: "primary",
            model: {
              stream: () => Stream.fail(new ModelError.ModelError({ code: "rate_limited", message: "capacity" }))
            }
          },
          { route: fixtureRoute, modelId: "backup", model: { stream: () => Stream.fromIterable([answer, settlement]) } }
        ], () =>
          Effect.andThen(Deferred.succeed(entered, undefined), Effect.never).pipe(
            Effect.ensuring(Effect.sync(() => {
              cancelled = true
            }))
          ))
        const fiber = yield* Effect.forkChild(Stream.runCollect(model.stream(request)))
        yield* Deferred.await(entered)
        yield* TestClock.adjust(1000)
        expect(cancelled).toBe(true)
        expect((yield* Metric.value(metric)).count).toBe(before.count + 1)
        expect(yield* Fiber.join(fiber)).toEqual([answer, settlement])
      }).pipe(Effect.provide(TestClock.layer()))
    )
  )
})
