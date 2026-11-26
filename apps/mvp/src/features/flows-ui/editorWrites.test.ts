import { Effect, Fiber, Latch } from "effect"
import { expect, test, vi } from "vitest"
import { awaitEditorWrites, hasFailedEditorWrite, hasPendingEditorWrites, trackEditorPersistence } from "./editorWrites.vibe"

test("a PWA update waits for an editor persistence receipt and parks after one fails", async () => {
  const held = await Effect.runPromise(Latch.make(false))
  const write = Effect.runPromise(trackEditorPersistence(held.await))
  await vi.waitFor(() => expect(hasPendingEditorWrites()).toBe(true))
  let drained = false
  const barrier = awaitEditorWrites().then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  await Effect.runPromise(held.open)
  await Promise.all([write, barrier])
  expect(hasPendingEditorWrites()).toBe(false)
  expect(hasFailedEditorWrite()).toBe(false)

  const interrupted = Effect.runFork(trackEditorPersistence(Effect.never))
  await vi.waitFor(() => expect(hasPendingEditorWrites()).toBe(true))
  await Effect.runPromise(Fiber.interrupt(interrupted))
  await awaitEditorWrites()
  expect(hasFailedEditorWrite()).toBe(false)

  await expect(Effect.runPromise(trackEditorPersistence(Effect.fail(new Error("storage unavailable"))))).rejects.toThrow("storage unavailable")
  await awaitEditorWrites()
  expect(hasPendingEditorWrites()).toBe(false)
  expect(hasFailedEditorWrite()).toBe(true)
})
