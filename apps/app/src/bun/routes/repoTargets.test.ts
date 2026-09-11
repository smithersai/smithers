import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReposResponseSchema, TargetRunMessageSchema, TargetsQueryResponseSchema } from "@smthrs/rpc/LocalApp"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { createRepositoryAuthority } from "../RepositoryAuthority"
import { Router } from "../routes"
import { registerRepoTargetRoutes } from "./repoTargets"
import { startLocalServer } from "../server"
import type { LocalServer } from "../server"

/*
 * The L3 HTTP routes and the target-run topic over a real local origin: a
 * temp workspace is opened, listed, queried and closed; a run streams its
 * frames over /ws after the client attaches. A fake build-cli (run by Bun in
 * place of Node) stands in for the loader so the suite needs no checkout.
 */

let dist = ""
let repoDir = ""
let plainDir = ""
let cli = ""
let server: LocalServer

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${server.origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: server.sessionToken },
    body: JSON.stringify(body)
  })

const get = (path: string): Promise<Response> =>
  fetch(`${server.origin}${path}`, { headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-l3-dist-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title>")
  repoDir = await realpath(await mkdtemp(join(tmpdir(), "smithers-l3-repo-")))
  expect(await Bun.spawn(["git", "init", "-q", repoDir]).exited).toBe(0)
  await mkdir(join(repoDir, ".smithers"))
  await writeFile(join(repoDir, ".smithers", "WORKSPACE.ts"), "import { Smithers as S } from \"@smthrs/targets\"\n")
  // A child workspace so the query route fans out and the run route validates.
  await mkdir(join(repoDir, "aomi-sdk", ".smithers"), { recursive: true })
  await writeFile(join(repoDir, "aomi-sdk", ".smithers", "WORKSPACE.ts"), "import { Smithers as S } from \"@smthrs/targets\"\n")
  plainDir = await realpath(await mkdtemp(join(tmpdir(), "smithers-l3-plain-")))
  cli = join(dist, "fake-cli.js")
  await writeFile(
    cli,
    [
      "const [verb] = process.argv.slice(2)",
      "if (verb === \"query\") {",
      "  const child = process.cwd().endsWith(\"aomi-sdk\")",
      "  const targets = child",
      "    ? [{ label: \"//src:sdkLint\", target: \"Shell.Test\", kinds: [\"lint\"] }]",
      "    : [{ label: \"//src:lint\", target: \"Shell.Test\", kinds: [\"lint\"] }, { label: \"//:fails\", target: \"Shell.Test\", kinds: [\"test\"] }]",
      "  console.log(JSON.stringify({ query: \"//...\", targets }))",
      "  process.exit(0)",
      "}",
      "if (verb === \"graph\") {",
      "  const child = process.cwd().endsWith(\"aomi-sdk\")",
      "  const labels = child ? [\"//src:sdkLint\"] : [\"//src:lint\", \"//:fails\"]",
      "  console.log(JSON.stringify({ graph: labels.join(\"\\n\"), targets: labels.map((label) => ({ label, target: \"Shell.Test\" })) }))",
      "  process.exit(0)",
      "}",
      "console.log(`ran ${verb} in ${process.cwd()}`)",
      "console.error(\"done\")",
      "process.exit(verb === \"//:fails\" ? 2 : 0)"
    ].join("\n")
  )
  server = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    allowManualRepositoryPaths: true,
    node: { path: process.execPath, version: "v22.19.0" },
    buildCli: cli,
    log: () => {}
  })
  // The fake loader runs under the loader sandbox on macOS; it reads nothing outside the repo.
})

