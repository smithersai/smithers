import type { StorageApi } from "@tanstack/db"
import { expect, test } from "bun:test"
import type { TargetRunFrame } from "@smthrs/rpc/LocalApp"
import { createAppStore } from "../AppStore"
import type { Card } from "../AppState"
import type { TargetRunClient } from "../TargetRunClient"
import { createControllerContext, type ControllerContext } from "./context"
import { createTargetsController, targetsCardId } from "./targets"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const setup = async (answer: Promise<Response> | Response) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const targetCard: Card = {
    id: targetsCardId("repo-1"),
    kind: "targets",
    title: "repo targets",
    status: "acted",
    createdAt: 1,
    ordinal: 1,
    payload: {
      repoId: "repo-1",
      repoName: "repo",
      status: "done",
      warnings: [],
      targets: [{
        id: "opaque-target",
        label: "//:check",
        target: "Shell.Test",
        kinds: ["test"],
        package: "//",
        name: "check",
        workspace: "."
      }]
    }
  }
  store.dispatch({ type: "card.upsert", actor: "system", card: targetCard })
  const attachments: Array<{ readonly runId: string; readonly onFrame: (frame: TargetRunFrame) => void }> = []
  const runs: TargetRunClient = {
    attach: (runId, onFrame) => {
      attachments.push({ runId, onFrame })
      return () => {}
    },
    dispose: () => {}
  }
  const ctx = {
    store,
    baseUrl: "",
    commandActor: "user",
    boundedFetch: async () => await answer,
    errorMessageOf: async (response: Response, fallback: string) => {
      const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined
      return typeof body?.message === "string" ? body.message : fallback
    }
  } as unknown as ControllerContext
  const controller = createTargetsController(ctx, {
    nextOrdinal: () => 2,
    loadRepos: async () => {},
    runs
  })
  return { controller, store, attachments }
}

const runCards = (store: Awaited<ReturnType<typeof createAppStore>>) =>
  [...store.collections.cards.values()].filter((card) => card.kind === "target-run")

test("a slow target validation is represented immediately, then adopts the server run id", async () => {
  let resolve!: (response: Response) => void
  const pending = new Promise<Response>((accept) => { resolve = accept })
  const { controller, store, attachments } = await setup(pending)

  const running = controller.runTarget("repo-1", ".", "//:check")
  expect(runCards(store)).toHaveLength(1)
  expect(runCards(store)[0]?.payload).toMatchObject({
    runId: "",
    label: "//:check",
    status: "running",
    output: "Validating the target against the current repository…\n"
  })

  resolve(Response.json({ runId: "run-1" }))
  expect(await running).toBeUndefined()
  expect(runCards(store)[0]?.payload).toMatchObject({ runId: "run-1", status: "running", output: "" })
  expect(attachments.map(({ runId }) => runId)).toEqual(["run-1"])
})

test("a refused validation settles the request card as failed", async () => {
  const { controller, store, attachments } = await setup(
    Response.json({ message: "That target is stale." }, { status: 409 })
  )

  expect(await controller.runTarget("repo-1", ".", "//:check")).toBe("That target is stale.")
  expect(runCards(store)[0]).toMatchObject({
    status: "error",
    payload: { runId: "", status: "failed", output: "error: That target is stale.\n" }
  })
  expect(attachments).toEqual([])
})

