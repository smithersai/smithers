import { Collection } from "@smthrs/effect-tanstack-db"
import { ChatStore } from "./features/chat/store"
import { COMPOSER, HOME_DRAFT, PLACE } from "./features/chat/schema"
import { PendingSnapshot } from "@smthrs/platform-browser"
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Deferred, Effect, Fiber, Option } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { nodeDevice, openTab, openTestApp, TEST_REPOSITORY, TestChatApi } from "./test/chatApi"
import { Issues } from "./features/issues/issues"
import { IssuesStore } from "./features/issues/store"
import { TodosStore } from "./features/todos/store"
import { executionOf, WriteIntents, type WriteIntent } from "./writeAdmission"
import { resumeAdmissions } from "./resumeAdmissions"
import { commentDraftKey, newDraftKey, WRITE_ID_NAMESPACE } from "./features/issues/contract"
import { OP_ID_NAMESPACE } from "./features/todos/contract"

const closing: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const app of closing.splice(0).reverse()) await app.dispose() })
const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]
const repoId = `github/${TEST_REPOSITORY}`
const opening = async () => {
  const server = openTestApp({ answers: false })
  closing.push(server)
  const api = await server.runPromise(Effect.service(TestChatApi))
  const data = new Map<string, string>()
  const snapshot = PendingSnapshot.make({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }, "pending")
  const host = { ...nodeDevice({ agent: api }), writeSnapshot: snapshot }
  const app = openTab(api, { host })
  closing.push(app)
  const services = await app.runPromise(Effect.all({ issues: Issues, store: IssuesStore, todos: TodosStore, intents: WriteIntents, chat: ChatStore }))
  return { app, snapshot, ...services }
}
const uuid = (namespace: string, value: string) => Effect.runPromise(Uuid.v5(namespace, value).pipe(Effect.provide(WebCrypto.layer), Effect.orDie))
const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 20_000 })

test("a restored Create recovers its route and retires only the navigation receipt that route acknowledged", async () => {
  const tab = await opening()
  const first = { commandId: crypto.randomUUID(), flow: "issue/create", payload: { repo: TEST_REPOSITORY, title: "Earlier", body: "Earlier" } }
  const last = { commandId: crypto.randomUUID(), flow: "issue/create", draftId: newDraftKey(repoId), payload: { repo: TEST_REPOSITORY, title: "Recovered", body: "Exact snapshot" } }
  tab.intents.retain(first)
  tab.intents.retain(last)
  await tab.app.runPromise(tab.store.drafts.insert({ id: newDraftKey(repoId), title: "Recovered", body: "Exact snapshot" }))
  await tab.app.runPromise(resumeAdmissions)
  await tab.issues.actions.open(owner, name, undefined, null)
  const id = await uuid(WRITE_ID_NAMESPACE, last.commandId)
  expect(Option.getOrThrow(await tab.app.runPromise(tab.store.view.get("view"))).createdWriteId).toBe(id)
  await until(() => expect(tab.store.drafts.tanstack.get(newDraftKey(repoId))).toBeUndefined())
  await tab.issues.actions.open(owner, name, undefined, id)
  expect(tab.intents.pending().map(row => row.commandId)).toEqual([first.commandId])
  await tab.issues.actions.open(owner, name, 99)
  expect(Option.getOrThrow(await tab.app.runPromise(tab.store.view.get("view"))).createdWriteId).toBeUndefined()
})

