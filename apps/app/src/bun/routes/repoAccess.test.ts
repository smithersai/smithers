import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRepositoryAuthority } from "../RepositoryAuthority"
import { createTargetRunner } from "../Targets"
import { Router } from "../routes"
import { registerRepoTargetRoutes } from "./repoTargets"
import { registerPtyRoutes } from "./pty"
import type { PtyManager } from "../Pty"

for (const disconnect of [false, true]) {
  test(`${disconnect ? "disconnect" : "read-only"} revokes host processes and survives restart`, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-repo-access-")))
    const router = new Router()
    const host = { router, publish: () => {}, onMessage: () => () => {} }
    const sessions = new Map<string, { sessionId: string; cwd: string }>()
    let sequence = 0
    const manager = {
      create: async ({ cwd }: { cwd: string }) => {
        const session = { sessionId: `pty-${++sequence}`, cwd }
        sessions.set(session.sessionId, session)
        return { status: "ok", session }
      },
      kill: async (id: string) => sessions.delete(id),
      list: () => [...sessions.values()]
    } as unknown as PtyManager
    const options = { node: Promise.resolve(null), authority: createRepositoryAuthority(), allowManualRepositoryPaths: true, stateDir: dir,
      onRepoAccessRevoked: (repoId: string) => ptys.revokeRepo(repoId)
    }
    const routes = registerRepoTargetRoutes(host, options)
    const ptys = registerPtyRoutes(host, manager, { resolveRepo: (id) => routes.resolveRepo(id, "read-write") })
    const post = async (path: string, body: unknown) => {
      const route = router.match("POST", path)
      if (!route) return new Response(null, { status: 404 })
      const request = new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      return route.handler({ request, url: new URL(request.url), params: route.params })
    }
    try {
      await routes.restored
      const opened = await post("/api/repo/open", { path: dir })
      const { repo } = await opened.json() as { repo: { id: string } }
      expect((await post("/api/pty", { repoId: repo.id, kind: "terminal", cols: 80, rows: 24 })).status).toBe(201)
      const pending = routes.runner.start({ repoId: repo.id, repo: dir, workspace: ".", label: "//:test", node: { path: process.execPath, version: "v22.19.0" } })
      expect((await post(disconnect ? "/api/repo/close" : "/api/repo/access", { repoId: repo.id, ...(disconnect ? {} : { access: "read" }) })).status).toBe(200)
      expect(sessions.size).toBe(0)
      expect(pending.status).toBe("failed")
      expect(routes.resolveRepo(repo.id, "read-write").status).toBe(disconnect ? "not-found" : "permission-denied")
      expect((await post("/api/pty", { repoId: repo.id, kind: "terminal", cols: 80, rows: 24 })).status).toBe(disconnect ? 404 : 403)
      expect((await post("/api/targets/run", { repoId: repo.id, verb: "ci", pattern: "//..." })).status).toBe(disconnect ? 404 : 403)
      const saved = JSON.parse(await readFile(join(dir, "repositories.json"), "utf8"))
      expect(saved.repositories).toEqual(disconnect ? [] : [{ path: dir, access: "read" }])
      if (!disconnect) expect((await post("/api/repo/access", { repoId: repo.id, access: "read-write" })).status).toBe(400)
      await routes.stop()
      const restored = registerRepoTargetRoutes({ ...host, router: new Router() }, { ...options, onRepoAccessRevoked: undefined })
      await restored.restored
      expect(restored.repos.list()).toHaveLength(disconnect ? 0 : 1)
      if (!disconnect) expect(restored.resolveRepo(restored.repos.list()[0]!.id, "read-write").status).toBe("permission-denied")
      await restored.stop()
    } finally {
      await routes.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test("revocation waits for and kills a PTY whose creation was already pending", async () => {
  const router = new Router()
  let access = true
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const killed: string[] = []
  const manager = {
    create: async () => {
      entered.resolve()
      await finish.promise
      return { status: "ok", session: { sessionId: "pending" } }
    },
    kill: async (id: string) => { killed.push(id); return true }
  } as unknown as PtyManager
  const ptys = registerPtyRoutes({ router, onMessage: () => () => {} }, manager, {
    resolveRepo: () => access ? { status: "ok", path: "/tmp" } : { status: "permission-denied" }
  })
  const request = new Request("http://localhost/api/pty", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoId: "repo", kind: "terminal", cols: 80, rows: 24 }) })
  const creating = router.match("POST", "/api/pty")!.handler({ request, url: new URL(request.url), params: {} })
  await entered.promise
  access = false
  let revoked = false
  const revoking = ptys.revokeRepo("repo").then(() => { revoked = true })
  await Promise.resolve()
  expect(revoked).toBe(false)
  finish.resolve()
  expect((await creating).status).toBe(403)
  await revoking
  expect(killed).toEqual(["pending"])
})