/* The targets table (docs/LOCAL-APP.md "Cards"): filter, selection, and the facts a selection reads. */
const routed = async (routes: Record<string, () => Response>) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: targetsCardId("repo-1"),
      kind: "targets",
      title: "repo targets",
      status: "acted",
      createdAt: 1,
      ordinal: 1,
      payload: {
        repoId: "repo-1",
        repoName: "repo",
        status: "done",
        warnings: [],
        targets: [
          { id: "t1", label: "//:check", target: "Shell.Test", kinds: ["test"], package: "//", name: "check", workspace: "." },
          { id: "t2", label: "//:lint", target: "Shell.Test", kinds: ["lint"], package: "//", name: "lint", workspace: "." }
        ]
      }
    }
  })
  const requested: Array<string> = []
  const ctx = {
    store,
    baseUrl: "",
    commandActor: "user",
    boundedFetch: async (input: string) => {
      requested.push(input)
      const route = Object.keys(routes).find((path) => input.endsWith(path))
      return route === undefined ? Response.json({ message: "absent" }, { status: 404 }) : routes[route]!()
    },
    errorMessageOf: async (response: Response, fallback: string) => {
      const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined
      return typeof body?.message === "string" ? body.message : fallback
    }
  } as unknown as ControllerContext
  const controller = createTargetsController(ctx, {
    nextOrdinal: () => 2,
    loadRepos: async () => {},
    runs: { attach: () => () => {}, dispose: () => {} }
  })
  const card = () => store.collections.cards.get(targetsCardId("repo-1")) as Extract<Card, { kind: "targets" }>
  return { controller, card, requested, store }
}

/** `routed` with no routes, plus the store for the tests that dispatch. */
const routedWithStore = () => routed({})

test("target.filter toggles chips and sets or clears the query and workspace in the card's view", async () => {
  const { controller, card } = await routed({})
  controller.filterTargets("repo-1", { kind: "test" })
  controller.filterTargets("repo-1", { kind: "lint" })
  controller.filterTargets("repo-1", { kind: "test" })
  controller.filterTargets("repo-1", { state: "failed" })
  controller.filterTargets("repo-1", { state: "bogus" })
  controller.filterTargets("repo-1", { query: "ch", workspace: "tools" })
  expect(card().payload.view).toEqual({ kinds: ["lint"], states: ["failed"], query: "ch", workspace: "tools" })
  controller.filterTargets("repo-1", { query: "  ", workspace: "*" })
  expect(card().payload.view).toEqual({ kinds: ["lint"], states: ["failed"] })
  expect(controller.filterTargets("nope", { query: "x" })).toBe("There is no targets card for repository nope.")
})

test("target.select reads the target's facts once through the graph route and keeps them on the card", async () => {
  const graph = {
    repoId: "repo-1",
    nodes: [
      { label: "//:check", package: "//", name: "check", rule: "Shell.Test", kinds: ["test"], private: false, plan: { cacheable: true, key: "k".repeat(64) }, source: { file: "legacy declaration", line: 4 } },
      { label: "//:lint", package: "//", name: "lint", rule: "Shell.Test", kinds: ["lint"], private: false }
    ],
    edges: [{ from: "//:check", to: "//:lint", kind: "deps" }],
    warnings: [],
    generatedAt: "2026-08-30T00:00:00.000Z",
    durationMs: 5
  }
  const { controller, card, requested } = await routed({ "/api/targets/graph": () => Response.json(graph) })
  expect(await controller.selectTarget("repo-1", "//:check")).toBeUndefined()
  expect(card().payload.view?.selected).toBe("//:check")
  expect(card().payload.details?.["//:check"]).toMatchObject({
    status: "done",
    deps: ["//:lint"],
    rdeps: [],
    node: { source: { file: "legacy declaration", line: 4 }, plan: { cacheable: true } }
  })
  // A second selection of the same label is a view change only — no second read.
  await controller.selectTarget("repo-1", "//:check")
  expect(requested.filter((url) => url.endsWith("/api/targets/graph"))).toHaveLength(1)
  await controller.selectTarget("repo-1")
  expect(card().payload.view?.selected).toBeUndefined()
  expect(card().payload.details?.["//:check"]?.status).toBe("done")
  expect(await controller.selectTarget("repo-1", "//:nope")).toBe("//:nope is not a target of repo.")
})

test("a graph read the server refuses lands on the card as that target's failed detail, not a blank", async () => {
  const { controller, card } = await routed({
    "/api/targets/graph": () => Response.json({ message: "graph_failed: declared input is not a regular file: packages/smithers/flows/jj/wasm" }, { status: 500 })
  })
  await controller.selectTarget("repo-1", "//:lint")
  expect(card().payload.details?.["//:lint"]).toEqual({
    status: "failed",
    error: "graph_failed: declared input is not a regular file: packages/smithers/flows/jj/wasm"
  })
})

