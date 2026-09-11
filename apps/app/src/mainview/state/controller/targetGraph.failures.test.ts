/*
 * What the target-graph commands do when nothing goes right (docs/LOCAL-APP.md
 * "Cards: target graph"). The rule the product path lives by is that a card
 * never shows a state it did not receive: no repository open, more than one
 * open, a route that 500s, a route that answers a shape the contract does not
 * describe, a transport that throws before any response exists.
 *
 * The authors' suite proves the happy path against the fixtures; every case
 * here is a branch that reached the human as a silently blank card.
 */
import type { StorageApi } from "@tanstack/db"
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Repo } from "@smthrs/rpc/LocalApp"
import { TARGET_GRAPH_ROUTES } from "@smthrs/rpc/TargetGraph"
import type { TargetGraphDevFixtures } from "../../dev/fixtureRunStream"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { repoKeyOf } from "../AppState"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { createTargetGraphController } from "./targetGraph"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "native only" })
}

const repo = (id: string): Repo => ({
  id,
  path: `/tmp/${id}`,
  name: id,
  git: { branch: "main", remote: null },
  warnings: [],
  smithers: {
    detected: true,
    workspaceFile: null,
    declarationFiles: ["PACKAGE.ts"],
    reason: "declared",
    workspaces: [{ path: ".", title: id }]
  }
})

/** The whole backend as one answer: every target-graph route replies with it. */
const answerWith = (reply: (url: string) => Response | Promise<Response>): (() => void) => {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    return reply(url)
  }) as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

const controllerWith = async (repos: ReadonlyArray<string>) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent)
  store.dispatch({ type: "repos.loaded", actor: "system", repos: repos.map((id) => repo(id)) })
  return { store, controller }
}

const cardOf = (
  store: Awaited<ReturnType<typeof controllerWith>>["store"],
  id: string
): Card | undefined => store.collections.cards.get(id)

let restore = () => {}
beforeEach(() => {
  restore = () => {}
})
afterEach(() => {
  restore()
})

const COMMANDS = ["target.graph", "target.history", "target.affected", "target.ci"] as const

test("with no repository open, every command says to open one and lands no card", async () => {
  const { store, controller } = await controllerWith([])
  for (const name of COMMANDS) {
    const result = await controller.commands.run(name)
    expect(result.status).not.toBe("executed")
    expect(JSON.stringify(result)).toContain("Open a repository first")
  }
  expect([...store.collections.cards.values()].length).toBe(0)
})

test("with two repositories open, every command acts on the active one — the first by name until one is selected", async () => {
  const { store, controller } = await controllerWith(["force", "eigen"])
  restore = answerWith(() =>
    new Response(JSON.stringify({ error: { message: "down" } }), { status: 500, headers: { "content-type": "application/json" } })
  )
  for (const name of COMMANDS) await controller.commands.run(name)
  const cards = [...store.collections.cards.values()]
  expect(cards.length).toBe(COMMANDS.length)
  // "eigen" sorts before "force": the store named it active when both loaded at once.
  expect(cards.map((card) => (card.payload as { repoId?: string }).repoId)).toEqual(COMMANDS.map(() => "eigen"))
  store.dispatch({ type: "repo.selected", actor: "user", id: repoKeyOf("/tmp/force") })
  await controller.commands.run("target.graph")
  expect((cardOf(store, "graph-force")?.payload as { repoId?: string } | undefined)?.repoId).toBe("force")
})

test("a route that 500s leaves each card failed with the backend's words", async () => {
  restore = answerWith(() =>
    new Response(JSON.stringify({ error: { message: "The loader exited 1: no WORKSPACE.ts" } }), {
      status: 500,
      headers: { "content-type": "application/json" }
    })
  )
  const { store, controller } = await controllerWith(["force"])

  await controller.commands.run("target.graph")
  const graph = cardOf(store, "graph-force")
  if (graph?.kind !== "graph") throw new Error("expected a graph card")
  expect(graph.payload.status).toBe("failed")
  expect(graph.status).toBe("error")
  expect(graph.payload.error).toContain("no WORKSPACE.ts")
  /* Nothing renders a graph it never received. */
  expect(graph.payload.graph).toBeUndefined()

  await controller.commands.run("target.affected")
  const affected = cardOf(store, "affected-force")
  if (affected?.kind !== "affected") throw new Error("expected an affected card")
  expect(affected.payload.status).toBe("failed")
  expect(affected.payload.result).toBeUndefined()

  await controller.commands.run("target.ci")
  const ci = cardOf(store, "ci-force")
  if (ci?.kind !== "ci-matrix") throw new Error("expected a ci card")
  expect(ci.payload.status).toBe("failed")
  expect(ci.payload.result).toBeUndefined()

  await controller.commands.run("target.history")
  const history = cardOf(store, "run-history-force")
  if (history?.kind !== "run-history") throw new Error("expected a history card")
  expect(history.payload.status).toBe("failed")
  expect(history.payload.runs).toEqual([])
})

