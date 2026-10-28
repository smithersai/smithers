import { createMemoryHistory } from "@tanstack/react-router"
import { Effect, ManagedRuntime, Metric } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { appLayer, realServices } from "../../boot"
import { failingWorker, nodeDevice, type NodeDevice } from "../../test/chatApi"
import { Runs } from "../runs/runs"
import { reads } from "../runs/store"
import { Chat } from "./chat"
import { ChatStore } from "./store"

// The whole browser layer with an injected offline transport. Device storage is real SQLite, as in chatApi.ts;
// a branch draft must save and restore even when neither ChatApi nor Electric can be reached.
const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const open = async (host: NodeDevice) => {
  const options = {
    origin: "http://offline.test",
    host,
    fetch: (() => Promise.reject(new TypeError("offline"))) as typeof fetch,
    reload: () => {},
  }
  const runtime = ManagedRuntime.make(appLayer(options, realServices(options)))
  runtimes.push(runtime)
  const chat = await runtime.runPromise(Effect.service(Chat))
  const store = await runtime.runPromise(Effect.service(ChatStore))
  chat.queries.composer.startSyncImmediate()
  await runtime.runPromise(store.drafts.restored)
  await chat.actions.show("branch-draft")
  return { runtime, chat, composer: () => chat.queries.composer.toArray[0] }
}

test("an unshared branch keeps a draft saved on the device and restores it after reload while offline", async () => {
  const host = nodeDevice()
  const first = await open(host)
  first.chat.actions.setDraft("typo")
  first.chat.actions.setDraft("")
  first.chat.actions.setDraft("half a thought")
  await vi.waitFor(() => expect(first.composer()).toMatchObject({ draft: "half a thought", saved: true }))
  expect(host.stored("chat-drafts")).toBe(1)
  await first.runtime.dispose()
  const again = await open(host)
  await vi.waitFor(() => expect(again.composer()).toMatchObject({ draft: "half a thought", saved: true }))
})

test("Runs hover warms before navigation; a failed engine never leaves a ready snapshot", async () => {
  const tab = await open(nodeDevice({ engineWorker: failingWorker }))
  const runs = await tab.runtime.runPromise(Effect.service(Runs))
  runs.queries.view.startSyncImmediate()
  const { router } = await import("../../router")
  router.update({ history: createMemoryHistory({ initialEntries: ["/"] }), context: { ...router.options.context!, runs } })
  await router.load()
  const count = () => tab.runtime.runSync(Metric.value(Metric.withAttributes(reads, { read: "list", outcome: "unavailable" }))).count
  const before = count()
  await router.preloadRoute({ to: "/app/runs" })
  expect(count() - before).toBe(1)
  expect(runs.queries.view.toArray[0]).toMatchObject({ listOpen: false, listReady: false })
  await runs.actions.openList()
  expect(runs.queries.view.toArray[0]).toMatchObject({ listOpen: true, listReady: false })
})

test("leaving a run through the frontend clears only that run and preserves a newer page", async () => {
  const tab = await open(nodeDevice({ engineWorker: failingWorker }))
  const runs = await tab.runtime.runPromise(Effect.service(Runs))
  runs.queries.view.startSyncImmediate()
  await runs.actions.openRun("first")
  runs.actions.closeRun("first")
  await vi.waitFor(() => expect(runs.queries.view.toArray[0]?.runId).toBeNull())
  await runs.actions.openRun("second")
  runs.actions.closeRun("first")
  await tab.runtime.runPromise(Effect.yieldNow)
  expect(runs.queries.view.toArray[0]?.runId).toBe("second")
})

test("retyped identical draft text has a new generation that survives reload", async () => {
  const host = nodeDevice()
  const first = await open(host)
  first.chat.actions.setDraft("Same text")
  await vi.waitFor(() => expect(first.composer()).toMatchObject({ draft: "Same text", saved: true }))
  const previous = first.composer()!.generation
  expect(previous).toBeDefined()
  first.chat.actions.setDraft("")
  first.chat.actions.setDraft("Same text")
  await vi.waitFor(() => expect(first.composer()).toMatchObject({ draft: "Same text", saved: true }))
  const generation = first.composer()!.generation
  expect(generation).not.toBe(previous)
  await first.runtime.dispose()
  const restored = await open(host)
  expect(restored.composer()).toMatchObject({ draft: "Same text", generation })
  const { mirrorDraft, restoreDraft } = await import("./actions")
  await restored.runtime.runPromise(mirrorDraft("", null))
  await restored.runtime.runPromise(restoreDraft)
  expect(restored.composer()).toMatchObject({ draft: "Same text", generation })
})

test("a restored legacy draft preserves its absent generation until an actual edit", async () => {
  const host = nodeDevice()
  const first = await open(host)
  console.info("draft.generation.receipt", { stage: "first_open" })
  const store = await first.runtime.runPromise(Effect.service(ChatStore))
  console.info("draft.generation.receipt", { stage: "insert_start" })
  await first.runtime.runPromise(store.drafts.insert({ id: "branch-draft", text: "Legacy draft" }).pipe(Effect.flatMap(write => write.persisted)))
  console.info("draft.generation.receipt", { stage: "insert_persisted" })
  await first.runtime.dispose()
  console.info("draft.generation.receipt", { stage: "first_closed" })
  const restored = await open(host)
  console.info("draft.generation.receipt", { stage: "second_open" })
  expect(restored.composer()).toMatchObject({ draft: "Legacy draft" })
  expect(restored.composer()!.generation).toBeUndefined()
  const { mirrorDraft, restoreDraft } = await import("./actions")
  await restored.runtime.runPromise(mirrorDraft("", null))
  await restored.runtime.runPromise(restoreDraft)
  expect(restored.composer()).toMatchObject({ draft: "Legacy draft" })
  expect(restored.composer()!.generation).toBeUndefined()
  restored.chat.actions.setDraft("Edited legacy draft")
  expect(restored.composer()!.generation).toBeDefined()
}, 90_000)

test("making an unchanged legacy shared prompt private retains its source generation", async () => {
  const tab = await open(nodeDevice())
  const { mirrorDraft, share } = await import("./actions")
  const store = await tab.runtime.runPromise(Effect.service(ChatStore))
  await tab.runtime.runPromise(share(true))
  await tab.runtime.runPromise(mirrorDraft("Legacy shared prompt", null))
  await tab.runtime.runPromise(share(false))
  await vi.waitFor(() => expect(tab.composer()).toMatchObject({ draft: "Legacy shared prompt", saved: true }))
  expect(store.drafts.tanstack.get("branch-draft")).toMatchObject({ id: "branch-draft", text: "Legacy shared prompt" })
  expect(store.drafts.tanstack.get("branch-draft")?.generation).toBeUndefined()
  expect(tab.composer()!.generation).toBeUndefined()
})
