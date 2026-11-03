import { ShapeSource } from "@smthrs/effect-electric"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Exit, Option } from "effect"
import { expect, test } from "vitest"
import { shapeRequest } from "./shapeRequest.ts"

test.each(["open", "delete"] as const)("%s returns a 503 immediately without retrying or consuming the response", async (stage) => {
  let calls = 0
  const refused = new Response("snapshot lock timeout", { status: 503, headers: { "retry-after": "86400" } })
  const result = await Effect.runPromise(shapeRequest("http://electric.test/v1/shape", stage).pipe(
    Effect.provideService(ShapeSource.ShapeSource, {
      request: () => Effect.sync(() => { calls++; return refused }),
    }),
    Effect.timeoutOption("100 millis"),
  ))
  expect(result).toEqual(Option.some(refused))
  expect(calls).toBe(1)
  expect(await refused.text()).toBe("snapshot lock timeout")
})

test.each([400, 401, 403, 429, 500])("a %s still reaches the fixture's original status assertion immediately", async (status) => {
  let calls = 0
  const refused = new Response("refused", { status })
  const response = await Effect.runPromise(shapeRequest("http://electric.test/v1/shape", "open").pipe(
    Effect.provideService(ShapeSource.ShapeSource, {
      request: () => Effect.sync(() => { calls++; return refused }),
    }),
  ))
  expect(response).toBe(refused)
  expect(await response.text()).toBe("refused")
  expect(calls).toBe(1)
})

test("a network failure still fails immediately", async () => {
  let calls = 0
  const failure = new ShapeSource.RequestFailed({})
  const result = await Effect.runPromise(Effect.exit(shapeRequest("http://electric.test/v1/shape", "open").pipe(
    Effect.provideService(ShapeSource.ShapeSource, {
      request: () => Effect.suspend(() => { calls++; return Effect.fail(failure) }),
    }),
  )))
  expect(result).toEqual(Exit.fail(failure))
  expect(calls).toBe(1)
})

test("a setup refusal records only a safe correlation id and leaves its body untouched", async () => {
  const { Logger } = await import("effect")
  const logs: Array<{ message: unknown; annotations: unknown }> = []
  const refused = new Response("PRIVATE", { status: 503, headers: { "x-request-id": "unsafe PRIVATE value", "set-cookie": "PRIVATE" } })
  const response = await Effect.runPromise(shapeRequest("http://electric.test/private", "open").pipe(
    Effect.provideService(ShapeSource.ShapeSource, { request: () => Effect.succeed(refused) }),
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make(options => { const line = StructuredLogger.formatStructured.log(options); logs.push({ message: line.message, annotations: line.annotations }) })])),
  ))
  expect(logs).toHaveLength(1)
  expect(JSON.stringify(logs)).not.toContain("PRIVATE")
  expect(JSON.stringify(logs)).not.toContain("http:")
  expect(await response.text()).toBe("PRIVATE")
})
