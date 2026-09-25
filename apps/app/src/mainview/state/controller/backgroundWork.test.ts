import { afterEach, expect, test } from "bun:test"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, unavailableAgent, waitFor } from "../TestFixtures"
import { workerToastActions } from "../../WorkerToastActions"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { observeBackgroundWork } from "./backgroundWork"
import { createWorkflowLaunchController } from "./workflow-launch"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() }, { seedWiki: false })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableAgent, { workflowPollMs: 1, toastAutoDismissMs: 10000 })
  const failures = createFailureController(ctx)
  ctx.withToast = failures.withToast
  ctx.resolveToast = failures.resolveToast
  cleanups.push(async () => { await ctx.dispose(); await store.dispose?.() })
  return { store, ctx }
}

test("one debounced toast spans unresolved launch and execution, with controls from the real receipt", async () => {
  const { store, ctx } = await fixture()
  const remote = Promise.withResolvers<{ status: "ok"; value: { runId: string } }>()
  let launches = 0
  ctx.gateway = { ...ctx.gateway, launch: async () => { launches++; return remote.promise } } as typeof ctx.gateway
  observeBackgroundWork(ctx)
  const launch = createWorkflowLaunchController(ctx, store.nextOrdinal, async () => {}, async () => true)
  const request = { repo: "owner/repo", binding: {}, workflow: "review", input: {}, actor: "user" as const }
  const result = await launch.start(request)
  expect(result).toMatchObject({ value: expect.stringContaining("run-requested") })
  await launch.start(request)
  expect(launches).toBe(1)
  expect(store.collections.toasts.size).toBe(0)
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "chat remains usable" }).isPersisted.promise
  expect(store.session()).toMatchObject({ draft: "chat remains usable", phase: "idle" })
  await waitFor(() => store.collections.toasts.size === 1)
  const toast = [...store.collections.toasts.values()][0]!
  expect(toast.status).toBe("running")
  expect(workerToastActions(store.collections.cards.get(toast.sourceCard!)).map(a => a.label)).toEqual(["Open tab"])
  remote.resolve({ status: "ok", value: { runId: "run-1" } })
  await waitFor(() => [...store.collections.cards.values()].some(c => c.kind === "run-trace" && c.payload.runId === "run-1"))
  await settle()
  expect(store.collections.toasts.size).toBe(1)
  expect(store.collections.toasts.get(toast.id)?.status).toBe("running")
  expect(workerToastActions(store.collections.cards.get(toast.sourceCard!)).map(a => a.label)).toContain("Stop")
  await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
    scope: { repo: "owner/repo", runId: "run-1" }, summary: { runId: "run-1", flowId: "review", status: "failed",
      createdAt: 1, updatedAt: 2, turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
      inputTokens: 0, outputTokens: 0, verdict: "offline", diagnosis: "offline" }
  } }).isPersisted.promise
  await waitFor(() => store.collections.toasts.get(toast.id)?.status === "failed")
  expect(workerToastActions(store.collections.cards.get(toast.sourceCard!)).map(a => a.label)).toEqual(["Open tab", "Run again"])
  expect(launches).toBe(1)
})

test("recovered workers get controls, failures stay visible, and quick work stays below the debounce", async () => {
  const { store, ctx } = await fixture()
  const card: Card = { id: "restored-worker", kind: "run-trace", title: "Review", status: "active", ordinal: 1, createdAt: Date.now() - 1000,
    payload: { repo: "owner/repo", workflow: "review", runId: "run-1", phase: "running", steps: [], result: null, lastSeq: 0 } }
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  observeBackgroundWork(ctx)
  await waitFor(() => store.collections.toasts.size === 1)
  const toast = [...store.collections.toasts.values()][0]!
  expect(toast.sourceCard).toBe(card.id)
  await store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload, phase: "failed", error: "offline" } } }).isPersisted.promise
  await waitFor(() => store.collections.toasts.get(toast.id)?.status === "failed")
  const fast = { ...card, id: "fast", createdAt: Date.now() }
  await store.dispatch({ type: "card.upsert", actor: "system", card: fast }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: { ...fast, payload: { ...fast.payload, phase: "completed" } } }).isPersisted.promise
  await new Promise(resolve => setTimeout(resolve, 320))
  expect([...store.collections.toasts.values()].map(t => t.sourceCard)).toEqual([card.id])
  expect(store.collections.toasts.get(toast.id)?.detail).toBe("offline")
})
