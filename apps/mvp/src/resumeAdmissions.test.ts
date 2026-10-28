import { Collection } from "@smthrs/effect-tanstack-db"
import { ChatStore } from "./features/chat/store"
import { COMPOSER, HOME_DRAFT, PLACE } from "./features/chat/schema"
import { PendingSnapshot } from "@smthrs/platform-browser"
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Deferred, Effect, Fiber, Option, Scope } from "effect"
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
const opening = async (offline = false) => {
  const server = openTestApp({ answers: false })
  closing.push(server)
  const api = await server.runPromise(Effect.service(TestChatApi))
  const data = new Map<string, string>()
  const snapshot = PendingSnapshot.make({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }, "pending")
  const device = nodeDevice({ agent: api })
  const host = { ...device, writeSnapshot: snapshot, ...(offline ? { outbox: { ...device.outbox, online: { ...device.outbox.online, isOnline: () => false } } } : {}) }
  const app = openTab(api, { host })
  closing.push(app)
  const services = await app.runPromise(Effect.all({ issues: Issues, store: IssuesStore, todos: TodosStore, intents: WriteIntents, chat: ChatStore }))
  return { app, snapshot, ...services }
}
const uuid = (namespace: string, value: string) => Effect.runPromise(Uuid.v5(namespace, value).pipe(Effect.provide(WebCrypto.layer), Effect.orDie))
const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 20_000 })

for (const source of ["comment", "todo"] as const) test(`live and retried ${source} cleanup failures retain the original input`, async () => {
  const tab = await opening(true)
  const key = source === "comment" ? commentDraftKey(repoId, 45) : crypto.randomUUID()
  const commentDraft = { id: key, title: "", body: "Retain failed cleanup" }
  const todoDraft = { id: key, repo: TEST_REPOSITORY, repoId, title: "Retain failed cleanup", prompt: "Prompt", acceptance: [], answerId: null, createdAt: 1 }
  let failures = 0
  const failedReceipt = Effect.sync(() => { failures++; }).pipe(Effect.andThen(Effect.fail(new Collection.TransactionFailed({ cause: "quota" }))))
  const { comment, retryWrite } = await import("./features/issues/actions")
  const { commit, retryChange } = await import("./features/todos/actions")
  const issueDrafts = { ...tab.store.drafts, delete: (id: string | ReadonlyArray<string>) => tab.store.drafts.delete(id).pipe(Effect.map(write => ({ ...write, persisted: failedReceipt }))) }
  const todoDrafts = { ...tab.todos.drafts, delete: (id: string | ReadonlyArray<string>) => tab.todos.drafts.delete(id).pipe(Effect.map(write => ({ ...write, persisted: failedReceipt }))) }
  if (source === "comment") {
    await tab.issues.actions.open(owner, name, 45)
    await tab.app.runPromise(tab.store.drafts.insert(commentDraft).pipe(Effect.flatMap(write => write.persisted)))
    await tab.app.runPromise(comment(owner, name, 45).pipe(Effect.provideService(IssuesStore, { ...tab.store, drafts: issueDrafts })))
  } else {
    await tab.app.runPromise(tab.todos.drafts.insert(todoDraft).pipe(Effect.flatMap(write => write.persisted)))
    await tab.app.runPromise(commit(key).pipe(Effect.provideService(TodosStore, { ...tab.todos, drafts: todoDrafts })))
  }
  const [intent] = tab.intents.pending()
  expect(intent).toMatchObject({ admitted: true, cleaned: false })
  if (source === "comment") {
    await tab.app.runPromise(tab.store.drafts.insert(commentDraft).pipe(Effect.flatMap(write => write.persisted)))
    await tab.app.runPromise(tab.store.requested.insert({ id: intent!.writeId!, repo: TEST_REPOSITORY, repoId, op: "issue/comment", number: 45, title: "", body: commentDraft.body, queuedAt: 1, status: "not_sent", reason: null }))
    await tab.app.runPromise(retryWrite(intent!.writeId!).pipe(Effect.provideService(IssuesStore, { ...tab.store, drafts: issueDrafts })))
  } else {
    await tab.app.runPromise(tab.todos.drafts.insert(todoDraft).pipe(Effect.flatMap(write => write.persisted)))
    await tab.app.runPromise(tab.todos.requested.insert({ id: intent!.writeId!, repo: TEST_REPOSITORY, repoId, op: "commit", number: 0, title: todoDraft.title, prompt: todoDraft.prompt, acceptance: [], queuedAt: 1, status: "not_sent", reason: null, taken: null }))
    await tab.app.runPromise(retryChange(intent!.writeId!).pipe(Effect.provideService(TodosStore, { ...tab.todos, drafts: todoDrafts })))
  }
  expect(failures).toBe(2)
  expect(tab.intents.pending()).toEqual([expect.objectContaining({ commandId: intent!.commandId, writeId: intent!.writeId, admitted: true, cleaned: false })])
})

