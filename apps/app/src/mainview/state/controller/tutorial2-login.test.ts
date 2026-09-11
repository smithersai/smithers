import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { initialGuide } from "../AppState"
import { createAppStore } from "../AppStore"
import { createAuthBillingController } from "./auth-billing"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const repositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "native unavailable"
  })
}

const agent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", code: "native-required", message: "native unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const fixture = async (body: unknown, status = 200) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const ctx = createControllerContext(store, repositories, agent, {
    fetchImpl: async (input) => (input instanceof Request ? input.url : String(input)).endsWith("/auth/session")
      ? Response.json(body, { status }) : Response.json({ scopes: [] })
  })
  ctx.withToast = createFailureController(ctx).withToast
  const controller = createAuthBillingController(ctx, () => 0)
  const enter = (step = 1, playthrough = 0) => store.dispatch({ type: "guide.changed", actor: "user", guide: { ...(store.session().guide ?? initialGuide()), step, playthrough, completed: [] } })
  return { store, ctx, controller, enter }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20))
const completed = (store: Awaited<ReturnType<typeof fixture>>["store"]) => store.session().guide?.completed?.includes("identity.signed-in") ?? false

describe("tutorial identity completion", () => {
  test("validated persisted login completes on entry and replay, regardless of allowlisting", async () => {
    const { store, controller, enter } = await fixture({ login: "will", allowlisted: false })
    await controller.loadSession()
    await tick()
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-in")
    expect(completed(store)).toBe(false)
    enter()
    await tick()
    expect(completed(store)).toBe(true)
    enter(0, 1)
    await tick()
    expect(completed(store)).toBe(false)
    enter(1, 1)
    await tick()
    expect(completed(store)).toBe(true)
  })
  for (const [body, status] of [
    [null, 200],
    [{ status: "unknown", login: "will" }, 200],
    [{ state: "unavailable", login: "will" }, 200],
    [{ login: " " }, 200], [{ status: "signed-out" }, 200],
    [{ login: "will" }, 501], [{ login: "will" }, 401]
  ] as const) test(`refuses ${JSON.stringify(body)} HTTP ${status}`, async () => {
    const { store, controller, enter } = await fixture(body, status)
    enter()
    await controller.loadSession()
    await tick()
    expect(completed(store)).toBe(false)
  })
  test("a redirect marker and persisted identity alone are not login evidence", async () => {
    const { store, controller, enter } = await fixture({})
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null })
    enter()
    controller.handleAuthReturn("?signed-in=github")
    await tick()
    expect(completed(store)).toBe(false)
    controller.handleAuthReturn("?auth=failed")
    expect(completed(store)).toBe(false)
  })
  test("a newer unavailable session supersedes an old pending response", async () => {
    const { store, controller, enter, ctx } = await fixture({ login: "will" })
    enter()
    const pending = controller.loadSession()
    await controller.adoptSession({ state: "unavailable", login: null, allowlisted: false, admin: false })
    await pending
    await tick()
    expect(completed(store)).toBe(false)
    expect(ctx.accountEpoch).toBe(2)
  })
})