afterAll(async () => {
  await server.stop()
  await rm(dist, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
  await rm(plainDir, { recursive: true, force: true })
})

describe("/api/repo/*", () => {
  test("native mode accepts only a fresh picker grant, exactly once", async () => {
    const secure = await startLocalServer({
      port: 0,
      distDir: dist,
      chatStub: true,
      node: { path: process.execPath, version: "v22.19.0" },
      buildCli: cli,
      log: () => {}
    })
    const securePost = (body: unknown): Promise<Response> => fetch(`${secure.origin}/api/repo/open`, {
      method: "POST",
      headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: secure.sessionToken },
      body: JSON.stringify(body)
    })
    try {
      expect((await securePost({ path: repoDir })).status).toBe(403)
      const selected = await secure.authorizeRepository(repoDir, "read-write")
      expect(selected.status).toBe("connected")
      if (selected.status !== "connected") return
      const authorizationId = selected.repository.authorizationId
      expect((await securePost({ authorizationId })).status).toBe(200)
      expect((await securePost({ authorizationId })).status).toBe(403)
    } finally {
      await secure.stop()
    }
  })

  test("open detects the workspace, list shows it, close removes it", async () => {
    const opened = await post("/api/repo/open", { path: repoDir })
    expect(opened.status).toBe(200)
    const { repo } = (await opened.json()) as { repo: { id: string; path: string; smithers: { detected: boolean } } }
    expect(repo.path).toBe(repoDir)
    expect(repo.smithers.detected).toBe(true)

    const plain = await post("/api/repo/open", { path: plainDir })
    expect(((await plain.json()) as { repo: { smithers: { detected: boolean; reason: string } } }).repo.smithers).toMatchObject({
      detected: false,
      reason: "no WORKSPACE.ts or smthrs legacy declaration"
    })

    const listed = ReposResponseSchema.parse(await (await get("/api/repos")).json())
    expect(listed.repos.map((entry) => entry.path)).toEqual([repoDir, plainDir])

    const closed = await post("/api/repo/close", { repoId: listed.repos[1]?.id })
    expect(await closed.json()).toEqual({ ok: true })
    expect(ReposResponseSchema.parse(await (await get("/api/repos")).json()).repos).toHaveLength(1)
    expect((await post("/api/repo/close", { repoId: "nope" })).status).toBe(404)
  })

  test("a bad path is a 400 with the error envelope", async () => {
    const missing = await post("/api/repo/open", { path: join(plainDir, "missing") })
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("invalid_path")
    expect((await post("/api/repo/open", {})).status).toBe(400)
  })
})