for (const state of ["matching", "changed", "absent"] as const) {
  test(`recovery clears only a ${state} comment and TODO draft snapshot`, async () => {
    const tab = await opening()
    const comment: WriteIntent = { commandId: crypto.randomUUID(), flow: "issue/comment", draftId: commentDraftKey(repoId, 45), payload: { repo: TEST_REPOSITORY, number: 45, body: "Comment" } }
    const todo: WriteIntent = { commandId: crypto.randomUUID(), flow: "todo/commit", payload: { repo: TEST_REPOSITORY, title: "TODO", prompt: "Prompt" }, draftId: crypto.randomUUID(), identity: { namespace: OP_ID_NAMESPACE, value: "stable snapshot" } }
    tab.intents.retain(comment)
    tab.intents.retain(todo)
    if (state !== "absent") await tab.app.runPromise(Effect.all([
      tab.store.drafts.insert({ id: commentDraftKey(repoId, 45), title: "", body: state === "matching" ? "Comment" : "Later comment" }),
      tab.todos.drafts.insert({ id: todo.draftId!, repo: TEST_REPOSITORY, repoId, title: state === "matching" ? "TODO" : "Later TODO", prompt: "Prompt", acceptance: [], answerId: null, createdAt: 1 }),
    ]))
    await tab.app.runPromise(resumeAdmissions)
    await until(() => expect(tab.intents.pending()).toEqual([]))
    await until(() => {
      expect(tab.store.drafts.tanstack.get(commentDraftKey(repoId, 45))?.body).toBe(state === "changed" ? "Later comment" : undefined)
      expect(tab.todos.drafts.tanstack.get(todo.draftId!)?.title).toBe(state === "changed" ? "Later TODO" : undefined)
    })
    const executionId = await tab.app.runPromise(executionOf(todo))
    expect(await uuid(OP_ID_NAMESPACE, executionId)).toMatch(/^[0-9a-f-]{36}$/)
  })
}

test("unknown and invalid input receipts never start a write and remain diagnosable", async () => {
  const tab = await opening()
  tab.intents.retain({ commandId: "unknown", flow: "not/a/flow", payload: {} })
  tab.intents.retain({ commandId: "invalid", flow: "issue/comment", payload: {} })
  await tab.app.runPromise(resumeAdmissions)
  await until(() => expect(tab.intents.pending()).toHaveLength(2))
  expect(tab.store.sending.tanstack.toArray).toEqual([])
})

test("an unresolved local recovery receipt cannot erase a press on immediate shutdown", async () => {
  const tab = await opening()
  await tab.issues.actions.open(owner, name, 45)
  tab.issues.actions.setCommentDraft(owner, name, 45, "Retained before device persistence")
  const real = tab.store.requested
  const faulty = { ...real, insert: (row: Parameters<typeof real.insert>[0]) => real.insert(row).pipe(Effect.map(write => ({ ...write, persisted: Effect.never }))) }
  const { comment } = await import("./features/issues/actions")
  const fiber = tab.app.runFork(comment(owner, name, 45).pipe(Effect.provideService(IssuesStore, { ...tab.store, requested: faulty })))
  await until(() => expect(tab.snapshot.read()).toBeDefined())
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect((tab.snapshot.read()!.value as WriteIntent[])[0]!.payload.body).toBe("Retained before device persistence")
})

test("input-storage refusal keeps source drafts and never admits a write", async () => {
  const tab = await opening()
  await tab.issues.actions.open(owner, name)
  tab.issues.actions.setNewTitle(owner, name, "Keep this issue draft")
  const { create, open } = await import("./features/issues/actions")
  const { commit, drop } = await import("./features/todos/actions")
  const refusing = { ...tab.intents, retain: () => false }
  expect(await tab.app.runPromise(create(owner, name).pipe(Effect.provideService(WriteIntents, refusing)))).toBe(false)
  expect(tab.store.drafts.tanstack.get(newDraftKey(repoId))?.title).toBe("Keep this issue draft")
  const draftId = crypto.randomUUID()
  await tab.app.runPromise(tab.todos.drafts.insert({ id: draftId, repo: TEST_REPOSITORY, repoId, title: "TODO", prompt: "Prompt", acceptance: [], answerId: null, createdAt: 1 }))
  expect(await tab.app.runPromise(commit(draftId).pipe(Effect.provideService(WriteIntents, refusing)))).toBeUndefined()
  await tab.app.runPromise(drop(owner, name, 1).pipe(Effect.provideService(WriteIntents, refusing)))
  expect(tab.todos.drafts.tanstack.get(draftId)?.title).toBe("TODO")
  expect(tab.todos.sending.tanstack.toArray).toEqual([])
  expect(tab.store.sending.tanstack.toArray).toEqual([])
  // The public Effect action also works in a non-browser composition with only its declared services.
  await Effect.runPromise(open(owner, name).pipe(Effect.provideService(IssuesStore, tab.store)))
})