test("a target run refreshes the recorded runs the table's last-run column reads", async () => {
  let history: Array<Record<string, unknown>> = []
  const attachments: Array<(frame: TargetRunFrame) => void> = []
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: targetsCardId("repo-1"),
      kind: "targets",
      title: "repo targets",
      status: "acted",
      createdAt: 1,
      ordinal: 1,
      payload: {
        repoId: "repo-1",
        repoName: "repo",
        status: "done",
        warnings: [],
        targets: [{ id: "t1", label: "//:check", target: "Shell.Test", kinds: ["test"], package: "//", name: "check", workspace: "." }]
      }
    }
  })
  const ctx = {
    store,
    baseUrl: "",
    commandActor: "user",
    boundedFetch: async (input: string) =>
      input.endsWith("/api/targets/runs")
        ? Response.json({ runs: history })
        : Response.json({ runId: "run-1" }),
    errorMessageOf: async (_response: Response, fallback: string) => fallback
  } as unknown as ControllerContext
  const controller = createTargetsController(ctx, {
    nextOrdinal: () => 2,
    loadRepos: async () => {},
    runs: { attach: (_runId, onFrame) => { attachments.push(onFrame); return () => {} }, dispose: () => {} }
  })
  const card = () => store.collections.cards.get(targetsCardId("repo-1")) as Extract<Card, { kind: "targets" }>
  history = [{ runId: "run-1", repoId: "repo-1", label: "//:check", labels: ["//:check"], status: "running", startedAt: 10 }]
  await controller.runTarget("repo-1", ".", "//:check")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(card().payload.runs?.[0]).toMatchObject({ runId: "run-1", status: "running" })
  history = [{ runId: "run-1", repoId: "repo-1", label: "//:check", labels: ["//:check"], status: "done", startedAt: 10, endedAt: 40, exitCode: 0 }]
  attachments[0]?.({ type: "exit", code: 0 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(card().payload.runs?.[0]).toMatchObject({ runId: "run-1", status: "done", exitCode: 0 })
})

/* Featured / Recent views, stars, and name groups (cards/TargetsTable.ts). */
test("target.filter mode= switches the view and drops an unknown mode", async () => {
  const { controller, card } = await routed({})
  controller.filterTargets("repo-1", { mode: "recent" })
  expect(card().payload.view?.mode).toBe("recent")
  controller.filterTargets("repo-1", { mode: "bogus" })
  expect(card().payload.view?.mode).toBeUndefined()
})

test("a star lands in app-starred-targets keyed by the repository path and mirrors onto the card; unstar removes both", async () => {
  const { controller, card, store } = await routedWithStore()
  store.dispatch({
    type: "repos.loaded",
    actor: "system",
    repos: [{
      id: "repo-1",
      path: "/tmp/repo",
      name: "repo",
      git: null,
      warnings: [],
      smithers: { detected: true, workspaceFile: null, declarationFiles: ["legacy declaration"], reason: "ok", workspaces: [{ path: ".", title: "repo" }] }
    }]
  })
  expect(controller.starTarget("repo-1", "//:lint", true)).toBeUndefined()
  expect([...store.collections.starredTargets.values()]).toMatchObject([{ id: "local:/tmp/repo:://:lint", repoKey: "local:/tmp/repo", label: "//:lint" }])
  expect(card().payload.starred).toEqual(["//:lint"])
  expect(controller.starTarget("repo-1", "//:nope", true)).toBe("//:nope is not a target of repo.")
  expect(controller.starTarget("repo-1", "//:lint", false)).toBeUndefined()
  expect([...store.collections.starredTargets.values()]).toEqual([])
  expect(card().payload.starred).toEqual([])
})

