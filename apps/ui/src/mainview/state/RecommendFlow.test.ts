import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { RECOMMENDATION_ID } from "./AppState"
import type { Repo } from "./AppState"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { RECOMMEND_OUTCOME_PATH, RECOMMEND_PATH } from "./Recommend"
import { json, memoryStorage, nativeRepositories, silentAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The recommender as a workflow: a material change → the `recommend` flow →
 * the rule's pills at once, then ONE POST /api/recommend whose validated
 * answer replaces them, and the user's next dispatch reported once as the
 * outcome. No real model is ever asked here: the Worker is a recorder.
 */

const cloudBootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: ["agent", "identity", "cloud"],
  authFlow: "redirect",
  sandbox: null
}

const localBootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "1.0.0",
  buildSha: "abcdef1234567890",
  capabilities: ["agent", "local.repositories", "local.targets", "local.terminal", "local.harnesses"],
  authFlow: "none",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const repo: Repo = {
  id: "repo-1",
  name: "smithers",
  path: "/Users/will/smithers",
  git: { branch: "main", remote: null },
  warnings: [],
  smithers: {
    detected: true,
    workspaceFile: "smithers.workspace.ts",
    declarationFiles: ["legacy declaration"],
    reason: "workspace file present",
    workspaces: [{ path: ".", title: "smithers" }]
  }
}

const settle = async (ticks = 6) => {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

interface Hit {
  readonly path: string
  readonly method: string
  readonly body: Record<string, unknown>
}

/** A Worker double that records every recommend call and answers from a script, newest answer first. */
const recorder = (answers: Array<() => Response> = []) => {
  const hits: Hit[] = []
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input)
    const path = new URL(url, "https://app.test").pathname
    const body = typeof init?.body === "string" && init.body !== "" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    hits.push({ path, method: init?.method ?? "GET", body })
    if (path === RECOMMEND_OUTCOME_PATH) return new Response(null, { status: 204 })
    if (path === RECOMMEND_PATH) return (answers.shift() ?? (() => json(503, { status: "error", message: "no key" })))()
    return json(404, { status: "error" })
  }
  return {
    fetchImpl,
    hits,
    recommends: () => hits.filter((hit) => hit.path === RECOMMEND_PATH),
    outcomes: () => hits.filter((hit) => hit.path === RECOMMEND_OUTCOME_PATH)
  }
}

const answer = (id: string, commands: ReadonlyArray<string>) => () => json(200, { id, commands, model: "gpt-oss-120b" })

const boot = async (services: AppServices = {}, repositories = unavailableRepositories) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, repositories, silentAgent, {
    bootstrap: cloudBootstrap,
    recommender: { enabled: true, debounceMs: 0 },
    ...services
  })
  return { store, controller }
}

const row = (store: Awaited<ReturnType<typeof boot>>["store"]) =>
  store.collections.recommendations.get(RECOMMENDATION_ID)

const signIn = (store: Awaited<ReturnType<typeof boot>>["store"]) =>
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })

