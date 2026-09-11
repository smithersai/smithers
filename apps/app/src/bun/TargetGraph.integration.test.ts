/*
 * The target-graph backend against REAL workspaces, over real HTTP, with no
 * mocks anywhere: `startLocalServer` boots the product's server, the routes
 * spawn the real `smithers-build` loader through the real Node sidecar, and the
 * assertions are facts about repositories on this machine.
 *
 * Host workspaces are explicit opt-in, never inferred from personal checkout
 * paths. Set SMITHERS_HOST_WORKSPACE_TESTS=1 plus the absolute
 * SMITHERS_GRAPH_READ_WORKSPACE and/or SMITHERS_GRAPH_RUN_WORKSPACE. The latter
 * must be a disposable clone: these tests execute build commands there and
 * retain their run history. No cleanup deletes a host workspace's artifacts.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  RunHistoryResponseSchema,
  RunReplayResponseSchema,
  TargetGraphResponseSchema
} from "@smthrs/rpc/TargetGraph"
import { TargetsQueryResponseSchema } from "@smthrs/rpc/LocalApp"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import type { RunReplayResponse, TargetGraphResponse } from "@smthrs/rpc/TargetGraph"
import { findNode } from "./Node"
import { clearTargetGraphCache } from "./TargetGraph"
import { startLocalServer } from "./server"
import type { LocalServer } from "./server"
import { hostWorkspaceTests } from "../../scripts/host-workspace-tests"

const workspaces = hostWorkspaceTests(process.env)
const READ_WORKSPACE = workspaces.read ?? ""
const RUN_WORKSPACE = workspaces.run ?? ""
const workspaceLoads = (path: string): boolean =>
  existsSync(join(path, "PACKAGE.ts")) &&
  spawnSync(join(import.meta.dir, "../../../../packages/smithers/build/build-cli/bin/smithers-build"), ["query", "//..."], {
    cwd: path,
    stdio: "ignore",
    timeout: 30_000
  }).status === 0
const haveReadWorkspace = workspaces.read !== undefined && workspaceLoads(READ_WORKSPACE)
const haveRunWorkspace = workspaces.run !== undefined && workspaceLoads(RUN_WORKSPACE)
if (workspaces.read !== undefined && !haveReadWorkspace) throw new Error("The selected read workspace could not load its build graph.")
if (workspaces.run !== undefined && !haveRunWorkspace) throw new Error("The selected run workspace could not load its build graph.")

/* A real loader run against a real monorepo; nothing here finishes in 5s. */
const BUDGET = 300_000

let server: LocalServer
let dist = ""
let base = ""
let node: Awaited<ReturnType<typeof findNode>> = null

beforeAll(async () => {
  clearTargetGraphCache()
  node = haveReadWorkspace || haveRunWorkspace ? await findNode() : null
  dist = await mkdtemp(join(tmpdir(), "smithers-integration-dist-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><div id=\"root\"></div>")
  server = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    allowManualRepositoryPaths: true,
    ...(node === null ? {} : { node }),
    home: dist,
    stateDir: join(dist, "state"),
    cloudApi: null,
    identityUpstream: null,
    harnesses: async () => [],
    log: () => {}
  })
  base = `http://127.0.0.1:${server.port}`
}, BUDGET)

afterAll(async () => {
  try {
    await server?.stop()
  } finally {
    if (dist !== "") await rm(dist, { recursive: true, force: true })
  }
})

const post = async (route: string, body: unknown): Promise<Response> =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: server.sessionToken },
    body: JSON.stringify(body)
  })

const openRepo = async (path: string): Promise<string> => {
  const response = await post("/api/repo/open", { path })
  expect(response.status).toBe(200)
  const body = await response.json() as { repo: { id: string } }
  return body.repo.id
}

