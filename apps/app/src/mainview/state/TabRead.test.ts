import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { TAB_READ_TAIL_BYTES } from "./controller/tabs"
import { memoryStorage } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * `tab.read` (docs/LOCAL-APP.md "Tabs"): Smithers is the first tab and reads
 * every other one. A process tab answers with the server's bounded plain-text
 * tail; a card tab with its payload; main with the note that it IS the
 * conversation; an unknown id with the list of tabs that exist.
 */

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "native only" })
}

const silentAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const harness = async (answer: (url: string) => Response) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const urls: string[] = []
  const controller = createAppController(store, unavailableRepositories, silentAgent, {
    bootstrap: {
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "test",
      capabilities: ["local.terminal", "local.harnesses"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    },
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      urls.push(url)
      return answer(url)
    }
  })
  await store.dispatch({
    type: "tab.opened",
    actor: "user",
    tab: { id: "t1", kind: "terminal", title: "Terminal · ~", sessionId: "t1", cwd: "~" }
  }).isPersisted.promise
  return { store, controller, urls }
}

describe("tab.read", () => {
  test("a terminal tab answers with the server's plain-text tail, bounded by the tail query", async () => {
    const { controller, urls } = await harness(() =>
      Response.json({ sessionId: "t1", alive: true, output: "$ bun test\n12 pass\n", truncated: true })
    )
    const outcome = await controller.commands.runAsAgent("tab.read", "t1")
    expect(outcome).toEqual({
      status: "executed",
      value: "terminal \"Terminal · ~\" (running) in ~ — older output not shown\n$ bun test\n12 pass\n"
    })
    expect(urls.some((url) => url.endsWith(`/api/pty/t1/output?tail=${TAB_READ_TAIL_BYTES}`))).toBe(true)
  })

  test("an exited tab says so with its code; an empty scrollback is stated, not blank", async () => {
    const { store, controller } = await harness(() =>
      Response.json({ sessionId: "t1", alive: false, output: "", truncated: false })
    )
    await store.dispatch({ type: "pty.exited", actor: "system", sessionId: "t1", code: 2 }).isPersisted.promise
    const outcome = await controller.commands.runAsAgent("tab.read", "t1")
    expect(outcome).toEqual({ status: "executed", value: "terminal \"Terminal · ~\" (exited, code 2) in ~\n(no output yet)" })
  })

  test("main, a card tab, and an unknown id each answer honestly", async () => {
    const { store, controller } = await harness(() => Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 }))
    expect(await controller.commands.runAsAgent("tab.read", "main")).toMatchObject({
      status: "executed",
      value: expect.stringContaining("this conversation")
    })
    await store.dispatch({
      type: "card.upsert",
      actor: "user",
      card: { id: "theme-picker", kind: "theme-picker", title: "Color themes", status: "active", createdAt: 1, ordinal: 0, payload: { selected: "night-owl" } }
    }).isPersisted.promise
    await store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: { id: "card-theme-picker", kind: "card", title: "Color themes", cardId: "theme-picker" }
    }).isPersisted.promise
    expect(await controller.commands.runAsAgent("tab.read", "card-theme-picker")).toEqual({
      status: "executed",
      value: JSON.stringify({ kind: "theme-picker", title: "Color themes", status: "active", payload: { selected: "night-owl" } })
    })
    const missing = await controller.commands.runAsAgent("tab.read", "nope")
    expect(missing.status).toBe("failed")
    expect(missing.status === "failed" ? missing.error : "").toContain("t1 (terminal \"Terminal · ~\")")
    // The server refusing is a refusal, never a crash.
    const refused = await controller.commands.runAsAgent("tab.read", "t1")
    expect(refused.status).toBe("failed")
  })

  test("the flow is model-invocable and listed with its argument hint", () => {
    return harness(() => Response.json({})).then(({ controller }) => {
      const entry = controller.commands.find("tab.read")
      expect(entry?.binding.descriptor.modelInvocable).toBe(true)
      expect(entry?.metadata.args).toBe("<tabId>")
    })
  })
})