for (const disconnect of [false, true]) {
  test(`failed revocation persistence is reported and retryable (${disconnect})`, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-repo-save-")))
    const router = new Router()
    const routes = registerRepoTargetRoutes({ router, publish: () => {}, onMessage: () => () => {} }, {
      node: Promise.resolve(null), authority: createRepositoryAuthority(), allowManualRepositoryPaths: true, stateDir: dir
    })
    const post = async (path: string, body: unknown) => {
      const request = new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      return router.match("POST", path)!.handler({ request, url: new URL(request.url), params: {} })
    }
    try {
      await routes.restored
      const { repo } = await (await post("/api/repo/open", { path: dir })).json() as { repo: { id: string } }
      // A directory at the destination causes an atomic replacement to fail.
      await rm(join(dir, "repositories.json"))
      await mkdir(join(dir, "repositories.json"))
      const path = disconnect ? "/api/repo/close" : "/api/repo/access"
      const body = { repoId: repo.id, ...(disconnect ? {} : { access: "read" }) }
      expect((await post(path, body)).status).toBe(500)
      expect(routes.resolveRepo(repo.id, "read-write").status).toBe("permission-denied")
      expect(routes.repos.get(repo.id)).toBeDefined()
      await rm(join(dir, "repositories.json"), { recursive: true })
      expect((await post(path, body)).status).toBe(200)
      expect(JSON.parse(await readFile(join(dir, "repositories.json"), "utf8")).repositories).toEqual(disconnect ? [] : [{ path: dir, access: "read" }])
    } finally {
      await routes.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test("a target waiting for its runtime cannot start after revocation", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-target-revoke-")))
  await writeFile(join(dir, "WORKSPACE.ts"), 'import { Smithers } from "@smthrs/targets"\n')
  const router = new Router()
  const node = Promise.withResolvers<{ path: string; version: string }>()
  const routes = registerRepoTargetRoutes({ router, publish: () => {}, onMessage: () => () => {} }, {
    node: node.promise, authority: createRepositoryAuthority(), allowManualRepositoryPaths: true
  })
  const post = async (path: string, body: unknown) => {
    const request = new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    return router.match("POST", path)!.handler({ request, url: new URL(request.url), params: {} })
  }
  try {
    const { repo } = await (await post("/api/repo/open", { path: dir })).json() as { repo: { id: string } }
    const running = post("/api/targets/run", { repoId: repo.id, verb: "ci", pattern: "//..." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await post("/api/repo/access", { repoId: repo.id, access: "read" })).status).toBe(200)
    node.resolve({ path: process.execPath, version: "v22.19.0" })
    expect((await running).status).toBe(403)
  } finally {
    await routes.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("revocation terminates a running target child and leaves another repository alone", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "smithers-running-revoke-")))
  const cli = join(dir, "waiting.js")
  await writeFile(cli, 'console.log("ready"); setInterval(() => {}, 1000)\n')
  const ready = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<void>()
  const runner = createTargetRunner({ cli, autoStartMs: 60_000, publish: (_topic, message) => {
    const event = message as { frame: { type: string } }
    if (event.frame.type === "stdout") ready.resolve()
    if (event.frame.type === "exit") exited.resolve()
  } })
  try {
    const run = runner.start({ repoId: "repo", repo: dir, workspace: ".", label: "//:wait", node: { path: process.execPath, version: "v22.19.0" } })
    const other = runner.start({ repoId: "other", repo: dir, workspace: ".", label: "//:wait", node: { path: process.execPath, version: "v22.19.0" } })
    runner.attach(run.runId)
    await ready.promise
    expect(run.status).toBe("running")
    await runner.revokeRepo("repo")
    await exited.promise
    expect(run.status).toBe("failed")
    expect(other.status).toBe("pending")
  } finally {
    runner.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