const targetIdOf = async (repoId: string, label: string): Promise<string> => {
  const response = await post("/api/targets/query", { repoId })
  expect(response.status).toBe(200)
  const targets = TargetsQueryResponseSchema.parse(await response.json())
  const targetId = targets.targets.find((target) => target.label === label)?.id
  if (targetId === undefined) throw new Error(`target ${label} was not returned by the repository query`)
  return targetId
}

const graphOf = async (repoId: string, extra: Record<string, unknown> = {}): Promise<TargetGraphResponse> => {
  const response = await post("/api/targets/graph", { repoId, ...extra })
  expect(response.status).toBe(200)
  const parsed = TargetGraphResponseSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error(`the graph route broke its own contract: ${parsed.error.message}`)
  return parsed.data
}

test.skipIf(!haveReadWorkspace)("the graph route answers the opted-in workspace's real DAG", async () => {
  const repoId = await openRepo(READ_WORKSPACE)
  const graph = await graphOf(repoId)
  /* The workspace's real shape, as the CLI reports it. */
  expect(graph.nodes.length).toBeGreaterThan(0)
  expect(graph.edges.length).toBeGreaterThan(0)
  expect(graph.warnings).toEqual([])
  expect(graph.digest).toMatch(/^[0-9a-f]{64}$/)
  expect(Date.parse(graph.generatedAt)).toBeGreaterThan(0)

  /* Every edge names nodes the response actually carries. */
  const labels = new Set(graph.nodes.map((entry) => entry.label))
  for (const edge of graph.edges) {
    expect(labels.has(edge.from)).toBe(true)
    expect(labels.has(edge.to)).toBe(true)
  }
  /* And the rules are the loader's, not invented. */
  const typeCheck = graph.nodes.find((entry) => entry.label === "//src:typeCheck")
  expect(typeCheck).toBeDefined()
  expect(typeCheck?.package).toBe("//src")
  expect(typeCheck?.rule).not.toBe("")
}, BUDGET)

test.skipIf(!haveReadWorkspace)("the graph route carries the planner's facts when asked to plan", async () => {
  const repoId = await openRepo(READ_WORKSPACE)
  const planned = await graphOf(repoId, { plan: true, labels: ["//src:typeCheck"] })
  const node = planned.nodes.find((entry) => entry.label === "//src:typeCheck")
  expect(node?.plan).toBeDefined()
  /* The facts the drawer answers "why did this rebuild" with. */
  expect(typeof node?.plan?.cacheable).toBe("boolean")
  expect(node?.plan?.key ?? "").toMatch(/^[0-9a-f]{8,}$/)
  expect((node?.plan?.argv ?? []).length).toBeGreaterThan(0)

  /* An unplanned graph carries no plan at all rather than an empty one. */
  const bare = await graphOf(repoId)
  expect(bare.nodes.find((entry) => entry.label === "//src:typeCheck")?.plan).toBeUndefined()
}, BUDGET)

test.skipIf(!haveReadWorkspace)("the affected route reads the real working tree", async () => {
  const repoId = await openRepo(READ_WORKSPACE)
  const response = await post("/api/targets/affected", { repoId })
  expect(response.status).toBe(200)
  const body = await response.json() as { repoId: string; changedFiles: Array<string>; affected: Array<{ label: string }> }
  expect(body.repoId).toBe(repoId)
  expect(Array.isArray(body.changedFiles)).toBe(true)
  /* Every affected label is a label the graph actually has. */
  const graph = await graphOf(repoId)
  const labels = new Set(graph.nodes.map((entry) => entry.label))
  for (const entry of body.affected) expect(labels.has(entry.label)).toBe(true)
}, BUDGET)

test.skipIf(!haveReadWorkspace)("the ci route answers the workflows the workspace really has", async () => {
  const repoId = await openRepo(READ_WORKSPACE)
  const response = await post("/api/targets/ci", { repoId })
  expect(response.status).toBe(200)
  const body = await response.json() as {
    workflows: Array<{ name: string; path: string; source: string; jobs: Array<{ name: string }> }>
  }
  expect(body.workflows.length).toBeGreaterThan(0)
  for (const workflow of body.workflows) {
    expect(workflow.path).toMatch(/\.ya?ml$/)
    /* A preview says where it came from; nothing is passed off as generated. */
    expect(["on-disk", "scratch-render"]).toContain(workflow.source)
  }
}, BUDGET)