describe("/api/targets/*", () => {
  test("query fans out over the detected workspaces; an unknown repo is 404", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    const response = await post("/api/targets/query", { repoId: opened.repo.id })
    expect(response.status).toBe(200)
    const body = TargetsQueryResponseSchema.parse(await response.json())
    expect(body.warnings).toEqual([])
    expect(body.targets.map(({ id: _id, ...target }) => target)).toEqual([
      { label: "//src:lint", target: "Shell.Test", kinds: ["lint"], package: "//src", name: "lint", workspace: "." },
      { label: "//:fails", target: "Shell.Test", kinds: ["test"], package: "//", name: "fails", workspace: "." },
      { label: "//src:sdkLint", target: "Shell.Test", kinds: ["lint"], package: "//src", name: "sdkLint", workspace: "aomi-sdk" }
    ])
    expect(body.targets.every((target) => typeof target.id === "string" && target.id !== "")).toBe(true)
    expect((await post("/api/targets/query", { repoId: "nope" })).status).toBe(404)
  })

  test("a re-query of an unchanged repository keeps grant ids stable, so the first client's id still runs", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    const first = TargetsQueryResponseSchema.parse(await (await post("/api/targets/query", { repoId: opened.repo.id })).json())
    // A second tab queries the same unchanged repository.
    const second = TargetsQueryResponseSchema.parse(await (await post("/api/targets/query", { repoId: opened.repo.id })).json())
    const key = (target: { workspace: string; label: string }) => `${target.workspace} ${target.label}`
    const ids = new Map(first.targets.map((target) => [key(target), target.id]))
    for (const target of second.targets) expect(target.id).toBe(ids.get(key(target))!)

    // The first client's card id still resolves after the second query.
    const targetId = first.targets.find((target) => target.workspace === "." && target.label === "//src:lint")?.id
    expect(targetId).toBeDefined()
    const started = await post("/api/targets/run", { repoId: opened.repo.id, targetId })
    expect(started.status).toBe(200)
    const { runId } = (await started.json()) as { runId: string }
    expect(typeof runId).toBe("string")
    const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`, server.websocketProtocol)
    const finished = new Promise<number | null | undefined>((resolve) => {
      socket.onmessage = (event) => {
        const parsed = TargetRunMessageSchema.safeParse(JSON.parse(String(event.data)))
        if (!parsed.success || parsed.data.runId !== runId) return
        if (parsed.data.frame.type === "exit") resolve(parsed.data.frame.code)
      }
    })
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve()
    })
    socket.send(JSON.stringify({ type: "subscribe", topic: `target-run:${runId}` }))
    socket.send(JSON.stringify({ type: "target-run.attach", runId }))
    expect(await finished).toBe(0)
    socket.close()
  })

  test("an opaque grant preserves its server-owned child workspace", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    const queried = TargetsQueryResponseSchema.parse(
      await (await post("/api/targets/query", { repoId: opened.repo.id })).json()
    )
    const targetId = queried.targets.find(
      (target) => target.workspace === "aomi-sdk" && target.label === "//src:sdkLint"
    )?.id
    expect(targetId).toBeDefined()
    expect((await post("/api/targets/run", { repoId: opened.repo.id, targetId: "unknown" })).status).toBe(404)

    /*
     * Extra renderer-authored workspace/label fields cannot redirect the
     * process: the server resolves both from targetId.
     */
    const started = await post("/api/targets/run", {
      repoId: opened.repo.id,
      targetId,
      workspace: ".",
      label: "//:fails"
    })
    expect(started.status).toBe(200)
    const { runId } = (await started.json()) as { runId: string }
    const socket = new WebSocket(
      `${server.origin.replace("http", "ws")}/ws`,
      server.websocketProtocol
    )
    const frames: Array<{ type: string; data?: string; code?: number | null }> = []
    const finished = new Promise<void>((resolve) => {
      socket.onmessage = (event) => {
        const parsed = TargetRunMessageSchema.safeParse(JSON.parse(String(event.data)))
        if (!parsed.success || parsed.data.runId !== runId) return
        frames.push(parsed.data.frame)
        if (parsed.data.frame.type === "exit") resolve()
      }
    })
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve()
    })
    socket.send(JSON.stringify({ type: "subscribe", topic: `target-run:${runId}` }))
    socket.send(JSON.stringify({ type: "target-run.attach", runId }))
    await finished
    socket.close()
    expect(frames.filter((frame) => frame.type === "stdout").map((frame) => frame.data).join("")).toBe(
      `ran //src:sdkLint in ${join(repoDir, "aomi-sdk")}\n`
    )
    expect(frames[frames.length - 1]).toMatchObject({ type: "exit", code: 0 })
  })

  test("run streams stdout, stderr and exit on the topic once the client attaches; cancel answers", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    const queried = TargetsQueryResponseSchema.parse(await (await post("/api/targets/query", { repoId: opened.repo.id })).json())
    const targetId = queried.targets.find((target) => target.label === "//:fails")?.id
    expect(targetId).toBeDefined()
    const started = await post("/api/targets/run", { repoId: opened.repo.id, targetId })
    expect(started.status).toBe(200)
    const { runId } = (await started.json()) as { runId: string }

    const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`, server.websocketProtocol)
    const frames: Array<{ type: string; data?: string; code?: number | null; seq?: number }> = []
    const finished = new Promise<void>((resolve) => {
      socket.onmessage = (event) => {
        const parsed = TargetRunMessageSchema.safeParse(JSON.parse(String(event.data)))
        if (!parsed.success || parsed.data.runId !== runId) return
        frames.push(parsed.data.frame)
        if (parsed.data.frame.type === "exit") resolve()
      }
    })
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve()
    })
    socket.send(JSON.stringify({ type: "subscribe", topic: `target-run:${runId}` }))
    socket.send(JSON.stringify({ type: "target-run.attach", runId }))
    await finished
    socket.close()
    expect(frames.filter((frame) => frame.type === "stdout").map((frame) => frame.data).join("")).toBe(
      `ran //:fails in ${repoDir}\n`
    )
    expect(frames.filter((frame) => frame.type === "stderr").map((frame) => frame.data).join("")).toBe("done\n")
    /* The run-local seq the contract orders replay by reaches the client. */
    expect(frames.map((frame) => (frame as { seq?: number }).seq)).toEqual(frames.map((_frame, index) => index))
    expect(frames[frames.length - 1]).toMatchObject({ type: "exit", code: 2, seq: frames.length - 1 })
    expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index))

    expect(await (await post("/api/targets/cancel", { runId })).json()).toEqual({ ok: false })
    expect((await post("/api/targets/cancel", { runId: "nope" })).status).toBe(404)
    expect((await post("/api/targets/run", { repoId: "nope", targetId: "unknown" })).status).toBe(404)
    expect((await post("/api/targets/run", { repoId: opened.repo.id, targetId: "unknown" })).status).toBe(404)
    expect((await post("/api/targets/run", { repoId: opened.repo.id })).status).toBe(400)
  })
})

/*
 * One broken declaration anywhere in a checkout (a directory declared where
 * a file belongs) fails `graph //...`; a run must still start
 * from the target's own `graph <label>`, and when that fails too the refusal
 * names the loader's reason instead of a bare "could not be revalidated".
 */
