import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CardView } from "../ChatCards"
import { cardActions } from "../cards/CardActions"
import { recommendedNames } from "../flows/registry"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { knowledgeFlowAvailable } from "./KnowledgeFeatures"
import { memoryStorage, silentAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()
const hidden = ["wiki", "wiki.create", "wiki.open", "wiki.graph", "world", "world.new-note",
  "history.show", "history.bootstrap", "history.amend", "history.fold", "search.wiki", "search.history"]

describe("optional generated knowledge", () => {
  test("default-off flags remove command, agent, recommendation and palette doors without changing source tools", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent)
    expect(controller.features.wiki).toBe(false)
    expect(controller.features.mythicalHistory).toBe(false)
    const callable = controller.commands.callable().map(entry => entry.binding.descriptor.name)
    for (const name of hidden) {
      expect(controller.commands.find(name)).toBeUndefined()
      expect(callable).not.toContain(name)
      expect((await controller.commands.run(name)).status).toBe("unknown-command")
      expect((await controller.commands.runForAgent(name)).status).toBe("unknown-command")
    }
    expect(recommendedNames(controller.commands.state())).not.toContain("wiki")
    for (const prefix of ["wiki:", "history:"]) {
      expect(controller.searchPalette(prefix).groups).toEqual([])
      expect(controller.searchPalette(prefix).flow).toBeNull()
      expect(controller.searchPalette("?").help?.map(row => row.prefix)).not.toContain(prefix)
    }
    for (const name of ["files.read", "branches.list", "flow.run", "flow.create", "triggers.list"]) {
      expect(controller.commands.find(name)).toBeDefined()
    }
    const search = await controller.commands.runForAgent("search.open", "World")
    expect(JSON.stringify(search)).not.toContain('"kind":"note"')
  })

  test("generic launch and direct librarian calls cannot provision a disabled feature", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const calls: string[] = []
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: async input => { calls.push(String(input)); return new Response("{}") }
    })
    for (const name of ["librarian/wiki", "librarian/history", "wiki", "checks/wiki"]) {
      expect(await controller.runWorkflow(name, "owner/repo")).toBe("This feature is not enabled.")
    }
    expect(await controller.createWiki("owner/repo")).toBe("This feature is not enabled.")
    expect(await controller.bootstrapHistory("owner/repo")).toBe("This feature is not enabled.")
    expect(calls).toEqual([])
    expect(store.session().librarianLaunches ?? []).toEqual([])
  })

  test("restored knowledge cards stay stored but cannot open or take over the current view", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const card = { id: "old-wiki", kind: "world" as const, title: "Wiki", status: "active" as const, createdAt: 1, ordinal: 1,
      payload: { documents: [] } }
    await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    await store.dispatch({ type: "surface.changed", actor: "user", surface: "world" }).isPersisted.promise
    await store.dispatch({ type: "card.maximized", actor: "user", id: card.id }).isPersisted.promise
    const controller = createAppController(store, unavailableRepositories, silentAgent)
    expect(store.session().surface).toBe("chat")
    expect(store.session().maximizedCardId).toBeNull()
    expect(store.collections.cards.has(card.id)).toBe(true)
    expect(renderToStaticMarkup(createElement(CardView, { card, maximized: false, worldDocuments: [], ...cardActions(controller) }))).toBe("")
    expect((await controller.commands.run("card.maximize", card.id)).status).toBe("failed")
    expect((await controller.commands.run("tab.card", card.id)).status).toBe("failed")
  })

  test("the two opt-ins are independent and preserve their existing implementations", async () => {
    for (const features of [{ wiki: true }, { mythicalHistory: true }]) {
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const controller = createAppController(store, unavailableRepositories, silentAgent, { features })
      expect(controller.commands.find("wiki") !== undefined).toBe("wiki" in features)
      expect(controller.commands.find("history.bootstrap") !== undefined).toBe("mythicalHistory" in features)
      if ("wiki" in features) {
        expect((await controller.commands.run("wiki")).status).toBe("executed")
        expect(store.collections.cards.get("world-embedded")?.kind).toBe("world")
      }
    }
    for (const name of ["coding/request", "coding/prototype", "commits.list", "files.read", "history-tools/custom"]) {
      expect(knowledgeFlowAvailable(name)).toBe(true)
    }
  })
})
