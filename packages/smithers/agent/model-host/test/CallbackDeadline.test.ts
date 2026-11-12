/** Every callback a turn waits on ends at the callback deadline, headers and body alike. */
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import { environmentModelResolver } from "../src/EnvironmentResolver.ts"
import { CHAT_CALLBACK_DEADLINE_MS } from "../src/internal/CallbackDeadline.ts"
import type { DurableChatGrant } from "./fixtures/durable.ts"
import { apiCaller, sourceLister, sourceReader } from "./fixtures/durable.ts"

const grant: DurableChatGrant = {
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 1,
  token: "fixture-token",
  cursor: { version: 1, runId: "run", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) },
  expiresAt: "2100-01-01",
  producerBaseUrl: "https://callback.test",
  installOrigin: "http://127.0.0.1:4567",
  api: { author: "ben", token: "smithers_" + "a".repeat(40) },
  request: {
    runId: "run",
    instructions: "answer",
    messages: [{ role: "user", content: "hi" }],
    sharedConversation: true
  }
}

/**
 * A callback that never finishes, as `fetch` behaves: aborting its signal
 * rejects the request, or errors a body it already started. `entered` settles
 * once the stalled stage is waiting.
 */
const stalled = (stage: "headers" | "body") => {
  let signal: AbortSignal | undefined
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const request = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      signal = init!.signal!
      signal.addEventListener("abort", () => reject(signal!.reason), { once: true })
      if (stage === "headers") return enter()
      const body = new ReadableStream<Uint8Array>({
        start: (controller) =>
          signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true }),
        pull: () => enter()
      })
      resolve(new Response(body, { headers: { "content-type": "application/x-ndjson" } }))
    })
  const fetchImpl: typeof fetch = Object.assign(request, { preconnect: globalThis.fetch.preconnect })
  return { fetchImpl, entered, aborted: () => signal?.aborted }
}

/** Runs one callback to its deadline on the test clock and returns its outcome. */
const atDeadline = <A, E>(
  call: Effect.Effect<A, E>,
  entered: Promise<void>
): Promise<{ readonly _tag: "Success"; readonly value: A } | { readonly _tag: "Failure"; readonly error: E }> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.result(call))
      yield* Effect.promise(() => entered)
      yield* TestClock.adjust(CHAT_CALLBACK_DEADLINE_MS - 1)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      const result = yield* Fiber.join(fiber)
      return result._tag === "Success"
        ? { _tag: "Success" as const, value: result.success }
        : { _tag: "Failure" as const, error: result.failure }
    }).pipe(Effect.provide(TestClock.layer()))
  )

const binding = { protocol: "openai-chat", baseUrl: "https://fixture.test", modelId: "fixture", credential: "FIXTURE" }
const env = { SMITHERS_MODEL_KEY_FIXTURE: "fixture-key", SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://fixture.test" }

test.each(["headers", "body"] as const)(
  "a shared conversation's context callback that stalls its %s fails resolution at the deadline",
  async (stage) => {
    const callback = stalled(stage)
    const outcome = await atDeadline(
      environmentModelResolver({ binding, env, fetchImpl: callback.fetchImpl })(grant),
      callback.entered
    )
    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" && outcome.error.message).toBe("configured model route is unavailable")
    expect(callback.aborted()).toBe(true)
  }
)

const callbacks: ReadonlyArray<readonly [string, (fetchImpl: typeof fetch) => Effect.Effect<unknown>]> = [
  ["source read", (fetchImpl) => sourceReader("http://callback.test", grant, fetchImpl)("a.ts")],
  ["source list", (fetchImpl) => sourceLister("http://callback.test", grant, fetchImpl)("")],
  ["API", (fetchImpl) => apiCaller("http://callback.test", grant, fetchImpl)("/api/todos")]
]

test.each(callbacks.flatMap(([name, call]) => [[name, "headers", call], [name, "body", call]] as const))(
  "a %s callback that stalls its %s answers timed_out at the deadline",
  async (_name, stage, call) => {
    const callback = stalled(stage)
    expect(await atDeadline(call(callback.fetchImpl), callback.entered)).toEqual({
      _tag: "Success",
      value: { code: "timed_out" }
    })
    expect(callback.aborted()).toBe(true)
  }
)
