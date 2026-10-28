import { PendingSnapshot } from "@smthrs/platform-browser"
import { Context, Effect, Layer, Option } from "effect"
import { expect, test } from "vitest"
import { beginAdmission, executionOf, finishAdmission, settledEngineInputs, whileAdmitting, WriteIntents, type WriteIntent } from "./writeAdmission"

const intent = (commandId: string, flow = "issue/comment"): WriteIntent => ({ commandId, flow, payload: { repo: "private/name", body: "private content" } })
const device = () => {
  const data = new Map<string, string>()
  const state = { refused: false, owner: "person-a" as string | undefined }
  const snapshot = PendingSnapshot.make({ getItem: key => data.get(key) ?? null, setItem: (key, value) => {
    if (state.refused) throw new Error("quota")
    data.set(key, value)
  }, removeItem: key => { data.delete(key) } }, "pending", () => state.owner)
  return { data, state, snapshot }
}
const storeOf = (snapshot?: PendingSnapshot.Service) => Effect.runPromise(Effect.scoped(Effect.map(Layer.build(WriteIntents.layer(snapshot)), context => Context.get(context, WriteIntents))))

test("a pending input survives a page restart before any asynchronous admission receipt", async () => {
  const host = device()
  const before = await storeOf(host.snapshot)
  const receipt = Effect.runSync(beginAdmission("issue/comment", { repo: "private/name", number: 1, body: "private content" }).pipe(Effect.provideService(WriteIntents, before)))
  expect(Option.isSome(receipt)).toBe(true)
  const reopened = await storeOf(host.snapshot)
  expect(reopened.pending()).toEqual([Option.getOrThrow(receipt)])
  expect(await Effect.runPromise(executionOf(Option.getOrThrow(receipt)))).toBe(Option.getOrThrow(receipt).commandId)
  await Effect.runPromise(finishAdmission(Option.getOrThrow(receipt), false).pipe(Effect.provideService(WriteIntents, reopened)))
  expect(reopened.pending()).toHaveLength(1)
  await Effect.runPromise(finishAdmission(Option.getOrThrow(receipt), true).pipe(Effect.provideService(WriteIntents, reopened)))
  expect((await storeOf(host.snapshot)).pending()).toEqual([])
})

test("receipts clear their own inputs and cannot erase a newer command", async () => {
  const host = device()
  const store = await storeOf(host.snapshot)
  expect(store.retain(intent("a"))).toBe(true)
  expect(store.retain(intent("b"))).toBe(true)
  expect(store.retain({ ...intent("a"), payload: { number: 1 } })).toBe(true)
  expect(store.pending().map(row => row.commandId)).toEqual(["b", "a"])
  store.forget("a")
  expect(store.pending()).toEqual([intent("b")])
  host.state.refused = true
  store.forget("absent")
  expect(store.pending()).toEqual([intent("b")])
  host.state.refused = false
  store.forget("b")
  store.forget("b")
  expect(host.data.size).toBe(0)
})

test("a Create retains navigation recovery after outbox admission", async () => {
  const host = device()
  const store = await storeOf(host.snapshot)
  const row = { ...intent("create", "issue/create"), draftId: "new-issue-form" }
  store.retain(row)
  await Effect.runPromise(finishAdmission(row, true).pipe(Effect.provideService(WriteIntents, store)))
  expect((await storeOf(host.snapshot)).pending()).toEqual([expect.objectContaining(row)])
})

test("storage refusal refuses the input, and ownership fences a previous person's payload", async () => {
  const host = device()
  const store = await storeOf(host.snapshot)
  host.state.refused = true
  expect(Effect.runSync(beginAdmission("issue/comment", {}).pipe(Effect.provideService(WriteIntents, store)))).toEqual(Option.none())
  host.state.refused = false
  store.retain(intent("a"))
  host.state.owner = "person-b"
  expect(store.pending()).toEqual([])
  host.state.owner = undefined
  expect(store.retain(intent("b"))).toBe(false)
  host.state.owner = "person-a"
  expect(store.pending()).toEqual([intent("a")])
  host.data.set("pending", "malformed")
  expect(store.pending()).toEqual([])
  host.data.set("pending", JSON.stringify({ owner: "person-a", value: [{}] }))
  expect(store.pending()).toEqual([])
})

