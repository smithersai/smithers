import { ShapeSource } from "@smthrs/effect-electric"
import { Deferred, Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { shaOf } from "../../../worker/test/branch"
import { nodeDevice, openFaultyApp, openFaultyTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { EngineFaults, QuestionFaults } from "../../test/faults"
import { retry, wentOffline } from "../chat/actions"
import { Chat } from "../chat/chat"
import { ChatStore } from "../chat/store"
import { Branch } from "./branch"
import { open as openBranch } from "./actions"
import { BranchStore } from "./store"

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

// Real ChatApi, SQLite device persistence and durable outbox. Only the unreachable services are faulted.
test.each(["browser", "sync"])("reopening a verified branch with %s offline restores its conversation and queued count without granting workspace access", async (outage) => {
  const server = openTestApp()
  disposals.push(() => server.dispose())
  const api = await server.runPromise(Effect.service(TestChatApi))
  api.branches.github.publish("octo", "hello", { defaultBranch: "main", branches: { main: shaOf("main"), work: shaOf("work") } })
  let online = true
  let reopens = 0
  const device = nodeDevice({ agent: api, isOnline: () => online, reopenRoute: () => { reopens++ } })
  const first = openFaultyTab(api, { host: device })
  disposals.push(() => first.dispose())
  const [branch, chat, store, questions] = await first.runPromise(Effect.all([
    Effect.service(Branch), Effect.service(Chat), Effect.service(ChatStore), Effect.service(QuestionFaults),
  ]))
  branch.queries.current.startSyncImmediate()
  chat.queries.place.startSyncImmediate()
  await branch.actions.open("octo", "hello", "work")
  const conversationId = branch.queries.current.toArray[0]!.conversationId!
  expect(conversationId).not.toBeNull()
  expect(device.stored("branch-conversations")).toBe(1)
  online = false
  await first.runPromise(wentOffline)
  await first.runPromise(questions.failNext("unreachable"))
  expect((await chat.actions.ask("kept offline")).asked).toBe(true)
  await vi.waitFor(() => expect(store.asking.tanstack.toArray).toHaveLength(1))
  await first.dispose()

  online = outage === "sync"
  const again = openFaultyTab(api, { host: device, unreachableAfter: "100 millis" }, (shapes) => shapes.down())
  disposals.push(() => again.dispose())
  const [reopened, restored, faults] = await again.runPromise(Effect.all([
    Effect.service(Branch), Effect.service(Chat), Effect.service(EngineFaults),
  ]))
  reopened.queries.current.startSyncImmediate()
  restored.queries.place.startSyncImmediate()
  await again.runPromise(faults.holdStarts)
  const opening = reopened.actions.open("octo", "hello", "work")
  void opening.catch(() => undefined)
  await vi.waitFor(() => expect(restored.queries.place.toArray[0]?.conversationId).toBe(conversationId), { timeout: 3_000 })
  expect(await opening).toBeUndefined()
  expect(reopened.queries.current.toArray[0]).toMatchObject({ status: "offline", conversationId, access: null, branchId: null })
  const queued = restored.queries.of(conversationId).queued
  queued.startSyncImmediate()
  await vi.waitFor(() => expect(queued.toArray.map((row) => row.text)).toEqual(["kept offline"]))
  expect(reopens).toBe(0)
  if (outage === "sync") {
    await again.runPromise(Effect.flatMap(ShapeSource.Faults, (shapes) => shapes.heal))
    await again.runPromise(faults.releaseStarts)
    await vi.waitFor(() => expect(reopens).toBe(1), { timeout: 10_000 })
    await again.runPromise(retry("online"))
    expect(reopens).toBe(1)
  }
}, 90_000)

test.each(["leave", "abort"])("a delayed cache restore cannot select the old branch after %s", async (exit) => {
  const runtime = openFaultyApp({ host: nodeDevice({ isOnline: () => false }) })
  disposals.push(() => runtime.dispose())
  const [branch, chat, store, faults] = await runtime.runPromise(Effect.all([
    Effect.service(Branch), Effect.service(Chat), Effect.service(BranchStore), Effect.service(EngineFaults),
  ]))
  chat.queries.place.startSyncImmediate()
  branch.queries.current.startSyncImmediate()
  await runtime.runPromise(faults.holdStarts)
  await runtime.runPromise(store.conversations.restored)
  await runtime.runPromise(store.conversations.insert({ id: "octo/hello/work", conversationId: crypto.randomUUID() }))
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  // Fault only the restore receipt; reads, writes, routing and chat use their real services.
  const delayed = { ...store, conversations: { ...store.conversations,
    restored: store.conversations.restored.pipe(
      Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Deferred.await(release))),
  } }
  const controller = new AbortController()
  const opening = runtime.runPromise(openBranch("octo", "hello", "work", controller.signal).pipe(Effect.provideService(BranchStore, delayed)))
  await runtime.runPromise(Deferred.await(entered))
  if (exit === "leave") await branch.actions.leave()
  else controller.abort()
  await runtime.runPromise(Deferred.succeed(release, undefined))
  expect(await opening).toBeUndefined()
  expect(chat.queries.place.toArray[0]?.conversationId).toBeNull()
  expect(branch.queries.current.toArray[0]?.status).toBe(exit === "leave" ? "none" : "tracking")
}, 90_000)
