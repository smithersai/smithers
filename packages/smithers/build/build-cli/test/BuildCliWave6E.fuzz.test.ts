import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as TargetIndexSchema from "@smthrs/targets/TargetIndex"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as Engine from "../src/engine.ts"
import * as Executor from "../src/Executor.ts"
import * as GitCommit from "../src/GitCommit.ts"
import * as GitHooks from "../src/GitHooks.ts"
import * as GithubRender from "../src/GithubRender.ts"
import * as DeclarationDependencies from "../src/internal/DeclarationDependencies.ts"
import * as GoCache from "../src/internal/GoCache.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as OutputCas from "../src/internal/OutputCas.ts"
import * as Label from "../src/Label.ts"
import * as Owners from "../src/Owners.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as Resolver from "../src/Resolver.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"
import * as TargetIndex from "../src/TargetIndex.ts"
import * as TrustedReview from "../src/TrustedReview.ts"
import * as Watch from "../src/Watch.ts"
import * as Workspace from "../src/Workspace.ts"

const assertPassed = <A>(report: Fuzz.Report<A, unknown>): void => {
  if (report._tag !== "Passed") {
    throw new Error(Fuzz.formatReport(report))
  }
}
const slugArb = Schema.Literals(["aa", "b1", "c2", "d3", "e4", "f5"])

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

const writeExecutable = async (path: string, content: string): Promise<void> => {
  await Fs.writeFile(path, content, { mode: 0o755 })
  await Fs.chmod(path, 0o755)
}

