import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CardView } from "../ChatCards"
import { ControllerTestProvider } from "../ControllerContext"
import { cardActions } from "../cards/CardActions"
import { agentVisibleCatalog } from "../flows/agentTools"
import { namespace as searchNamespace } from "../flows/entries/search"
import { parseSubmit, recommendedNames } from "../flows/registry"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { smithersInstructions } from "./Instructions"
import { knowledgeCardAvailable, knowledgeFlowAvailable, runtimeFlowAvailable, wikiFlagEnabled } from "./KnowledgeFeatures"
import { parseRecommendation } from "./Recommend"
import { json, memoryStorage, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()
const hidden = ["wiki", "wiki.create", "wiki.open", "wiki.graph", "world", "world.new-note",
  "history.show", "history.bootstrap", "history.amend", "history.fold", "search.wiki", "search.history"]

describe("optional generated knowledge", () => {
  test("default-off flags remove command, agent, recommendation and palette doors without changing source tools", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
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

  test("built-in knowledge doors stay disabled while runtime flows reach the identity guard", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const calls: string[] = []
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async input => { calls.push(String(input)); return new Response("{}") }
    })
    for (const name of ["wiki", "checks/wiki"]) {
      expect(await controller.runWorkflow(name, "owner/repo")).toBe("This feature is not enabled.")
    }
    for (const name of ["librarian/wiki", "librarian/history"]) {
      expect(await controller.runWorkflow(name, "owner/repo")).toBe("Sign in with GitHub first: flows run on your own workspace.")
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
    const controller = createAppController(store, silentAgent)
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
      const controller = createAppController(store, silentAgent, { features })
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
    expect(runtimeFlowAvailable("librarian/history")).toBe(true)
  })
})

/*
 * .smithers/factory.json declares flows whose ids are `wiki` and `checks/wiki`
 * (both model-invocable), and the repository-flow leaf builder used to register
 * one slash leaf per row with no flag filter — so the flag being OFF was what
 * let the name back in past the registry's collision guard.
 */
const FACTORY_ROWS = [
  { id: "wiki", description: "Review each engineering wiki page against its code", summary: null, featured: true, modelInvocable: true },
  { id: "checks/wiki", description: "Check the wiki pages", summary: null, featured: false, modelInvocable: true },
  { id: "review", description: "Review a change", summary: null, featured: true, modelInvocable: true }
]

const repositoryDeclaringWikiFlows = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "repository.upserted", actor: "system",
    repository: { id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: null, catalog: true }
  }).isPersisted.promise
  await store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: "smithersai/smithers", flows: FACTORY_ROWS }).isPersisted.promise
  return store
}

const suggestedFlows = (controller: ReturnType<typeof createAppController>, commands: ReadonlyArray<string>) =>
  parseRecommendation({ id: "reco", commands }, controller.commands.all(), "chat")?.suggestions.map(row => row.flow) ?? []

describe("a repository that declares a knowledge flow", () => {
  test("gets no slash leaf, no agent tool, no recommendation and no unrelated loss while the Wiki flag is off", async () => {
    const store = await repositoryDeclaringWikiFlows()
    const controller = createAppController(store, silentAgent)
    // The leaf builder is live: an unrelated row keeps every door.
    expect(controller.commands.find("review")).toBeDefined()
    expect(controller.commands.callable().map(entry => entry.binding.descriptor.name)).toContain("review")
    expect(suggestedFlows(controller, ["review"])).toEqual(["review"])
    for (const name of ["wiki", "checks.wiki"]) {
      expect(controller.commands.find(name)).toBeUndefined()
      expect(controller.commands.all().map(item => item.name)).not.toContain(name)
      expect(controller.commands.callable().map(entry => entry.binding.descriptor.name)).not.toContain(name)
      expect(controller.commands.slashTree("").flatMap(row => row.kind === "flow" ? [row.flow.name] : [])).not.toContain(name)
      expect((await controller.commands.run(name)).status).toBe("unknown-command")
      expect((await controller.commands.runForAgent(name)).status).toBe("unknown-command")
    }
    expect(suggestedFlows(controller, ["wiki", "checks.wiki"])).toEqual([])
  })

  test("keeps every door when the Wiki flag is on", async () => {
    const store = await repositoryDeclaringWikiFlows()
    const controller = createAppController(store, silentAgent, { features: { wiki: true } })
    for (const name of ["wiki", "checks.wiki", "review"]) expect(controller.commands.find(name)).toBeDefined()
    // The declared `wiki` surface flow still takes the name from the leaf: one entry, not two.
    expect(controller.commands.all().filter(item => item.name === "wiki")).toHaveLength(1)
    expect(controller.commands.callable().map(entry => entry.binding.descriptor.name)).toContain("checks.wiki")
    expect(suggestedFlows(controller, ["checks.wiki", "review"])).toEqual(["checks.wiki", "review"])
  })
})

