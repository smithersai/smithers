/*
 * The dev fixture seam's graph branch (docs/LOCAL-APP.md "The dev fixture
 * seam"). The flag is an explicit localStorage opt-in that the product path
 * never sets; what has to hold is that WITH it the graph card fills from the
 * captured force fixture and touches no route, and WITHOUT it the seam is
 * absent entirely — a fixture that leaked into the product would paint a card
 * green against data the backend never sent.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import type { Repo } from "@smthrs/rpc/LocalApp"
import { TARGET_GRAPH_FIXTURE_FLAG } from "../../dev/fixtureRunStream"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const REPO: Repo = {
  id: "force",
  path: "/tmp/force",
  name: "force",
  git: { branch: "main", remote: null },
  warnings: [],
  smithers: {
    detected: true,
    workspaceFile: null,
    declarationFiles: ["PACKAGE.ts"],
    reason: "declared",
    workspaces: [{ path: ".", title: "force" }]
  }
}

/* Any call to a route is a failure: the seam must not reach the network. */
let calls: Array<string> = []
let realFetch: typeof globalThis.fetch
beforeEach(() => {
  calls = []
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    return new Response("no", { status: 500 })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  localStorage.removeItem(TARGET_GRAPH_FIXTURE_FLAG)
})

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(
    store,
    { available: false, pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "native only" }) } as NativeRepositories,
    { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} } as AgentPort
  )
  store.dispatch({ type: "repos.loaded", actor: "system", repos: [REPO] })
  return { store, controller }
}

test("with the flag on, the graph card fills from the fixture and calls no route", async () => {
  localStorage.setItem(TARGET_GRAPH_FIXTURE_FLAG, "1")
  const { store, controller } = await boot()
  expect((await controller.commands.run("target.graph")).status).toBe("executed")
  const card = store.collections.cards.get("graph-force")
  if (card?.kind !== "graph") throw new Error("expected a graph card")
  expect(card.payload.status).toBe("done")
  /* The captured force workspace: 82 nodes, 94 edges. */
  expect(card.payload.graph?.nodes.length).toBe(82)
  expect(card.payload.graph?.edges.length).toBe(94)
  expect(calls).toEqual([])
})

test("with the flag off, the graph card goes to the route and fails honestly", async () => {
  const { store, controller } = await boot()
  await controller.commands.run("target.graph")
  const card = store.collections.cards.get("graph-force")
  if (card?.kind !== "graph") throw new Error("expected a graph card")
  /* No fixture stands in for a backend that answered 500. */
  expect(card.payload.status).toBe("failed")
  expect(card.payload.graph).toBeUndefined()
  expect(calls).toEqual(["/api/targets/graph"])
})

test("a flag set to anything but \"1\" is the flag off", async () => {
  localStorage.setItem(TARGET_GRAPH_FIXTURE_FLAG, "true")
  const { store, controller } = await boot()
  await controller.commands.run("target.graph")
  const card = store.collections.cards.get("graph-force")
  if (card?.kind !== "graph") throw new Error("expected a graph card")
  expect(card.payload.status).toBe("failed")
  expect(calls).toEqual(["/api/targets/graph"])
})