describe("recommend: the flow", () => {
  test("is registered, hidden from the slash menu, and never the model's to call", async () => {
    const { controller } = await boot()
    const entry = controller.commands.find("system.recommend")
    expect(entry).toBeDefined()
    expect(entry?.metadata.hidden).toBe(true)
    expect(entry?.binding.descriptor.modelInvocable).toBe(false)
    expect(controller.slashItems("recomm").map((item) => item.flow.name)).not.toContain("system.recommend")
  })

  test("the pills default ON for the cloud host and OFF elsewhere; an explicit value wins", async () => {
    const cloud = await boot()
    expect(cloud.controller.features.suggestionPills).toBe(true)
    const cloudOff = await boot({ features: { suggestionPills: false } })
    expect(cloudOff.controller.features.suggestionPills).toBe(false)
    const local = await boot({ bootstrap: localBootstrap }, nativeRepositories)
    expect(local.controller.features.suggestionPills).toBe(false)
    const localOn = await boot({ bootstrap: localBootstrap, features: { suggestionPills: true } }, nativeRepositories)
    expect(localOn.controller.features.suggestionPills).toBe(true)
  })

  test("a material transition writes the rule at once and sends ONE request in the contract's shape", async () => {
    const worker = recorder([answer("rec-1", ["wiki", "chat.commands"])])
    const { store, controller } = await boot({ fetchImpl: worker.fetchImpl })
    store.dispatch({ type: "message.submitted", actor: "user", turnId: "t1", text: "what can you do here?" })
    store.dispatch({ type: "message.appended", actor: "system", text: "I can list flows and read files." })
    store.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "t1" })
    await settle()

    const requests = worker.recommends()
    expect(requests.length).toBe(1)
    expect(requests[0]?.method).toBe("POST")
    const body = requests[0]?.body ?? {}
    expect(body.repo).toBeNull()
    expect(body.tail).toEqual([
      { role: "user", text: "what can you do here?" },
      { role: "assistant", text: "I can list flows and read files." }
    ])
    const commands = body.commands as Array<{ name: string; summary: string }>
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.length).toBeLessThanOrEqual(300)
    // Every entry is a flow this session can invoke, listed with the slash menu's one-line summary.
    for (const command of commands) {
      const entry = controller.commands.find(command.name)
      expect(entry).toBeDefined()
      expect(entry?.metadata.hidden).not.toBe(true)
      expect(command.summary).toBe(entry?.metadata.summary ?? "")
    }
    expect(commands.map((command) => command.name)).toContain("wiki")
    expect(commands.map((command) => command.name)).not.toContain("system.recommend")

    const current = row(store)
    expect(current?.source).toBe("agent")
    expect(current?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["wiki", "chat.commands"])
    expect(current?.suggestions[0]?.emphasis).toBe("primary")
    // The request is invisible to the conversation.
    expect(store.session().phase).toBe("idle")
  })

  test("the request names the selected repository", async () => {
    const worker = recorder([answer("rec-1", ["wiki"])])
    const { store } = await boot({ fetchImpl: worker.fetchImpl })
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: null, catalog: true }]
    })
    store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" })
    signIn(store)
    await settle()
    expect(worker.recommends().at(-1)?.body.repo).toBe("smithersai/smithers")
  })

  test("the validated answer drops names the registry does not offer; the pills cap at three", async () => {
    const worker = recorder([answer("rec-1", ["deploy.everything", "chat.commands", "card.maximize", "wiki", "connect", "flow.list"])])
    const { store } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    const current = row(store)
    expect(current?.source).toBe("agent")
    expect(current?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["chat.commands", "wiki", "connect"])
  })

  test("a 429, a 503, a network failure, or an empty answer leaves the rule standing and never an empty row", async () => {
    const worker = recorder([
      () => json(429, { status: "error", code: "turn_rate_limited", message: "spent" }),
      () => json(503, { status: "error", message: "CEREBRAS_API_KEY is unset" }),
      () => { throw new Error("network down") },
      answer("rec-empty", [])
    ])
    const { store } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    expect(row(store)?.source).toBe("rule")
    expect(row(store)?.suggestions.length).toBeGreaterThan(0)
    for (const step of [1, 2, 3]) {
      store.dispatch({
        type: "tab.opened",
        actor: "user",
        tab: { id: `tab-${step}`, kind: "terminal", title: "Terminal", sessionId: `pty-${step}`, cwd: "/Users/will/smithers" }
      })
      await settle()
      expect(row(store)?.source).toBe("rule")
      expect(row(store)?.suggestions.length).toBeGreaterThan(0)
    }
    expect(worker.recommends().length).toBe(4)
  })

  test("a newer state supersedes the request in flight; the old answer is dropped", async () => {
    let releaseFirst: (() => void) | undefined
    const worker = recorder([
      () => json(200, { id: "rec-old", commands: ["chat.commands"], model: "m" }),
      answer("rec-new", ["wiki"])
    ])
    // The first answer waits until the second state has asked.
    const gated = async (input: unknown, init?: RequestInit) => {
      const response = await worker.fetchImpl(input, init)
      const path = new URL(typeof input === "string" ? input : String(input), "https://app.test").pathname
      if (path === RECOMMEND_PATH && worker.recommends().length === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
      }
      return response
    }
    const { store } = await boot({ fetchImpl: gated })
    signIn(store)
    await settle()
    store.dispatch({ type: "identity.session.cleared", actor: "user" })
    await settle()
    expect(worker.recommends().length).toBe(2)
    expect(row(store)?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["wiki"])
    releaseFirst?.()
    await settle()
    expect(row(store)?.suggestions.map((suggestion) => suggestion.flow)).toEqual(["wiki"])
  })

  test("the next user dispatch reports the outcome exactly once, through any door", async () => {
    const worker = recorder([answer("rec-1", ["wiki", "chat.commands"]), answer("rec-2", ["connect"])])
    const { store, controller } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    expect(worker.outcomes().length).toBe(0)

    // The pill (or the slash line, or a button): the registry's one door.
    controller.runCommand("chat.commands")
    await settle()
    expect(worker.outcomes().map((hit) => hit.body)).toEqual([{ id: "rec-1", command: "chat.commands" }])

    // A second dispatch before a fresh recommendation reports nothing more.
    controller.runCommand("wiki")
    await settle()
    expect(worker.outcomes().length).toBe(1)

    // A fresh recommendation opens a fresh outcome.
    store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: { id: "tab-x", kind: "terminal", title: "Terminal", sessionId: "pty-x", cwd: "/Users/will/smithers" }
    })
    await settle()
    controller.runCommand("connect")
    await settle()
    expect(worker.outcomes().map((hit) => hit.body)).toEqual([
      { id: "rec-1", command: "chat.commands" },
      { id: "rec-2", command: "connect" }
    ])
  })

  test("a hidden act, the recommender's own flow, and the agent's door are never the outcome", async () => {
    const worker = recorder([answer("rec-1", ["wiki"])])
    const { store, controller } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    await controller.commands.run("system.recommend")
    await controller.commands.run("card.maximize", "card-none")
    await controller.commands.runAsAgent("wiki")
    await settle()
    expect(worker.outcomes().length).toBe(0)
    controller.runCommand("wiki")
    await settle()
    expect(worker.outcomes().map((hit) => hit.body)).toEqual([{ id: "rec-1", command: "wiki" }])
  })

  test("without a recommendation the user's dispatch reports nothing", async () => {
    const worker = recorder([() => json(503, { status: "error", message: "CEREBRAS_API_KEY is unset" })])
    const { store, controller } = await boot({ fetchImpl: worker.fetchImpl })
    signIn(store)
    await settle()
    controller.runCommand("wiki")
    await settle()
    expect(worker.outcomes().length).toBe(0)
  })

  test("a keystroke never regenerates", async () => {
    const worker = recorder()
    const { controller } = await boot({ fetchImpl: worker.fetchImpl })
    controller.changeDraft("hel")
    controller.changeDraft("hello")
    await settle()
    expect(worker.recommends().length).toBe(0)
  })

  test("pills off: the rule row still lands and no request leaves", async () => {
    const worker = recorder([answer("rec-1", ["wiki"])])
    const { store } = await boot({ fetchImpl: worker.fetchImpl, features: { suggestionPills: false } })
    signIn(store)
    await settle()
    expect(worker.recommends().length).toBe(0)
    expect(row(store)?.source).toBe("rule")
  })

  test("opt-in: a composition root that does not enable the recommender gets the rule only", async () => {
    const worker = recorder([answer("rec-1", ["wiki"])])
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    createAppController(store, unavailableRepositories, silentAgent, {
      bootstrap: cloudBootstrap,
      fetchImpl: worker.fetchImpl,
      recommender: { debounceMs: 0 }
    })
    signIn(store)
    await settle()
    expect(row(store)?.source).toBe("rule")
    expect(worker.recommends().length).toBe(0)
  })

  test("the local host: opening a repository retires 'Select a repo' at once through the rule", async () => {
    // No key on this origin: every request is a 503, so the rule alone writes the row.
    const worker = recorder()
    const { store, controller } = await boot(
      { bootstrap: localBootstrap, fetchImpl: worker.fetchImpl, features: { suggestionPills: true } },
      nativeRepositories
    )
    await controller.recommend()
    expect(row(store)?.suggestions[0]?.flow).toBe("repo.open")
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
    await settle()
    expect(row(store)?.suggestions.map((suggestion) => suggestion.flow)).not.toContain("repo.open")
  })
})
