import { Effect } from "effect"
import { expect, test } from "vitest"
import { openProviderResource, waitForDispatch } from "./session-lifecycle.ts"

test("closing the provider runs its scope finalizers exactly once", async () => {
  let closed = 0
  const provider = await openProviderResource(Effect.acquireRelease(
    Effect.succeed("provider"),
    () => Effect.sync(() => { closed++ }),
  ))
  expect(provider.value).toBe("provider")
  expect(closed).toBe(0)
  await provider.close()
  await provider.close()
  expect(closed).toBe(1)
})

test("dispatch rejection is handled while a question poll is pending", async () => {
  const unhandled: unknown[] = []
  const listener = (error: unknown) => { unhandled.push(error) }
  process.on("unhandledRejection", listener)
  try {
    const result = waitForDispatch(Effect.fail(new Error("dispatch refused")), Effect.sleep("30 millis"), 500, "1 millis")
    await expect(result).rejects.toThrow("dispatch refused")
    expect(unhandled).toEqual([])
  } finally { process.off("unhandledRejection", listener) }
})

test("dispatch rejection stays handled after the trial times out", async () => {
  const unhandled: unknown[] = []
  const listener = (error: unknown) => { unhandled.push(error) }
  process.on("unhandledRejection", listener)
  try {
    const dispatch = Effect.sleep("40 millis").pipe(Effect.andThen(Effect.fail(new Error("late refusal"))))
    expect(await waitForDispatch(dispatch, Effect.void, 1, "5 millis")).toBe(false)
    await Effect.runPromise(Effect.sleep("60 millis"))
    expect(unhandled).toEqual([])
  } finally { process.off("unhandledRejection", listener) }
})

test("a completed dispatch returns and a failed poll propagates", async () => {
  expect(await waitForDispatch(Effect.void, Effect.void, 500, "1 millis")).toBe(true)
  await expect(waitForDispatch(Effect.sleep("10 millis"), Effect.fail(new Error("poll failed")), 500))
    .rejects.toThrow("poll failed")
})


test("provider acquisition failure also closes resources already acquired", async () => {
  let closed = 0
  const resource = Effect.acquireRelease(Effect.void, () => Effect.sync(() => { closed++ })).pipe(
    Effect.andThen(Effect.fail(new Error("provider failed"))),
  )
  await expect(openProviderResource(resource)).rejects.toThrow("provider failed")
  expect(closed).toBe(1)
})