for (const failed of ["restore", "delete"] as const) test(`a failed draft ${failed} receipt retains cleanup across another reload`, async () => {
  const tab = await opening()
  const intent: WriteIntent = { commandId: crypto.randomUUID(), flow: "issue/comment", draftId: commentDraftKey(repoId, 45), payload: { repo: TEST_REPOSITORY, number: 45, body: "Retain cleanup" } }
  tab.intents.retain(intent)
  await tab.app.runPromise(tab.store.drafts.insert({ id: intent.draftId!, title: "", body: "Retain cleanup" }))
  const real = tab.store.drafts
  const drafts = failed === "restore" ? { ...real, restored: Effect.fail(new Collection.LoadFailed({ cause: "quota" })) }
    : { ...real, delete: (id: string | ReadonlyArray<string>) => real.delete(id).pipe(Effect.map(write => ({ ...write, persisted: Effect.fail(new Collection.TransactionFailed({ cause: "quota" })) }))) }
  await tab.app.runPromise(resumeAdmissions.pipe(Effect.provideService(IssuesStore, { ...tab.store, drafts })))
  await until(() => expect(tab.intents.pending()[0]).toMatchObject({ admitted: true, cleaned: false }))
  await tab.app.runPromise(resumeAdmissions)
  await until(() => expect(tab.intents.pending()).toEqual([]))
})

for (const state of ["matching", "new_text", "other_conversation", "no_stored_draft"] as const) test(`slash recovery clears only the ${state} source composer`, async () => {
  const tab = await opening()
  const text = `/comment ${TEST_REPOSITORY} 45 Recovered slash`
  const intent: WriteIntent = { commandId: crypto.randomUUID(), flow: "issue/comment", payload: { repo: TEST_REPOSITORY, number: 45, body: "Recovered slash" }, composer: { conversationId: null, text } }
  tab.intents.retain(intent)
  if (state !== "no_stored_draft") await tab.app.runPromise(tab.chat.drafts.insert({ id: HOME_DRAFT, text: state === "new_text" ? "Later typing" : text }))
  await tab.app.runPromise(tab.chat.composer.update(COMPOSER, row => { row.draft = state === "new_text" ? "Later typing" : text }))
  if (state === "other_conversation") await tab.app.runPromise(tab.chat.place.update(PLACE, row => { row.conversationId = "other" }))
  await tab.app.runPromise(resumeAdmissions)
  await until(() => expect(tab.intents.pending()).toEqual([]))
  expect(tab.chat.drafts.tanstack.get(HOME_DRAFT)?.text).toBe(state === "new_text" ? "Later typing" : undefined)
  expect(tab.chat.composer.tanstack.get(COMPOSER)?.draft).toBe(state === "new_text" ? "Later typing" : state === "other_conversation" ? text : "")
})

test("Discard draft cancels its retained commit after refusal and fences a running admission", async () => {
  const tab = await opening()
  const { beginAdmission, finishAdmission } = await import("./writeAdmission")
  const { discardDraft } = await import("./features/todos/actions")
  const id = crypto.randomUUID()
  await tab.app.runPromise(tab.todos.drafts.insert({ id, repo: TEST_REPOSITORY, repoId, title: "Retained TODO", prompt: "Prompt", acceptance: [], answerId: null, createdAt: 1 }))
  const row = Option.getOrThrow(tab.app.runSync(beginAdmission("todo/commit", { repo: TEST_REPOSITORY, title: "Retained TODO", prompt: "Prompt" }, undefined, id)))
  tab.app.runSync(discardDraft(id))
  expect(tab.todos.drafts.tanstack.get(id)).toBeDefined()
  await tab.app.runPromise(finishAdmission(row, false))
  tab.app.runSync(discardDraft(id))
  expect(tab.intents.pending()).toEqual([])
  expect(tab.todos.drafts.tanstack.get(id)).toBeUndefined()
  await tab.app.runPromise(resumeAdmissions)
  expect(tab.todos.sending.tanstack.toArray).toEqual([])
})

