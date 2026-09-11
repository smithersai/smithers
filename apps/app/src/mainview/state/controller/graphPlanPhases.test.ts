/*
 * `show graph` must not be all-or-nothing behind the slowest thing it asks
 * for.
 *
 * The card asked the graph route for the DAG *and* a full-workspace plan in
 * ONE request: `{ plan: true }` with no labels plans `//...`, every target in
 * the workspace. Measured against ~/artsy-e2e/force that is ~4.7s for the
 * graph and ~15.9s for graph+plan; under the load of a real session — the
 * auto-loaded targets card querying the loader at the same time — it crosses
 * the 30s seam budget and the whole card dies with `seam timeout`, showing
 * NOTHING, even though the DAG itself was ready in a few seconds.
 * `e2e/playwright/target-graph.real.spec.ts` caught it twice in three runs.
 *
 * So the graph is fetched first and painted, then the plan facts are fetched
 * and patched into the same card. The final state is identical; what changes
 * is that a slow or failed plan can no longer blank a graph that loaded.
 */
import type { StorageApi } from "@tanstack/db"
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Repo } from "@smthrs/rpc/LocalApp"
import type { TargetGraphResponse } from "@smthrs/rpc/TargetGraph"
import { TARGET_GRAPH_ROUTES } from "@smthrs/rpc/TargetGraph"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"

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

const NODE = { label: "//src:typeCheck", package: "//src", name: "typeCheck", rule: "Shell.Test", kinds: ["test"], private: false }
const BARE: TargetGraphResponse = {
  repoId: "force", nodes: [NODE], edges: [], warnings: [],
  generatedAt: "2026-08-27T00:00:00.000Z", digest: "a".repeat(64), durationMs: 4700
}
const PLANNED: TargetGraphResponse = {
  ...BARE,
  nodes: [{ ...NODE, plan: { mode: "check", cacheable: true, key: "b".repeat(64), argv: ["tsc", "--noEmit"] } }],
  durationMs: 15900
}

/** Records every graph request's body and answers each phase separately. */
const routeWith = (planned: () => Promise<Response>): { bodies: Array<Record<string, unknown>>; restore: () => void } => {
  const bodies: Array<Record<string, unknown>> = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.endsWith(TARGET_GRAPH_ROUTES.graph)) return new Response("not found", { status: 404 })
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    bodies.push(body)
    if (body.plan === true) return planned()
    return new Response(JSON.stringify(BARE), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { bodies, restore: () => { globalThis.fetch = real } }
}

/*
 * A plan the test holds open. `started` settles the moment the controller
 * asks for the plan facts, which is the exact window the DAG has to be
 * navigable in; `release` answers the request. Without this seam a test can
 * only see the state both phases left behind, and moving the graph patch
 * after the plan would keep every final assertion green.
 */
const heldPlan = (answer: () => Promise<Response>) => {
  let markStarted!: () => void
  const started = new Promise<void>((accept) => { markStarted = accept })
  let release!: () => void
  const released = new Promise<void>((accept) => { release = accept })
  return {
    started,
    release,
    respond: async () => {
      markStarted()
      await released
      return await answer()
    }
  }
}

let restore = () => {}
beforeEach(() => {
  restore = () => {}
})
afterEach(() => {
  restore()
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

const graphCard = (store: Awaited<ReturnType<typeof boot>>["store"]) => {
  const card = store.collections.cards.get("graph-force")
  if (card?.kind !== "graph") throw new Error("expected a graph card")
  return card
}

test("a plan that fails still leaves the DAG painted", async () => {
  const plan = heldPlan(async () => { throw new Error("seam timeout") })
  const route = routeWith(plan.respond)
  restore = route.restore
  const { store, controller } = await boot()
  const running = controller.commands.run("target.graph")

  /*
   * The plan is in flight and the DAG is ALREADY on the card. This is the
   * whole point of the split: the graph a human navigates cannot wait on the
   * facts only the drawer reads.
   */
  await plan.started
  const painted = graphCard(store)
  expect(painted.payload.status).toBe("done")
  expect(painted.payload.graph?.nodes.map((node) => node.label)).toEqual(["//src:typeCheck"])
  expect(painted.payload.graph?.edges).toEqual([])
  expect(painted.payload.error).toBeUndefined()

  plan.release()
  await running

  const card = graphCard(store)
  /* The graph arrived, so the card is done — not blanked by the plan. */
  expect(card.payload.status).toBe("done")
  expect(card.payload.graph?.nodes.length).toBe(1)
  expect(card.payload.error).toBeUndefined()
  /* Without plan facts, but with the graph a human can actually navigate. */
  expect(card.payload.graph?.nodes[0]?.plan).toBeUndefined()

  /* Two requests: the DAG first, the plan facts second. */
  expect(route.bodies.map((body) => body.plan)).toEqual([undefined, true])
})

test("a plan that succeeds patches its facts into the painted card", async () => {
  const plan = heldPlan(async () =>
    new Response(JSON.stringify(PLANNED), { status: 200, headers: { "content-type": "application/json" } })
  )
  const route = routeWith(plan.respond)
  restore = route.restore
  const { store, controller } = await boot()
  const running = controller.commands.run("target.graph")

  /* The bare DAG is painted before the plan answers, plan facts and all. */
  await plan.started
  const painted = graphCard(store)
  expect(painted.payload.status).toBe("done")
  expect(painted.payload.graph?.nodes.length).toBe(1)
  expect(painted.payload.graph?.nodes[0]?.plan).toBeUndefined()

  plan.release()
  await running

  const card = graphCard(store)
  expect(card.payload.status).toBe("done")
  expect(card.payload.graph?.nodes[0]?.plan).toMatchObject({ mode: "check", cacheable: true })
  expect(card.payload.graph?.nodes[0]?.plan?.argv).toEqual(["tsc", "--noEmit"])
})

test("a graph route that fails still fails the card: the plan cannot rescue it", async () => {
  const real = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "The loader exited 1." } }), {
      status: 500,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch
  restore = () => { globalThis.fetch = real }
  const { store, controller } = await boot()
  await controller.commands.run("target.graph")
  const card = graphCard(store)
  expect(card.payload.status).toBe("failed")
  expect(card.payload.graph).toBeUndefined()
  expect(card.payload.error).toContain("The loader exited 1.")
})

test("a focused graph asks the plan for that label alone, never the workspace", async () => {
  const route = routeWith(async () =>
    new Response(JSON.stringify(PLANNED), { status: 200, headers: { "content-type": "application/json" } })
  )
  restore = route.restore
  const { controller } = await boot()
  await controller.commands.run("target.graph", "//src:typeCheck")
  /*
   * `labels` narrows the plan. Both phases carry it, so the second request
   * plans one target rather than `//...`.
   */
  expect(route.bodies.length).toBe(2)
  for (const body of route.bodies) expect(body.labels).toEqual(["//src:typeCheck"])
  expect(route.bodies[1]?.plan).toBe(true)
})