describe("/api/targets/run revalidates against the target's own graph when the whole graph is broken", () => {
  let brokenDist = ""
  let brokenRepo = ""
  let broken: Awaited<ReturnType<typeof startLocalServer>>
  const brokenPost = (path: string, body: unknown): Promise<Response> =>
    fetch(`${broken.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: broken.sessionToken },
      body: JSON.stringify(body)
    })

  beforeAll(async () => {
    brokenDist = await mkdtemp(join(tmpdir(), "smithers-l3-broken-dist-"))
    await writeFile(join(brokenDist, "index.html"), "<!doctype html><title>Smithers</title>")
    brokenRepo = await realpath(await mkdtemp(join(tmpdir(), "smithers-l3-broken-repo-")))
    await writeFile(join(brokenRepo, "legacy declaration"), "import { Smithers as S } from \"@smthrs/targets\"\n")
    const cli = join(brokenDist, "fake-cli.js")
    await writeFile(
      cli,
      [
        "const [verb, pattern] = process.argv.slice(2)",
        "if (verb === \"query\") {",
        "  console.log(JSON.stringify({ query: \"//...\", targets: [{ label: \"//:ok\", target: \"Shell.Test\", kinds: [\"test\"] }, { label: \"//:doomed\", target: \"Shell.Test\", kinds: [\"test\"] }] }))",
        "  process.exit(0)",
        "}",
        "if (verb === \"graph\" && pattern === \"//...\") {",
        "  console.log(JSON.stringify({ code: \"graph_failed\", message: \"declared input is not a regular file: packages/smithers/flows/jj/wasm\" }))",
        "  process.exit(1)",
        "}",
        "if (verb === \"graph\" && pattern === \"//:ok\") {",
        "  console.log(JSON.stringify({ graph: \"//:ok (Shell.Test)\", targets: [{ label: \"//:ok\", target: \"Shell.Test\" }], edges: [] }))",
        "  process.exit(0)",
        "}",
        "if (verb === \"graph\") {",
        "  console.log(JSON.stringify({ code: \"graph_failed\", message: `no closure for ${pattern}` }))",
        "  process.exit(1)",
        "}",
        "console.log(`ran ${verb}`)",
        "process.exit(0)"
      ].join("\n")
    )
    broken = await startLocalServer({
      port: 0,
      distDir: brokenDist,
      chatStub: true,
      allowManualRepositoryPaths: true,
      node: { path: process.execPath, version: "v22.19.0" },
      buildCli: cli,
      log: () => {}
    })
  })

  afterAll(async () => {
    await broken.stop()
    await rm(brokenDist, { recursive: true, force: true })
    await rm(brokenRepo, { recursive: true, force: true })
  })

  test("a target whose own closure loads runs; one whose closure is broken is refused with the loader's reason", async () => {
    const opened = (await (await brokenPost("/api/repo/open", { path: brokenRepo })).json()) as { repo: { id: string } }
    const queried = TargetsQueryResponseSchema.parse(await (await brokenPost("/api/targets/query", { repoId: opened.repo.id })).json())
    const ok = queried.targets.find((target) => target.label === "//:ok")?.id
    const doomed = queried.targets.find((target) => target.label === "//:doomed")?.id
    expect(ok).toBeDefined()
    expect(doomed).toBeDefined()

    const started = await brokenPost("/api/targets/run", { repoId: opened.repo.id, targetId: ok })
    expect(started.status).toBe(200)
    expect(typeof ((await started.json()) as { runId: string }).runId).toBe("string")

    const refused = await brokenPost("/api/targets/run", { repoId: opened.repo.id, targetId: doomed })
    expect(refused.status).toBe(503)
    const body = (await refused.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("target_graph_unavailable")
    expect(body.error.message).toContain("graph_failed: no closure for //:doomed")
  })
})

/*
 * Pattern runs: `{ repoId, verb, pattern, workspace? }` runs the verb over
 * the pattern (`ci //packages/...`, how CI runs everything). The grammar is
 * the grant — a CLI verb and a `//dir/...` or label pattern — so no opaque
 * id is minted, and anything outside it is refused before argv exists.
 */
describe("/api/targets/run pattern runs", () => {
  test("a verb over a pattern spawns `<verb> <pattern> --ui plain` in the named workspace", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    const started = await post("/api/targets/run", { repoId: opened.repo.id, workspace: "aomi-sdk", verb: "ci", pattern: "//src/..." })
    expect(started.status).toBe(200)
    const { runId } = (await started.json()) as { runId: string }
    const socket = new WebSocket(`${server.origin.replace("http", "ws")}/ws`, server.websocketProtocol)
    const frames: Array<{ type: string; data?: string; label?: string; code?: number | null }> = []
    const finished = new Promise<void>((resolve) => {
      socket.onmessage = (event) => {
        const parsed = TargetRunMessageSchema.safeParse(JSON.parse(String(event.data)))
        if (!parsed.success || parsed.data.runId !== runId) return
        frames.push(parsed.data.frame)
        if (parsed.data.frame.type === "exit") resolve()
      }
    })
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve()
    })
    socket.send(JSON.stringify({ type: "subscribe", topic: `target-run:${runId}` }))
    socket.send(JSON.stringify({ type: "target-run.attach", runId }))
    await finished
    socket.close()
    expect(frames.find((frame) => frame.type === "started")).toMatchObject({ label: "ci //src/...", labels: ["//src/..."] })
    expect(frames.filter((frame) => frame.type === "stdout").map((frame) => frame.data).join("")).toBe(
      `ran ci in ${join(repoDir, "aomi-sdk")}\n`
    )
    expect(frames[frames.length - 1]).toMatchObject({ type: "exit", code: 0 })
    // The recording carries the pattern run under its `<verb> <pattern>` label.
    const runs = (await (await post("/api/targets/runs", { repoId: opened.repo.id })).json()) as { runs: Array<{ runId: string; label: string }> }
    expect(runs.runs.find((run) => run.runId === runId)?.label).toBe("ci //src/...")
  })

  test("a verb the CLI lacks, a pattern outside the grammar, or an unopened workspace is refused", async () => {
    const opened = (await (await post("/api/repo/open", { path: repoDir })).json()) as { repo: { id: string } }
    expect((await post("/api/targets/run", { repoId: opened.repo.id, verb: "rm", pattern: "//..." })).status).toBe(400)
    expect((await post("/api/targets/run", { repoId: opened.repo.id, verb: "ci", pattern: "//packages; rm -rf /" })).status).toBe(400)
    expect((await post("/api/targets/run", { repoId: opened.repo.id, verb: "ci", pattern: "packages/..." })).status).toBe(400)
    expect((await post("/api/targets/run", { repoId: opened.repo.id, verb: "ci", pattern: "//...", extra: 1 })).status).toBe(400)
    expect((await post("/api/targets/run", { repoId: opened.repo.id, verb: "ci", pattern: "//...", workspace: "elsewhere" })).status).toBe(409)
    expect((await post("/api/targets/run", { repoId: "nope", verb: "ci", pattern: "//..." })).status).toBe(404)
  })
})

