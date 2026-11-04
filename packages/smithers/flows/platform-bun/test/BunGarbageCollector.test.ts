import { describe, expect, it } from "@effect/vitest"
import { MicrosandboxSandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import { afterEach, vi } from "vitest"
import * as BunGarbageCollector from "../src/BunGarbageCollector.vibe"

const onBun = process.versions.bun !== undefined

/** A reference to an object nothing else holds, made in an earlier job so the runtime does not keep it alive for this one. */
const unreachable = async (): Promise<WeakRef<object>> => {
  const reference = new WeakRef({ payload: Array.from({ length: 1024 }, (_, index) => index) })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return reference
}

describe("BunGarbageCollector", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.runIf(onBun)("collects the whole heap through Bun's own collector", async () => {
    const reference = await unreachable()
    await Effect.runPromise(BunGarbageCollector.collector.collect)
    expect(reference.deref()).toBeUndefined()
  })

  it.skipIf(onBun)("asks Bun's global for a synchronous collection", async () => {
    const calls: Array<boolean> = []
    vi.stubGlobal("Bun", { gc: (force: boolean) => calls.push(force) })
    await Effect.runPromise(BunGarbageCollector.collector.collect)
    expect(calls).toEqual([true])
  })

  it.effect("provides the one process-wide collector, so every provider counts toward the same collections", () =>
    Effect.gen(function*() {
      expect(yield* MicrosandboxSandbox.GarbageCollector).toBe(BunGarbageCollector.collector)
    }).pipe(Effect.provide(BunGarbageCollector.layer)))
})
