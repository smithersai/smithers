import { describe, expect, spyOn, test } from "bun:test"
import { EXPERIMENTAL_MANIFEST, manifestRow } from "./Manifest"
import { executeAgentToolCall } from "../flows/agentTools"
import { flowArgs } from "../flows/FlowArgs"
import { payloadFor } from "../flows/SlashPayload"
import type { AppStore } from "../state/AppStore"
import { createAppStore } from "../state/AppStore"
import { MAIN_TAB_ID, PALETTES } from "../state/AppState"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, settled, unavailableAgent, unavailableRepositories } from "../state/TestFixtures"

const createAppController = scopedControllers()

const boot = async (experimental: boolean, storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    features: { experimental }
  })
  return { controller, store, storage }
}

const cards = (store: AppStore) => [...store.collections.cards.values()].filter(card => card.kind === "experimental")
const names = (items: ReadonlyArray<{ readonly name: string }>) => items.map(item => item.name).filter(name => name.startsWith("experimental.")).sort()
const allNames = [...EXPERIMENTAL_MANIFEST.map(entry => `experimental.${entry.id}`), "experimental.set"].sort()

describe("experimental flows share the flag and all three doors", () => {
  test("the session switch changes all doors on the same controller", async () => {
    const { controller, store } = await boot(false)
    expect(controller.commands.all().some(item => item.name === "app.experimental")).toBe(true)
    expect(names(controller.commands.all())).toEqual([])
    expect((await controller.commands.runAsAgent("experimental.plan")).status).toBe("unavailable")
    expect((await controller.commands.run("app.experimental", "on")).status).toBe("executed")
    expect(controller.commands.state().experimental).toBe(true)
    expect(names(controller.commands.all())).toEqual(allNames)
    const ordered = controller.commands.all().map(item => item.name)
    expect(ordered.indexOf("experimental.set")).toBeLessThan(ordered.indexOf("input.mode"))
    expect(ordered.indexOf("experimental.plan")).toBeGreaterThan(ordered.indexOf("palette.recent"))
    expect(names(controller.commands.disclosed())).toEqual(allNames)
    expect((await controller.commands.run("experimental.plan")).status).toBe("executed")
    expect(cards(store)).toHaveLength(1)
    expect((await controller.commands.runAsAgent("experimental.plan")).status).toBe("executed")
    await controller.commands.run("app.experimental", "on")
    expect(store.session().experimental).toBe(true)
    await controller.commands.run("app.experimental", "off")
    expect(names(controller.commands.all())).toEqual([])
    expect(names(controller.commands.disclosed())).toEqual([])
    for (const name of ["experimental.plan", "experimental.set"]) {
      expect((await controller.commands.run(name)).status).toBe("unavailable")
      expect((await controller.commands.runAsAgent(name)).status).toBe("unavailable")
    }
    expect(cards(store)).toHaveLength(1)
    await controller.commands.run("app.experimental")
    expect(store.session().experimental).toBe(true)
    await controller.commands.run("app.experimental")
    expect(store.session().experimental).toBe(false)
    expect((await controller.commands.runAsAgent("app.experimental", "on")).status).toBe("executed")
    expect(names(controller.commands.disclosed())).toEqual(allNames)
  })

  for (const presentation of ["maximized", "tab"] as const) {
    test(`session setting persists with a ${presentation} card and off reconciles it live`, async () => {
      const { controller, store, storage } = await boot(false)
      await controller.commands.run("app.experimental", "on")
      await controller.commands.run("experimental.plan")
      const id = cards(store)[0]!.id
      await controller.commands.run(presentation === "tab" ? "tab.card" : "card.maximize", id)
      await controller.dispose()
      const restored = await boot(false, storage)
      expect(names(restored.controller.commands.all())).toEqual(allNames)
      if (presentation === "tab") expect(restored.store.session().activeTabId).toBe(`card-${id}`)
      else expect(restored.store.session().maximizedCardId).toBe(id)
      await restored.controller.commands.run("app.experimental", "off")
      expect(restored.store.session().maximizedCardId).toBeNull()
      expect(restored.store.session().activeTabId).toBe(MAIN_TAB_ID)
      expect(restored.store.collections.cards.has(id)).toBe(true)
    })
  }

  test("flag off: no registration, disclosure or agent invocation, and no upsert", async () => {
    const { controller, store } = await boot(false)
    const dispatch = spyOn(store, "dispatch")
    try {
      expect(names(controller.commands.all())).toEqual([])
      expect(names(controller.commands.disclosed())).toEqual([])
      expect((await controller.commands.runAsAgent("experimental.plan")).status).toBe("unavailable")
      expect((await controller.commands.runAsAgent("experimental.set", flowArgs("experimental.set", {
        cardId: "experimental:plan", key: "nodeId", value: "test"
      }))).status).toBe("unavailable")
      expect(dispatch.mock.calls.filter(([event]) => event.type === "card.upsert")).toEqual([])
      expect(cards(store)).toEqual([])
    } finally { dispatch.mockRestore() }
  })

  test("flag on: every pane and the hidden selection flow are disclosed and agent-invocable", async () => {
    const { controller, store } = await boot(true)
    expect(names(controller.commands.all())).toEqual(allNames)
    expect(names(controller.commands.disclosed())).toEqual(allNames)
    expect(controller.commands.find("experimental.set")?.metadata.hidden).toBe(true)
    expect((await controller.commands.runAsAgent("experimental.plan")).status).toBe("executed")
    expect(cards(store)).toHaveLength(1)
    expect(cards(store)[0]?.payload).toEqual({ pane: "plan" })
    expect(store.session().maximizedCardId).toBeNull()
  })

  test("the agent patches one prop, preserving every other card field and its identity", async () => {
    const { controller, store } = await boot(true)
    await controller.commands.runAsAgent("experimental.plan")
    const opened = cards(store)[0]!
    const before = { ...opened, title: "Saved plan", createdAt: 17, ordinal: 23,
      payload: { ...opened.payload, props: { nodeId: "build", retained: "unchanged" } } }
    await store.dispatch({ type: "card.upsert", actor: "system", card: before }).isPersisted.promise
    const dispatch = spyOn(store, "dispatch")
    try {
      const input = { cardId: before.id, key: "nodeId", value: "test" }
      expect((await controller.commands.runAsAgent("experimental.set", flowArgs("experimental.set", input))).status).toBe("executed")
      expect(cards(store)).toEqual([{ ...before, payload: { ...before.payload, props: { nodeId: "test", retained: "unchanged" } } }])
      expect(dispatch.mock.calls.filter(([event]) => event.type === "card.upsert").map(([event]) => event.actor)).toEqual(["smithers"])
    } finally { dispatch.mockRestore() }
  })

  test("an unknown or non-experimental card is refused as a string without an upsert", async () => {
    const { controller, store } = await boot(true)
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "ordinary", kind: "status", status: "active", title: "Work", createdAt: 1, ordinal: 1, payload: { note: "Running" }
    } }).isPersisted.promise
    const dispatch = spyOn(store, "dispatch")
    try {
      for (const cardId of ["missing", "ordinary"]) {
        const result = await controller.commands.runAsAgent("experimental.set", flowArgs("experimental.set", { cardId, key: "nodeId", value: "test" }))
        expect(result.status).toBe("failed")
        if (result.status !== "failed") throw new Error("Expected a refusal")
        expect(result.error).toContain("Experimental card not found.")
      }
      expect(dispatch.mock.calls.filter(([event]) => event.type === "card.upsert")).toEqual([])
    } finally { dispatch.mockRestore() }
  })

  test("reopening keeps id, creation time and selections, and moves the card after messages and cards", async () => {
    const { controller, store } = await boot(true)
    await controller.commands.run("experimental.cell-loop")
    const first = cards(store)[0]!
    await controller.commands.run("experimental.set", flowArgs("experimental.set", { cardId: first.id, key: "cell", value: "6" }))
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "later", kind: "status", status: "active", title: "Later", createdAt: first.createdAt + 1, ordinal: first.ordinal + 100, payload: { note: "Done" }
    } }).isPersisted.promise
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: "later-message", text: "After the card" }).isPersisted.promise
    const tail = Math.max(...[...store.collections.cards.values(), ...store.collections.messages.values()].map(row => row.ordinal))
    const clock = spyOn(Date, "now").mockReturnValue(first.createdAt + 5000)
    try { await controller.commands.run("experimental.cell-loop") } finally { clock.mockRestore() }
    expect(cards(store)).toHaveLength(1)
    const second = cards(store)[0]!
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.ordinal).toBe(tail + 1)
    expect(second.payload).toEqual({ pane: "cell-loop", props: { cell: "6" } })
  })

  test("selection survives a new store and controller", async () => {
    const { controller, storage } = await boot(true)
    await controller.commands.run("experimental.plan")
    await controller.commands.runAsAgent("experimental.set", flowArgs("experimental.set", { cardId: "experimental:plan", key: "nodeId", value: "publish" }))
    await controller.dispose()
    const restored = await boot(true, storage)
    expect(cards(restored.store)[0]?.payload).toEqual({ pane: "plan", props: { nodeId: "publish" } })
  })

  for (const presentation of ["maximized", "tab"] as const) {
    test(`boot reconciles a restored ${presentation} experimental card when disabled`, async () => {
      const { controller, store, storage } = await boot(true)
      await controller.commands.run("experimental.plan")
      const id = cards(store)[0]!.id
      await controller.commands.run(presentation === "tab" ? "tab.card" : "card.maximize", id)
      if (presentation === "tab") expect(store.session().activeTabId).toBe(`card-${id}`)
      else expect(store.session().maximizedCardId).toBe(id)
      await controller.dispose()
      const restoredStore = await createAppStore({ kind: "localStorage", storage })
      if (presentation === "tab") expect(restoredStore.session().activeTabId).toBe(`card-${id}`)
      else expect(restoredStore.session().maximizedCardId).toBe(id)
      createAppController(restoredStore, unavailableRepositories, unavailableAgent, { features: { experimental: false } })
      expect(restoredStore.session().maximizedCardId).toBeNull()
      expect(restoredStore.session().activeTabId).toBe(MAIN_TAB_ID)
      expect(restoredStore.collections.cards.has(id)).toBe(true)
    })
  }

  test("JSON grammar preserves whitespace, quotes and clearing a selection", async () => {
    const { controller, store } = await boot(true)
    await controller.commands.run("experimental.plan")
    for (const value of ['  two "words"\nnext line  ', ""]) {
      const input = { cardId: "experimental:plan", key: "nodeId", value }
      const args = flowArgs("experimental.set", input)
      expect(payloadFor("experimental.set", args)).toEqual({ payload: input })
      expect((await controller.commands.run("experimental.set", args)).status).toBe("executed")
      expect(cards(store)[0]?.payload.props?.nodeId).toBe(value)
    }
  })

  test("the environment enables the flows with the setting unset, even with an explicit false", async () => {
    // Bun exposes import.meta.env through process.env, as in KnowledgeFeatures.test.tsx.
    const prior = process.env.VITE_SMITHERS_EXPERIMENTAL
    try {
      process.env.VITE_SMITHERS_EXPERIMENTAL = "true"
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const controller = createAppController(store, unavailableRepositories, unavailableAgent)
      expect(controller.features.experimental).toBe(true)
      expect(names(controller.commands.disclosed())).toEqual(allNames)
      expect((await controller.commands.runAsAgent("experimental.plan")).status).toBe("executed")
      const disabled = await boot(false)
      expect(names(disabled.controller.commands.all())).toEqual(allNames)
    } finally {
      if (prior === undefined) delete process.env.VITE_SMITHERS_EXPERIMENTAL
      else process.env.VITE_SMITHERS_EXPERIMENTAL = prior
    }
  })

  /*
   * A switch is not a missing name: the model is given the experimental
   * commands while the switch is on, and a toggle-off mid-turn used to refuse
   * its next call with "no command has that name" — which is false, and sent
   * the model looking for a different flow instead of re-listing.
   */
  test("a name the switch hides refuses as not currently available, never as no such name", async () => {
    const { controller } = await boot(false)
    const reason = "/experimental.plan is not currently available — /app.experimental turns experimental panes on."
    expect(controller.commands.explainAbsent("experimental.plan")).toEqual({ door: "experimental", reason })
    expect(await controller.commands.run("experimental.plan")).toEqual({
      status: "unavailable", door: "experimental", reason, action: null
    })
    expect(await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "experimental.plan" })
    })).toBe(`failed: ${reason} Use the list action for every command callable right now`)
    // A name no host has is still nothing at all, and the switch explains nothing while it is on.
    expect(controller.commands.explainAbsent("experimental.no-such-pane")).toBeUndefined()
    expect((await controller.commands.runAsAgent("experimental.no-such-pane")).status).toBe("unknown-command")
    await controller.commands.run("app.experimental", "on")
    expect(controller.commands.explainAbsent("experimental.plan")).toBeUndefined()
  })

  /*
   * A display preference, not account data: the sign-out scrub names the
   * session fields it clears one by one (AppProjection `forgetAccountState`),
   * and /verbose, the palette and this switch are not among them.
   */
  test("the setting survives a sign-out, like verbose and the palette", async () => {
    const { controller, store } = await boot(false)
    await controller.commands.run("app.experimental", "on")
    store.dispatch({ type: "verbose.toggled", actor: "user", on: true })
    store.dispatch({ type: "palette.changed", actor: "user", palette: PALETTES[1]! })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in",
      login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "message.appended", actor: "system", text: "Private work" }).isPersisted.promise
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out",
      login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
    await settled()
    // The scrub ran...
    expect([...store.collections.messages.values()].some(row => row.text?.includes("Private work"))).toBe(false)
    // ...and left every preference, and the flows the switch registers, alone.
    expect(store.session().experimental).toBe(true)
    expect(store.session().verbose).toBe(true)
    expect(store.session().palette).toBe(PALETTES[1]!)
    expect(names(controller.commands.all())).toEqual(allNames)
  })

  test("pane ids are unique flow leaves and an unknown pane has no manifest row", () => {
    const ids = EXPERIMENTAL_MANIFEST.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter(id => !/^[a-z][a-z0-9-]*$/.test(id))).toEqual([])
    expect(manifestRow("promoted-away")).toBeUndefined()
  })
})