test("non-browser hosts retain existing boundaries and deterministic identities replay unchanged", async () => {
  const store = await storeOf()
  expect(store.retain(intent("none"))).toBe(true)
  store.forget("none")
  expect(store.pending()).toEqual([])
  const receipt = Option.getOrThrow(Effect.runSync(beginAdmission("todo/commit", {}, { namespace: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", value: "same snapshot" }, "draft")))
  expect(receipt.draftId).toBe("draft")
  const first = await Effect.runPromise(executionOf(receipt))
  expect(await Effect.runPromise(executionOf(receipt))).toBe(first)
  await Effect.runPromise(finishAdmission(receipt, true))
  expect(Option.isSome(Effect.runSync(beginAdmission("issue/create", {})))).toBe(true)
})

test("Edit and Discard retire exactly the original identity, and refuse a failed cleanup", async () => {
  const { Uuid, WebCrypto } = await import("@smthrs/crypto")
  const { forgetAdmission, identifyAdmission } = await import("./writeAdmission")
  const namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
  const host = device()
  const store = await storeOf(host.snapshot)
  const row = intent(crypto.randomUUID())
  const id = await Effect.runPromise(Uuid.v5(namespace, row.commandId).pipe(Effect.provide(WebCrypto.layer)))
  store.retain(row)
  await Effect.runPromise(identifyAdmission(row, row.commandId, id).pipe(Effect.provideService(WriteIntents, store)))
  store.retain(intent("later"))
  host.state.refused = true
  expect(await Effect.runPromise(forgetAdmission(namespace, id).pipe(Effect.provideService(WriteIntents, store)))).toBe(false)
  expect(store.pending()).toHaveLength(2)
  host.state.refused = false
  expect(await Effect.runPromise(forgetAdmission(namespace, id).pipe(Effect.provideService(WriteIntents, store)))).toBe(true)
  expect(store.pending()).toEqual([intent("later")])
  expect(await Effect.runPromise(forgetAdmission(namespace, "absent").pipe(Effect.provideService(WriteIntents, store)))).toBe(true)
  expect(await Effect.runPromise(forgetAdmission(namespace, "absent"))).toBe(true)
})

test("receipt instrumentation preserves successes, typed failures and cancellation", async () => {
  const { admissionReceipt } = await import("./writeAdmission")
  expect(await Effect.runPromise(admissionReceipt(Effect.succeed(7), "command", "issue/comment", "engine"))).toBe(7)
  expect(await Effect.runPromise(admissionReceipt(Effect.fail("refused"), "command", "issue/comment", "engine").pipe(Effect.flip))).toBe("refused")
  const exit = await Effect.runPromiseExit(admissionReceipt(Effect.interrupt, "command", "issue/comment", "engine"))
  expect(exit._tag).toBe("Failure")
})


test("a browser without a stable reload identity refuses staging", async () => {
  const store = await Effect.runPromise(Effect.scoped(Effect.map(Layer.build(WriteIntents.layer(undefined, false)), context => Context.get(context, WriteIntents))))
  expect(store.retain(intent("unstable"))).toBe(false)
})

test("navigation before admission or cleanup cannot retire a Create receipt", async () => {
  const { acknowledgeNavigation, identifyAdmission } = await import("./writeAdmission")
  const host = device()
  const store = await storeOf(host.snapshot)
  const row = { ...intent("creation", "issue/create"), draftId: "new-issue-form" }
  store.retain(row)
  await Effect.runPromise(identifyAdmission(row, row.commandId, "write").pipe(Effect.provideService(WriteIntents, store)))
  await Effect.runPromise(acknowledgeNavigation("unrelated").pipe(Effect.provideService(WriteIntents, store)))
  await Effect.runPromise(acknowledgeNavigation("write").pipe(Effect.provideService(WriteIntents, store)))
  expect((await storeOf(host.snapshot)).pending()).toHaveLength(1)
  await Effect.runPromise(finishAdmission(row, true, false).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.pending()).toHaveLength(1)
  await Effect.runPromise(finishAdmission(row, false).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.pending()[0]).toMatchObject({ admitted: true, cleaned: false })
  await Effect.runPromise(finishAdmission(row, true, true).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.pending()).toEqual([])
  store.retain(row)
  await Effect.runPromise(identifyAdmission(row, row.commandId, "write").pipe(Effect.provideService(WriteIntents, store)))
  await Effect.runPromise(finishAdmission(row, true).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.pending()).toHaveLength(1)
  await Effect.runPromise(acknowledgeNavigation("write").pipe(Effect.provideService(WriteIntents, store)))
  expect(store.pending()).toEqual([])
  await Effect.runPromise(acknowledgeNavigation("absent"))
  await Effect.runPromise(identifyAdmission(row, "execution", "write"))
})

test("Discard remains synchronous and fences running admission for its write or source draft", async () => {
  const { forgetAdmission, forgetDraftAdmissions, identifyAdmission } = await import("./writeAdmission")
  const host = device()
  const store = await storeOf(host.snapshot)
  const row = Option.getOrThrow(Effect.runSync(beginAdmission("todo/commit", {}, undefined, "draft").pipe(Effect.provideService(WriteIntents, store))))
  await Effect.runPromise(identifyAdmission(row, "execution", "write").pipe(Effect.provideService(WriteIntents, store)))
  expect(Effect.runSync(forgetAdmission("namespace", "write").pipe(Effect.provideService(WriteIntents, store)))).toBe(false)
  expect(Effect.runSync(forgetDraftAdmissions("draft").pipe(Effect.provideService(WriteIntents, store)))).toBe(false)
  await Effect.runPromise(finishAdmission(row, false).pipe(Effect.provideService(WriteIntents, store)))
  expect(Effect.runSync(forgetDraftAdmissions("draft").pipe(Effect.provideService(WriteIntents, store)))).toBe(true)
  expect(store.pending()).toEqual([])
  expect(Effect.runSync(forgetDraftAdmissions("absent"))).toBe(true)
  expect(Effect.runSync(forgetDraftAdmissions("absent").pipe(Effect.provideService(WriteIntents, store)))).toBe(true)
})

test("repeated admission of the same source joins its original identity; independent inputs stay distinct", async () => {
  const host = device()
  const store = await storeOf(host.snapshot)
  const begin = (payload: Record<string, unknown>, draftId?: string, composer?: WriteIntent["composer"]) => Option.getOrThrow(Effect.runSync(beginAdmission("issue/comment", payload, undefined, draftId, composer).pipe(Effect.provideService(WriteIntents, store))))
  const first = begin({ body: "Same", number: 7, optional: undefined }, "draft")
  const again = begin({ number: 7, body: "Same" }, "draft")
  expect(again.commandId).toBe(first.commandId)
  expect(store.admitting.get(first.commandId)).toBe(2)
  await Effect.runPromise(finishAdmission(first, false).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.admitting.get(first.commandId)).toBe(1)
  await Effect.runPromise(finishAdmission(again, false).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.admitting.has(first.commandId)).toBe(false)
  expect(begin({ body: "New", number: 7 }, "draft").commandId).not.toBe(first.commandId)
  expect(begin({ body: "Same" }, "draft").commandId).not.toBe(first.commandId)
  expect(begin({ body: "Same", number: 7 }, "other").commandId).not.toBe(first.commandId)
  const slash = begin({ body: "Slash" }, undefined, { conversationId: null, text: "/comment" })
  expect(begin({ body: "Slash" }, undefined, { conversationId: null, text: "/comment" }).commandId).toBe(slash.commandId)
  expect(begin({ body: "Slash" }, undefined, { conversationId: "other", text: "/comment" }).commandId).not.toBe(slash.commandId)
  expect(begin({ body: "Slash" }, undefined, { conversationId: null, text: "/new" }).commandId).not.toBe(slash.commandId)
  expect(begin({ body: "Slash" }).commandId).not.toBe(slash.commandId)
})

test("explicit admissions fence legacy writes and release on success, failure and interruption", async () => {
  const { Deferred, Fiber } = await import("effect")
  const { finishRetainedAdmission, forgetDraftAdmissions, identifyAdmission, whileAdmitting } = await import("./writeAdmission")
  const host = device()
  const store = await storeOf(host.snapshot)
  expect(await Effect.runPromise(whileAdmitting("legacy", Effect.succeed(7)))).toBe(7)
  await Effect.runPromise(finishRetainedAdmission("none", true, true))
  await Effect.runPromise(finishRetainedAdmission("none", true, true).pipe(Effect.provideService(WriteIntents, store)))
  const row = Option.getOrThrow(Effect.runSync(beginAdmission("todo/commit", {}, undefined, "draft").pipe(Effect.provideService(WriteIntents, store))))
  await Effect.runPromise(identifyAdmission(row, row.commandId, "write").pipe(Effect.provideService(WriteIntents, store)))
  await Effect.runPromise(finishAdmission(row, false).pipe(Effect.provideService(WriteIntents, store)))
  const gate = await Effect.runPromise(Deferred.make<void>())
  const first = Effect.runFork(whileAdmitting("write", Deferred.await(gate)).pipe(Effect.provideService(WriteIntents, store)))
  const second = Effect.runFork(whileAdmitting("write", Deferred.await(gate)).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.admitting.get("write")).toBe(2)
  expect(Effect.runSync(forgetDraftAdmissions("draft").pipe(Effect.provideService(WriteIntents, store)))).toBe(false)
  await Effect.runPromise(Fiber.interrupt(first))
  expect(store.admitting.get("write")).toBe(1)
  await Effect.runPromise(Deferred.succeed(gate, undefined))
  await Effect.runPromise(Fiber.join(second))
  expect(store.admitting.has("write")).toBe(false)
  expect(await Effect.runPromise(whileAdmitting("write", Effect.fail("refused")).pipe(Effect.provideService(WriteIntents, store), Effect.flip))).toBe("refused")
  expect(store.admitting.has("write")).toBe(false)
  await Effect.runPromise(finishRetainedAdmission("write", false, false).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.pending()).toHaveLength(1)
  await Effect.runPromise(finishRetainedAdmission("write", true, true).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.pending()).toEqual([])
})

test("identical content in a new composer generation is an independent press", async () => {
  const store = await storeOf(device().snapshot)
  const begin = (generation: string) => Option.getOrThrow(Effect.runSync(beginAdmission("issue/comment", { body: "Same" }, undefined, undefined, { conversationId: null, text: "/comment", generation }).pipe(Effect.provideService(WriteIntents, store))))
  const first = begin("first")
  expect(begin("first").commandId).toBe(first.commandId)
  expect(begin("second").commandId).not.toBe(first.commandId)
})

test("a refused identity update still fences and completes Retry through its in-memory correlation", async () => {
  const { Deferred, Fiber } = await import("effect")
  const { finishRetainedAdmission, forgetDraftAdmissions, identifyAdmission, whileAdmitting } = await import("./writeAdmission")
  const host = device()
  const store = await storeOf(host.snapshot)
  const provide = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provideService(WriteIntents, store))
  const row = Option.getOrThrow(Effect.runSync(provide(beginAdmission("todo/commit", {}, undefined, "source"))))
  host.state.refused = true
  await Effect.runPromise(provide(identifyAdmission(row, row.commandId, "write")))
  expect(store.pending()[0]!.writeId).toBeUndefined()
  host.state.refused = false
  await Effect.runPromise(provide(finishAdmission(row, false)))
  await Effect.runPromise(provide(finishRetainedAdmission("unrelated", true, true)))
  const gate = await Effect.runPromise(Deferred.make<void>())
  const fiber = Effect.runFork(provide(whileAdmitting("write", Deferred.await(gate))))
  expect(Effect.runSync(provide(forgetDraftAdmissions("source")))).toBe(false)
  await Effect.runPromise(Fiber.interrupt(fiber))
  await Effect.runPromise(provide(finishRetainedAdmission("write", true, true)))
  expect(store.pending()).toEqual([])
})


test("a slash-created issue retires after delivery and cleanup without a navigation receipt", async () => {
  const host = device()
  const store = await storeOf(host.snapshot)
  const row = { ...intent("slash-create", "issue/create"), composer: { conversationId: null, text: "/issue owner/repo title" } }
  store.retain(row)
  await Effect.runPromise(finishAdmission(row, true, false).pipe(Effect.provideService(WriteIntents, store)))
  expect((await storeOf(host.snapshot)).pending()).toHaveLength(1)
  await Effect.runPromise(finishAdmission(row, true, true).pipe(Effect.provideService(WriteIntents, store)))
  expect((await storeOf(host.snapshot)).pending()).toEqual([])
})

test("an engine operation's input is the feed's to settle once its run did; a tab that can't stage it keeps it in memory", async () => {
  const host = device()
  const store = await storeOf(host.snapshot)
  const engine = (commandId: string, fields: Partial<WriteIntent> = {}): WriteIntent => ({ ...intent(commandId, "todo/issue"), executionId: `exec-${commandId}`, ...fields })
  for (const row of [engine("done"), engine("failed"), engine("running"), { ...intent("outbox", "issue/create"), executionId: "exec-outbox" }]) {
    expect(store.retain(row)).toBe(true)
  }
  // Admission alone retires no engine operation's input.
  const admitting = Option.getOrThrow(await Effect.runPromise(beginAdmission("todo/issue", { repo: "a/b", issue: 9 }).pipe(Effect.provideService(WriteIntents, store))))
  store.update(admitting.commandId, { executionId: "exec-admitting" })
  const results = new Map([["run:exec-done", "done"], ["run:exec-failed", "failed"], ["run:exec-admitting", "done"], ["run:exec-outbox", "done"]] as const)
  expect(settledEngineInputs(store, results).map(({ intent, state }) => [intent.commandId, state])).toEqual([["done", "done"], ["failed", "failed"]])
  await Effect.runPromise(finishAdmission(admitting, true).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.pending().map((row) => row.commandId)).toContain(admitting.commandId)
  // Session storage that refuses: only an engine operation's input is kept, in memory, and goes with forget.
  host.state.refused = true
  expect(store.retain(intent("write", "issue/create"))).toBe(false)
  expect(store.retain(engine("memory"))).toBe(true)
  expect(store.pending().map((row) => row.commandId)).toContain("memory")
  expect(store.update("memory", { admitted: true })).toBe(true)
  expect(store.pending().find((row) => row.commandId === "memory")).toMatchObject({ admitted: true })
  expect(store.forget("memory")).toBe(true)
  expect(store.pending().map((row) => row.commandId)).not.toContain("memory")
  // Once storage works again, the input moves back to it.
  expect(store.retain(engine("back"))).toBe(true)
  host.state.refused = false
  expect(store.retain(engine("back", { admitted: true }))).toBe(true)
  expect((await storeOf(host.snapshot)).pending().map((row) => row.commandId)).toContain("back")
})

test("each attempt speaks for its command: a new one clears the last refusal, and a refusal while another attempt runs says nothing (decision 0124)", async () => {
  const store = await storeOf(device().snapshot)
  const run = <A>(effect: Effect.Effect<A, never, WriteIntents>) => Effect.runPromise(effect.pipe(Effect.provideService(WriteIntents, store)))
  const first = Option.getOrThrow(await run(beginAdmission("todo/issue", { repo: "a/b", issue: 1 }, undefined, "make:1")))
  await run(finishAdmission(first, false))
  expect(store.refused.has(first.commandId)).toBe(true)
  // Try again: the new attempt's reply never comes. Nothing proves the old refusal still holds.
  const again = Option.getOrThrow(await run(beginAdmission("todo/issue", { repo: "a/b", issue: 1 }, undefined, "make:1")))
  expect(again.commandId).toBe(first.commandId)
  expect(store.refused.has(first.commandId)).toBe(false)
  await run(finishAdmission(again, false, true, true))
  expect(store.refused.has(first.commandId)).toBe(false)
  // Two attempts at once: the one refused while the other still runs says nothing; the last to end decides.
  const one = Option.getOrThrow(await run(beginAdmission("todo/issue", { repo: "a/b", issue: 1 }, undefined, "make:1")))
  const two = Option.getOrThrow(await run(beginAdmission("todo/issue", { repo: "a/b", issue: 1 }, undefined, "make:1")))
  await run(finishAdmission(one, false))
  expect(store.refused.has(one.commandId)).toBe(false)
  await run(finishAdmission(two, false))
  expect(store.refused.has(one.commandId)).toBe(true)
  // A page Retry under the write id is an attempt too.
  store.update(one.commandId, { writeId: "w1" })
  await run(whileAdmitting("w1", Effect.sync(() => expect(store.refused.has(one.commandId)).toBe(false))))
  await run(whileAdmitting("unknown", Effect.sync(() => expect(store.admitting.get("unknown")).toBe(1))))
})

test("an engine operation's newer copy in memory wins over the older one storage kept (decision 0124)", async () => {
  const host = device()
  const store = await storeOf(host.snapshot)
  const staged = Option.getOrThrow(await Effect.runPromise(beginAdmission("todo/issue", { repo: "a/b", issue: 3 }, undefined, "make:3").pipe(Effect.provideService(WriteIntents, store))))
  // Storage takes the staging, then refuses every later write.
  host.state.refused = true
  expect(store.update(staged.commandId, { executionId: "exec-3" })).toBe(true)
  await Effect.runPromise(finishAdmission(staged, false).pipe(Effect.provideService(WriteIntents, store)))
  expect(store.pending()).toEqual([expect.objectContaining({ commandId: staged.commandId, executionId: "exec-3", admitted: false })])
  expect(store.refused.has(staged.commandId)).toBe(true)
})

test("a press joins an engine operation's input until it retires, cleaned or not; a cleaned write's input it never joins", async () => {
  const store = await storeOf(device().snapshot)
  const run = <A>(effect: Effect.Effect<A, never, WriteIntents>) => Effect.runPromise(effect.pipe(Effect.provideService(WriteIntents, store)))
  expect(store.retain({ ...intent("engine", "todo/issue"), payload: { repo: "a/b", issue: 1 }, draftId: "make:1", admitted: true, cleaned: true })).toBe(true)
  expect(store.retain({ ...intent("write", "issue/create"), payload: { repo: "a/b", title: "t" }, draftId: "new:a/b", admitted: true, cleaned: true })).toBe(true)
  expect(Option.getOrThrow(await run(beginAdmission("todo/issue", { repo: "a/b", issue: 1 }, undefined, "make:1"))).commandId).toBe("engine")
  expect(Option.getOrThrow(await run(beginAdmission("issue/create", { repo: "a/b", title: "t" }, undefined, "new:a/b"))).commandId).not.toBe("write")
})