for (const source of ["comment", "issue", "todo"] as const) {
  test(`an admission receipt cannot delete newer typing in its ${source} source draft`, async () => {
    const tab = await opening()
    const { comment, create } = await import("./features/issues/actions")
    const { commit } = await import("./features/todos/actions")
    const key = source === "comment" ? commentDraftKey(repoId, 45) : source === "issue" ? newDraftKey(repoId) : crypto.randomUUID()
    const gate = await Effect.runPromise(Deferred.make<void>())
    let queued = false
    if (source === "todo") {
      await tab.app.runPromise(tab.todos.drafts.insert({ id: key, repo: TEST_REPOSITORY, repoId, title: "Earlier", prompt: "Earlier prompt", acceptance: [], answerId: null, createdAt: 1 }))
    } else {
      await tab.issues.actions.open(owner, name, source === "comment" ? 45 : undefined)
      await tab.app.runPromise(tab.store.drafts.insert({ id: key, title: "Earlier", body: "Earlier body" }))
    }
    const effect = source === "todo"
      ? commit(key).pipe(Effect.provideService(TodosStore, { ...tab.todos, queue: row => tab.todos.queue(row).pipe(Effect.tap(() => { queued = true; return Deferred.await(gate) })) }), Effect.asVoid)
      : (source === "comment" ? comment(owner, name, 45) : create(owner, name)).pipe(Effect.provideService(IssuesStore, { ...tab.store, queue: row => tab.store.queue(row).pipe(Effect.tap(() => { queued = true; return Deferred.await(gate) })) }), Effect.asVoid)
    const fiber = tab.app.runFork(effect)
    await until(() => expect(queued).toBe(true))
    if (source === "todo") await tab.app.runPromise(tab.todos.drafts.update(key, draft => { draft.prompt = "Newer typing" }))
    else await tab.app.runPromise(tab.store.drafts.update(key, draft => { draft.body = "Newer typing" }))
    await Effect.runPromise(Deferred.succeed(gate, undefined))
    await Effect.runPromise(Fiber.join(fiber))
    const held = source === "todo" ? tab.todos.drafts.tanstack.get(key)?.prompt : tab.store.drafts.tanstack.get(key)?.body
    expect(held).toBe("Newer typing")
  })
}

for (const source of ["issue", "todo", "legacy"] as const) test(`Retry fences Discard and completes the retained ${source} lifecycle`, async () => {
  const tab = await opening()
  const { beginAdmission, finishAdmission, identifyAdmission } = await import("./writeAdmission")
  const { retryWrite, discard, comment } = await import("./features/issues/actions")
  const { retryChange, discard: discardTodo } = await import("./features/todos/actions")
  const todo = source === "todo"
  const flow = todo ? "todo/commit" : "issue/comment"
  const key = todo ? crypto.randomUUID() : commentDraftKey(repoId, 45)
  const payload = todo ? { repo: TEST_REPOSITORY, title: "Retained TODO", prompt: "Prompt" } : { repo: TEST_REPOSITORY, number: 45, body: "Retained comment" }
  const intent = Option.getOrThrow(await tab.app.runPromise(beginAdmission(flow, payload, todo ? { namespace: OP_ID_NAMESPACE, value: JSON.stringify([key, TEST_REPOSITORY, "Retained TODO", "Prompt", [], null]) } : undefined, key)))
  const id = await uuid(todo ? OP_ID_NAMESPACE : WRITE_ID_NAMESPACE, await tab.app.runPromise(executionOf(intent)))
  await tab.app.runPromise(identifyAdmission(intent, intent.commandId, id))
  await tab.app.runPromise(finishAdmission(intent, false))
  if (source === "legacy") tab.intents.forget(intent.commandId)
  if (todo) {
    await tab.app.runPromise(tab.todos.drafts.insert({ id: key, repo: TEST_REPOSITORY, repoId, title: "Retained TODO", prompt: "Prompt", acceptance: [], answerId: null, createdAt: 1 }))
    await tab.app.runPromise(tab.todos.requested.insert({ id, repo: TEST_REPOSITORY, repoId, op: "commit", number: 0, title: "Retained TODO", prompt: "Prompt", acceptance: [], queuedAt: 1, status: "not_sent", reason: null, taken: null }))
  } else {
    await tab.issues.actions.open(owner, name, 45)
    await tab.app.runPromise(tab.store.drafts.insert({ id: key, title: "", body: "Retained comment" }))
    await tab.app.runPromise(tab.store.requested.insert({ id, repo: TEST_REPOSITORY, repoId, op: "issue/comment", number: 45, title: "", body: "Retained comment", queuedAt: 1, status: "not_sent", reason: null }))
  }
  const gate = await Effect.runPromise(Deferred.make<void>())
  let waiting = false
  const retry = todo
    ? retryChange(id).pipe(Effect.provideService(TodosStore, { ...tab.todos, queue: row => Effect.sync(() => { waiting = true }).pipe(Effect.andThen(Deferred.await(gate)), Effect.andThen(tab.todos.queue(row))) }))
    : retryWrite(id).pipe(Effect.provideService(IssuesStore, { ...tab.store, queue: row => Effect.sync(() => { waiting = true }).pipe(Effect.andThen(Deferred.await(gate)), Effect.andThen(tab.store.queue(row))) }))
  const fiber = tab.app.runFork(retry)
  await until(() => expect(waiting).toBe(true))
  await tab.app.runPromise(todo ? discardTodo(id) : discard(id))
  expect(todo ? tab.todos.requested.tanstack.has(id) : tab.store.requested.tanstack.has(id)).toBe(true)
  await Effect.runPromise(Deferred.succeed(gate, undefined))
  await Effect.runPromise(Fiber.join(fiber))
  expect(tab.intents.pending()).toEqual([])
  if (!todo) {
    expect(tab.store.drafts.tanstack.get(key)).toBeUndefined()
    await tab.app.runPromise(tab.store.drafts.insert({ id: key, title: "", body: "Retained comment" }))
    await tab.app.runPromise(comment(owner, name, 45))
    const ids = new Set([...tab.store.sending.tanstack.toArray, ...tab.store.requested.tanstack.toArray].map(row => row.id))
    expect(ids.size).toBe(2)
  }
})

