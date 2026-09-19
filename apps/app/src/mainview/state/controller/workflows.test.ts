import { expect, test } from "bun:test"
import type { RunSummaryRow } from "./gateway"
import { scopedControllers } from "../ControllerTestScope"
import { createAppStore } from "../AppStore"
import { json, memoryStorage, scriptedToolAgent, settle, unavailableRepositories, waitFor } from "../TestFixtures"

const createAppController = scopedControllers()
const repo = "owner/launch-test"
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", ownerKind: "user", name: "launch-test", head: null }] }).isPersisted.promise
  const calls: Array<{ procedure: string; payload: Record<string, unknown>; repo: string; workspaceId?: string }> = []
  let provision = async () => json(200, { status: "ready" })
  let run = async () => json(200, { ok: true, payload: { runId: "run-1" } })
  let status: RunSummaryRow["status"] = "running"
  const summary = (): RunSummaryRow => ({ runId: "run-1", flowId: "review", status, createdAt: 1, updatedAt: status === "running" ? 2 : 3,
    turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 1, outputTokens: 1,
    verdict: status === "failed" ? "The check failed." : status, diagnosis: status })
  const chat = scriptedToolAgent([() => [{ type: "delta", kind: "text", text: "Still here." }, { type: "done", reason: "stop" }]])
  const services = { workflowPollMs: 5, toastAutoDismissMs: 60_000, fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith("/api/workflow/provision")) return provision()
    if (!path.endsWith("/api/workflow/rpc")) return json(404, {})
    const body = JSON.parse(String(init?.body))
    calls.push(body)
    if (body.procedure === "Plan") return json(200, { ok: true, payload: { planId: "plan-1", digest: "digest", envelope: { capabilities: [], flows: [], budget: {} } } })
    if (body.procedure === "Approval.Submit") return json(200, { ok: true, payload: {} })
    if (body.procedure === "Run") return run()
    if (body.procedure === "Projection.Snapshot") return json(200, { ok: true, payload: { rows: body.payload.selector._tag === "run-summary" ? [summary()] : [] } })
    return json(200, { ok: true, payload: { items: [] } })
  } }
  const controller = createAppController(store, unavailableRepositories, chat.agent, services)
  const cards = () => [...store.collections.cards.values()].filter(card => card.kind === "run-trace")
  const toasts = () => [...store.collections.toasts.values()].filter(toast => toast.key.startsWith("flow.request."))
  return { store, storage, controller, services, calls, cards, toasts, chat,
    provision: (fn: typeof provision) => { provision = fn }, run: (fn: typeof run) => { run = fn }, status: (value: RunSummaryRow["status"]) => { status = value } }
}

test("flow.run persists a request and returns during unresolved preparation; duplicate input and Chat stay usable", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  const result = await Promise.race([t.controller.commands.run("flow.run", `review ${repo} {"args":"inspect"}`), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
  expect(result).toMatchObject({ status: "executed", value: expect.stringContaining("run-requested") })
  expect(t.cards()).toHaveLength(1)
  expect(t.cards()[0]!.payload.phase).toBe("launching")
  await t.controller.commands.run("flow.run", `review ${repo} {"args":"inspect"}`)
  expect(t.cards()).toHaveLength(1)
  t.controller.send("Are you still here?")
  await waitFor(() => t.chat.requests.length === 1 && t.store.session().phase === "idle")
  await waitFor(() => t.toasts()[0]?.status === "running")
  expect(t.calls).toHaveLength(0)
  gate.resolve(json(200, { status: "ready" }))
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
})

test("the shared 300 ms toast spans an unresolved launch and running job, and settles only on completion", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.run(() => gate.promise)
  const result = await Promise.race([t.controller.commands.run("flow.run", `review ${repo}`), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
  expect(result).toMatchObject({ status: "executed", value: expect.stringContaining("run-requested") })
  expect(t.toasts()).toHaveLength(0)
  const id = t.cards()[0]!.id
  await waitFor(() => t.calls.some(call => call.procedure === "Run"))
  await waitFor(() => t.toasts()[0]?.status === "running")
  t.controller.send("Chat during launch")
  await waitFor(() => t.chat.requests.length === 1 && t.store.session().phase === "idle")
  gate.resolve(json(200, { ok: true, payload: { runId: "run-1" } }))
  await waitFor(() => t.cards()[0]?.payload.phase === "running")
  expect(t.cards()[0]!.id).toBe(id)
  expect(t.toasts()[0]?.status).toBe("running")
  t.controller.send("Chat during execution")
  await waitFor(() => t.chat.requests.length === 2 && t.store.session().phase === "idle")
  await t.controller.commands.run("flow.run", `review ${repo}`)
  expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  t.status("completed")
  await waitFor(() => t.toasts()[0]?.status === "ok")
  expect(t.cards()[0]?.payload.phase).toBe("completed")
})

test("workspace_starting retries the persisted request until the gateway serves it", async () => {
  const t = await fixture()
  let attempts = 0
  t.provision(async () => ++attempts < 3 ? new Response(JSON.stringify({ code: "workspace_starting", message: "Waking up" }), { status: 503, headers: { "Retry-After": "0" } }) : json(200, { status: "ready" }))
  expect(await t.controller.commands.run("flow.run", `review ${repo}`)).toMatchObject({ status: "executed" })
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(attempts).toBe(3)
  expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  expect(t.cards()).toHaveLength(1)
})

test("a refused launch stays visible and the existing retry flow retries the same request", async () => {
  const t = await fixture()
  t.run(async () => json(200, { ok: false, error: { message: "Provider unavailable", detail: { code: "provider_unavailable" } } }))
  await t.controller.commands.run("flow.run", `review ${repo} {"args":"inspect"}`)
  await waitFor(() => t.cards()[0]?.status === "error")
  const id = t.cards()[0]!.id
  expect(t.cards()[0]!.payload.error).toContain("Provider unavailable")
  t.run(async () => json(200, { ok: true, payload: { runId: "run-1" } }))
  await t.controller.commands.run("flow.run.retry", id)
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.cards()[0]!.id).toBe(id)
  const plans = t.calls.filter(call => call.procedure === "Plan")
  expect(plans).toHaveLength(2)
  expect(plans[0]!.payload.idempotencyKey).toBeString()
  expect(plans[1]!.payload.idempotencyKey).toBe(plans[0]!.payload.idempotencyKey)
  expect(plans[1]!.payload.input).toEqual({ args: "inspect" })
})

test("workspace_starting during Run retries the same admission instead of failing the request", async () => {
  const t = await fixture()
  let attempts = 0
  t.run(async () => ++attempts === 1
    ? new Response(JSON.stringify({ code: "workspace_starting", message: "Waking up" }), { status: 503, headers: { "Retry-After": "0" } })
    : json(200, { ok: true, payload: { runId: "run-1" } }))
  await t.controller.commands.run("flow.run", `review ${repo} {"args":"inspect"}`)
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.cards()).toHaveLength(1)
  expect(t.cards()[0]?.status).toBe("active")
  for (const procedure of ["Plan", "Approval.Submit", "Run"]) {
    const calls = t.calls.filter(call => call.procedure === procedure)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.payload.idempotencyKey).toBe(calls[1]!.payload.idempotencyKey)
  }
})

