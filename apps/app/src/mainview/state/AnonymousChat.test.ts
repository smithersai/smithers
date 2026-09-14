import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { StartAgentTurnRequest, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { initialGuide } from "./AppState"
import { memoryStorage, settled, silentAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()
const cloud: AppBootstrap = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity"], authFlow: "redirect", sandbox: null }
const question = "What can I do without signing in?"

const setup = async (options: { bootstrap?: AppBootstrap; state?: "signed-in" | "signed-out" | "unknown"; result?: () => Promise<StartAgentTurnResult> } = {}) => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  if (options.state !== "unknown") {
    const state = options.state ?? "signed-out"
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state, login: state === "signed-in" ? "will" : null, allowlisted: state === "signed-in", admin: false, scopesPlain: null }).isPersisted.promise
  }
  const requests: StartAgentTurnRequest[] = []
  const controller = createAppController(store, unavailableRepositories, { ...silentAgent, available: true,
    startTurn: async request => { requests.push(request); return options.result ? options.result() : { status: "started" } },
  }, { bootstrap: options.bootstrap ?? cloud, fetchImpl: async () => new Response("{}", { status: 200 }) })
  return { storage, store, controller, requests }
}

describe("anonymous tutorial chat", () => {
  test("skipping sign-in can open Chat, retain a draft, and finish without a failed model request", async () => {
    const { store, controller, requests, storage } = await setup()
    await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 10 } }).isPersisted.promise
    await controller.commands.run("onboarding.act", "decline login")
    expect(store.session().guide?.step).toBe(13)
    await controller.commands.run("chat.open")
    expect(store.session().guide?.conversationOpen).toBe(true)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: question }).isPersisted.promise
    await controller.commands.run("chat.send", question)
    expect(requests).toHaveLength(0)
    expect(store.session().draft).toBe(question)
    expect(store.session().phase).toBe("idle")
    const messages = [...store.collections.messages.values()]
    expect(messages.some(message => message.status === "failed" || message.role === "user")).toBe(false)
    expect(messages.find(message => message.action?.flow === "auth.sign-in")?.text).toContain("Close Chat to continue or finish")
    await controller.commands.run("onboarding.act", "finish")
    expect(store.session().guide?.finished).toBe(true)
    expect(store.session().draft).toBe(question)
    await controller.dispose()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.session().draft).toBe(question)
    expect(reopened.session().guide?.finished).toBe(true)
    await reopened.dispose?.()
  })

  test("commands still execute while signed out", async () => {
    const { controller, store, requests } = await setup()
    controller.send("/chat.commands")
    await settled()
    expect(requests).toHaveLength(0)
    expect([...store.collections.messages.values()].some(message => message.action?.flow === "auth.sign-in")).toBe(false)
    expect(store.session().draft).toBe("")
  })

  test("signed-in, local, and public catalog chat retain their existing backend path", async () => {
    for (const mode of ["signed-in", "local", "catalog", "no-identity"] as const) {
      const { store, controller, requests } = await setup({
        state: mode === "signed-in" ? "signed-in" : "signed-out",
        bootstrap: mode === "local" ? { ...cloud, host: "local" } : mode === "no-identity" ? { ...cloud, capabilities: ["agent"] } : cloud,
      })
      if (mode === "catalog") {
        await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "user", name: "smithers", head: null, catalog: true }] }).isPersisted.promise
        await store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" }).isPersisted.promise
      }
      controller.send(question)
      await settled()
      expect(requests).toHaveLength(1)
      expect(store.session().draft).toBe("")
    }
  })

  test.each([false, true])("a sign-in refusal while identity is loading preserves text (new draft: %s)", async newerDraft => {
    let refuse!: (result: StartAgentTurnResult) => void
    const pending = new Promise<StartAgentTurnResult>(resolve => { refuse = resolve })
    const { store, controller, requests } = await setup({ state: "unknown", result: () => pending })
    controller.send(question)
    if (newerDraft) await store.dispatch({ type: "composer.changed", actor: "user", draft: "My next thought" }).isPersisted.promise
    refuse({ status: "error", message: "Smithers web agent failed (HTTP 401): Sign in to run a Smithers turn.", refusal: { code: "sign_in_required", message: "Sign in to run a Smithers turn.", retryAt: null } })
    await settled()
    expect(requests).toHaveLength(1)
    expect(store.session().phase).toBe("idle")
    expect(store.session().draft).toBe(newerDraft ? "My next thought" : question)
    expect([...store.collections.messages.values()].some(message => message.status === "failed")).toBe(false)
    expect([...store.collections.messages.values()].some(message => message.action?.flow === "auth.sign-in")).toBe(true)
  })
})