test("a refused TODO Drop or Retry remains visibly Not sent and retries the same identity", async () => {
  const tab = await opening()
  const { drop, retry, retryChange, discard } = await import("./features/todos/actions")
  const { VIEW } = await import("./features/todos/schema")
  const real = tab.todos.requested
  const requested = { ...real, insert: (row: Parameters<typeof real.insert>[0]) => real.insert(row).pipe(Effect.map(write => ({ ...write, persisted: Effect.fail(new Collection.TransactionFailed({ cause: "quota" })) }))) }
  const todos = { ...tab.todos, requested }
  const refusing = { ...tab.intents, retain: () => false }
  for (const [op, press] of [["drop", drop], ["retry", retry]] as const) {
    await tab.app.runPromise(press(owner, name, 1).pipe(Effect.provideService(WriteIntents, refusing), Effect.provideService(TodosStore, todos)))
    const failed = Option.getOrThrow(await tab.app.runPromise(tab.todos.view.get(VIEW))).admissionFailures ?? []
    const held = failed.find(row => row.op === op)!
    expect(held?.status).toBe("not_sent")
    expect(tab.todos.sending.tanstack.toArray.some(row => row.id === held.id)).toBe(false)
    await until(() => expect(tab.intents.admitting.has(held.id)).toBe(false))
    await tab.app.runPromise(retryChange(held.id))
    expect((Option.getOrThrow(await tab.app.runPromise(tab.todos.view.get(VIEW))).admissionFailures ?? []).some(row => row.id === held.id)).toBe(false)
    expect([...tab.todos.sending.tanstack.toArray, ...tab.todos.requested.tanstack.toArray].some(row => row.id === held.id)).toBe(true)
  }
  await tab.app.runPromise(drop(owner, name, 2).pipe(Effect.provideService(WriteIntents, refusing), Effect.provideService(TodosStore, todos)))
  const [held] = Option.getOrThrow(await tab.app.runPromise(tab.todos.view.get(VIEW))).admissionFailures!
  await until(() => expect(tab.intents.admitting.has(held!.id)).toBe(false))
  await tab.app.runPromise(discard(held!.id))
  expect(Option.getOrThrow(await tab.app.runPromise(tab.todos.view.get(VIEW))).admissionFailures).toEqual([])
})