test("reload reconnects a launch whose Run response was lost, using the same Plan and Run keys", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.run(() => gate.promise)
  await t.controller.commands.run("flow.run", `review ${repo}`)
  await waitFor(() => t.calls.some(call => call.procedure === "Run"))
  await t.controller.dispose()
  await t.store.settled?.()
  const restored = await createAppStore({ kind: "localStorage", storage: t.storage })
  t.run(async () => json(200, { ok: true, payload: { runId: "run-1" } }))
  createAppController(restored, unavailableRepositories, t.chat.agent, t.services)
  await waitFor(() => [...restored.collections.cards.values()].some(card => card.kind === "run-trace" && card.payload.runId === "run-1"))
  for (const procedure of ["Plan", "Run"]) {
    const requests = t.calls.filter(call => call.procedure === procedure)
    expect(requests).toHaveLength(2)
    expect(requests[0]!.payload.idempotencyKey).toBeString()
    expect(requests[1]!.payload.idempotencyKey).toBe(requests[0]!.payload.idempotencyKey)
  }
  gate.resolve(json(200, { ok: true, payload: { runId: "stale-run" } }))
  await settle()
  expect([...restored.collections.cards.values()].filter(card => card.kind === "run-trace")).toHaveLength(1)
})

test("reload of a running remote job restores its toast without launching again", async () => {
  const t = await fixture()
  await t.controller.commands.run("flow.run", `review ${repo}`)
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  await t.controller.dispose()
  await t.store.settled?.()
  const store = await createAppStore({ kind: "localStorage", storage: t.storage })
  createAppController(store, unavailableRepositories, t.chat.agent, t.services)
  await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.key.startsWith("flow.request.") && toast.status === "running"))
  expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  t.status("failed")
  await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.key.startsWith("flow.request.") && toast.status === "failed"))
  expect([...store.collections.cards.values()].find(card => card.kind === "run-trace")).toMatchObject({ payload: { phase: "failed", error: "The check failed." } })
})

test("late preparation from a different account never launches or replaces the new account's cards", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  await t.controller.commands.run("flow.run", `review ${repo}`)
  await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "different-owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  gate.resolve(json(200, { status: "ready" }))
  await settle()
  expect(t.calls.filter(call => call.procedure === "Plan" || call.procedure === "Run")).toHaveLength(0)
  expect(t.toasts().some(toast => toast.status === "ok")).toBe(false)
})

test("refreshing the same signed-in identity does not reject an unresolved preparation", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  await t.controller.commands.run("flow.run", `review ${repo}`)
  await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  gate.resolve(json(200, { status: "ready" }))
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.cards()[0]?.status).toBe("active")
})

test("simultaneous equivalent inputs across the user and agent bindings share one launch", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  await Promise.all([
    t.controller.runWorkflow("review", repo, { args: "inspect", count: 1 }),
    t.controller.commands.runForAgent("flow.run", `review ${repo} {"count":1,"args":"inspect"}`)
  ])
  expect(t.cards()).toHaveLength(1)
  gate.resolve(json(200, { status: "ready" }))
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.calls.filter(call => call.procedure === "Plan")).toHaveLength(1)
})

test("a persisted request launches its admitted input even if the caller later changes its object", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  const input = { args: "inspect", nested: { count: 1 }, _workflowLaunch: "flow-owned value" }
  await t.controller.runWorkflow("review", repo, input)
  input.args = "changed after admission"
  input.nested.count = 9
  gate.resolve(json(200, { status: "ready" }))
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.calls.find(call => call.procedure === "Plan")?.payload.input).toEqual({ args: "inspect", nested: { count: 1 }, _workflowLaunch: "flow-owned value" })
})
