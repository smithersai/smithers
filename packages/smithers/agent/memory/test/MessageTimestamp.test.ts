import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import { run } from "./fixtures/MemoryStoreHarness.ts"

it("atomically defaults message time across later and overlapping appends while preserving conflicts", async () => {
  const result = await run(Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const input = { threadId: "history", id: "message", role: "user", text: "hello" }
    const first = yield* store.appendMessageOnce(input)
    yield* TestClock.adjust(100)
    const later = yield* store.appendMessageOnce(input)
    const overlapping = yield* Effect.all(
      Array.from({ length: 8 }, () => store.appendMessageOnce({ ...input, id: "overlap" })),
      { concurrency: "unbounded" }
    )
    const conflicts = yield* Effect.forEach([
      { ...input, text: "changed" },
      { ...input, role: "assistant" },
      { ...input, at: first.at + 1 },
      { ...input, at: -1 }
    ], (entry) => Effect.flip(store.appendMessageOnce(entry)))
    const missingAt = yield* store.appendMessage(input as MemoryStore.AppendMessageInput).pipe(Effect.flip)
    yield* store.appendMessage({ ...input, at: first.at })
    return {
      first,
      later,
      overlapping,
      conflicts,
      missingAt,
      messages: yield* store.listMessages({ threadId: input.threadId })
    }
  }))
  expect(result.first.at).toBe(0)
  expect(result.later).toEqual(result.first)
  expect(result.overlapping).toHaveLength(8)
  expect(result.overlapping.every((message) => message.at === 100)).toBe(true)
  expect(result.messages).toHaveLength(2)
  expect(result.conflicts.map((error) => error.code)).toEqual([
    "idempotency_conflict",
    "idempotency_conflict",
    "idempotency_conflict",
    "invalid_argument"
  ])
  expect(result.missingAt.code).toBe("invalid_argument")
})