test("repeated refused TODO presses reuse ephemeral recovery and Discard needs no stored row", async () => {
  const tab = await opening(true)
  const { drop, retry, discard } = await import("./features/todos/actions")
  const { VIEW } = await import("./features/todos/schema")
  const requested = { ...tab.todos.requested, insert: () => Effect.fail(new Collection.MutationRefused({ operation: "insert", cause: "quota" })) }
  const refusing = { ...tab.intents, retain: () => false }
  for (const press of [drop("other", name, 1), retry(owner, name, 1), drop(owner, name, 2), drop(owner, name, 1)]) {
    await tab.app.runPromise(press.pipe(Effect.provideService(WriteIntents, refusing), Effect.provideService(TodosStore, { ...tab.todos, requested })))
  }
  const failures = () => Option.getOrThrow(tab.app.runSync(tab.todos.view.get(VIEW))).admissionFailures ?? []
  const original = failures().find(row => row.repo === TEST_REPOSITORY && row.op === "drop" && row.number === 1)!
  await until(() => expect(tab.intents.admitting.size).toBe(0))
  expect(tab.todos.requested.tanstack.has(original.id)).toBe(false)
  const admitted: string[] = []
  await tab.app.runPromise(drop(owner, name, 1).pipe(Effect.provideService(TodosStore, {
    ...tab.todos, queue: row => tab.todos.queue(row).pipe(Effect.tap(() => Effect.sync(() => { admitted.push(row.id) }))),
  })))
  expect(admitted).toEqual([original.id])
  expect(failures().some(row => row.id === original.id)).toBe(false)
  const discarded = failures()[0]!
  await tab.app.runPromise(discard(discarded.id))
  expect(failures().some(row => row.id === discarded.id)).toBe(false)
  expect(failures()).toHaveLength(2)
})