test("expand, pick and run-set act on a name group; run-set runs one target.run per picked member", async () => {
  const runsRequested: Array<string> = []
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: targetsCardId("repo-1"),
      kind: "targets",
      title: "repo targets",
      status: "acted",
      createdAt: 1,
      ordinal: 1,
      payload: {
        repoId: "repo-1",
        repoName: "repo",
        status: "done",
        warnings: [],
        targets: [
          { id: "a", label: "//packages/a:lint", target: "EsLint", kinds: ["lint"], package: "//packages/a", name: "lint", workspace: "." },
          { id: "b", label: "//packages/b:lint", target: "EsLint", kinds: ["lint"], package: "//packages/b", name: "lint", workspace: "." },
          { id: "c", label: "//:ci", target: "GithubCiGen", kinds: ["build"], package: "//", name: "ci", workspace: "." }
        ]
      }
    }
  })
  const ctx = {
    store,
    baseUrl: "",
    commandActor: "user",
    boundedFetch: async (input: string, init?: RequestInit) => {
      if (input.endsWith("/api/targets/run")) {
        runsRequested.push(String((JSON.parse(String(init?.body)) as { targetId: string }).targetId))
        return Response.json({ runId: `run-${runsRequested.length}` })
      }
      return Response.json({ runs: [] })
    },
    errorMessageOf: async (_response: Response, fallback: string) => fallback
  } as unknown as ControllerContext
  const controller = createTargetsController(ctx, {
    nextOrdinal: () => 2,
    loadRepos: async () => {},
    runs: { attach: () => () => {}, dispose: () => {} }
  })
  const card = () => store.collections.cards.get(targetsCardId("repo-1")) as Extract<Card, { kind: "targets" }>
  expect(controller.expandTargetGroup("repo-1", "//...:ci")).toBe("//...:ci is not a group of repo's targets.")
  controller.expandTargetGroup("repo-1", "//...:lint")
  expect(card().payload.view?.expanded).toEqual(["//...:lint"])
  controller.expandTargetGroup("repo-1", "lint")
  expect(card().payload.view?.expanded).toEqual([])
  controller.pickTargets("repo-1", "//...:lint", "//packages/b:lint")
  expect(card().payload.view?.picked).toEqual({ "//...:lint": ["//packages/a:lint"] })
  expect(controller.pickTargets("repo-1", "//...:lint", "//:ci")).toBe("//:ci is not a member of //...:lint.")
  expect(await controller.runTargetSet("repo-1", "//...:lint")).toBeUndefined()
  expect(runsRequested).toEqual(["a"])
  controller.pickTargets("repo-1", "//...:lint", "none")
  expect(await controller.runTargetSet("repo-1", "//...:lint")).toBe("Nothing picked in //...:lint.")
  controller.pickTargets("repo-1", "//...:lint", "all")
  expect(card().payload.view?.picked).toEqual({})
  expect(await controller.runTargetSet("repo-1", "//...:lint")).toBeUndefined()
  expect(runsRequested).toEqual(["a", "a", "b"])
  // A group label can be starred like any target.
  expect(controller.starTarget("repo-1", "//...:lint", true)).toBeUndefined()
  expect(card().payload.starred).toEqual(["//...:lint"])
})

/*
 * Pattern runs and the run card's fold (LOCAL-APP.md "Cards"): a pattern run
 * posts `{ verb, pattern, workspace }` — no target grant — and every frame of
 * the topic lands on the card: `node` frames as per-target rows (merged by
 * label so the results block's rule joins the status line's timing),
 * `summary` as the totals, attributed chunks under `nodeOutput`, exit as the
 * settled status.
 */
