import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { BodyNotJson, BodyTooLarge, UpstreamTimeout, UpstreamUnreachable } from "./Failures"
import { fetchWithDeadline, readBoundedBytes, readBoundedJson, readText, transportLayer } from "./Http"

const encoder = new TextEncoder()

/** A body stream that never ends on its own and records a cancel. */
const pendingStream = () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    }
  })
  return { stream, cancelled: () => cancelled }
}

describe("readBoundedBytes owns the body for the read's lifetime", () => {
  test("a finished body leaves the stream unlocked", async () => {
    const response = new Response("hello")
    const stream = response.body!
    const bytes = await Effect.runPromise(readBoundedBytes(response, 100))
    expect(new TextDecoder().decode(bytes)).toBe("hello")
    expect(stream.locked).toBe(false)
  })

  test("a body past the ceiling fails BodyTooLarge, cancels the stream and unlocks it", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200))
      },
      cancel() {
        cancelled = true
      }
    })
    const exit = await Effect.runPromiseExit(readBoundedBytes(new Response(stream), 100))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("BodyTooLarge")
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  test("a declared content-length past the ceiling refuses before reading and discards the body", async () => {
    const { stream, cancelled } = pendingStream()
    const response = new Response(stream, { headers: { "content-length": "9999" } })
    const exit = await Effect.runPromiseExit(readBoundedBytes(response, 100))
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("BodyTooLarge")
    expect(cancelled()).toBe(true)
  })

  test("interrupting a pending read cancels the stream and unlocks it", async () => {
    const { stream, cancelled } = pendingStream()
    const fiber = Effect.runFork(readBoundedBytes(new Response(stream), 100))
    await Bun.sleep(10)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(cancelled()).toBe(true)
    expect(stream.locked).toBe(false)
  })

  test("an unbounded read of a body that stalls after its headers is cancelled on timeout", async () => {
    const { stream, cancelled } = pendingStream()
    const exit = await Effect.runPromiseExit(
      readText(new Response(stream)).pipe(Effect.timeoutOrElse({ duration: 20, orElse: () => Effect.succeed("timed out") }))
    )
    expect(Exit.isSuccess(exit) && exit.value).toBe("timed out")
    expect(cancelled()).toBe(true)
    expect(stream.locked).toBe(false)
  })

  test("readBoundedJson tells a non-JSON body from an oversized one", async () => {
    const notJson = await Effect.runPromiseExit(readBoundedJson(new Response("{nope"), 100))
    expect(Exit.isFailure(notJson) && String(notJson.cause)).toContain(BodyNotJson.name)
    const tooLarge = await Effect.runPromiseExit(readBoundedJson(new Response("x".repeat(101)), 100))
    expect(Exit.isFailure(tooLarge) && String(tooLarge.cause)).toContain(BodyTooLarge.name)
  })
})

describe("fetchWithDeadline bounds the headers only", () => {
  test("a body that streams past the deadline is delivered whole and never aborted", async () => {
    let aborted = false
    const impl = async (_input: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true
      })
      await Bun.sleep(5)
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 4; i++) {
              await Bun.sleep(20)
              controller.enqueue(encoder.encode("x"))
            }
            controller.close()
          }
        })
      )
    }
    const response = await Effect.runPromise(
      fetchWithDeadline("The test service", "https://upstream.test/", undefined, 40).pipe(Effect.provide(transportLayer(impl)))
    )
    expect(await response.text()).toBe("xxxx")
    expect(aborted).toBe(false)
  })

  test("headers that never arrive fail UpstreamTimeout and abort the underlying fetch", async () => {
    let aborted = false
    const impl = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        })
      })
    const exit = await Effect.runPromiseExit(
      fetchWithDeadline("The test service", "https://upstream.test/", undefined, 20).pipe(Effect.provide(transportLayer(impl)))
    )
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain(UpstreamTimeout.name)
    expect(aborted).toBe(true)
  })

  test("a connection failure is UpstreamUnreachable with the seam's name", async () => {
    const impl = async () => {
      throw new Error("ECONNREFUSED")
    }
    const exit = await Effect.runPromiseExit(
      fetchWithDeadline("The identity service", "https://upstream.test/", undefined, 20).pipe(Effect.provide(transportLayer(impl)))
    )
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain(UpstreamUnreachable.name)
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("ECONNREFUSED")
  })

  test("the caller's own signal is joined with the fiber's", async () => {
    let seen: AbortSignal | null | undefined
    const impl = async (_input: unknown, init?: RequestInit) => {
      seen = init?.signal
      return new Response("ok")
    }
    const own = new AbortController()
    await Effect.runPromise(
      fetchWithDeadline("t", "https://upstream.test/", { signal: own.signal }, 20).pipe(Effect.provide(transportLayer(impl)))
    )
    expect(seen?.aborted).toBe(false)
    own.abort()
    expect(seen?.aborted).toBe(true)
  })

  test("a caller whose signal is already aborted is refused without a request ever leaving", async () => {
    let calls = 0
    const impl = async () => {
      calls += 1
      return new Response("ok")
    }
    const gone = new AbortController()
    gone.abort(new Error("client left"))
    const exit = await Effect.runPromiseExit(
      fetchWithDeadline("t", "https://upstream.test/", { signal: gone.signal }, 20).pipe(Effect.provide(transportLayer(impl)))
    )
    expect(calls).toBe(0)
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain(UpstreamUnreachable.name)
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("client left")
  })
})