test("a restored Create recovers its route and retires only the navigation receipt that route acknowledged", async () => {
  const tab = await opening()
  const first = { commandId: crypto.randomUUID(), flow: "issue/create", draftId: newDraftKey(repoId), payload: { repo: TEST_REPOSITORY, title: "Earlier", body: "Earlier" } }
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

for (const state of ["matching", "new_generation", "new_unstored_generation", "restore_failure", "delete_failure"] as const) test(`Retry composer cleanup respects its ${state} source receipt`, async () => {
  const { clearComposerSource, clearWriteComposer } = await import("./admissionSource")
  expect(await Effect.runPromise(clearWriteComposer("absent"))).toBe(true)
  expect(await Effect.runPromise(clearComposerSource({ conversationId: null, text: "source" }))).toBe(false)
  const tab = await opening()
  const source = { conversationId: null, text: "/comment", generation: "original" }
  const row = { commandId: "source", flow: "issue/comment", payload: {}, composer: source }
  tab.intents.retain(row)
  tab.intents.byWrite.set("write", row.commandId)
  await tab.app.runPromise(tab.chat.drafts.insert({ id: HOME_DRAFT, text: source.text, generation: state.startsWith("new_") ? "later" : "original" }).pipe(Effect.flatMap(write => write.persisted)))
  await tab.app.runPromise(tab.chat.composer.update(COMPOSER, composer => { composer.draft = source.text; composer.generation = state.startsWith("new_") ? "later" : "original" }))
  const drafts = state === "new_unstored_generation" ? { ...tab.chat.drafts, isSynced: () => Effect.succeed(false) }
    : state === "restore_failure" ? { ...tab.chat.drafts, restored: Effect.fail(new Collection.LoadFailed({ cause: "quota" })) }
    : state === "delete_failure" ? { ...tab.chat.drafts, delete: (id: string | ReadonlyArray<string>) => tab.chat.drafts.delete(id).pipe(Effect.map(write => ({ ...write, persisted: Effect.fail(new Collection.TransactionFailed({ cause: "quota" })) }))) }
    : tab.chat.drafts
  expect(await tab.app.runPromise(clearWriteComposer("write").pipe(Effect.provideService(ChatStore, { ...tab.chat, drafts })))).toBe(state === "matching" || state === "new_generation")
  expect(tab.chat.composer.tanstack.get(COMPOSER)?.draft).toBe(state === "matching" || state === "delete_failure" ? "" : source.text)
})

test("an unsaved replacement composer keeps the earlier input cleanup pending", async () => {
  const { clearComposerSource } = await import("./admissionSource")
  const tab = await opening()
  await tab.app.runPromise(tab.chat.composer.update(COMPOSER, composer => { composer.draft = "New text"; composer.generation = "new"; composer.saved = false }))
  expect(await tab.app.runPromise(clearComposerSource({ conversationId: null, text: "Earlier", generation: "earlier" }))).toBe(false)
  expect(tab.chat.composer.tanstack.get(COMPOSER)?.draft).toBe("New text")
})

for (const replacement of [false, true]) test(`a pending source deletion cannot confirm cleanup after navigation (${replacement})`, async () => {
  const { clearComposerSource } = await import("./admissionSource")
  const { ChatDraft } = await import("./features/chat/schema")
  const { setDraft } = await import("./features/chat/actions")
  const tab = await opening()
  let deleted!: () => void
  let reject!: (error: Error) => void
  let inserted!: () => void
  const deletion = new Promise<void>((resolve, fail) => { deleted = resolve; reject = fail })
  const insertion = new Promise<void>(resolve => { inserted = resolve })
  const drafts = await tab.app.runPromise(Scope.provide(Collection.make(ChatDraft, {
    id: `source-${crypto.randomUUID()}`, getKey: row => row.id,
    sync: { sync: source => { source.begin(); source.write({ type: "insert", value: { id: HOME_DRAFT, text: "Original", generation: "first" } }); source.commit(); source.markReady() } },
    onDelete: () => deletion, onInsert: () => insertion,
  }), tab.store.scope))
  await tab.app.runPromise(drafts.preload)
  const chat = { ...tab.chat, drafts }
  await tab.app.runPromise(tab.chat.composer.update(COMPOSER, composer => { composer.draft = "Original"; composer.generation = "first" }))
  await tab.app.runPromise(setDraft("").pipe(Effect.provideService(ChatStore, chat)))
  await tab.app.runPromise(tab.chat.place.update(PLACE, place => { place.conversationId = "another" }))
  let completed = false
  const fiber = tab.app.runFork(clearComposerSource({ conversationId: null, text: "Original", generation: "first" }).pipe(Effect.provideService(ChatStore, chat), Effect.tap(() => Effect.sync(() => { completed = true }))))
  await Effect.runPromise(Effect.yieldNow)
  expect(completed, "absence is optimistic while its deletion receipt is unresolved").toBe(false)
  if (replacement) {
    await tab.app.runPromise(drafts.insert({ id: HOME_DRAFT, text: "Later", generation: "later" }))
    deleted()
  } else reject(new Error("quota"))
  expect(await Effect.runPromise(Fiber.join(fiber))).toBe(false)
  inserted()
})


test("recovering a slash-created issue never takes over the New issue form", async () => {
  const tab = await opening()
  tab.intents.retain({ commandId: crypto.randomUUID(), flow: "issue/create", payload: { repo: TEST_REPOSITORY, title: "From slash", body: "" } })
  await tab.app.runPromise(resumeAdmissions)
  await until(() => expect(tab.intents.pending()).toEqual([]))
  expect(tab.intents.resumed.size).toBe(0)
  await tab.issues.actions.open(owner, name, undefined, null)
  expect(Option.getOrThrow(await tab.app.runPromise(tab.store.view.get("view"))).createdWriteId).toBeUndefined()
})

test("a settled run admits its engine input whatever became of its Start reply; only a finished one's line leaves the composer (decision 0124)", async () => {
  const { settleFromRuns } = await import("./resumeAdmissions")
  const tab = await opening()
  const text = "/new octo/hello topic"
  const engine = (commandId: string, fields: Partial<WriteIntent> = {}): WriteIntent => ({
    commandId, flow: "conversation/new", payload: { repo: TEST_REPOSITORY }, executionId: `exec-${commandId}`, door: "slash", ...fields,
  })
  for (const row of [engine("clean", { admitted: true, cleaned: true }), engine("dirty", { admitted: true, cleaned: false }), engine("running")]) tab.intents.retain(row)
  // A failed run's input retires, and its line stays the person's.
  tab.intents.retain(engine("failed", { composer: { conversationId: null, text, generation: "g1" } }))
  await tab.app.runPromise(tab.chat.composer.update(COMPOSER, (row) => { row.draft = text; row.generation = "g1" }))
  const results = new Map([["run:exec-clean", "done"], ["run:exec-dirty", "done"], ["run:exec-failed", "failed"]] as const)
  await tab.app.runPromise(settleFromRuns(results, new Set()))
  // "dirty" has no line to clear: its run's result confirms the cleanup its admission couldn't.
  await until(() => expect(tab.intents.pending().map((row) => row.commandId).sort()).toEqual(["running"]))
  expect(tab.chat.composer.tanstack.get(COMPOSER)?.draft).toBe(text)
  // A finished run's line leaves the composer, and its input retires.
  tab.intents.retain(engine("done", { composer: { conversationId: null, text, generation: "g1" } }))
  await tab.app.runPromise(settleFromRuns(new Map([["run:exec-done", "done"]]), new Set()))
  await until(() => expect(tab.intents.pending().map((row) => row.commandId)).not.toContain("done"))
  expect(tab.chat.composer.tanstack.get(COMPOSER)?.draft).toBe("")
  // A cleanup that can't confirm, behind an unsaved replacement, keeps the input admitted for the next page open, once.
  await tab.app.runPromise(tab.chat.composer.update(COMPOSER, (row) => { row.draft = "New text"; row.generation = "new"; row.saved = false }))
  tab.intents.retain(engine("unclean", { composer: { conversationId: null, text, generation: "g2" } }))
  await tab.app.runPromise(settleFromRuns(new Map([["run:exec-unclean", "done"]]), new Set()))
  await until(() => expect(tab.intents.pending().find((row) => row.commandId === "unclean")).toMatchObject({ admitted: true, cleaned: false }))
  await tab.app.runPromise(settleFromRuns(new Map([["run:exec-unclean", "done"]]), new Set()))
  expect(tab.intents.pending().find((row) => row.commandId === "unclean")).toMatchObject({ admitted: true, cleaned: false })
  expect(tab.chat.composer.tanstack.get(COMPOSER)?.draft).toBe("New text")
  // The cleanup itself, awaited: unconfirmed, it leaves the input for the next page open.
  const { completeFromRun } = await import("./resumeAdmissions")
  tab.intents.retain(engine("awaited", { composer: { conversationId: null, text, generation: "g3" } }))
  await tab.app.runPromise(completeFromRun(engine("awaited", { composer: { conversationId: null, text, generation: "g3" } }), "done"))
  expect(tab.intents.pending().find((row) => row.commandId === "awaited")).toMatchObject({ admitted: true, cleaned: false })
})

test("a settled run's input this tab can't forget is tried once, and the refused forget wakes nothing", async () => {
  const { settleFromRuns } = await import("./resumeAdmissions")
  const { Context, Fiber, Layer, Ref, Stream } = await import("effect")
  const tab = await opening()
  const engine = (commandId: string): WriteIntent => ({
    commandId, flow: "todo/issue", payload: { repo: TEST_REPOSITORY, issue: 7 }, executionId: `exec-${commandId}`, admitted: true, cleaned: true,
  })
  tab.intents.retain(engine("kept"))
  tab.intents.retain(engine("other"))
  // Storage now refuses to rewrite the receipts: the forget can't land.
  const refusing = { ...tab.snapshot, stage: () => undefined, acknowledge: () => undefined }
  const store = await Effect.runPromise(Effect.scoped(Effect.map(Layer.build(WriteIntents.layer(refusing)), (context) => Context.get(context, WriteIntents))))
  const wakes = await Effect.runPromise(Ref.make(0))
  const counting = Effect.runFork(store.changes.pipe(Stream.runForEach(() => Ref.update(wakes, (n) => n + 1))))
  await Effect.runPromise(Effect.yieldNow)
  const attempted = new Set<string>()
  for (let i = 0; i < 3; i++) await tab.app.runPromise(settleFromRuns(new Map([["run:exec-kept", "done"]]), attempted).pipe(Effect.provideService(WriteIntents, store)))
  await Effect.runPromise(Effect.sleep("50 millis"))
  expect(store.pending().map((row) => row.commandId).sort()).toEqual(["kept", "other"])
  expect(await Effect.runPromise(Ref.get(wakes))).toBe(0)
  expect([...attempted]).toEqual(["kept"])
  await Effect.runPromise(Fiber.interrupt(counting))
})
