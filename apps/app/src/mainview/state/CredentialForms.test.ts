import { expect, test } from "bun:test"
import { MODEL_CREDENTIAL_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { writeOnlyGesture } from "../flows/CommandGesture"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, unavailableAgent, unavailableRepositories, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

test("agent enrollment confirms public fields before collecting the key, and no form or command persists it", async () => {
  const persisted = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => persisted.get(key) ?? null, setItem: (key, value) => { persisted.set(key, value) }, removeItem: key => { persisted.delete(key) }
  } })
  const requests: string[] = []
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, { fetchImpl: async (url, init) => {
    const path = new URL(String(url), "http://local.test").pathname
    if (path === MODEL_CREDENTIAL_PATH) { requests.push(String(init?.body)); return Response.json({ ok: true, credential: { name: "ENROLLED", origins: ["http://127.0.0.1:5555"], present: true, managed: true } }) }
    return Response.json({ models: [], credentials: [], seats: ["explainer"], enrollment: { available: true } })
  } })
  const outcome = await controller.commands.runForAgent("model.credential.enroll", "--name ENROLLED --origin http://127.0.0.1:5555")
  expect(outcome).toMatchObject({ status: "executed" })
  expect(requests).toHaveLength(0)
  const confirmation = [...store.collections.messages.values()].find(message => message.action?.flow === "model.credential.enroll")!
  expect(confirmation.action?.label).toContain("Confirm:")
  expect(await controller.commands.run(confirmation.action!.flow, confirmation.action!.args)).toMatchObject({ status: "form" })
  const id = "form-model.credential.enroll"
  const card = store.collections.cards.get(id)!
  expect(card.kind === "flow-form" && card.payload.fields.some(field => field.kind === "write-only")).toBe(true)
  const secret = "opaque-form-private-fixture"
  expect(await controller.commands.run("form.set", `${id} value ${secret}`)).toMatchObject({ status: "failed" })
  expect(await controller.commands.submit({ name: "form.submit", actor: "user", payload: { cardId: id }, gesture: writeOnlyGesture("form.submit", { value: secret }) })).toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => {
    const models = store.collections.cards.get("models")
    return models?.kind === "models" && models.payload.credentialRequests?.[0]?.state === "completed"
  })
  expect(requests).toHaveLength(1)
  expect(JSON.parse(requests[0]!).value === secret).toBe(true)
  await store.settled?.()
  expect(JSON.stringify([...persisted]).includes(secret)).toBe(false)
  expect(JSON.stringify([...store.collections.transitions.values(), ...store.collections.cards.values(), ...store.collections.messages.values()]).includes(secret)).toBe(false)
})

test("agent card frames cannot downgrade a secure control to a persisted text field", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const id = "form-model.credential.enroll"
  const controller = createAppController(store, unavailableRepositories, {
    available: true, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, cancelTurn: async () => {},
    startTurn: async request => {
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({ type: "card.update", runId: request.runId, id, patch: { kind: "flow-form", payload: { fields: [{ name: "value", label: "API key", kind: "text", required: true }] } } })
          listener({ type: "done", runId: request.runId })
        }
      })
      return { status: "started" }
    }
  })
  await controller.commands.run("model.credential.enroll", "--name ENROLLED --origin https://provider.example")
  controller.send("change the form")
  await waitFor(() => store.session().phase === "idle")
  const card = store.collections.cards.get(id)
  expect(card?.kind === "flow-form" && card.payload.fields.find(field => field.name === "value")?.kind).toBe("write-only")
  expect(await controller.commands.run("form.set", `${id} value private-field-fixture`)).toMatchObject({ status: "failed" })
  expect(JSON.stringify([...store.collections.cards.values()])).not.toContain("private-field-fixture")
})

test("cloud slash enrollment disables the secret option before any catalog was loaded", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null }
  })
  await controller.commands.run("model.credential.enroll", "--name ENROLLED --origin https://provider.example")
  const card = store.collections.cards.get("form-model.credential.enroll")
  expect(card?.kind === "flow-form" && card.payload.fields.find(field => field.name === "value")?.disabledReason).toBe("Local host required")
})

test.each([
  [{ available: true }, undefined],
  [{ available: false, reason: "vault_unavailable" }, "Vault unavailable"],
  [{ available: false, reason: "sign_in_required" }, "Sign in required"]
])("cloud enrollment uses the host capability and never persists its write-only value (%j)", async (enrollment, disabledReason) => {
  const persisted = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => persisted.get(key) ?? null, setItem: (key, value) => { persisted.set(key, value) }, removeItem: key => { persisted.delete(key) }
  } })
  const calls: string[] = []
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith(MODEL_CREDENTIAL_PATH)) {
        calls.push(String(init?.body))
        return Response.json({ ok: true, credential: { name: "CLOUD", origins: ["https://provider.example"], present: true, managed: true } })
      }
      return Response.json({ models: [], credentials: [], seats: ["explainer"], enrollment })
    }
  })
  await controller.commands.run("model.list")
  await waitFor(() => {
    const card = store.collections.cards.get("models")
    return card?.kind === "models" && card.payload.host === "observed"
  })
  await controller.commands.run("model.credential.enroll", "--name CLOUD --origin https://provider.example")
  const id = "form-model.credential.enroll", card = store.collections.cards.get(id)
  expect(card?.kind === "flow-form" && card.payload.fields.find(field => field.name === "value")?.disabledReason).toBe(disabledReason)
  if (disabledReason !== undefined) return
  const value = "cloud-write-only-fixture-value"
  expect(await controller.commands.submit({ name: "form.submit", actor: "user", payload: { cardId: id }, gesture: writeOnlyGesture("form.submit", { value }) }))
    .toMatchObject({ status: "executed", value: "Requested" })
  await waitFor(() => calls.length === 1)
  await store.settled?.()
  expect(JSON.stringify([...persisted])).not.toContain(value)
  expect(JSON.stringify([...store.collections.cards.values(), ...store.collections.transitions.values(), ...store.collections.messages.values()])).not.toContain(value)
})