test.skipIf(!haveRunWorkspace)("a real run of //src:typeCheck streams node frames and a critical path", async () => {
  const repoId = await openRepo(RUN_WORKSPACE)
  const started = await post("/api/targets/run", { repoId, targetId: await targetIdOf(repoId, "//src:typeCheck") })
  expect(started.status).toBe(200)
  const { runId } = await started.json() as { runId: string }
  expect(runId).toMatch(/^[0-9a-f-]{36}$/)

  /* Nobody attaches, so the runner starts the child on its own; poll the record. */
  const deadline = Date.now() + BUDGET - 30_000
  let replay: RunReplayResponse | undefined
  while (Date.now() < deadline) {
    const response = await post("/api/targets/runs/replay", { runId })
    if (response.status === 200) {
      const parsed = RunReplayResponseSchema.safeParse(await response.json())
      if (parsed.success && parsed.data.run.status !== "pending" && parsed.data.run.status !== "running") {
        replay = parsed.data
        break
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (replay === undefined) throw new Error("the run never settled")

  expect(replay.run.exitCode).toBe(0)
  expect(replay.run.status).toBe("done")

  /* The structured frames the overlay and the timeline are built from. */
  const nodes = replay.events.filter((event) => event.type === "node")
  expect(nodes.length).toBeGreaterThan(0)
  const settled = nodes.map((event) => (event as { node: { label: string; status: string } }).node)
  expect(settled.some((node) => node.label === "//src:typeCheck")).toBe(true)
  for (const node of settled) expect(node.label.startsWith("//")).toBe(true)

  const summary = replay.events.find((event) => event.type === "summary")
  expect(summary).toBeDefined()
  if (summary?.type !== "summary") throw new Error("expected a summary frame")
  expect(summary.summary.ok).toBe(true)
  expect(summary.summary.total).toBeGreaterThan(0)
  expect(summary.summary.hit + summary.summary.ran).toBe(summary.summary.total)
  /* The critical path is a real dependency chain, ending at what was asked for. */
  expect(summary.summary.criticalPath.length).toBeGreaterThan(0)
  expect(summary.summary.criticalPath.at(-1)).toBe("//src:typeCheck")
  expect(new Set(summary.summary.criticalPath).size).toBe(summary.summary.criticalPath.length)

  /* Every recorded frame carries the seq replay orders by, gap-free from zero. */
  expect(replay.events.map((event) => event.seq)).toEqual(replay.events.map((_event, index) => index))
}, BUDGET)

test.skipIf(!haveRunWorkspace)("history and replay round-trip through the repository's own disk", async () => {
  const repoId = await openRepo(RUN_WORKSPACE)
  const started = await post("/api/targets/run", { repoId, targetId: await targetIdOf(repoId, "//src:srcs") })
  const { runId } = await started.json() as { runId: string }

  const deadline = Date.now() + BUDGET - 30_000
  let listed: Array<{ runId: string; status: string }> = []
  while (Date.now() < deadline) {
    const response = await post("/api/targets/runs", { repoId })
    expect(response.status).toBe(200)
    const parsed = RunHistoryResponseSchema.safeParse(await response.json())
    if (parsed.success) {
      listed = [...parsed.data.runs]
      if (listed.some((record) => record.runId === runId && record.status !== "pending" && record.status !== "running")) break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const record = listed.find((entry) => entry.runId === runId)
  expect(record).toBeDefined()
  expect(record?.status).toBe("done")

  /* The journal is on disk in the repository the run belonged to. */
  expect(existsSync(join(RUN_WORKSPACE, ".flows", "ui", "runs", `${runId}.jsonl`))).toBe(true)

  /* A SECOND server, sharing only that directory, rebuilds the same recording. */
  const secondDist = await mkdtemp(join(tmpdir(), "smithers-integration-dist2-"))
  await writeFile(join(secondDist, "index.html"), "<!doctype html><div id=\"root\"></div>")
  const second = await startLocalServer({
    port: 0,
    distDir: secondDist,
    chatStub: true,
    allowManualRepositoryPaths: true,
    ...(node === null ? {} : { node }),
    home: secondDist,
    stateDir: join(secondDist, "state"),
    cloudApi: null,
    identityUpstream: null,
    harnesses: async () => [],
    log: () => {}
  })
  try {
    const secondBase = `http://127.0.0.1:${second.port}`
    const open = await fetch(`${secondBase}/api/repo/open`, {
      method: "POST",
      headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: second.sessionToken },
      body: JSON.stringify({ path: RUN_WORKSPACE })
    })
    const reopened = (await open.json() as { repo: { id: string } }).repo.id
    const history = await fetch(`${secondBase}/api/targets/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: second.sessionToken },
      body: JSON.stringify({ repoId: reopened })
    })
    const rebuilt = RunHistoryResponseSchema.parse(await history.json())
    expect(rebuilt.runs.some((entry) => entry.runId === runId)).toBe(true)

    const replayed = await fetch(`${secondBase}/api/targets/runs/replay`, {
      method: "POST",
      headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: second.sessionToken },
      body: JSON.stringify({ runId })
    })
    expect(replayed.status).toBe(200)
    const parsed = RunReplayResponseSchema.parse(await replayed.json())
    expect(parsed.run.runId).toBe(runId)
    expect(parsed.events.length).toBeGreaterThan(0)
    expect(parsed.events.at(-1)?.type).toBe("exit")
  } finally {
    await second.stop()
    await rm(secondDist, { recursive: true, force: true })
  }
}, BUDGET)

test("the routes refuse a repository that is not open, and a body that is not one", async () => {
  for (const route of ["/api/targets/graph", "/api/targets/runs", "/api/targets/affected", "/api/targets/ci"]) {
    const missing = await post(route, { repoId: "not-open" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: "repo_not_found" } })

    const blank = await post(route, {})
    expect(blank.status).toBe(400)
    expect(await blank.json()).toMatchObject({ error: { code: "invalid_request" } })
  }
  /* Replay is keyed by run, not by repository. */
  const noRun = await post("/api/targets/runs/replay", { runId: "nope" })
  expect(noRun.status).toBe(404)
  expect(await noRun.json()).toMatchObject({ error: { code: "run_not_found" } })
  expect((await post("/api/targets/runs/replay", {})).status).toBe(400)
})

test("the replay route cannot be walked out of the runs directory", async () => {
  /*
   * A run id is a server-minted UUID and replay is a lookup in the store, not
   * a path join — so a traversal id has nothing to traverse. Asserted here
   * because the journal filename IS derived from the run id on the write
   * side, and a future refactor that reads by filename would reopen it.
   */
  for (const runId of [
    "../../../../etc/passwd",
    "..%2f..%2f..%2fetc%2fpasswd",
    "/etc/passwd",
    "run/../../../../../../etc/hosts"
  ]) {
    const response = await post("/api/targets/runs/replay", { runId })
    expect(response.status).toBe(404)
    const body = await response.text()
    expect(body).toContain("run_not_found")
    /* Nothing from the host filesystem comes back in the refusal. */
    expect(body).not.toContain("root:")
  }
})

test.skipIf(!haveReadWorkspace)("the graph route rejects labels that are not strings", async () => {
  const repoId = await openRepo(READ_WORKSPACE)
  for (const labels of [42, ["//src:typeCheck", 7], "not an array"]) {
    const response = await post("/api/targets/graph", { repoId, labels })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } })
  }
}, BUDGET)