test("a route that answers a shape the contract does not describe fails the card", async () => {
  restore = answerWith(() =>
    new Response(JSON.stringify({ nodes: "not an array" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  )
  const { store, controller } = await controllerWith(["force"])
  const result = await controller.commands.run("target.graph")
  expect(JSON.stringify(result)).toContain("unexpected shape")
  const graph = cardOf(store, "graph-force")
  if (graph?.kind !== "graph") throw new Error("expected a graph card")
  expect(graph.payload.status).toBe("failed")
  expect(graph.payload.graph).toBeUndefined()
})

test("a transport that throws before any response fails the card with the throw", async () => {
  restore = answerWith(() => {
    throw new Error("Failed to fetch")
  })
  const { store, controller } = await controllerWith(["force"])
  const result = await controller.commands.run("target.graph")
  expect(JSON.stringify(result)).toContain("Failed to fetch")
  const graph = cardOf(store, "graph-force")
  if (graph?.kind !== "graph") throw new Error("expected a graph card")
  expect(graph.payload.status).toBe("failed")
  expect(graph.payload.error).toContain("Failed to fetch")
})

test("a repository with no targets renders an empty graph, not a failure", async () => {
  restore = answerWith((url) =>
    new Response(
      JSON.stringify(
        url.endsWith(TARGET_GRAPH_ROUTES.graph)
          ? { repoId: "force", nodes: [], edges: [], warnings: [], generatedAt: "2026-08-27T00:00:00.000Z", durationMs: 3 }
          : {}
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  )
  const { store, controller } = await controllerWith(["force"])
  expect((await controller.commands.run("target.graph")).status).toBe("executed")
  const graph = cardOf(store, "graph-force")
  if (graph?.kind !== "graph") throw new Error("expected a graph card")
  /* An empty workspace is a fact the backend answered, not an error. */
  expect(graph.payload.status).toBe("done")
  expect(graph.payload.graph?.nodes).toEqual([])
})

test("a repository with no recorded runs lists none, and replaying an unknown run says so", async () => {
  restore = answerWith((url) =>
    url.endsWith(TARGET_GRAPH_ROUTES.runs)
      ? new Response(JSON.stringify({ repoId: "force", runs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
      : new Response(JSON.stringify({ error: { message: "No target run with id nope." } }), {
        status: 404,
        headers: { "content-type": "application/json" }
      })
  )
  const { store, controller } = await controllerWith(["force"])
  expect((await controller.commands.run("target.history")).status).toBe("executed")
  const history = cardOf(store, "run-history-force")
  if (history?.kind !== "run-history") throw new Error("expected a history card")
  expect(history.payload.status).toBe("done")
  expect(history.payload.runs).toEqual([])

  const replay = await controller.commands.run("target.runs.select", "force nope")
  expect(JSON.stringify(replay)).toContain("No target run with id nope.")
  /* No timeline card is invented for a run that was never recorded. */
  expect(cardOf(store, "run-timeline-nope")).toBeUndefined()
})

test("scrubbing a run with no recording says so rather than blanking the card", async () => {
  const { controller } = await controllerWith(["force"])
  const result = await controller.commands.run("target.run.scrub", "never-recorded 1700000000000")
  expect(JSON.stringify(result)).toContain("never-recorded")
})

test("focusing with no graph card open says so", async () => {
  const { controller } = await controllerWith(["force"])
  const result = await controller.commands.run("target.graph.focus", "force //src:typeCheck")
  expect(JSON.stringify(result)).toContain("no graph card open")
})

test("the timeline command needs a run to show", async () => {
  const { controller } = await controllerWith(["force"])
  const result = await controller.commands.run("target.timeline")
  expect(JSON.stringify(result)).toContain("Name the run")
})

test("opening a declaration the host refuses reports the refusal", async () => {
  restore = answerWith(() =>
    new Response(JSON.stringify({ error: "no editor is configured" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  )
  const { controller } = await controllerWith(["force"])
  const refused = await controller.commands.run("target.source.open", "force src/PACKAGE.ts:42")
  expect(JSON.stringify(refused)).toContain("Could not open the declaration")
  expect(JSON.stringify(refused)).toContain("no editor is configured")
})

test("opening a declaration the host accepts says nothing at all", async () => {
  const urls: Array<string> = []
  restore = answerWith((url) => {
    urls.push(url)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
  })
  const { controller } = await controllerWith(["force"])
  const opened = await controller.commands.run("target.source.open", "force src/PACKAGE.ts:42")
  expect(opened.status).toBe("executed")
  expect(JSON.stringify(opened)).not.toContain("Could not open")
  expect(urls).toEqual(["/api/targets/open-source"])
})

test("a declaration site with no line number still opens", async () => {
  restore = answerWith(() =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
  )
  const { controller } = await controllerWith(["force"])
  expect((await controller.commands.run("target.source.open", "force src/PACKAGE.ts")).status).toBe("executed")
})

test("the timeline of a run this session never watched paints from its recording, settled, not as a RUNNING card that never changes", async () => {
  // Reproduced on the Smithers checkout: `/target.timeline <runId>` for a finished run stayed
  // "RUNNING — No node timings yet" because the live path attached to a stream with no frames left.
  const replay = {
    run: { runId: "run-9", repoId: "force", label: "//src:typeCheck", labels: ["//src:typeCheck"], status: "done", startedAt: 1_000, endedAt: 2_000, exitCode: 0 },
    events: [
      { type: "node", at: 1_500, node: { label: "//src:typeCheck", status: "ran", startedAt: 1_000, endedAt: 1_500, durationMs: 500 } },
      { type: "summary", at: 2_000, summary: { total: 1, hit: 0, ran: 1, failed: 0, skipped: 0, durationMs: 1_000, ok: true, criticalPath: ["//src:typeCheck"] } },
      { type: "exit", code: 0 }
    ]
  }
  restore = answerWith((url) =>
    url.endsWith(TARGET_GRAPH_ROUTES.replay)
      ? new Response(JSON.stringify(replay), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ error: { message: "unexpected route" } }), { status: 500, headers: { "content-type": "application/json" } })
  )
  const { store, controller } = await controllerWith(["force"])
  await controller.commands.run("target.timeline", "force run-9")
  const timeline = cardOf(store, "run-timeline-run-9")
  if (timeline?.kind !== "run-timeline") throw new Error("expected a run-timeline card")
  expect(timeline.payload.status).toBe("done")
  expect(timeline.payload.nodes.map((node) => node.label)).toEqual(["//src:typeCheck"])
  expect(timeline.payload.summary?.ok).toBe(true)
  expect(timeline.status).toBe("acted")
})

test("the timeline of a run the replay route refuses reports the refusal instead of opening a dead RUNNING card", async () => {
  // The refusal `target.runs.select` already reports was DISCARDED here: showTimeline read the
  // replay only to decide whether to paint it, then attached live to a topic no run publishes on.
  const asked: Array<string> = []
  restore = answerWith((url) => {
    asked.push(url)
    return new Response(JSON.stringify({ error: { message: "No target run with id nope." } }), {
      status: 404,
      headers: { "content-type": "application/json" }
    })
  })
  const { store, controller } = await controllerWith(["force"])
  const result = await controller.commands.run("target.timeline", "force nope")
  expect(result.status).not.toBe("executed")
  expect(JSON.stringify(result)).toContain("No target run with id nope.")
  expect(asked.some((url) => url.endsWith(TARGET_GRAPH_ROUTES.replay))).toBe(true)
  expect(cardOf(store, "run-timeline-nope")).toBeUndefined()
})

test("the timeline of a run nothing recorded says so rather than attaching to a dead topic", async () => {
  /*
   * `undefined` from the seam is "nothing recorded this run" — the dev fixture seam answers that
   * way for every run it never scripted. The live path would paint RUNNING with zero nodes for
   * the rest of the session, so the command refuses the way `target.runs.select` does. The seam
   * is injected here because only the fixture branch can answer undefined: the route branch turns
   * a shape it cannot read into a refusal string.
   */
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const attached: Array<string> = []
  const ctx = {
    store,
    baseUrl: "http://local.test",
    commandActor: "user" as const,
    onDispose: () => {}
  } as unknown as ControllerContext
  const controller = createTargetGraphController(ctx, {
    nextOrdinal: () => 1,
    runs: {
      attach: (runId: string) => {
        attached.push(runId)
        return () => {}
      },
      dispose: () => {}
    },
    devFixtures: {
      replay: () => undefined,
      streamRun: (runId: string) => {
        attached.push(runId)
        return () => {}
      }
    } as unknown as TargetGraphDevFixtures
  })
  expect(await controller.showTimeline("force", "never-recorded")).toBe("There is no recording of run never-recorded.")
  expect(attached).toEqual([])
  expect(store.collections.cards.get("run-timeline-never-recorded")).toBeUndefined()
})

test("the timeline of a run the recording still calls running attaches live", async () => {
  const replay = {
    run: { runId: "run-live", repoId: "force", label: "//src:typeCheck", labels: ["//src:typeCheck"], status: "running", startedAt: 1_000 },
    events: []
  }
  restore = answerWith((url) =>
    url.endsWith(TARGET_GRAPH_ROUTES.replay)
      ? new Response(JSON.stringify(replay), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ error: { message: "unexpected route" } }), { status: 500, headers: { "content-type": "application/json" } })
  )
  const { store, controller } = await controllerWith(["force"])
  expect((await controller.commands.run("target.timeline", "force run-live")).status).toBe("executed")
  const timeline = cardOf(store, "run-timeline-run-live")
  if (timeline?.kind !== "run-timeline") throw new Error("expected a run-timeline card")
  expect(timeline.payload.status).toBe("running")
  expect(timeline.status).toBe("active")
})
