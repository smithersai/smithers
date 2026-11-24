import { Smithers as S } from "@smthrs/targets"
import * as OwnersTarget from "@smthrs/targets/Owners"
import * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as Cache from "../src/Cache.ts"
import * as Owners from "../src/Owners.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as Resolver from "../src/Resolver.ts"
import * as TrustedReview from "../src/TrustedReview.ts"

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

describe("BuildCliWave9C PackageTree, Cache, Resolver, Owners, Affected, TrustedReview", () => {
  it(
    "PackageTree outDir/file capture, materialize, limits, symlink confinement, ignored & snapshotTree faults",
    async () => {
      await withTempDir("wave9c-tree-", async (dir) => {
        const ws = NodePath.join(dir, "ws")
        const outside = NodePath.join(dir, "outside")
        await Fs.mkdir(ws, { recursive: true })
        await Fs.mkdir(outside, { recursive: true })

        await expect(PackageTree.captureOutDir(ws, ".cache", "missing-dist")).rejects.toThrow()

        await Fs.symlink(outside, NodePath.join(ws, "escape-parent"))
        await Fs.mkdir(NodePath.join(outside, "dist"), { recursive: true })
        await expect(PackageTree.captureOutDir(ws, ".cache", "escape-parent/dist")).rejects.toThrow()

        const dist = NodePath.join(ws, "dist")
        await Fs.mkdir(NodePath.join(dist, "sub"), { recursive: true })
        await Fs.writeFile(NodePath.join(dist, "a.txt"), "hello world")
        await Fs.writeFile(NodePath.join(dist, "sub", "b.txt"), "sub content")
        await Fs.symlink("a.txt", NodePath.join(dist, "link-a.txt"))
        const manifest = await PackageTree.captureOutDir(ws, ".cache", "dist")
        expect(manifest.entries.some((e) => e.kind === "link")).toBe(true)
        expect(PackageTree.decodeManifest(manifest)).toBeDefined()
        expect(
          PackageTree.decodeManifest({
            ...manifest,
            entries: [{ path: "bad", kind: "link", digest: "", executable: false, target: "../../etc/passwd" }]
          })
        ).toBeUndefined()

        await expect(
          PackageTree.captureOutDir(ws, ".cache", "dist", ws, { ...PackageTree.outDirLimits, fileBytes: 2 })
        ).rejects.toThrow(PackageTree.OutDirLimitError)
        await expect(
          PackageTree.captureOutDir(ws, ".cache", "dist", ws, { ...PackageTree.outDirLimits, manifestBytes: 10 })
        ).rejects.toThrow(PackageTree.OutDirLimitError)

        const fakeManifest: PackageTree.OutDirManifest = {
          ...manifest,
          entries: [{ path: "a.txt", kind: "file", digest: "f".repeat(64), executable: false, target: "" }]
        }
        const missingMsg = await PackageTree.verifyManifestBlobs(ws, ".cache", fakeManifest)
        expect(missingMsg).toContain("cas blob missing")

        await Fs.rm(dist, { recursive: true, force: true })
        await PackageTree.materializeManifest(ws, ".cache", manifest)
        expect(await PackageTree.treeMatchesManifest(ws, manifest)).toBeUndefined()

        await Fs.writeFile(NodePath.join(dist, "extra.txt"), "nope")
        expect(await PackageTree.treeMatchesManifest(ws, manifest)).toContain("not in the captured tree")
        await Fs.rm(NodePath.join(dist, "extra.txt"))

        await Fs.mkdir(NodePath.join(dist, "extra-dir"))
        expect(await PackageTree.treeMatchesManifest(ws, manifest)).toContain("not in the captured tree")
        await Fs.rm(NodePath.join(dist, "extra-dir"), { recursive: true, force: true })

        // Colocated jj repo creates .git & .jj cleanly
        NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })
        await PackageTree.runGit(ws, ["config", "user.email", "test@example.com"])
        await PackageTree.runGit(ws, ["config", "user.name", "Test"])
        await Fs.writeFile(NodePath.join(ws, ".gitignore"), "ignored-*\n.cache/\n.jj/\n")
        await Fs.writeFile(NodePath.join(ws, "tracked.txt"), "v1\n")
        await PackageTree.runGit(ws, ["add", ".gitignore", "tracked.txt"])
        await PackageTree.runGit(ws, ["commit", "-q", "-m", "init"])

        await Fs.writeFile(NodePath.join(ws, "tracked.txt"), "v2\n")
        const faultyIo: PackageTree.TreeIo = {
          ...Fs,
          lstat: async () => {
            throw Object.assign(new Error("denied"), { code: "EACCES" })
          }
        }
        await expect(PackageTree.snapshotTree(ws, ".cache", faultyIo)).rejects.toThrow()

        const snap = await PackageTree.snapshotTree(ws, ".cache")
        try {
          await Fs.writeFile(NodePath.join(ws, "brand-new.txt"), "new")
          const changed = await PackageTree.changedSinceSnapshot(snap, ".cache")
          expect(changed).toContain("brand-new.txt")
          await PackageTree.revertPath(snap, "brand-new.txt")
          await expect(Fs.access(NodePath.join(ws, "brand-new.txt"))).rejects.toThrow()
        } finally {
          await PackageTree.releaseSnapshot(snap)
        }

        await Fs.symlink("tracked.txt", NodePath.join(ws, "ignored-link"))
        await Fs.writeFile(NodePath.join(ws, "ignored-file"), "orig")
        const igStash = await PackageTree.openIgnoredStash()
        try {
          const igSnap = await PackageTree.snapshotIgnored(ws, ".cache", PackageTree.ignoredLimits, igStash)
          try {
            await Fs.rm(NodePath.join(ws, "ignored-link"))
            await Fs.writeFile(NodePath.join(ws, "ignored-link"), "replaced-with-file")
            await Fs.writeFile(NodePath.join(ws, "ignored-file"), "modified")
            const igChanged = await PackageTree.changedIgnored(igSnap, ".cache")
            expect(igChanged).toContain("ignored-link")
            await PackageTree.revertIgnored(igSnap, "ignored-link")
            const st = await Fs.lstat(NodePath.join(ws, "ignored-link"))
            expect(st.isSymbolicLink()).toBe(true)
          } finally {
            await PackageTree.releaseIgnored(igSnap)
          }
        } finally {
          await PackageTree.releaseIgnoredStash(igStash)
        }
      })
    },
    60_000
  )

  it("Cache validation errors, limits, surrogate handling, and remote HTTP status/degrade paths", async () => {
    await withTempDir("wave9c-cache-", async (dir) => {
      await expect(Cache.openCache({ workspaceRoot: "" })).rejects.toThrow(TypeError)
      await expect(Cache.openCache({ workspaceRoot: dir, cacheDirectory: 123 as never })).rejects.toThrow(TypeError)
      await expect(Cache.openCache({ workspaceRoot: dir, cacheDirectory: "bad\0dir" })).rejects.toThrow(TypeError)
      await expect(
        Cache.openCache({ workspaceRoot: dir, io: { openTemp: "nope" as never } })
      ).rejects.toThrow(TypeError)
      await expect(
        Cache.openCache({
          workspaceRoot: dir,
          endpoint: `https://example.com/${"a".repeat(9000)}`,
          readToken: () => "tok"
        })
      ).rejects.toThrow()
      await expect(
        Cache.openCache({
          workspaceRoot: dir,
          endpoint: "not-a-url",
          readToken: () => "tok"
        })
      ).rejects.toThrow()
      await expect(
        Cache.openCache({
          workspaceRoot: dir,
          endpoint: "https://example.com",
          readToken: "not-fn" as never
        })
      ).rejects.toThrow(TypeError)

      const outside = NodePath.join(dir, "outside")
      const ws = NodePath.join(dir, "ws")
      await Fs.mkdir(outside, { recursive: true })
      await Fs.mkdir(ws, { recursive: true })
      await Fs.symlink(outside, NodePath.join(ws, ".esc-cache"))
      await expect(Cache.openCache({ workspaceRoot: ws, cacheDirectory: ".esc-cache" })).rejects.toThrow()

      const store = await Cache.openCache({ workspaceRoot: ws, cacheDirectory: ".cache" })
      const key = "a".repeat(64)
      const baseEntry = (output: unknown, k = key): Cache.CachedResult => ({
        key: k,
        target: "T",
        label: "//pkg:t",
        exitOk: true,
        storedAt: new Date().toISOString(),
        output
      })
      await expect(store.put(key, baseEntry(new Date()))).rejects.toThrow(TypeError)
      const accArr = ["x"]
      Object.defineProperty(accArr, "0", { get: () => "x", enumerable: true })
      await expect(store.put(key, baseEntry(accArr))).rejects.toThrow(TypeError)
      await store.put(key, baseEntry({ emoji: "😀" }))
      const got = await store.get(key)
      expect((got?.output as { emoji: string } | undefined)?.emoji).toBe("😀")
      const bigKey = "b".repeat(64)
      await expect(store.put(bigKey, baseEntry("x".repeat(16 * 1024 * 1024 + 100), bigKey))).rejects.toThrow(
        RangeError
      )

      let mode: "429" | "401" | "bad-json" | "wrong-key" = "429"
      const server = Http.createServer((_req, res) => {
        if (mode === "429") {
          res.writeHead(429, { "retry-after": new Date(Date.now() + 5000).toUTCString() })
          res.end("busy")
          return
        }
        if (mode === "401") {
          res.writeHead(401)
          res.end("unauthorized")
          return
        }
        if (mode === "bad-json") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end("{not-json")
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ keyDigest: "0".repeat(64), entry: baseEntry("ok") }))
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const addr = server.address() as { port: number }
      const endpoint = `http://127.0.0.1:${addr.port}`
      try {
        for (const m of ["429", "401", "bad-json", "wrong-key"] as const) {
          mode = m
          const warnings: Array<string> = []
          const remoteStore = await Cache.openCache({
            workspaceRoot: ws,
            cacheDirectory: `.rcache-${m}`,
            endpoint,
            readToken: () => "tok123",
            writeToken: () => "tok123",
            warn: (msg: string) => warnings.push(msg)
          })
          const r = await remoteStore.get("c".repeat(64))
          expect(r).toBeNull()
          const putKey = "d".repeat(64)
          await remoteStore.put(putKey, baseEntry("v", putKey)).catch(() => undefined)
        }
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  }, 60_000)

  it("Resolver, Owners, Affected, and TrustedReview edge & error matrices", async () => {
    await withTempDir("wave9c-misc-", async (dir) => {
      const ws = NodePath.join(dir, "ws")
      await Fs.mkdir(NodePath.join(ws, "src"), { recursive: true })
      await Fs.writeFile(NodePath.join(ws, "src", "entry.ts"), `import "#missing"\nexport const x = 1\n`)

      const badTsconfigs = [
        { extends: "pkg/tsconfig.json" },
        { compilerOptions: { paths: { "a/*": "not-array" } } },
        { compilerOptions: { paths: { "a/*/*": ["src/*"] } } },
        { compilerOptions: { paths: { "a/*": ["src/*/*"] } } },
        { compilerOptions: { paths: { "a/*": ["../../outside/*"] } } }
      ]
      for (const [i, cfg] of badTsconfigs.entries()) {
        const cfgPath = NodePath.join(ws, `tsconfig.bad${i}.json`)
        await Fs.writeFile(cfgPath, JSON.stringify(cfg))
        await expect(
          Resolver.loadResolverConfig({ workspaceRoot: ws, tsconfig: `tsconfig.bad${i}.json` })
        ).rejects.toThrow()
      }

      await Fs.writeFile(
        NodePath.join(ws, "tsconfig.ok.json"),
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@exact": ["src/exact.ts"] } } })
      )
      await Fs.writeFile(NodePath.join(ws, "src", "exact.ts"), `export const e = 1\n`)
      await Fs.writeFile(
        NodePath.join(ws, "src", "main.ts"),
        `import { e } from "@exact"\nimport "#nope"\nexport { e }\n`
      )
      const okConfig = await Resolver.loadResolverConfig({ workspaceRoot: ws, tsconfig: "tsconfig.ok.json" })
      const closure = await Resolver.computeClosure({
        config: okConfig,
        entries: ["src/main.ts"]
      })
      expect(closure.result.files.length).toBeGreaterThanOrEqual(2)

      await expect(
        Resolver.computeClosure({
          config: okConfig,
          entries: ["src/does-not-exist.ts"]
        })
      ).rejects.toThrow(Resolver.ClosureError)

      await expect(
        Resolver.computeClosure({
          config: okConfig,
          entries: ["src/main.ts"],
          maximumFiles: 1
        })
      ).rejects.toThrow(Resolver.ClosureError)

      // Owners: alias symlink root, Subtree pattern, role upgrade, glob intersection
      const wsAlias = NodePath.join(dir, "ws-alias")
      await Fs.symlink(ws, wsAlias)
      const ownersDecl = OwnersTarget.declare({
        owners: ["team:core"],
        perFile: { "src/*": ["alice"], "*.ts": ["bob"] },
        upstream: {
          mode: "approve",
          packages: ["//pkg/..."]
        }
      })
      const fakeIndex = {
        root: ws,
        workspace: WorkspaceDeclaration.Workspace("w", {
          repository: "git+https://github.com/org/repo.git",
          cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
          owners: OwnersTarget.declare({ owners: ["root-owner"] })
        }),
        packages: () => ["", "pkg", "pkg/sub"],
        hasPackage: (p: string) => ["", "pkg", "pkg/sub"].includes(p),
        packagePaths: () => ["", "pkg", "pkg/sub"],
        ownersOf: (pkg: string) => (pkg === "pkg" ? ownersDecl : undefined),
        targets: () => [],
        edges: () => []
      } as unknown as PackageIndex
      const resolved = Owners.resolve(fakeIndex, [NodePath.join(wsAlias, "pkg", "sub", "a.ts"), "pkg/src/a.ts"])
      expect(resolved.requiredApprovers.length).toBeGreaterThan(0)
      expect(Owners.text(resolved)).toBeTruthy()
      expect(Owners.toJson(resolved)).toBeDefined()

      // Affected: invalid_timeout, cancelled, invalid changed path, private target label
      await expect(Affected.changedPaths(ws, { base: "HEAD", timeoutMs: 0 })).rejects.toThrow(Affected.AffectedGitError)
      const ac = new AbortController()
      ac.abort(new Error("stop"))
      await expect(Affected.changedPaths(ws, { base: "HEAD", signal: ac.signal })).rejects.toThrow(
        Affected.AffectedGitError
      )

      const privDep = S.Shell.Test({ shell: "true" })
      const pubTarget = S.Shell.Test({ shell: "true", data: [privDep] })
      const affIndex = PackageIndex.make({
        root: ws,
        workspace: WorkspaceDeclaration.Workspace("w", {
          repository: "git+https://github.com/org/repo.git",
          cache: WorkspaceDeclaration.Cache({ directory: ".cache" })
        }),
        factory: undefined,
        packages: [{ packagePath: "pkg", file: "pkg/PACKAGE.ts", value: S.Package({ targets: { pub: pubTarget } }) }],
        modules: [],
        moduleRoots: []
      }, ws)
      expect(() => Affected.select(affIndex, ["//..."], ["../escape"])).toThrow()
      expect(() => Affected.select(affIndex, ["//..."], ["/abs"])).toThrow()
      expect(() => Affected.select(affIndex, ["//..."], [""])).toThrow()
      const affRes = Affected.select(affIndex, ["//..."], ["pkg/a.ts"])
      expect(affRes).toBeDefined()

      // TrustedReview: missing policyRevision -> ReviewPolicyRequired; invalid index labels; missing reviewPolicy
      await expect(
        TrustedReview.prepare({ workspace: ws, revision: "HEAD", policyRevision: "", patterns: [] })
      ).rejects.toThrow(TrustedReview.ReviewPolicyRequired)

      const makeSource = (indexJson: unknown): TrustedReview.ReviewSource => ({
        tree: async () =>
          new Map([
            [".smithers/targets.json", { id: "100644 blob " + "a".repeat(40), regular: true }],
            ["pkg/a.ts", { id: "100644 blob " + "b".repeat(40), regular: true }]
          ]),
        read: async (
          _rev,
          path
        ) => (path === ".smithers/targets.json" ? JSON.stringify(indexJson) : "export const a = 1\n"),
        grep: async () => []
      })

      await expect(
        TrustedReview.prepareSource(
          makeSource({
            version: 1,
            targets: [{
              label: "//wrong:name",
              package: "pkg",
              name: "other",
              target: "SecurityReview",
              kinds: ["lint"]
            }]
          }),
          { policyRevision: "rev0", revision: "rev1", patterns: [] }
        )
      ).rejects.toThrow()

      await expect(
        TrustedReview.prepareSource(
          makeSource({
            version: 1,
            targets: [{ label: "//pkg:sec", package: "pkg", name: "sec", target: "SecurityReview", kinds: ["lint"] }]
          }),
          { policyRevision: "rev0", revision: "rev1", patterns: [] }
        )
      ).rejects.toThrow()
    })
  }, 60_000)
})
