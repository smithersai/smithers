import { describe, expect, test } from "bun:test"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Ref from "effect/Ref"
import { CLIENT_DISCONNECTED_STATUS, runRequest, UNEXPECTED_FAILURE_MESSAGE } from "./Boundary"

describe("runRequest, the native fetch boundary", () => {
  test("answers the handler's response", async () => {
    const response = await runRequest(Effect.succeed(new Response("ok", { status: 201 })))
    expect(response.status).toBe(201)
    expect(await response.text()).toBe("ok")
  })

  test("a client that disconnects interrupts the handler, runs its finalizers, and is answered 499", async () => {
    let released = false
    const controller = new AbortController()
    const handler = Effect.never.pipe(
      Effect.ensuring(Effect.sync(() => {
        released = true
      })),
      Effect.as(new Response("never"))
    )
    const pending = runRequest(handler, controller.signal)
    await Bun.sleep(5)
    controller.abort()
    const response = await pending
    expect(response.status).toBe(499)
    expect(CLIENT_DISCONNECTED_STATUS).toBe(499)
    expect(await response.json()).toEqual({ status: "error", message: "The client disconnected." })
    expect(released).toBe(true)
  })

  test("a signal already aborted before the handler starts is answered 499 without running it", async () => {
    const controller = new AbortController()
    controller.abort()
    let ran = false
    const response = await runRequest(
      Effect.sync(() => {
        ran = true
        return new Response("ran")
      }),
      controller.signal
    )
    expect(response.status).toBe(499)
    expect(ran).toBe(false)
  })

  test("a defect is logged and answered with the generic 500, never a stack trace or a hang", async () => {
    const logged: Array<unknown> = []
    const original = console.error
    console.error = (...args: Array<unknown>) => {
      logged.push(args)
    }
    try {
      const response = await runRequest(Effect.die(new Error("boom")))
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ status: "error", message: "Smithers could not complete this request. Try again in a moment." })
      expect(UNEXPECTED_FAILURE_MESSAGE).toBe("Smithers could not complete this request. Try again in a moment.")
      expect(JSON.stringify(logged.map(String))).toContain("boom")
    } finally {
      console.error = original
    }
  })

  test("a runtime carries per-isolate services across requests", async () => {
    class Counter extends Context.Service<Counter, { readonly next: Effect.Effect<number> }>()("test/Counter") {}
    const layer = Layer.effect(
      Counter,
      Effect.map(Ref.make(0), (ref) => ({ next: Ref.updateAndGet(ref, (n) => n + 1) }))
    )
    const runtime = ManagedRuntime.make(layer)
    const handler = Counter.use((counter) => Effect.map(counter.next, (n) => new Response(String(n))))
    expect(await (await runRequest(handler, undefined, runtime)).text()).toBe("1")
    expect(await (await runRequest(handler, undefined, runtime)).text()).toBe("2")
    expect(await (await runRequest(handler, undefined, ManagedRuntime.make(layer))).text()).toBe("1")
  })
})