describe("the Plugin Library flag", () => {
  const libraryCard = { id: "old-library", kind: "plugin-library" as const, title: "Library", status: "active" as const,
    createdAt: 1, ordinal: 1, payload: { tutorial: false } }

  test("a restored Library card is reset, refused and dropped from the agent's context like a Wiki card", async () => {
    expect(knowledgeCardAvailable("plugin-library")).toBe(false)
    expect(knowledgeCardAvailable("plugin-library", { pluginLibrary: true })).toBe(true)
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "card.upsert", actor: "system", card: libraryCard }).isPersisted.promise
    await store.dispatch({ type: "card.maximized", actor: "user", id: libraryCard.id }).isPersisted.promise
    const controller = createAppController(store, silentAgent)
    expect(store.session().maximizedCardId).toBeNull()
    expect(store.collections.cards.has(libraryCard.id)).toBe(true)
    expect((await controller.commands.run("card.maximize", libraryCard.id)).status).toBe("failed")
    expect((await controller.commands.run("tab.card", libraryCard.id)).status).toBe("failed")
    expect(renderToStaticMarkup(createElement(CardView, { card: libraryCard, maximized: false, worldDocuments: [], ...cardActions(controller) }))).toBe("")
  })

  test("the Library card opens as it does today when the flag is on", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "card.upsert", actor: "system", card: libraryCard }).isPersisted.promise
    await store.dispatch({ type: "card.maximized", actor: "user", id: libraryCard.id }).isPersisted.promise
    const controller = createAppController(store, silentAgent, { features: { pluginLibrary: true } })
    expect(store.session().maximizedCardId).toBe(libraryCard.id)
    expect((await controller.commands.run("tab.card", libraryCard.id)).status).toBe("executed")
    expect(renderToStaticMarkup(createElement(ControllerTestProvider, {
      controller,
      children: createElement(CardView, { card: libraryCard, maximized: false, worldDocuments: [], ...cardActions(controller) })
    }))).not.toBe("")
  })
})

describe("the copy the slash menu and the prompt carry", () => {
  test("the search summaries name no flag-off feature", async () => {
    expect(searchNamespace.summary).not.toMatch(/wiki|history/i)
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    for (const features of [{}, { wiki: true, mythicalHistory: true }]) {
      const controller = createAppController(store, silentAgent, { features })
      const open = controller.commands.all().find(item => item.name === "search.open")
      expect(open?.summary).toBeDefined()
      expect(open?.summary).not.toMatch(/wiki|history/i)
    }
  })
})

describe("the Wiki build flag", () => {
  test("is read from the one environment door the controller reads", () => {
    const prior = process.env.VITE_SMITHERS_WIKI
    try {
      delete process.env.VITE_SMITHERS_WIKI
      expect(wikiFlagEnabled()).toBe(false)
      process.env.VITE_SMITHERS_WIKI = "false"
      expect(wikiFlagEnabled()).toBe(false)
      process.env.VITE_SMITHERS_WIKI = "true"
      expect(wikiFlagEnabled()).toBe(true)
    } finally {
      if (prior === undefined) delete process.env.VITE_SMITHERS_WIKI
      else process.env.VITE_SMITHERS_WIKI = prior
    }
  })
})

/*
 * `/chat.clear --summarize` is the one Wiki door that hangs off a flow the
 * release keeps: the archive is always local, the summary writes Wiki notes.
 * With the flag off the option must not exist at any door, and an explicit
 * one (a persisted card, an agent that read an older catalog) must still
 * archive — the act the human asked for — without a note and without the
 * model call that would mint one.
 */
