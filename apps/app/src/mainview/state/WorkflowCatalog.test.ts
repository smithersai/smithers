import { expect, test } from "bun:test"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { json, memoryStorage, settle, silentAgent, unavailableRepositories, waitFor } from "./TestFixtures"

const controllerFor = scopedControllers()
const repo = "codeplanesmithers/canary-sandbox"
const id = `workflow-list-${repo}`
const toast = `toast-flow.catalog.${id}`
const ready = () => json(200, { status: "ready", repo, gatewayId: "gateway" })
const catalog = (flowId = "checks/fast") => json(200, { ok: true, payload: { _tag: "flows", items: [{ flowId, description: "Check" }] } })
const failure = () => json(502, { status: "error", code: "upstream_refused", message: "upstream unavailable" })
const deferred = () => {
  let resolve!: (value: Response) => void
  return { promise: new Promise<Response>(yes => { resolve = yes }), resolve: (value: Response) => resolve(value) }
}
async function fixture(options: {
  provision?: () => Promise<Response>; list?: () => Promise<Response>; storage?: ReturnType<typeof memoryStorage>
} = {}) {
  const storage = options.storage ?? memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const calls: Array<{ path: string; body: any }> = []
  const services: AppServices = { toastAutoDismissMs: 10_000, workflowPollMs: 1,
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "https://test.local").pathname
      if (!path.startsWith("/api/workflow/")) return json(404, {})
      const body = JSON.parse(String(init?.body))
      calls.push({ path, body })
      if (path.endsWith("/provision")) {
        expect(store.collections.cards.get(id)).toMatchObject({ payload: { catalogRequest: { state: "pending" } } })
        return options.provision?.() ?? ready()
      }
      expect(body).toMatchObject({ procedure: "List", payload: { _tag: "flows" } })
      return options.list?.() ?? catalog()
    } }
  const controller = controllerFor(store, unavailableRepositories, silentAgent, services)
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "codeplanesmithers", ownerKind: "user", name: "canary-sandbox", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "codeplanesmithers", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await settle(2)
  return { store, storage, controller, calls }
}
const acknowledged = async (promise: Promise<unknown>) => {
  expect(await Promise.race([promise, new Promise(resolve => setTimeout(() => resolve("blocked"), 300))]))
    .toMatchObject({ status: "executed", value: "Flows requested." })
}

test("CAP-001: no hover provisioning; activation returns before preparation and catalog, deduplicates, and keeps Chat usable", async () => {
  const provision = deferred(), list = deferred()
  const { controller, store, calls } = await fixture({ provision: () => provision.promise, list: () => list.promise })
  await controller.commands.preload!("flows")
  await controller.commands.preload!("flow.list")
  expect(calls).toHaveLength(0)
  await acknowledged(controller.commands.run("flows"))
  await waitFor(() => calls.length === 1)
  expect(store.collections.cards.get(id)?.loading).toBe(true)
  expect(store.collections.toasts.has(toast)).toBe(false)
  await acknowledged(controller.commands.run("flow.list"))
  expect(calls).toHaveLength(1)
  expect((await controller.commands.run("chat")).status).toBe("executed")
  expect(store.session().surface).toBe("chat")
  await waitFor(() => store.collections.toasts.get(toast)?.status === "running")
  provision.resolve(ready())
  await waitFor(() => calls.length === 2)
  expect(store.collections.toasts.get(toast)?.status).toBe("running")
  expect(store.collections.cards.get(id)?.loading).toBe(true)
  list.resolve(catalog())
  await waitFor(() => store.collections.toasts.get(toast)?.status === "ok")
  expect(store.collections.cards.get(id)).toMatchObject({ loading: false, payload: { workflows: [{ key: "checks/fast" }] } })
  expect(calls.map(call => call.body.procedure).filter(Boolean)).toEqual(["List"])
  expect(store.session().surface).toBe("chat")
})

for (const step of ["provision", "list"] as const) test(`CAP-001: ${step} failure stays visible, survives reload, and retries only on request`, async () => {
  let refused = true
  const { controller, store, storage, calls } = await fixture({
    provision: async () => step === "provision" && refused ? failure() : ready(),
    list: async () => refused ? failure() : catalog()
  })
  await acknowledged(controller.commands.run("flow.list"))
  await waitFor(() => store.collections.toasts.get(toast)?.status === "failed")
  expect(store.collections.cards.get(id)).toMatchObject({ loading: false, status: "error", payload: { catalogRequest: { state: "failed" } } })
  if (step === "provision") expect(calls).toHaveLength(1)
  await store.settled?.()
  await controller.dispose()
  const reloaded = await fixture({ storage })
  await settle(5)
  expect(reloaded.calls).toHaveLength(0)
  expect(reloaded.store.collections.cards.get(id)?.status).toBe("error")
  refused = false
  await acknowledged(reloaded.controller.commands.run("flow.list", `sourceCard=${id}`))
  await waitFor(() => reloaded.store.collections.cards.get(id)?.status === "active" && !reloaded.store.collections.cards.get(id)?.loading)
  expect(reloaded.calls.map(call => call.body.procedure).filter(Boolean)).toEqual(["List"])
})

test("pending catalog reconnects after reload and the old completion cannot overwrite it", async () => {
  const oldRead = deferred()
  const first = await fixture({ list: () => oldRead.promise })
  await acknowledged(first.controller.commands.run("flow.list"))
  await waitFor(() => first.calls.length === 2)
  await first.store.settled?.()
  await first.controller.dispose()
  const next = await fixture({ storage: first.storage })
  await waitFor(() => next.calls.length === 2 && next.store.collections.cards.get(id)?.loading === false)
  oldRead.resolve(catalog("stale"))
  await settle(5)
  expect(next.store.collections.cards.get(id)).toMatchObject({ payload: { workflows: [{ key: "checks/fast" }] } })
})

test("an account change fences a pending catalog and never resumes another owner's request", async () => {
  const provision = deferred()
  const { controller, store, calls } = await fixture({ provision: () => provision.promise })
  await acknowledged(controller.commands.run("flow.list"))
  await waitFor(() => calls.length === 1)
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "another-user", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  provision.resolve(ready())
  await settle(5)
  expect(calls).toHaveLength(1)
  expect(store.collections.toasts.get(toast)?.status).not.toBe("ok")
})