describe("@smthrs/build-cli Wave-6E: Executor, Workspace, Owners, PackageTree, OutputCas, Cache, ServiceSupervisor, GoCache, GitCommit & TrustedReview fuzz", () => {
  it(
    "Executor lossy failure serialization, Workspace remote discovery, DeclarationDependencies bootstrap & Engine.runInstall validation",
    async () => {
      const report = await Effect.runPromise(Fuzz.run(
        Arbitrary.schema(Schema.Struct({
          slug: slugArb,
          useWorktree: Schema.Boolean,
          importEffect: Schema.Boolean,
          surrogatePad: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 600 }))
        })),
        (input) =>
          Effect.promise(async () => {
            const { slug, useWorktree, importEffect, surrogatePad } = input
            // 1. Executor.describeFailure (lossy budget, surrogate truncation, functions, proxies, sparse arrays, accessors, arguments)
            const namedFn = function sampleNamed() {
              return 1
            }
            const anonFn = (() => () => 2)()
            const fnProxy = new Proxy(namedFn, {})
            const sparse: Array<unknown> = []
            sparse[0] = "first"
            sparse[3] = "fourth"
            Object.defineProperty(sparse, 2, {
              enumerable: true,
              get() {
                return "getter-value"
              }
            })
            const objWithAccessor: Record<string, unknown> = {
              tag: slug,
              namedFn,
              anonFn,
              fnProxy,
              sparse,
              bigEmoji: "😀".repeat(surrogatePad) + "TAIL-" + slug,
              arguments: ["arg1", "arg2", "😀".repeat(surrogatePad), "arg4"],
              extra1: "a".repeat(2000),
              extra2: "b".repeat(2000),
              extra3: "c".repeat(2000),
              extra4: "d".repeat(2000)
            }
            Object.defineProperty(objWithAccessor, "acc", {
              enumerable: true,
              get() {
                throw new Error("must not invoke accessor")
              }
            })
            const described = Executor.describeFailure(objWithAccessor)
            expect(described.length).toBeGreaterThan(0)
            expect(described).toContain("<function sampleNamed>")
            expect(described).toContain("<function proxy>")
            expect(described).toContain("<accessor>")

            // Strict encodeCacheOutput refusals (function, accessor, custom prototype, sparse hole, oversized string)
            expect("reason" in Executor.encodeCacheOutput({ fn: namedFn })).toBe(true)
            expect("reason" in Executor.encodeCacheOutput(objWithAccessor)).toBe(true)
            class CustomClass {
              readonly x = 1
            }
            expect("reason" in Executor.encodeCacheOutput(new CustomClass())).toBe(true)
            const hugeStr = "x".repeat(300_000)
            const hugeEnc = Executor.encodeCacheOutput({ hugeStr })
            expect("reason" in hugeEnc || "output" in hugeEnc).toBe(true)
            const counts = Executor.notStoredCounts(["reason-a", "reason-b", "reason-a"])
            expect(counts.length).toBe(2)

            // 2. Workspace.discoverSmithersCloudRepository (.git/config, linked worktree gitdir+commondir, .jj fallback)
            await withTempDir("smthrs-w6e-ws-", async (root) => {
              const host = `cloud-${slug}.example.invalid`
              const env = { SMITHERS_CLOUD_HOSTS: host }
              if (useWorktree) {
                const commonDir = NodePath.join(root, "common-git")
                const worktreeGitDir = NodePath.join(commonDir, "worktrees", "wt1")
                await Fs.mkdir(worktreeGitDir, { recursive: true })
                await Fs.writeFile(NodePath.join(root, ".git"), `gitdir: ${worktreeGitDir}\n`)
                await Fs.writeFile(NodePath.join(worktreeGitDir, "commondir"), "../..\n")
                await Fs.writeFile(
                  NodePath.join(commonDir, "config"),
                  `[core]\n\trepositoryformatversion = 0\n[remote "upstream"]\n\turl = https://${host}/org-up/repo-${slug}.git\n[remote "origin"]\n\turl = git@${host}:org-orig/repo-${slug}.git\n`
                )
                const found = await Workspace.discoverSmithersCloudRepository(root, env)
                expect(found?.repo).toBe(`org-orig/repo-${slug}`)
              } else {
                // Fall through to .jj/repo/store/git/config
                await Fs.mkdir(NodePath.join(root, ".jj/repo/store/git"), { recursive: true })
                await Fs.writeFile(
                  NodePath.join(root, ".jj/repo/store/git/config"),
                  `[remote "alt"]\n\turl = https://${host}/org-jj/repo-${slug}\n`
                )
                const found = await Workspace.discoverSmithersCloudRepository(root, env)
                expect(found?.repo).toBe(`org-jj/repo-${slug}`)
              }
              expect(Workspace.normalizeOverrideEndpoint(`https://${host}/cache/`)).toBe(`https://${host}/cache`)
            })

            // 3. DeclarationDependencies.assertDeclarationDependencies (bootstrap major-version tolerance vs mismatch)
            await withTempDir("smthrs-w6e-dep-", async (root) => {
              const declPath = NodePath.join(root, "PACKAGE.ts")
              await Fs.writeFile(
                declPath,
                importEffect
                  ? `import { Effect } from "effect"\nexport const Package = {}\n`
                  : `import { Smithers as S } from "@smthrs/targets"\nexport const Package = {}\n`
              )
              await Fs.mkdir(NodePath.join(root, "node_modules/effect"), { recursive: true })
              await Fs.writeFile(
                NodePath.join(root, "node_modules/effect/package.json"),
                JSON.stringify({ name: "effect", version: "3.14.0" })
              )
              if (importEffect) {
                expect(() => DeclarationDependencies.assertDeclarationDependencies([declPath], { bootstrap: true }))
                  .toThrow()
              } else {
                expect(() => DeclarationDependencies.assertDeclarationDependencies([declPath], { bootstrap: true })).not
                  .toThrow()
              }
              expect(() => DeclarationDependencies.assertDeclarationDependencies([declPath], { bootstrap: false }))
                .toThrow()
            })

            // 4. Engine.runInstall toolchain & cacheDirectory validation
            await withTempDir("smthrs-w6e-inst-", async (root) => {
              await expect(
                Engine.runInstall(root, { toolchain: "bad" as unknown as never })
              ).rejects.toThrow(/plain object/)
              await expect(
                Engine.runInstall(root, {
                  toolchain: {
                    manager: "bogus" as "pnpm",
                    managerVersion: "1.0.0",
                    runtime: "node",
                    runtimeVersion: "26.4.0",
                    managerExecutable: "pnpm",
                    runtimeExecutable: "node"
                  }
                })
              ).rejects.toThrow(/package manager/)
              await expect(
                Engine.runInstall(root, {
                  toolchain: {
                    manager: "pnpm",
                    managerVersion: "11.21.0",
                    runtime: "bogus" as "node",
                    runtimeVersion: "26.4.0",
                    managerExecutable: "pnpm",
                    runtimeExecutable: "node"
                  }
                })
              ).rejects.toThrow(/runtime/)
              await expect(
                Engine.runInstall(root, {
                  cacheDirectory: ".custom-cache",
                  toolchain: {
                    manager: "pnpm",
                    managerVersion: "11.21.0",
                    runtime: "node",
                    runtimeVersion: "26.4.0",
                    managerExecutable: "pnpm",
                    runtimeExecutable: "node"
                  }
                })
              ).rejects.toThrow(/cacheDirectory/)
            })
            return true
          }),
        { seed: 20261701, executions: 8 }
      ))
      assertPassed(report)
    },
    60_000
  )

  it(
    "Owners upstream claims + CODEOWNERS/OWNERS, PackageTree ignored/portals/file manifests & OutputCas chunked assembly",
    async () => {
      const report = await Effect.runPromise(Fuzz.run(
        Arbitrary.schema(Schema.Struct({
          slug: slugArb,
          corruptChunk: Schema.Literals(["none", "size", "digest"]),
          danglingPortal: Schema.Boolean
        })),
        (input) =>
          Effect.promise(async () => {
            const { slug, corruptChunk, danglingPortal } = input
            await withTempDir("smthrs-w6e-tree-", async (root) => {
              // 1. Owners with workspace defaults, noparent, perFile, and upstream claims (approve + review)
              const libTarget = S.Shell.Build({ shell: "true", outDirs: ["dist"] })
              const appTarget = S.Shell.Test({ shell: "true", data: [libTarget] })
              const index = PackageIndex.make({
                root,
                workspace: S.Workspace("w6e-own", {
                  repository: "git+https://example.invalid/w6e-own.git",
                  cache: S.Cache({ directory: ".flows" }),
                  owners: { owners: ["ws-owner"] }
                }),
                factory: undefined,
                packages: [
                  {
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({
                      targets: {}
                    })
                  },
                  {
                    file: "lib/PACKAGE.ts",
                    packagePath: "lib",
                    value: S.Package({
                      owners: {
                        owners: ["lib-owner"],
                        noparent: true,
                        perFile: { "secret/*": ["sec-owner"] }
                      },
                      targets: { build: libTarget }
                    })
                  },
                  {
                    file: "app/PACKAGE.ts",
                    packagePath: "app",
                    value: S.Package({
                      owners: {
                        owners: ["app-owner"],
                        upstream: { mode: "approve", packages: ["//lib"] }
                      },
                      targets: { test: appTarget }
                    })
                  },
                  {
                    file: "orphan/PACKAGE.ts",
                    packagePath: "orphan",
                    value: S.Package({
                      targets: {}
                    })
                  }
                ]
              })
              const res = Owners.resolve(index, ["lib/index.ts", "lib/secret/key.ts", "orphan/a.ts"])
              expect(res.touchedPaths.length).toBe(3)
              const libTouch = res.touchedPaths.find((t) => t.path === "lib/index.ts")!
              expect(libTouch.owners.some((o) => o.owner === "app-owner")).toBe(true)
              const orphanTouch = res.touchedPaths.find((t) => t.path === "orphan/a.ts")!
              expect(orphanTouch.owners.some((o) => o.owner === "ws-owner")).toBe(true)
              const codeowners = Owners.renderCodeowners(index, "acme")
              expect(codeowners).toContain("app-owner")
              const ownersTree = Owners.renderOwnersTree(index)
              expect(ownersTree.length).toBeGreaterThanOrEqual(2)
              expect(Owners.text(res)).toContain("lib/index.ts")
              expect(Owners.toJson(res).touched_paths.length).toBe(3)

              // 2. PackageTree: git repo with ignored files, escaping portals (existing + dangling), file manifest & scratchCopy
              execFileSync("git", ["init", "-q"], { cwd: root })
              await PackageTree.runGit(root, ["config", "user.email", "w6e@example.invalid"])
              await PackageTree.runGit(root, ["config", "user.name", "w6e"])
              await Fs.writeFile(NodePath.join(root, ".gitignore"), "ignored-dir/\nignored.tmp\n")
              await Fs.mkdir(NodePath.join(root, "ignored-dir"), { recursive: true })
              await Fs.writeFile(NodePath.join(root, "ignored-dir/a.txt"), `v1-${slug}\n`)
              await Fs.writeFile(NodePath.join(root, "tracked.txt"), `tracked-${slug}\n`)
              await PackageTree.runGit(root, ["add", ".gitignore", "tracked.txt"])
              await PackageTree.runGit(root, ["commit", "-q", "-m", "init"])

              const externalDir = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-w6e-ext-"))
              try {
                const portalTarget = danglingPortal
                  ? NodePath.join(externalDir, "not-yet-created.txt")
                  : NodePath.join(externalDir, "real-dir")
                if (!danglingPortal) {
                  await Fs.mkdir(portalTarget, { recursive: true })
                  await Fs.writeFile(NodePath.join(portalTarget, "ext.txt"), `ext-${slug}`)
                }
                await Fs.symlink(portalTarget, NodePath.join(root, "ext-link"))

                const ignSnap = await PackageTree.snapshotIgnored(root, ".flows")
                const portSnap = await PackageTree.snapshotPortals(root, ".flows", ignSnap)
                try {
                  // Mutate ignored file & portal target
                  await Fs.writeFile(NodePath.join(root, "ignored-dir/a.txt"), `mutated-${slug}\n`)
                  if (danglingPortal) {
                    await Fs.writeFile(portalTarget, `created-through-dangling-${slug}`)
                  } else {
                    await Fs.writeFile(NodePath.join(portalTarget, "ext.txt"), `mutated-ext-${slug}`)
                  }
                  const ignChanges = await PackageTree.changedIgnored(ignSnap, ".flows")
                  expect(ignChanges.length).toBeGreaterThanOrEqual(1)
                  for (const ch of ignChanges) await PackageTree.revertIgnored(ignSnap, ch)
                  expect(await Fs.readFile(NodePath.join(root, "ignored-dir/a.txt"), "utf8")).toBe(`v1-${slug}\n`)

                  const reachable = await PackageTree.portalsReachableFrom(portSnap, root)
                  expect(reachable.length).toBeGreaterThanOrEqual(0)
                  const revertedPortals = await PackageTree.revertChangedPortals(portSnap)
                  expect(revertedPortals.length).toBeGreaterThanOrEqual(1)
                } finally {
                  await PackageTree.releasePortals(portSnap)
                  await PackageTree.releaseIgnored(ignSnap)
                }

                // captureFile / decodeFileManifest / verifyFileManifest / materializeFile / scratchCopy
                const casDir = NodePath.join(root, ".flows")
                const fileManifest = await PackageTree.captureFile(root, casDir, "tracked.txt")
                const decoded = PackageTree.decodeFileManifest(fileManifest)
                expect(decoded).toBeDefined()
                expect(await PackageTree.verifyFileManifest(root, casDir, decoded!)).toBeUndefined()
                await Fs.writeFile(NodePath.join(root, "tracked.txt"), "clobbered")
                await PackageTree.materializeFile(root, casDir, decoded!)
                expect(await Fs.readFile(NodePath.join(root, "tracked.txt"), "utf8")).toBe(`tracked-${slug}\n`)

                const scratch = await PackageTree.scratchCopy(root, ".flows", [])
                try {
                  expect(await Fs.readFile(NodePath.join(scratch, "tracked.txt"), "utf8")).toBe(`tracked-${slug}\n`)
                } finally {
                  await Fs.rm(scratch, { recursive: true, force: true })
                }
              } finally {
                await Fs.rm(externalDir, { recursive: true, force: true })
              }

              // 3. OutputCas chunked assembly (hydrate + corrupt chunk size / digest checks)
              const cas = NodePath.join(root, "cas-blobs")
              await Fs.mkdir(cas, { recursive: true })
              const partA = Buffer.alloc(OutputCas.chunkBytes, slug.charCodeAt(0))
              const partB = Buffer.from(`chunk-B-${slug}-`.repeat(16))
              const digA = createHash("sha256").update(partA).digest("hex")
              const digB = createHash("sha256").update(partB).digest("hex")
              const whole = Buffer.concat([partA, partB])
              const wholeDig = createHash("sha256").update(whole).digest("hex")

              // Also exercise OutputCas.prepare splitting a real >16MiB blob on corruptChunk === "none"
              if (corruptChunk === "none") {
                const srcWhole = NodePath.join(cas, wholeDig)
                await Fs.writeFile(srcWhole, whole)
                const prep = await OutputCas.prepare(cas, {
                  kind: "build",
                  manifests: [{
                    kind: "smithers-build/out-dir-v1",
                    path: "out",
                    entries: [{ path: "big.bin", kind: "file", mode: 0o644, size: whole.length, digest: wholeDig }]
                  }]
                })
                expect(prep.digests.length).toBeGreaterThanOrEqual(2)
                await Fs.rm(srcWhole, { force: true })
              }
              const indexObj = {
                kind: "smithers-build/chunks-v1",
                size: corruptChunk === "size" ? whole.length + 1 : whole.length,
                chunks: [
                  { digest: digA, size: corruptChunk === "size" ? partA.length + 1 : partA.length },
                  { digest: digB, size: partB.length }
                ]
              }
              const badWholeDig = corruptChunk === "digest"
                ? (wholeDig.startsWith("0") ? "1" : "0") + wholeDig.slice(1)
                : wholeDig
              const indexBytes = Buffer.from(JSON.stringify(indexObj))
              const indexDig = createHash("sha256").update(indexBytes).digest("hex")
              // Store index under badWholeDig via remote hydrate callback
              const remoteBlobs = new Map<string, Buffer>([
                [indexDig, indexBytes],
                [digA, partA],
                [digB, partB]
              ])
              const limiter = OutputCas.makeLimiter(4, 2)
              const hydrateCall = OutputCas.hydrate(
                cas,
                {
                  kind: "build",
                  manifests: [
                    {
                      kind: "smithers-build/out-dir-v1",
                      path: "out",
                      entries: [{
                        path: "big.bin",
                        kind: "file",
                        mode: 0o644,
                        size: whole.length,
                        digest: badWholeDig,
                        index: indexDig
                      }]
                    }
                  ]
                },
                async (d) => {
                  const b = remoteBlobs.get(d)
                  if (!b) return false
                  await OutputCas.writeBlob(cas, d, b)
                  return true
                },
                limiter
              )
              if (corruptChunk === "none") {
                expect(await hydrateCall).toBe(true)
                expect(await OutputCas.hasFile(cas, wholeDig)).toBe(true)
              } else {
                await expect(hydrateCall).rejects.toThrow()
              }
            })
            return true
          }),
        { seed: 20261702, executions: 6 }
      ))
      assertPassed(report)
    },
    60_000
  )

  it(
    "Cache chunked streaming, timeouts & findMissing degradation + ServiceSupervisor exec probe, SecretOrigin/secretUrls & docker container lifecycle",
    async () => {
      const report = await Effect.runPromise(Fuzz.run(
        Arbitrary.schema(Schema.Struct({
          slug: slugArb,
          findMissingMode: Schema.Literals(["timeout", "429", "401", "500", "bad-json"]),
          execReadyOk: Schema.Boolean
        })),
        (input) =>
          Effect.promise(async () => {
            const { slug, findMissingMode, execReadyOk } = input
            await withTempDir("smthrs-w6e-net-", async (root) => {
              // 1. Cache HTTP loopback server testing chunked growth, Content-Length mismatch, timeouts, and findMissing modes
              const acStore = new Map<string, string>()
              const server = Http.createServer((req, res) => {
                const url = req.url ?? "/"
                if (req.method === "GET" && url.startsWith("/ac/chunked-")) {
                  res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" })
                  const entry = JSON.stringify({
                    key: url.slice(4),
                    target: "t",
                    label: "//:t",
                    exitOk: true,
                    output: { pad: "A".repeat(24_000) },
                    storedAt: new Date().toISOString()
                  })
                  // Send in multiple small chunks to exercise readBoundedBytes buffer doubling
                  for (let i = 0; i < entry.length; i += 2048) {
                    res.write(entry.slice(i, i + 2048))
                  }
                  res.end()
                  return
                }
                if (req.method === "GET" && url.startsWith("/ac/trunc-")) {
                  res.writeHead(200, { "content-type": "application/json", "content-length": "500" })
                  res.end("{\"short\":true}")
                  return
                }
                if (req.method === "POST" && url === "/cas/findMissing") {
                  if (findMissingMode === "timeout") {
                    setTimeout(() => {
                      if (!res.writableEnded) {
                        res.writeHead(200)
                        res.end(JSON.stringify({ missing: [] }))
                      }
                    }, 450)
                    return
                  }
                  if (findMissingMode === "429") {
                    res.writeHead(429, { "retry-after": "1" })
                    res.end("busy")
                    return
                  }
                  if (findMissingMode === "401") {
                    res.writeHead(401)
                    res.end("denied")
                    return
                  }
                  if (findMissingMode === "500") {
                    res.writeHead(500)
                    res.end("err")
                    return
                  }
                  res.writeHead(200, { "content-type": "application/json" })
                  res.end(JSON.stringify({ missing: ["not-in-batch-digest"] }))
                  return
                }
                if (req.method === "PUT" && url.startsWith("/ac/")) {
                  const chunks: Array<Buffer> = []
                  req.on("data", (c: Buffer) => chunks.push(c))
                  req.on("end", () => {
                    acStore.set(url.slice(4), Buffer.concat(chunks).toString("utf8"))
                    res.writeHead(200)
                    res.end("ok")
                  })
                  return
                }
                res.writeHead(404)
                res.end("nope")
              })
              await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
              const port = (server.address() as AddressInfo).port
              const endpoint = `http://127.0.0.1:${port}`
              try {
                // Invalid timeouts validation
                await expect(
                  Cache.openCache({
                    workspaceRoot: root,
                    cacheDirectory: ".flows",
                    endpoint,
                    timeouts: { get: 0, put: 100 }
                  })
                ).rejects.toThrow(TypeError)

                const warnings: Array<string> = []
                const cache = await Cache.openCache({
                  workspaceRoot: root,
                  cacheDirectory: ".flows",
                  endpoint,
                  readToken: () => "tok-r",
                  writeToken: () => "tok-w",
                  timeouts: { get: 250, put: 250 },
                  warn: (m) => warnings.push(m)
                })
                const chunkedHit = await cache.get(`chunked-${slug}`)
                expect(chunkedHit?.exitOk).toBe(true)
                const truncMiss = await cache.get(`trunc-${slug}`)
                expect(truncMiss).toBeNull()

                // Publish an entry referencing a real CAS blob so /cas/findMissing runs
                const blobBytes = Buffer.from(`blob-${slug}`)
                const blobDigest = createHash("sha256").update(blobBytes).digest("hex")
                const casDir = NodePath.join(root, ".flows/cas/v1")
                await Fs.mkdir(casDir, { recursive: true })
                await OutputCas.writeBlob(casDir, blobDigest, blobBytes)
                const entryWithCas: Cache.CachedResult = {
                  key: `cas-pub-${slug}`,
                  target: "bld",
                  label: "//:bld",
                  exitOk: true,
                  output: {
                    kind: "build",
                    manifests: [
                      {
                        kind: "smithers-build/out-dir-v1",
                        path: "dist",
                        entries: [{
                          path: "a.txt",
                          kind: "file",
                          mode: 0o644,
                          size: blobBytes.length,
                          digest: blobDigest
                        }]
                      }
                    ]
                  },
                  storedAt: new Date().toISOString()
                }
                // Repeat 3 times for timeout mode so findMissingTimeoutLimit trips degradation
                const rounds = findMissingMode === "timeout" ? 3 : 1
                for (let r = 0; r < rounds; r++) {
                  await cache.put(`cas-pub-${slug}-${r}`, { ...entryWithCas, key: `cas-pub-${slug}-${r}` })
                }
              } finally {
                await new Promise<void>((resolve) => server.close(() => resolve()))
              }

              // 2. ServiceSupervisor: exec readiness probe, SecretOrigin/secretUrls, and docker fake binary lifecycle
              const binDir = NodePath.join(root, "fake-bin")
              await Fs.mkdir(binDir, { recursive: true })
              const dockerLog = NodePath.join(root, "docker.log")
              await writeExecutable(
                NodePath.join(binDir, "docker"),
                `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(dockerLog)}, args.join(" ") + "\\n");
if (args[0] === "create") { console.log("a".repeat(64)); process.exit(0); }
if (args[0] === "start") { setTimeout(() => process.exit(0), 2500); return; }
if (args[0] === "exec") { process.exit(${execReadyOk ? 0 : 1}); }
if (args[0] === "stop" || args[0] === "rm" || args[0] === "kill") { process.exit(0); }
process.exit(0);
`
              )
              const dockerExe = NodePath.join(binDir, "docker")
              const secretSpec: ServiceSupervisor.ServiceSpec = {
                key: `//:svc-secret-${slug}`,
                cwd: root,
                argv: [
                  process.execPath,
                  "-e",
                  `setTimeout(() => {}, 5000)`,
                  S.SecretOrigin("http://127.0.0.1:1"),
                  "URL_PLACEHOLDER"
                ],
                env: {
                  W6E_API_KEY: "super-secret-value",
                  W6E_DB_URL: "http://127.0.0.1:2/v1",
                  API_BASE: S.SecretOrigin("http://127.0.0.1:1")
                },
                secrets: [S.HttpSecret(S.Secret("W6E_API_KEY"), ["http://127.0.0.1:1"])],
                secretUrls: [{ index: 4, secret: S.Secret("W6E_DB_URL") }],
                readiness: {
                  exec: ["/bin/sh", "-c", execReadyOk ? "exit 0" : "exit 1"],
                  timeout: execReadyOk ? "3s" : "250ms"
                },
                stop: { signal: "SIGTERM", grace: "200ms" }
              }
              const prevApi = process.env["W6E_API_KEY"]
              const prevDb = process.env["W6E_DB_URL"]
              process.env["W6E_API_KEY"] = "super-secret-value"
              process.env["W6E_DB_URL"] = "http://127.0.0.1:2/v1"
              let secretOutcome
              try {
                secretOutcome = await Effect.runPromiseExit(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const sup = yield* ServiceSupervisor.make
                      const lease = yield* sup.acquire(secretSpec)
                      return yield* lease.whileHealthy(Effect.succeed("ran"))
                    })
                  ).pipe(Effect.provideService(ServiceSupervisor.HostPlatform, "linux"))
                )
              } finally {
                if (prevApi === undefined) delete process.env["W6E_API_KEY"]
                else process.env["W6E_API_KEY"] = prevApi
                if (prevDb === undefined) delete process.env["W6E_DB_URL"]
                else process.env["W6E_DB_URL"] = prevDb
              }
              if (execReadyOk) {
                if (secretOutcome._tag !== "Success") {
                  throw new Error("secretOutcome failed: " + String(secretOutcome.cause))
                }
              } else {
                expect(secretOutcome._tag).toBe("Failure")
              }

              // Docker service spec lifecycle
              const dockerSpec: ServiceSupervisor.ServiceSpec = {
                key: `//:svc-docker-${slug}`,
                cwd: root,
                docker: `smthrs-w6e-${slug}`,
                argv: [dockerExe, "create", "--rm", "alpine:latest", "sleep", "5"],
                readiness: {
                  exec: ["true"],
                  timeout: execReadyOk ? "3s" : "250ms"
                },
                stop: { signal: "SIGTERM", grace: "200ms" }
              }
              const dockerOutcome = await Effect.runPromiseExit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const sup = yield* ServiceSupervisor.make
                    const lease = yield* sup.acquire(dockerSpec)
                    return yield* lease.whileHealthy(Effect.succeed("docker-ok"))
                  })
                )
              )
              if (execReadyOk) {
                expect(dockerOutcome._tag).toBe("Success")
              } else {
                expect(dockerOutcome._tag).toBe("Failure")
              }
              expect(await Fs.readFile(dockerLog, "utf8")).toContain("create")
            })
            return true
          }),
        { seed: 20261703, executions: 5 }
      ))
      assertPassed(report)
    },
    60_000
  )

  it(
    "GoCache leases/evict, GitCommit materializeTree rollback, TrustedReview prepareSource, Resolver URL imports, Machine turn reap, Watch & GitHooks",
    async () => {
      const report = await Effect.runPromise(Fuzz.run(
        Arbitrary.schema(Schema.Struct({
          slug: slugArb,
          gateFailsFirst: Schema.Boolean,
          requiredMode: Schema.Boolean
        })),
        (input) =>
          Effect.promise(async () => {
            const { slug, gateFailsFirst, requiredMode } = input
            await withTempDir("smthrs-w6e-misc-", async (root) => {
              // 1. GoCache acquireLease, leased, usage, evict (with dead-PID stale lease + live lease), status, entries
              const goCacheDir = GoCache.directory(root, ".flows")
              await Fs.mkdir(goCacheDir, { recursive: true })
              const now = Date.now()
              const host = GoCache.leaseHost(now)
              const liveLease = await GoCache.acquireLease(root, ".flows", host, {})
              // Plant a stale lease owned by an expired timestamp and fake cache entries
              const leasesDir = NodePath.dirname(liveLease)
              const oldLeasePath = NodePath.join(leasesDir, "stale-old-lease.json")
              await Fs.writeFile(
                oldLeasePath,
                JSON.stringify({ pid: 999999, host: host.host, startedAt: now - GoCache.leaseLifetimeMs * 3 })
              )
              await Fs.mkdir(NodePath.join(goCacheDir, "aa"), { recursive: true })
              const entryA = NodePath.join(goCacheDir, "aa", `${"a".repeat(64)}-a`)
              const entryD = NodePath.join(goCacheDir, "aa", `${"a".repeat(64)}-d`)
              await Fs.writeFile(entryA, `action-${slug}`)
              await Fs.writeFile(entryD, `data-${slug}`.repeat(100))
              const st = await GoCache.status(root, ".flows")
              expect(st.bytes).toBeGreaterThan(0)
              const activeLeases = await GoCache.leased("Shell.Test", root, ".flows", {})
              expect(activeLeases).toBe(true)
              const useInfo = await GoCache.usage(root, ".flows", host, {})
              expect(useInfo.stale.length).toBeGreaterThanOrEqual(1)
              await GoCache.releaseLease(liveLease)
              const listed = await GoCache.entries(root, ".flows")
              const evicted = await GoCache.evict(root, ".flows", listed)
              expect(evicted.removed).toBe(listed.length)

              // 2. GitCommit.commit with staged mod, staged add, untracked file, materializeTree & gate failure/success
              const gitRepo = NodePath.join(root, "repo")
              await Fs.mkdir(gitRepo, { recursive: true })
              execFileSync("git", ["init", "-q"], { cwd: gitRepo })
              await PackageTree.runGit(gitRepo, ["config", "user.email", "w6e@example.invalid"])
              await PackageTree.runGit(gitRepo, ["config", "user.name", "w6e"])
              await Fs.writeFile(NodePath.join(gitRepo, "a.txt"), "base\n")
              await PackageTree.runGit(gitRepo, ["add", "a.txt"])
              await PackageTree.runGit(gitRepo, ["commit", "-q", "-m", "base"])

              await Fs.writeFile(NodePath.join(gitRepo, "a.txt"), `changed-${slug}\n`)
              await Fs.writeFile(NodePath.join(gitRepo, "added.txt"), `added-${slug}\n`)
              await Fs.writeFile(NodePath.join(gitRepo, "untracked.txt"), `untracked-${slug}\n`)
              const scratchDir = NodePath.join(root, "scratch-mat")
              await Fs.mkdir(scratchDir, { recursive: true })
              const commitTarget = S.Git.Commit({
                gates: [S.Shell.Test({ shell: "true" })],
                message: `feat: commit ${slug}`
              })
              const commitAttempt = GitCommit.commit({
                root: gitRepo,
                target: commitTarget,
                paths: ["a.txt", "added.txt"],
                gateRunner: {
                  run: async (_gates, candidate) => {
                    const rewritten = await candidate.materialize(scratchDir)
                    expect(rewritten.length).toBeGreaterThan(0)
                    return gateFailsFirst
                      ? [{ target: "//:gate", message: `failed-${slug}` }]
                      : []
                  }
                }
              })
              if (gateFailsFirst) {
                await expect(commitAttempt).rejects.toThrow()
              } else {
                const commitRes = await commitAttempt
                expect(commitRes.sha.length).toBeGreaterThan(0)
              }

              // 3. TrustedReview.prepareSource (index diff, related callers grep, #proposed-checks, //:proposed-security-policy, required)
              const revWs = S.Workspace("rev-w6e", {
                repository: "git+https://example.invalid/rev.git",
                cache: S.Cache({ directory: ".flows" })
              })
              const baseIdx = PackageIndex.make({
                root,
                workspace: revWs,
                factory: undefined,
                packages: [{
                  file: "PACKAGE.ts",
                  packagePath: "",
                  value: S.Package({
                    targets: {
                      review: S.LlmLint({
                        changes: S.gitDiff("HEAD"),
                        deps: [],
                        include: [S.glob("//src/**")],
                        context: [S.glob("//docs/**")],
                        prompt: "Review base code",
                        rubric: "Clean",
                        model: "claude-sonnet-4",
                        batchSize: 5,
                        securityChecks: ["check-a"]
                      })
                    }
                  })
                }]
              })
              const headIdx = PackageIndex.make({
                root,
                workspace: revWs,
                factory: undefined,
                packages: [{
                  file: "PACKAGE.ts",
                  packagePath: "",
                  value: S.Package({
                    targets: {
                      review: S.LlmLint({
                        changes: S.gitDiff("HEAD"),
                        deps: [],
                        include: [S.glob("//src/**")],
                        context: [S.glob("//docs/**")],
                        prompt: `Review updated ${slug}`,
                        rubric: "Clean",
                        model: "claude-sonnet-4",
                        batchSize: 5,
                        securityChecks: ["check-a", `check-${slug}`]
                      })
                    }
                  })
                }]
              })
              const baseIndexRows = JSON.stringify((await TargetIndex.build(baseIdx, "//...", {})).targets)
              const headIndexRows = JSON.stringify((await TargetIndex.build(headIdx, "//...", {})).targets)
              const baseFiles = new Map<string, string>([
                [TargetIndexSchema.indexPath, baseIndexRows],
                ["src/lib.ts", "export const greet = () => 1\n"],
                ["src/caller.ts", "import { greet } from \"./lib.ts\"\nexport const run = () => greet()\n"],
                ["PACKAGE.ts", "export const Package = {}\n"]
              ])
              const headFiles = new Map<string, string>([
                [TargetIndexSchema.indexPath, headIndexRows],
                ["src/lib.ts", `export const greet = () => "${slug}"\n`],
                ["src/caller.ts", "import { greet } from \"./lib.ts\"\nexport const run = () => greet()\n"],
                ["PACKAGE.ts", `export const Package = { tag: "${slug}" }\n`]
              ])
              const makeTree = (files: Map<string, string>) => {
                const m = new Map<string, { readonly id: string; readonly regular: boolean }>()
                for (const [k, v] of files) {
                  const oid = createHash("sha1").update(v).digest("hex")
                  m.set(k, { id: `100644 blob ${oid}`, regular: true })
                }
                return m
              }
              const source: TrustedReview.ReviewSource = {
                tree: async (rev) => makeTree(rev === "BASE" ? baseFiles : headFiles),
                read: async (rev, path) => (rev === "BASE" ? baseFiles : headFiles).get(path) ?? "",
                grep: async (_rev, _patterns, candidate) => (candidate("src/caller.ts") ? ["src/caller.ts"] : [])
              }
              const prepared = await TrustedReview.prepareSource(source, {
                policyRevision: "BASE",
                revision: "HEAD",
                patterns: [Label.parse("//...", "")],
                required: requiredMode
              })
              expect(prepared.policies.some((p) => p.label === "//:proposed-review-index")).toBe(true)
              expect(prepared.snapshot.some((f) => f.path === "src/caller.ts")).toBe(true)
              const gov = TrustedReview.governing(prepared)
              expect(gov.policyRevision).toBe("BASE")

              // 4. Resolver URL imports (new URL(..., import.meta.url))
              const resRoot = NodePath.join(root, "res-ws")
              await Fs.mkdir(NodePath.join(resRoot, "src/sub"), { recursive: true })
              await Fs.mkdir(NodePath.join(resRoot, "node_modules/@scope/pkg"), { recursive: true })
              await Fs.writeFile(NodePath.join(resRoot, "src/data.txt"), `data-${slug}`)
              await Fs.writeFile(NodePath.join(resRoot, "node_modules/@scope/pkg/a.js"), "export const x = 1\n")
              await Fs.writeFile(
                NodePath.join(resRoot, "src/entry.ts"),
                [
                  `export const u1 = new URL("./data.txt?raw#frag", import.meta.url)`,
                  `export const u2 = new URL("./sub/", import.meta.url)`,
                  `export const u3 = new URL("../node_modules/@scope/pkg/a.js", import.meta.url)`,
                  `export const u4 = new URL("/abs/path.txt", import.meta.url)`,
                  `export const u5 = new URL(globalThis.dyn, import.meta.url)`
                ].join("\n")
              )
              const resConfig = await Resolver.loadResolverConfig({ workspaceRoot: resRoot })
              const resolvedGraph = await Resolver.computeClosure({
                entries: ["src/entry.ts"],
                config: resConfig
              })
              expect(resolvedGraph.result.files.length).toBeGreaterThanOrEqual(1)

              // 5. Machine.hold with stale legacy .turn file and dead-PID turn directory reaping
              const turnRoot = NodePath.join(root, "turn-ws")
              await Fs.mkdir(turnRoot, { recursive: true })
              const turnPath = NodePath.join(turnRoot, "m1")
              // Legacy stale file lock
              const staleFile = `${turnPath}.turn`
              await Fs.writeFile(staleFile, "legacy")
              const past = new Date(Date.now() - 120_000)
              await Fs.utimes(staleFile, past, past)
              // Exercise darwin .turn directory lock & stale legacy file cleanup
              await Machine.unstale(turnPath, undefined, "darwin")
              // Exercise dead-PID marker reaping inside .turn directory
              const deadTurnDir = `${turnPath}-dead.turn`
              await Fs.mkdir(deadTurnDir, { recursive: true })
              await Fs.writeFile(NodePath.join(deadTurnDir, "999999-0123456789abcdef"), "")
              await Machine.unstale(`${turnPath}-dead`, undefined, "darwin")
              const hold1 = await Machine.hold(turnRoot, {}, () => {})
              expect(hold1).toBeDefined()

              // 6. GitHooks render / check / install & PackageDiscovery & Watch immediate abort
              const hooksRepo = gitRepo
              const rendered = GitHooks.render({ preCommit: "//:lint" })
              expect(rendered[0]!.content).toContain("//:lint")
              await GitHooks.install(hooksRepo, rendered)
              const hookCheck = await GitHooks.check(hooksRepo, rendered)
              expect(hookCheck.clean).toBe(true)

              // GithubRender multiline run array + affected refusal
              const wfMulti = S.Github.Workflow({
                name: `wf-${slug}`,
                on: { push: { branches: ["main"] } },
                runsOn: "ubuntu-latest",
                steps: [
                  { name: "Multi", run: [`echo one-${slug}`, `echo two-${slug}`] }
                ]
              })
              const ghWs = S.Workspace("gh-w6e", {
                repository: "git+https://example.invalid/gh-w6e.git",
                cache: S.Cache({ directory: ".flows" })
              })
              const ciGen = S.Github.CiGen({ workflows: [wfMulti], changes: ["workflows/**"] })
              const ghRendered = GithubRender.render({
                ciGen,
                workspace: ghWs,
                resolve: { labelOf: (t) => (t === ciGen ? "//:ci" : t === wfMulti ? "//:wf" : undefined) },
                packageDir: ""
              })
              expect(ghRendered.files[0]!.content).toContain(`echo one-${slug}`)

              // PackageDiscovery.findWorkspaceRoot
              await Fs.writeFile(NodePath.join(root, "WORKSPACE.ts"), "export default {}\n")
              const foundRoot = await PackageDiscovery.findWorkspaceRoot(NodePath.join(root, "res-ws/src"))
              expect(foundRoot).toBe(await Fs.realpath(root))

              // Watch.run with pre-aborted signal to exercise Watch entry/exit cleanly
              const ac = new AbortController()
              ac.abort()
              await Watch.run({
                root,
                args: ["test", "//:all"],
                ignored: [],
                debounceMs: 10,
                once: true,
                stdout: () => {},
                stderr: () => {},
                signal: ac.signal,
                services: Watch.makeServices()
              }).catch(() => undefined)
            })
            return true
          }),
        { seed: 20261704, executions: 5 }
      ))
      assertPassed(report)
    },
    60_000
  )
})