const SWEEP_NOTE = { title: "Prefers dark mode", body: "The user keeps the app in dark mode.", confidence: 0.9 }
const sweepStream = () =>
  new Response(
    [{ type: "delta", kind: "text", text: JSON.stringify({ notes: [SWEEP_NOTE] }) }, { type: "done", reason: "stop" }]
      .map((frame) => JSON.stringify(frame)).join("\n") + "\n",
    { status: 200, headers: { "content-type": "application/x-ndjson" } }
  )

const readyToArchive = async (features: { readonly wiki?: boolean }) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const sweeps: string[] = []
  const controller = createAppController(store, silentAgent, {
    features,
    fetchImpl: async (input) => {
      const path = new URL(String(input), "https://app.test").pathname
      if (path !== "/api/model/stream") return json(404, { status: "error" })
      sweeps.push(path)
      return sweepStream()
    }
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "message.appended", actor: "user", text: "remember that I prefer dark mode" }).isPersisted.promise
  return { store, controller, sweeps }
}

const clearEntry = (controller: ReturnType<typeof createAppController>) =>
  controller.commands.all().find((item) => item.name === "chat.clear")

describe("the optional Wiki summary on chat.clear", () => {
  test("with the flag off no door offers the option", async () => {
    const { controller } = await readyToArchive({})
    expect(clearEntry(controller)?.summary).not.toMatch(/wiki/i)
    expect(clearEntry(controller)?.args).toBeUndefined()
    const catalog = agentVisibleCatalog(controller.commands.callable())
    expect(JSON.stringify(catalog.find((row) => row.name === "chat.clear"))).not.toMatch(/summarize/i)
    const prompt = smithersInstructions(catalog, {
      host: "web", github: { connected: false, login: null, repositories: null },
      localRepositories: [], localRepositoriesAvailable: false
    }, [], { budgetBytes: 1_000_000 })
    expect(prompt).toContain("- /chat.clear — Archive this conversation and start fresh\n")
    expect(prompt).not.toContain("--summarize")
  })

  /*
   * Canary D-6 changed this expectation. Archiving under a flag the build has
   * no door for still archives: the person typed one thing, a consequential
   * act happened, and the flag they typed did nothing. A flag the flow never
   * declared is refused, and nothing happens at all.
   */
  test("with the flag off an explicit --summarize is refused, archives nothing and calls no model", async () => {
    const { store, controller, sweeps } = await readyToArchive({})
    // The typed line stays an invocation rather than falling through to the model as prose.
    expect(parseSubmit("/chat.clear --summarize", controller.commands.all()))
      .toEqual({ kind: "command", name: "chat.clear", args: "--summarize" })
    const outcome = await controller.commands.run("chat.clear", "--summarize")
    // The refusal is carried as what it is; its sentence is the one refusalSentence writes.
    expect(outcome).toEqual({
      status: "failed",
      error: "/chat.clear takes no --summarize — nothing ran. Send /chat.clear without it.",
      refusal: { kind: "unknown-flag", flow: "chat.clear", flag: "summarize" }
    })
    expect(sweeps).toEqual([])
    expect([...store.collections.worldDocuments.values()].filter((row) => row.sources.includes("chat-sweep"))).toEqual([])
    expect([...store.collections.transitions.values()].some((row) => row.type === "conversation.cleared")).toBe(false)
  })

  test("with the flag on the option, its copy and the note it writes are what they are today", async () => {
    const { store, controller, sweeps } = await readyToArchive({ wiki: true })
    expect(clearEntry(controller)?.summary).toBe("Archive this conversation and start fresh; optionally summarize into Wiki notes")
    expect(clearEntry(controller)?.args).toBe("[--summarize]")

    const outcome = await controller.commands.run("chat.clear", "--summarize")
    expect(outcome.status).toBe("executed")
    expect(sweeps).toEqual(["/api/model/stream"])
    expect([...store.collections.worldDocuments.values()].filter((row) => row.sources.includes("chat-sweep")).map((row) => row.title))
      .toEqual([SWEEP_NOTE.title])
  })
})
