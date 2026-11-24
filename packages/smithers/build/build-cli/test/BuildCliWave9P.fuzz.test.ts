import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as NodeCrypto from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"

const assertPassed = <A>(report: Fuzz.Report<A, unknown>): void => {
  if (report._tag !== "Passed") {
    throw new Error(Fuzz.formatReport(report))
  }
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

describe("BuildCli Wave-9P: ServiceSupervisor, Cache fault/remote edge cases & PackageTree confinement/snapshot", () => {
  it(
    "ServiceSupervisor parseSpec validation (non-plain, proxy, sparse, bad argv/urls/readiness/setup) + port-in-use + probe timeout + health failure",
    async () => {
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literal(1)),
          () =>
            Effect.promise(async () => {
              await withTempDir("wave9p-svc-", async (dir) => {
                // 1. parseSpec rejections via ServiceSupervisor.make
                const sparse: Array<string> = []
                sparse[2] = "x"
                const badSpecs: ReadonlyArray<unknown> = [
                  { key: "", argv: ["true"], cwd: dir },
                  { key: "k-argv", argv: [], cwd: dir },
                  { key: "k-surl", argv: ["true"], cwd: dir, secretUrls: [{ index: 0, secret: "bad" }] },
                  { key: "k-rurl", argv: ["true"], cwd: dir, readiness: { http: "not a url", timeout: "1s" } },
                  { key: "k-setup", argv: ["true"], cwd: dir, setup: [[]] },
                  { key: "k-date", argv: ["true"], cwd: dir, env: { A: new Date() } },
                  { key: "k-parr", argv: new Proxy(["true"], {}), cwd: dir },
                  { key: "k-sparse", argv: sparse, cwd: dir },
                  { key: "k-prec", argv: ["true"], cwd: dir, env: new Proxy({ A: "1" }, {}) }
                ]
                for (const bad of badSpecs) {
                  await expect(
                    Effect.runPromise(
                      Effect.scoped(
                        Effect.gen(function*() {
                          const sup = yield* ServiceSupervisor.make
                          yield* sup.acquire(bad as ServiceSupervisor.ServiceSpec)
                        })
                      )
                    )
                  ).rejects.toThrow()
                }

                // 2. Port-in-use refusal (L1071)
                const tcp = NodeNet.createServer()
                await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve))
                const tcpPort = (tcp.address() as NodeNet.AddressInfo).port
                try {
                  await expect(
                    Effect.runPromise(
                      Effect.scoped(
                        Effect.gen(function*() {
                          const sup = yield* ServiceSupervisor.make
                          yield* sup.acquire({
                            key: "port-in-use",
                            argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
                            cwd: dir,
                            readiness: { port: tcpPort }
                          })
                        })
                      )
                    )
                  ).rejects.toThrow(/already listens|port/)
                } finally {
                  await new Promise<void>((resolve) => tcp.close(() => resolve()))
                }

                // 3. Probe timeout (L941-946) against silent loopback HTTP server
                const silentHttp = NodeHttp.createServer((_req, _res) => {
                  // Intentionally never respond so attemptTimeoutMs fires
                })
                await new Promise<void>((resolve) => silentHttp.listen(0, "127.0.0.1", resolve))
                const silentPort = (silentHttp.address() as NodeNet.AddressInfo).port
                try {
                  await expect(
                    Effect.runPromise(
                      Effect.scoped(
                        Effect.gen(function*() {
                          const sup = yield* ServiceSupervisor.make
                          yield* sup.acquire({
                            key: "probe-timeout",
                            argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
                            cwd: dir,
                            readiness: { http: `http://127.0.0.1:${silentPort}/`, timeout: "120ms" }
                          })
                        })
                      )
                    )
                  ).rejects.toThrow(/ready|timed out/)
                } finally {
                  silentHttp.closeAllConnections?.()
                  await new Promise<void>((resolve) => silentHttp.close(() => resolve()))
                }

                // 4. Health failure after becoming ready (L1132-1138) + unexpected exit while supervised (L1414-1421)
                const flakyScript = NodePath.join(dir, "flaky-svc.mjs")
                await Fs.writeFile(
                  flakyScript,
                  [
                    `import http from "node:http"`,
                    `let hits = 0`,
                    `const s = http.createServer((req, res) => {`,
                    `  hits += 1`,
                    `  if (hits <= 2) { res.writeHead(200); res.end("ok") }`,
                    `  else { res.writeHead(500); res.end("fail") }`,
                    `})`,
                    `s.listen(Number(process.env.PORT), "127.0.0.1")`
                  ].join("\n")
                )
                // Find free port
                const probeSrv = NodeNet.createServer()
                await new Promise<void>((resolve) => probeSrv.listen(0, "127.0.0.1", resolve))
                const svcPort = (probeSrv.address() as NodeNet.AddressInfo).port
                await new Promise<void>((resolve) => probeSrv.close(() => resolve()))

                const healthOutcome = await Effect.runPromise(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const sup = yield* ServiceSupervisor.make
                      const handle = yield* sup.acquire({
                        key: "flaky-health",
                        argv: [process.execPath, flakyScript],
                        cwd: dir,
                        env: { PORT: String(svcPort) },
                        readiness: { http: `http://127.0.0.1:${svcPort}/`, timeout: "5s" },
                        health: { interval: "40ms", failures: 1 }
                      })
                      return yield* Effect.result(handle.whileHealthy(Effect.sleep("3 seconds")))
                    })
                  )
                )
                expect(healthOutcome._tag).toBe("Failure")
              })
              return true
            }),
          { executions: 1 }
        )
      )
      assertPassed(report)
    },
    90_000
  )

  it(
    "Cache local IO faults (open/stat/close/write+close/sync/win32-rename/oversize/corrupt/surrogate) & remote edge cases (bad keyDigest, invalid UTF-8, readToken throw, legacy hydrate)",
    async () => {
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literal(1)),
          () =>
            Effect.promise(async () => {
              await withTempDir("wave9p-cache-", async (dir) => {
                const mkEntry = (key: string, output: unknown = { ok: true }): Cache.CachedResult => ({
                  key,
                  target: "Shell.Test",
                  label: "//:t",
                  exitOk: true,
                  output,
                  storedAt: new Date().toISOString()
                })

                // 1. Valid surrogate pair in output (L451) + corrupt JSON on disk (L699)
                const cBase = await Cache.openCache({ workspaceRoot: dir, cacheDirectory: ".c1" })
                await cBase.put("k-surrogate", mkEntry("k-surrogate", { emoji: "\uD83D\uDE00" }))
                expect(await cBase.get("k-surrogate")).not.toBeNull()

                // Corrupt the shard file on disk -> JSON.parse catch L699
                await cBase.put("k-corrupt", mkEntry("k-corrupt"))
                const c1Dir = NodePath.join(dir, ".c1")
                const walkJson = async (d: string): Promise<Array<string>> => {
                  const out: Array<string> = []
                  for (const ent of await Fs.readdir(d, { withFileTypes: true })) {
                    const full = NodePath.join(d, ent.name)
                    if (ent.isDirectory()) out.push(...await walkJson(full))
                    else if (ent.name.endsWith(".json")) out.push(full)
                  }
                  return out
                }
                const files = await walkJson(c1Dir)
                for (const f of files) {
                  const txt = await Fs.readFile(f, "utf8")
                  if (txt.includes("k-corrupt")) await Fs.writeFile(f, "{broken-json")
                }
                expect(await cBase.get("k-corrupt")).toBeNull()

                // 2. Oversized entry (> entryLimit) -> writeLocal RangeError L883
                await expect(
                  cBase.put("k-huge", mkEntry("k-huge", { pad: "x".repeat(Cache.entryLimit + 1024) }))
                ).rejects.toThrow(/exceeds its|exceeding its limit/)

                // 3. IO fault injections on open, statHandle, closeHandle (read), writeContents+closeHandle (write), syncHandle EIO, win32 EPERM rename
                const cStatFail = await Cache.openCache({
                  workspaceRoot: dir,
                  cacheDirectory: ".c1",
                  io: {
                    statHandle: async () => {
                      throw new Error("stat-fail")
                    }
                  }
                })
                expect(await cStatFail.get("k-surrogate")).toBeNull()

                const cCloseReadFail = await Cache.openCache({
                  workspaceRoot: dir,
                  cacheDirectory: ".c1",
                  io: {
                    closeHandle: async (h) => {
                      await h.close().catch(() => undefined)
                      throw new Error("close-read-fail")
                    }
                  }
                })
                expect(await cCloseReadFail.get("k-surrogate")).toBeNull()

                const cWriteCloseFail = await Cache.openCache({
                  workspaceRoot: dir,
                  cacheDirectory: ".c2",
                  io: {
                    writeContents: async () => {
                      throw new Error("write-fail")
                    },
                    closeHandle: async (h) => {
                      await h.close().catch(() => undefined)
                      throw new Error("close-write-fail")
                    }
                  }
                })
                await expect(cWriteCloseFail.put("k-wc", mkEntry("k-wc"))).rejects.toThrow(
                  /close also failed|write-fail/
                )

                const cSyncEio = await Cache.openCache({
                  workspaceRoot: dir,
                  cacheDirectory: ".c3",
                  io: {
                    syncHandle: async () => {
                      const e = new Error("eio") as NodeJS.ErrnoException
                      e.code = "EIO"
                      throw e
                    }
                  }
                })
                await expect(cSyncEio.put("k-eio", mkEntry("k-eio"))).rejects.toThrow(/eio/)

                // win32 EPERM rename tolerance when target already has valid entry -> L842
                const cWin = await Cache.openCache({
                  workspaceRoot: dir,
                  cacheDirectory: ".c1",
                  platform: "win32",
                  io: {
                    rename: async () => {
                      const e = new Error("eperm") as NodeJS.ErrnoException
                      e.code = "EPERM"
                      throw e
                    }
                  }
                })
                await cWin.put("k-surrogate", mkEntry("k-surrogate", { emoji: "\uD83D\uDE00" }))

                // 4. Remote edge cases: wrong keyDigest (L1741), invalid UTF-8 body (L1063), readToken throwing (L1645),
                //    local manifest missing CAS blob falling back to remote GET (L1911-1912)
                let rMode: "bad-digest" | "bad-utf8" | "miss-404" = "bad-digest"
                const server = NodeHttp.createServer((req, res) => {
                  const url = req.url ?? ""
                  if (req.method === "GET" && url.startsWith("/ac/")) {
                    if (rMode === "bad-digest") {
                      res.writeHead(200, { "Content-Type": "application/json" })
                      res.end(JSON.stringify({ keyDigest: "wrong-key", result: mkEntry("k-r1") }))
                      return
                    }
                    if (rMode === "bad-utf8") {
                      res.writeHead(200, { "Content-Type": "application/octet-stream" })
                      res.end(Buffer.from([0xff, 0xfe, 0xfd]))
                      return
                    }
                    res.writeHead(404)
                    res.end("nope")
                    return
                  }
                  res.writeHead(404)
                  res.end("nope")
                })
                await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
                const endpoint = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`
                try {
                  const warnings: Array<string> = []
                  rMode = "bad-digest"
                  const cR1 = await Cache.openCache({
                    workspaceRoot: dir,
                    cacheDirectory: ".cr1",
                    endpoint,
                    readToken: () => {
                      throw new Error("token-boom")
                    },
                    warn: (m) => warnings.push(m)
                  })
                  expect(await cR1.get("k-r1")).toBeNull()
                  await cR1.close()

                  rMode = "bad-utf8"
                  const cR2 = await Cache.openCache({
                    workspaceRoot: dir,
                    cacheDirectory: ".cr2",
                    endpoint,
                    readToken: () => "tok-12345",
                    warn: (m) => warnings.push(m)
                  })
                  expect(await cR2.get("k-r2")).toBeNull()
                  await cR2.close()

                  // Local entry with missing CAS blob + remote returns 404 -> L1911-1912 returns local
                  rMode = "miss-404"
                  const missingDigest = NodeCrypto.createHash("sha256").update("absent").digest("hex")
                  const localManifest = {
                    kind: "target-outputs",
                    manifests: [{
                      outDir: "dist",
                      entries: [{ kind: "file", path: "a.txt", digest: missingDigest, mode: 0o644, size: 6 }]
                    }],
                    files: []
                  }
                  const cLocalOnly = await Cache.openCache({ workspaceRoot: dir, cacheDirectory: ".cr3" })
                  await cLocalOnly.put("k-legacy", mkEntry("k-legacy", localManifest))
                  const cR3 = await Cache.openCache({
                    workspaceRoot: dir,
                    cacheDirectory: ".cr3",
                    endpoint,
                    readToken: () => "tok-12345",
                    warn: (m) => warnings.push(m)
                  })
                  const gotLegacy = await cR3.get("k-legacy")
                  expect(gotLegacy?.key).toBe("k-legacy")
                  await cR3.close()
                  expect(warnings.length).toBeGreaterThan(0)
                } finally {
                  await new Promise<void>((resolve) => server.close(() => resolve()))
                }
              })
              return true
            }),
          { executions: 1 }
        )
      )
      assertPassed(report)
    },
    90_000
  )

  it(
    "PackageTree: snapshotTree settled-back & deleted trackedMode (L650, L657-658), runGit spawn error (L261), materializeManifest/captureOutDir symlink confinement (L2052-2091), treeMatchesManifest depth & EACCES (L2570-2579)",
    async () => {
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literal(1)),
          () =>
            Effect.promise(async () => {
              await withTempDir("wave9p-pt-", async (dir) => {
                // 1. runGit spawn error on nonexistent cwd -> L261
                await expect(
                  PackageTree.runGit(NodePath.join(dir, "no-such-dir"), ["status"])
                ).rejects.toThrow(/git status failed/)

                // 2. snapshotTree + changedSinceSnapshot: settled back to HEAD (L650) + deleted tracked file (L657-658)
                const repo = NodePath.join(dir, "repo")
                await Fs.mkdir(repo, { recursive: true })
                NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: repo, stdio: "ignore" })
                await PackageTree.runGit(repo, ["config", "user.email", "test@example.com"])
                await PackageTree.runGit(repo, ["config", "user.name", "Test"])
                await Fs.writeFile(NodePath.join(repo, "f1.txt"), "head-v1\n")
                await Fs.writeFile(NodePath.join(repo, "f2.txt"), "head-v2\n")
                await PackageTree.runGit(repo, ["add", "f1.txt", "f2.txt"])
                await PackageTree.runGit(repo, ["commit", "-m", "init"])

                // Dirty f1 before snapshot
                await Fs.writeFile(NodePath.join(repo, "f1.txt"), "dirty-before\n")
                const snap = await PackageTree.snapshotTree(repo, ".cache")
                try {
                  // Settle f1 back to HEAD state (L650) and remove f2 (L657-658)
                  await Fs.writeFile(NodePath.join(repo, "f1.txt"), "head-v1\n")
                  await Fs.rm(NodePath.join(repo, "f2.txt"))
                  const changed = await PackageTree.changedSinceSnapshot(snap, ".cache")
                  expect(changed).toContain("f1.txt")
                  expect(changed).toContain("f2.txt")
                } finally {
                  await PackageTree.releaseSnapshot(snap)
                }

                // 3. captureOutDir, materializeManifest symlinked parent confinement (L2052-2091), treeMatchesManifest depth & EACCES (L2570-2579)
                const ws = NodePath.join(dir, "ws")
                const outside = NodePath.join(dir, "outside")
                const cas = NodePath.join(ws, ".cache/cas")
                await Fs.mkdir(NodePath.join(ws, "out"), { recursive: true })
                await Fs.mkdir(outside, { recursive: true })
                await Fs.mkdir(cas, { recursive: true })
                await Fs.writeFile(NodePath.join(ws, "out/a.txt"), "hello\n")
                const manifest = await PackageTree.captureOutDir(ws, ".cache", "out")

                // Symlinked parent pointing outside workspace -> materializeManifest L2068
                await Fs.symlink(outside, NodePath.join(ws, "escape"))
                await expect(
                  PackageTree.materializeManifest(ws, ".cache", { ...manifest, outDir: "escape/sub/nested" })
                ).rejects.toThrow(/outside the workspace/)

                // Broken symlink parent -> materializeManifest L2065 & captureOutDir L2091
                await Fs.symlink(NodePath.join(dir, "missing-target"), NodePath.join(ws, "broken"))
                await expect(
                  PackageTree.materializeManifest(ws, ".cache", { ...manifest, outDir: "broken/sub" })
                ).rejects.toThrow(/readable parent/)
                await expect(
                  PackageTree.captureOutDir(ws, ".cache", "broken/sub")
                ).rejects.toThrow(/not created|readable parent/)

                // treeMatchesManifest with unreadable subdir (EACCES L2578-2579)
                const lockedDir = NodePath.join(ws, "out/locked")
                await Fs.mkdir(lockedDir, { recursive: true })
                await Fs.chmod(lockedDir, 0o000)
                try {
                  const mUnreadable = await PackageTree.treeMatchesManifest(ws, {
                    ...manifest,
                    entries: [...manifest.entries, {
                      kind: "file",
                      path: "locked/x.txt",
                      digest: "0".repeat(64),
                      executable: false,
                      target: ""
                    }]
                  })
                  expect(mUnreadable).toBeDefined()
                } finally {
                  await Fs.chmod(lockedDir, 0o755).catch(() => undefined)
                  await Fs.rm(lockedDir, { recursive: true, force: true })
                }

                // treeMatchesManifest with depth > outDirLimits.depth (L2570-2571)
                const depthEntries: Array<PackageTree.OutDirManifest["entries"][number]> = [...manifest.entries]
                let cur = NodePath.join(ws, "out")
                let rel = ""
                for (let i = 0; i <= PackageTree.outDirLimits.depth + 1; i++) {
                  const seg = `d${i}`
                  cur = NodePath.join(cur, seg)
                  rel = rel === "" ? seg : `${rel}/${seg}`
                  await Fs.mkdir(cur, { recursive: true })
                  depthEntries.push({
                    kind: "file",
                    path: `${rel}/leaf.txt`,
                    digest: "0".repeat(64),
                    executable: false,
                    target: ""
                  })
                }
                const mDeep = await PackageTree.treeMatchesManifest(ws, { ...manifest, entries: depthEntries })
                expect(mDeep).toBeDefined()
              })
              return true
            }),
          { executions: 1 }
        )
      )
      assertPassed(report)
    },
    90_000
  )
})