test("a pattern run posts the verb and pattern, then folds node, summary, output and exit frames into its card", async () => {
  const requests: Array<unknown> = []
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const attachments: Array<{ readonly runId: string; readonly onFrame: (frame: TargetRunFrame) => void }> = []
  const ctx = {
    store,
    baseUrl: "",
    commandActor: "user",
    boundedFetch: async (input: string, init?: RequestInit) => {
      if (input.endsWith("/api/targets/run")) {
        requests.push(JSON.parse(String(init?.body)))
        return Response.json({ runId: "run-p" })
      }
      return Response.json({ runs: [] })
    },
    errorMessageOf: async (_response: Response, fallback: string) => fallback
  } as unknown as ControllerContext
  const controller = createTargetsController(ctx, {
    nextOrdinal: () => 2,
    loadRepos: async () => {},
    runs: {
      attach: (runId, onFrame) => {
        attachments.push({ runId, onFrame })
        return () => {}
      },
      dispose: () => {}
    }
  })
  expect(await controller.runPattern("repo-1", ".", "ci", "//packages/...")).toBeUndefined()
  expect(requests).toEqual([{ repoId: "repo-1", workspace: ".", verb: "ci", pattern: "//packages/..." }])
  const card = () => runCards(store)[0]!
  expect(card().payload).toMatchObject({ runId: "run-p", label: "ci //packages/...", verb: "ci", pattern: "//packages/...", status: "running", nodes: [] })
  const frame = attachments[0]!.onFrame
  frame({ type: "started", runId: "run-p", label: "ci //packages/...", labels: ["//packages/..."], at: 1_000 })
  frame({ type: "node", node: { label: "//a:check", status: "running", startedAt: 1_000 }, at: 1_000 })
  frame({ type: "stdout", data: "//a:check  ran  5ms\n", label: "//a:check" })
  frame({ type: "node", node: { label: "//a:check", status: "ran", startedAt: 1_000, endedAt: 1_005, durationMs: 5 }, at: 1_005 })
  frame({ type: "node", node: { label: "//b:test", status: "failed", startedAt: 1_000, endedAt: 1_100, durationMs: 100, reason: "2 tests failed" }, at: 1_100 })
  frame({ type: "stderr", data: "FAIL b.test.ts\n", label: "//b:test" })
  frame({ type: "node", node: { label: "//a:check", status: "ran", rule: "Typecheck", durationMs: 5 }, at: 1_200 })
  frame({ type: "summary", summary: { total: 2, hit: 0, ran: 1, failed: 1, skipped: 0, durationMs: 1_200, ok: false, criticalPath: ["//b:test"] }, at: 1_200 })
  expect(card().payload.nodes).toEqual([
    { label: "//a:check", status: "ran", startedAt: 1_000, endedAt: 1_005, durationMs: 5, rule: "Typecheck" },
    { label: "//b:test", status: "failed", startedAt: 1_000, endedAt: 1_100, durationMs: 100, reason: "2 tests failed" }
  ])
  expect(card().payload.summary).toMatchObject({ total: 2, ran: 1, failed: 1 })
  expect(card().payload.nodeOutput).toEqual({ "//a:check": "//a:check  ran  5ms\n", "//b:test": "FAIL b.test.ts\n" })
  expect(card().payload.output).toBe("//a:check  ran  5ms\nFAIL b.test.ts\n")
  expect(card().payload.startedAt).toBe(1_000)
  frame({ type: "exit", code: 1 })
  expect(card()).toMatchObject({ status: "error", payload: { status: "failed", exitCode: 1 } })
  expect(typeof card().payload.endedAt).toBe("number")
})


/*
 * 2026-09-01: opening a repository renders nothing in the transcript; the
 * targets table is the explicit target.list act, and a bare call means the
 * active open repository.
 */
const openedRepo = (id: string, detected: boolean) => ({
  id,
  path: `/tmp/${id}`,
  name: `acme/${id}`,
  git: { branch: "main", remote: null },
  warnings: [],
  smithers: {
    detected,
    workspaceFile: detected ? "WORKSPACE.ts" : null,
    declarationFiles: [],
    reason: detected ? "1 workspace detected" : "no WORKSPACE.ts or smthrs legacy declaration",
    workspaces: [{ path: ".", title: id }]
  }
})

