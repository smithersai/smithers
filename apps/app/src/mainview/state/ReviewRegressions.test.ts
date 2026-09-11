import { afterEach, describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import type { Harness, Repo } from "@smthrs/rpc/LocalApp"
import { fileArgs } from "../flows/FileArgs"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController, AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { repoKeyOf } from "./AppState"

const createAppController = scopedControllers()

const controllers: AppController[] = []
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const until = async (ready: () => boolean) => {
  for (let tick = 0; tick < 200 && !ready(); tick += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(ready()).toBe(true)
}
const harness: Harness = {
  id: "codex", displayName: "Codex", binary: "/bin/codex", version: "1", status: "signed-in",
  account: null, launch: { argv: ["codex"] }, models: { suggestions: ["model-1"], listable: false }
}
const repo = (id: string, path: string): Repo => ({
  id, path, name: "acme/project", git: { branch: id, remote: "https://github.com/acme/project.git" }, warnings: [],
  smithers: { detected: true, workspaceFile: null, declarationFiles: [], reason: "", workspaces: [] }
})

const boot = async (fetchImpl?: AppServices["fetchImpl"]) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store,
    { available: true, pickLocalRepository: async () => ({ status: "cancelled" }) },
    { available: false, startTurn: async () => ({ status: "error", message: "unused" }), cancelTurn: async () => {}, subscribe: () => () => {} },
    {
      bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: [...RuntimeCapabilitySchema.options], authFlow: "none", sandbox: { platform: "darwin", mode: "enforced" } },
      socketUrl: () => undefined,
      fetchImpl: async (input, init) => {
        const path = new URL(String(input), "http://local").pathname
        if (path === "/api/agents") return json({ agents: AGENT_ROLES })
        if (path.endsWith("/models")) return json({ harnessId: "codex", models: [], source: "suggestions" })
        return fetchImpl === undefined ? json({}, 404) : fetchImpl(input, init)
      }
    })
  controllers.push(controller)
  store.dispatch({ type: "harnesses.loaded", actor: "system", harnesses: [harness] })
  return { store, controller }
}

