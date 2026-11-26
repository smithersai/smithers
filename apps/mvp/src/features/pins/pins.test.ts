import { Flow } from "@smthrs/flow"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Context, Effect, Schema } from "effect"
import { expect, test } from "vitest"
import { ChatPin, ChatUnpin } from "./flows"
import { Pin, Pending } from "./schema"
import { pinnedQuery } from "./store.vibe"
import { Message } from "../chat/schema"

test("pin and unpin are agent-callable flows; pin defaults to the previous answer", () => {
  expect(ChatPin._tag).toBe("chat/pin")
  expect(ChatUnpin._tag).toBe("chat/unpin")
  expect(Context.get(ChatPin.annotations, Flow.ModelInvocable)).toBe(true)
  expect(Context.get(ChatUnpin.annotations, Flow.ModelInvocable)).toBe(true)
  expect(Schema.decodeUnknownSync(ChatPin.payloadSchema)({})).toEqual({})
  expect(() => Schema.decodeUnknownSync(ChatPin.payloadSchema)({ messageId: "bad" })).toThrow()
})

test("pinned copy reads the whole collection, follows replacement, text updates and unpin", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const pins = yield* Collection.local({ id: "unit-pins", schema: Pin, getKey: r => r.conversationId })
    const messages = yield* Collection.local({ id: "unit-messages", schema: Message, getKey: r => r.id })
    const query = yield* pinnedQuery(pins, messages)
    query.tanstack.startSyncImmediate()
    const row = { id: "a", conversationId: "home", role: "assistant" as const, text: "First", status: "done" as const,
      questionId: null, failure: null, modelId: null, stopReason: null, inputTokens: null, outputTokens: null,
      position: 1, createdAt: "", updatedAt: "" }
    yield* messages.insert([row, { ...row, id: "b", role: "user", text: "Second", position: 2 }])
    expect(query.tanstack.toArray).toEqual([])
    yield* pins.insert({ conversationId: "home", personId: "me", messageId: "a", changedAt: "" })
    expect(query.tanstack.toArray.map(r => r.text)).toEqual(["First"])
    yield* messages.update("a", r => { r.text = "First revised" })
    expect(query.tanstack.toArray.map(r => r.text)).toEqual(["First revised"])
    yield* pins.update("home", r => { r.messageId = "b" })
    expect(query.tanstack.toArray.map(r => r.text)).toEqual(["Second"])
    yield* pins.update("home", r => { r.messageId = null })
    expect(query.tanstack.toArray).toEqual([])
  })))
})

test("an unadmitted pinned question keeps its local copy until unpin, even when its original is taken back", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const pins = yield* Collection.local({ id: "local-pins", schema: Pin, getKey: r => r.conversationId })
    const messages = yield* Collection.local({ id: "local-messages", schema: Message, getKey: r => r.id })
    const pending = yield* Collection.local({ id: "local-pin-intents", schema: Pending, getKey: r => r.conversationId })
    const query = yield* pinnedQuery(pins, messages, pending)
    query.tanstack.startSyncImmediate()
    yield* pending.insert({ conversationId: "home", personId: "", messageId: "local", changedAt: "", at: 1, home: true, failed: false, awaitAdmission: true, text: "Still here" })
    expect(query.tanstack.toArray.map(r => r.text)).toEqual(["Still here"])
    yield* pins.insert({ conversationId: "home", personId: "me", messageId: "local", changedAt: "" })
    yield* messages.insert({ id: "local", role: "user", text: "Different synced content", status: "done", questionId: null, failure: null, modelId: null, stopReason: null,
      inputTokens: null, outputTokens: null, position: 1, createdAt: "", updatedAt: "" })
    expect(query.tanstack.toArray.map(r => r.text)).toEqual(["Still here"])
    yield* pins.update("home", row => { row.messageId = null })
    yield* pending.update("home", row => { row.messageId = null; row.awaitAdmission = false })
    expect(query.tanstack.toArray).toEqual([])
  })))
})