test("opening a repository renders no card and no message; it only refreshes the open set", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const repo = openedRepo("fresh", true)
  const loads: Array<string> = []
  let resumed = 0
  const ctx = {
    store,
    baseUrl: "",
    commandActor: "user",
    boundedFetch: async () => new Response(JSON.stringify({ repo }), { status: 200, headers: { "content-type": "application/json" } }),
    http: async () => new Response("{}", { status: 500 }),
    errorMessageOf: async (_response: Response, fallback: string) => fallback,
    resumeDeferredCommand: () => {
      resumed += 1
    }
  } as unknown as ControllerContext
  const controller = createTargetsController(ctx, {
    nextOrdinal: () => 1,
    loadRepos: async () => {
      loads.push("repos")
    },
    runs: { attach: () => () => {}, dispose: () => {} }
  })
  const before = store.collections.messages.size
  await controller.openRepo({ path: "/tmp/fresh" })
  expect(loads).toEqual(["repos"])
  expect([...store.collections.cards.values()]).toEqual([])
  expect(store.collections.messages.size).toBe(before)
  // The open satisfies a parked files command's repo-source requirement.
  expect(resumed).toBe(1)
})

test("target.list names the missing repository, the missing workspace, or loads the active repository's table", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const queries: Array<unknown> = []
  const ctx = {
    store,
    baseUrl: "",
    commandActor: "user",
    boundedFetch: async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/api/targets/query")) return Response.json({ runs: [] })
      queries.push(JSON.parse(String(init?.body ?? "{}")))
      return new Response(JSON.stringify({ targets: [], warnings: [], durationMs: 1 }), { status: 200, headers: { "content-type": "application/json" } })
    },
    errorMessageOf: async (_response: Response, fallback: string) => fallback,
    resumeDeferredCommand: () => {}
  } as unknown as ControllerContext
  const controller = createTargetsController(ctx, { nextOrdinal: () => 1, loadRepos: async () => {}, runs: { attach: () => () => {}, dispose: () => {} } })
  expect(await controller.listTargets()).toBe("Open a repository first — there are no targets to list.")
  store.dispatch({ type: "repos.loaded", actor: "system", repos: [openedRepo("plain", false)] })
  expect(await controller.listTargets()).toBe("acme/plain has no Smithers workspace (no WORKSPACE.ts or smthrs legacy declaration).")
  expect(await controller.listTargets("nope")).toBe("No open repository has id nope.")
  store.dispatch({ type: "repos.loaded", actor: "system", repos: [openedRepo("plain", false), openedRepo("built", true)] })
  // "acme/built" sorts before "acme/plain": the store names it active when both load at once.
  expect(await controller.listTargets()).toBeUndefined()
  expect(queries).toEqual([{ repoId: "built" }])
  const card = store.collections.cards.get(targetsCardId("built"))
  expect(card?.kind).toBe("targets")
  expect(card?.kind === "targets" ? card.payload.status : undefined).toBe("done")
})

for (const phase of ["headers", "body"] as const) {
  test(`target.list settles its pending card when the query stalls at ${phase}`, async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [openedRepo("built", true)] })
    let cancelled = false
    const ctx = createControllerContext(store, {
      available: false,
      pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "unavailable" })
    }, {
      available: false,
      startTurn: async () => ({ status: "error", message: "unavailable" }),
      cancelTurn: async () => {},
      subscribe: () => () => {}
    }, {
      seamTimeoutMs: 20,
      fetchImpl: async () => phase === "headers" ? new Promise<Response>(() => {}) : new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"targets":')) },
        cancel() { cancelled = true }
      }))
    })
    const controller = createTargetsController(ctx, {
      nextOrdinal: () => 1,
      loadRepos: async () => {},
      runs: { attach: () => () => {}, dispose: () => {} }
    })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        controller.listTargets(),
        new Promise((resolve) => { watchdog = setTimeout(() => resolve("still pending"), 500) })
      ])
      expect(result).toBeUndefined()
      expect(store.collections.cards.get(targetsCardId("built"))).toMatchObject({
        status: "error",
        payload: { status: "failed", warnings: ["seam timeout"] }
      })
      if (phase === "body") expect(cancelled).toBe(true)
    } finally {
      clearTimeout(watchdog)
      await ctx.dispose()
    }
  })
}