describe("review regressions: concurrent commands and working-copy identity", () => {
  test("a human form releases menu backdrops while an agent form leaves human chrome alone", async () => {
    const { store, controller } = await boot()
    const menuTypes = ["tab.menu.toggled", "add-menu.toggled", "connect-menu.toggled", "surfaces-menu.toggled"] as const
    for (const type of menuTypes) store.dispatch({ type, actor: "user", open: true })
    expect((await controller.commands.run("tab.harness")).status).toBe("form")
    expect(store.session()).toMatchObject({ tabMenuOpen: false, addMenuOpen: false, connectMenuOpen: false, surfacesMenuOpen: false })
    const closed = [...store.collections.transitions.values()].filter((row) => menuTypes.includes(row.type as typeof menuTypes[number]) && JSON.parse(row.payload).open === false)
    expect(closed).toHaveLength(4)
    expect(closed.every((row) => row.actor === "user")).toBe(true)

    store.dispatch({ type: "tab.menu.toggled", actor: "user", open: true })
    expect((await controller.commands.runForAgent("tab.harness")).status).toBe("form")
    expect(store.session().tabMenuOpen).toBe(true)
  })

  test("a form claims its submission before the first await and releases it on failure", async () => {
    const gate = deferred()
    let creates = 0
    const { store, controller } = await boot(async (_input, init) => {
      if (init?.method === "POST") { creates += 1; await gate.promise; return json({ sessionId: "pty-1" }) }
      return json({}, 404)
    })
    expect((await controller.commands.run("tab.harness")).status).toBe("form")
    await controller.commands.run("form.set", "form-tab.harness harnessId codex")
    const first = controller.commands.run("form.submit", "form-tab.harness")
    await until(() => creates === 1)
    const card = store.collections.cards.get("form-tab.harness")
    expect(card?.kind === "flow-form" && card.payload.submitting).toBe(true)
    expect(await controller.commands.run("form.submit", "form-tab.harness")).toMatchObject({ status: "failed", error: expect.stringContaining("being submitted") })
    expect(await controller.commands.run("form.set", "form-tab.harness harnessId codex")).toMatchObject({ status: "failed" })
    gate.resolve()
    expect((await first).status).toBe("executed")
    expect(creates).toBe(1)
    expect(store.collections.cards.get("form-tab.harness")?.status).toBe("acted")

    controller.renderFlowForm({ name: "tab.harness", args: "missing-harness", via: "user" })
    await controller.commands.run("form.submit", "form-tab.harness")
    const failed = store.collections.cards.get("form-tab.harness")
    expect(failed?.kind === "flow-form" && failed.payload.submitting).toBe(false)
    expect(failed?.status).toBe("error")
  })

  test("clearing a prefilled field does not restore it from the original arguments", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { controller } = await boot(async (_input, init) => {
      if (init?.method === "PUT") { bodies.push(JSON.parse(String(init.body))); return json({}) }
      return json({}, 404)
    })
    controller.renderFlowForm({ name: "agent.create", args: "new-worker codex model-1 remove-this", via: "user" })
    await controller.commands.run("form.set", "form-agent.create purpose")
    expect((await controller.commands.run("form.submit", "form-agent.create")).status).toBe("executed")
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.purpose).toBe("")
  })

  test("human presentation remains human while an agent read awaits, and its eventual card remains attributed to the agent", async () => {
    const gate = deferred()
    let reading = false
    const { store, controller } = await boot(async (input) => {
      if (String(input).endsWith("/api/harnesses")) { reading = true; await gate.promise; return json({ harnesses: [harness] }) }
      return json({}, 404)
    })
    const read = controller.commands.runForAgent("agent.list")
    await until(() => reading)
    await controller.commands.run("world")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.has("world-embedded")).toBe(true)
    expect([...store.collections.transitions.values()].some((row) => row.type === "card.upsert" && row.actor === "user")).toBe(true)
    gate.resolve()
    expect((await read).status).toBe("executed")
    expect([...store.collections.transitions.values()].some((row) => row.type === "card.upsert" && row.actor === "smithers")).toBe(true)
    await controller.commands.runForAgent("world")
    expect(store.collections.cards.has("world-embedded")).toBe(true)
    expect(store.session().surface).toBe("chat")
  })

  test("an agent-created form keeps its actor after the harness fetch, including confirmation on submit", async () => {
    const gate = deferred()
    let reading = false
    let creates = 0
    const { store, controller } = await boot(async (input, init) => {
      if (String(input).endsWith("/api/harnesses")) { reading = true; await gate.promise; return json({ harnesses: [harness] }) }
      if (init?.method === "PUT") creates += 1
      return json({}, 404)
    })
    const open = controller.commands.runForAgent("agent.new", "new-worker codex model-1")
    await until(() => reading)
    await controller.commands.run("world")
    gate.resolve()
    await open
    const card = store.collections.cards.get("form-agent.create")
    expect(card?.kind === "flow-form" && card.payload.via).toBe("agent")
    await controller.commands.run("form.submit", "form-agent.create")
    expect(creates).toBe(0)
    expect([...store.collections.messages.values()].some((message) => message.action?.flow === "agent.create")).toBe(true)
  })

  test("a delayed harness launch stays attached to its captured working copy", async () => {
    const gate = deferred()
    const bodies: Array<Record<string, unknown>> = []
    const { store, controller } = await boot(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body))); await gate.promise; return json({ sessionId: "pty-1" })
    })
    const first = repo("repo-a", "/work/a"), second = repo("repo-b", "/work/b")
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [first, second] })
    store.dispatch({ type: "repo.selected", actor: "user", id: repoKeyOf(first.path) })
    const launch = controller.commands.run("tab.harness", "codex")
    await until(() => bodies.length === 1)
    store.dispatch({ type: "repo.selected", actor: "user", id: repoKeyOf(second.path) })
    gate.resolve(); await launch
    expect(bodies[0]?.repoId).toBe(first.id)
    expect(store.collections.tabs.get("pty-1")).toMatchObject({ cwd: first.path, repoKey: repoKeyOf(first.path) })
  })

  test("same-remote copies have separate file cards and a spaced path round-trips through commands and forms", async () => {
    const bodies: Array<{ repoId: string; path: string }> = []
    const { store, controller } = await boot(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { repoId: string; path: string }
      bodies.push(body)
      return json({ kind: "file", path: body.path, size: 10, content: body.repoId, truncated: false, binary: false })
    })
    const first = repo("repo-a", "/work/a"), second = repo("repo-b", "/work/b")
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [first, second] })
    const path = "docs/Meeting Notes.md"
    expect((await controller.commands.run("files.read", fileArgs(path, second.id))).status).toBe("executed")
    expect(bodies.at(-1)).toEqual({ repoId: second.id, path })
    await controller.commands.run("files.read", fileArgs(path, first.id))
    expect(store.collections.cards.get(`file-${first.id}-${path}`)?.payload).toMatchObject({ localRepoId: first.id, content: first.id })
    expect(store.collections.cards.get(`file-${second.id}-${path}`)?.payload).toMatchObject({ localRepoId: second.id, content: second.id })
    expect(await controller.commands.run("files.read", fileArgs(path, first.name))).toMatchObject({ status: "failed", error: expect.stringContaining("several open working copies") })
    controller.renderFlowForm({ name: "files.read", args: fileArgs(path, second.id), via: "user" })
    await controller.commands.run("form.submit", "form-files.read")
    expect(bodies.at(-1)).toEqual({ repoId: second.id, path })
  })
})