for (const kind of ["pattern", "targetId"] as const) {
  test(`${kind} journal initialization failure never spawns and releases the run`, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-journal-failure-")))
    const router = new Router()
    const routes = registerRepoTargetRoutes({ router, publish: () => {}, onMessage: () => () => {} }, {
      node: Promise.resolve({ path: process.execPath, version: "v22.19.0" }),
      authority: createRepositoryAuthority(),
      allowManualRepositoryPaths: true,
      cli
    })
    const request = async (path: string, body: unknown): Promise<Response> => {
      const route = router.match("POST", path)!
      const request = new Request(`http://localhost${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      })
      return route.handler({ request, url: new URL(request.url), params: route.params })
    }
    const initialize = spyOn(routes.history, "start")
    const spawn = spyOn(Bun, "spawn")
    try {
      await mkdir(join(dir, ".smithers"))
      await writeFile(join(dir, ".smithers", "WORKSPACE.ts"), "export const Workspace = {}")
      await mkdir(join(dir, ".flows"))
      // A file is a deterministic ENOTDIR even when the test runs as root.
      await writeFile(join(dir, ".flows", "ui"), "not a directory")
      await routes.restored
      const { repo } = await (await request("/api/repo/open", { path: dir })).json() as { repo: { id: string } }
      const queried = TargetsQueryResponseSchema.parse(await (await request("/api/targets/query", { repoId: repo.id })).json())
      const body = kind === "pattern"
        ? { repoId: repo.id, verb: "test", pattern: "//..." }
        : { repoId: repo.id, targetId: queried.targets[0]!.id }
      spawn.mockClear()
      // The host converts this rejected handler into HTTP 500.
      await expect(request("/api/targets/run", body)).rejects.toThrow("ENOTDIR")
      expect(initialize).toHaveBeenCalledTimes(1)
      const run = initialize.mock.calls[0]![0]
      await Bun.sleep(1200) // Beyond the production runner's one-second auto-start.
      expect(spawn.mock.calls.filter(([argv]) => Array.isArray(argv) && argv[1] === cli && argv[2] !== "graph")).toHaveLength(0)
      expect(routes.runner.get(run.runId)).toBeUndefined()
      expect(await routes.history.replay(run.runId)).toBeUndefined()
    } finally {
      await routes.stop()
      initialize.mockRestore()
      spawn.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })
}

for (const boundary of ["cancel", "stop"] as const) {
  test(`${boundary} waits for child reaping before flushing history and resolving`, async () => {
    const router = new Router()
    const routes = registerRepoTargetRoutes({ router, publish: () => {}, onMessage: () => () => {} }, {
      node: Promise.resolve(null), authority: createRepositoryAuthority()
    })
    await routes.restored
    const run = routes.runner.reserve({ repoId: "r", repo: repoDir, workspace: ".", label: "//:x", node: { path: process.execPath, version: "v22.19.0" } })
    const reaped = Promise.withResolvers<void>()
    const flushed = Promise.withResolvers<void>()
    const cancel = spyOn(routes.runner, "cancel").mockImplementation(async () => { await reaped.promise; return true })
    const stop = spyOn(routes.runner, "stop").mockImplementation(() => reaped.promise)
    const flush = spyOn(routes.history, "flush").mockImplementation(() => flushed.promise)
    try {
      const route = router.match("POST", "/api/targets/cancel")!
      const request = new Request("http://localhost/api/targets/cancel", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: run.runId })
      })
      let resolved = false
      const closing = Promise.resolve(boundary === "stop" ? routes.stop() : route.handler({ request, url: new URL(request.url), params: route.params })).then(() => { resolved = true })
      await Bun.sleep(10)
      expect(resolved).toBe(false)
      expect(flush).not.toHaveBeenCalled()
      reaped.resolve()
      await Bun.sleep(10)
      expect(flush).toHaveBeenCalledTimes(1)
      expect(resolved).toBe(false)
      flushed.resolve()
      await closing
      expect(resolved).toBe(true)
    } finally {
      reaped.resolve()
      flushed.resolve()
      cancel.mockRestore()
      stop.mockRestore()
      flush.mockRestore()
      await routes.runner.stop()
      await routes.stop()
    }
  })
}

test("server stop reaps a running target and persists its exit before resolving", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-target-shutdown-")))
  const loader = join(dir, "stubborn.js")
  const pidFile = join(dir, "pid")
  await writeFile(join(dir, "index.html"), "fixture")
  await writeFile(join(dir, "WORKSPACE.ts"), "export default {}")
  await writeFile(loader, `
    process.on("SIGTERM", () => {})
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
    console.log("ready")
    setInterval(() => {}, 1000)
  `)
  const host = await startLocalServer({
    port: 0, distDir: dir, home: dir, stateDir: join(dir, "state"),
    chatStub: true, allowManualRepositoryPaths: true,
    node: { path: process.execPath, version: "v22.19.0" }, buildCli: loader, harnesses: async () => []
  })
  const request = async (path: string, body: unknown) => {
    const response = await fetch(host.origin + path, { method: "POST",
      headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: host.sessionToken }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    return response.json()
  }
  let pid: number | undefined
  try {
    const { repo } = await request("/api/repo/open", { path: dir }) as { repo: { id: string } }
    const { runId } = await request("/api/targets/run", { repoId: repo.id, verb: "ci", pattern: "//..." }) as { runId: string }
    for (let i = 0; i < 500; i++) {
      const value = await readFile(pidFile, "utf8").catch(() => "")
      if (value !== "") { pid = Number(value); break }
      await Bun.sleep(10)
    }
    expect(pid).toBeDefined()
    await host.stop()
    expect(() => process.kill(pid!, 0)).toThrow()
    const journal = (await readFile(join(dir, ".flows", "ui", "runs", `${runId}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(journal.some((line) => line.type === "event" && line.event.type === "exit")).toBe(true)
    expect(journal.at(-1)).toMatchObject({ type: "record", record: { status: "failed" } })
  } finally {
    if (pid !== undefined) { try { process.kill(pid, "SIGKILL") } catch {} }
    await host.stop()
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)
