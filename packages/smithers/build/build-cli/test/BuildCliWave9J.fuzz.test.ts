import * as NodeCrypto from "node:crypto"
import { Fuzz } from "@smthrs/fuzz"
import * as Input from "@smthrs/targets/Input"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as Cli from "../src/Cli.ts"
import * as GoExec from "../src/GoExec.ts"
import * as PackageTree from "../src/PackageTree.ts"
import type * as Reporter from "../src/Reporter.ts"
import * as Resolver from "../src/Resolver.ts"

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

const serveCli = async (
  root: string | undefined,
  args: ReadonlyArray<string>,
  opts: {
    readonly audience?: "human" | "agent"
    readonly isTTY?: boolean
    readonly passExit?: boolean
    readonly env?: Readonly<Record<string, string | undefined>>
  } = {}
) => {
  let stdout = ""
  let stderr = ""
  let exitCode = 0
  const term = (sink: (t: string) => void): Reporter.Terminal => ({
    write: sink,
    isTTY: opts.isTTY ?? false,
    columns: 100
  })
  const fullArgs = root === undefined ? [...Cli.normalizeArgv(args)] : [...Cli.normalizeArgv(args), "--workspace", root]
  await Cli.makeCli({
    environment: {
      ...process.env,
      SMITHERS_AUDIENCE: opts.audience ?? "agent",
      NO_COLOR: opts.isTTY ? undefined : "1",
      CI: undefined,
      ...(opts.env ?? {})
    },
    stdout: term((t) => {
      stdout += t
    }),
    stderr: term((t) => {
      stderr += t
    }),
    ...(opts.passExit
      ? {
        exit: (c: number) => {
          exitCode = c
        }
      }
      : {})
  }).serve([...fullArgs], {
    stdout: (t) => {
      stdout += t
    },
    exit: (c) => {
      exitCode = c
    }
  })
  return { stdout, stderr, exitCode }
}

const makeCachedResult = (key: string, output: unknown): Cache.CachedResult => ({
  key,
  target: "Shell.Test",
  label: "//:t",
  exitOk: true,
  output,
  storedAt: new Date().toISOString()
})

describe("BuildCliWave9J Resolver, PackageTree, Cache, Cli, GoExec deep sweep", () => {
  it("Resolver deep config, specifiers, exports/imports/manifests, limits, and error branches", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            await withTempDir("wave9j-res-", async (dir) => {
              const ws = NodePath.join(dir, "ws")
              await Fs.mkdir(NodePath.join(ws, "src/dir"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "src/sub"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "node_modules/pkg-str"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "node_modules/pkg-arr"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "node_modules/pkg-cond"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "node_modules/pkg-deep"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "node_modules/pkg-badjson"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "node_modules/pkg-huge"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "node_modules/pkg-null-exp"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "bad-imports"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "pat-imports"), { recursive: true })

              await Fs.writeFile(NodePath.join(ws, "base.json"), JSON.stringify({ compilerOptions: null }))
              await Fs.writeFile(
                NodePath.join(ws, "tsconfig.json"),
                JSON.stringify({
                  extends: "./base",
                  compilerOptions: {
                    baseUrl: ".",
                    paths: {
                      "exact-alias": ["src/exact.ts"]
                    }
                  }
                })
              )
              await Fs.writeFile(NodePath.join(ws, "src/exact.ts"), "export const ex = 1\n")
              await Fs.writeFile(NodePath.join(ws, "src/extless"), "export const extless = 1\n")
              await Fs.writeFile(NodePath.join(ws, "src/dir/index.ts"), "export const dirIdx = 1\n")
              await Fs.writeFile(NodePath.join(ws, "src/sub/index.ts"), "export const subIdx = 1\n")
              await Fs.writeFile(NodePath.join(ws, "src/index.ts"), "export const rootIdx = 1\n")

              await Fs.writeFile(
                NodePath.join(ws, "node_modules/pkg-str/package.json"),
                JSON.stringify({ name: "pkg-str", exports: "./index.js" })
              )
              await Fs.writeFile(
                NodePath.join(ws, "node_modules/pkg-arr/package.json"),
                JSON.stringify({ name: "pkg-arr", exports: ["./index.js"] })
              )
              await Fs.writeFile(
                NodePath.join(ws, "node_modules/pkg-cond/package.json"),
                JSON.stringify({ name: "pkg-cond", exports: { import: "./index.js", default: ["./index.js"] } })
              )
              let deepObj: unknown = "./index.js"
              for (let i = 0; i < 12; i++) deepObj = { nested: deepObj }
              await Fs.writeFile(
                NodePath.join(ws, "node_modules/pkg-deep/package.json"),
                JSON.stringify({ name: "pkg-deep", exports: deepObj })
              )
              await Fs.writeFile(NodePath.join(ws, "node_modules/pkg-badjson/package.json"), "{not-json")
              await Fs.writeFile(
                NodePath.join(ws, "node_modules/pkg-huge/package.json"),
                `{"name":"pkg-huge","pad":"${"x".repeat(1024 * 1024 + 64)}"}`
              )
              await Fs.writeFile(
                NodePath.join(ws, "node_modules/pkg-null-exp/package.json"),
                JSON.stringify({ name: "pkg-null-exp", exports: null })
              )

              await Fs.writeFile(NodePath.join(ws, "bad-imports/package.json"), JSON.stringify({ name: "bi", imports: "nope" }))
              await Fs.writeFile(NodePath.join(ws, "bad-imports/entry.ts"), `import "#foo"\n`)
              await Fs.writeFile(
                NodePath.join(ws, "pat-imports/package.json"),
                JSON.stringify({
                  name: "pi",
                  imports: {
                    "not-hash": "./x.ts",
                    "#obj/*": { default: "./x.ts" },
                    "#str/*": "./*.ts"
                  }
                })
              )
              await Fs.writeFile(NodePath.join(ws, "pat-imports/a.ts"), "export const a = 1\n")
              await Fs.writeFile(
                NodePath.join(ws, "pat-imports/entry.ts"),
                `import "#str/a"\nimport "#obj/b"\nimport "#unmatched"\n`
              )

              const longVar = "v".repeat(160)
              await Fs.writeFile(
                NodePath.join(ws, "src/entry.ts"),
                [
                  `import "exact-alias"`,
                  `import "./"`,
                  `import "./dir/"`,
                  `import "./extless"`,
                  `import "./sub"`,
                  `import "pkg-str"`,
                  `import "pkg-arr"`,
                  `import "pkg-cond"`,
                  `import "pkg-deep"`,
                  `import "pkg-badjson"`,
                  `import "pkg-huge"`,
                  `import "pkg-null-exp"`,
                  `const r1 = require("pkg-str")`,
                  `const r2 = require.resolve("pkg-arr")`,
                  `const d0 = import()`,
                  `const d1 = import(${longVar})`,
                  `export { r1, r2, d0, d1 }`
                ].join("\n")
              )

              const cfg = await Resolver.loadResolverConfig({ workspaceRoot: ws, tsconfig: "tsconfig.json" })
              const res = await Resolver.computeClosure({
                entries: ["src/entry.ts", "bad-imports/entry.ts", "pat-imports/entry.ts"],
                config: cfg
              })
              expect(res.result.files.length).toBeGreaterThan(3)
              expect(res.result.packages).toContain("pkg-str")
              expect(res.result.packages).toContain("pkg-cond")
              expect(res.result.dynamic.length).toBeGreaterThanOrEqual(2)

              await expect(
                Resolver.loadResolverConfig({ workspaceRoot: ws, tsconfig: "../outside.json" })
              ).rejects.toThrow(/outside the workspace/)
              expect(() => Resolver.packageDirectoryOf(ws, NodePath.join(dir, "outside"))).toThrow(/outside the workspace/)

              await expect(
                Resolver.expandAnchoredSources({
                  workspaceRoot: ws,
                  sources: [{ base: ws, source: Input.file("does-not-exist.ts") }],
                  requireFiles: true
                })
              ).rejects.toThrow(/does not exist/)

              await expect(
                Resolver.computeClosure({
                  entries: ["src/entry.ts"],
                  config: cfg,
                  maximumFiles: 1
                })
              ).rejects.toThrow(/exceeds 1 files/)
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("PackageTree UTF-8 refusal, outDir limits/locks/verify mismatches, and ignored census revert", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            await withTempDir("wave9j-pt-", async (dir) => {
              const ws = NodePath.join(dir, "ws")
              await Fs.mkdir(ws, { recursive: true })
              NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })
              await PackageTree.runGit(ws, ["config", "user.email", "test@example.com"])
              await PackageTree.runGit(ws, ["config", "user.name", "Test"])

              await Fs.writeFile(NodePath.join(ws, "bad.bin"), Buffer.from([0xff, 0xfe, 0x80, 0xc0]))
              await Fs.writeFile(NodePath.join(ws, ".gitignore"), "ignored-dir/\n*.ign\n")
              await Fs.writeFile(NodePath.join(ws, "tracked.txt"), "hello\n")
              await PackageTree.runGit(ws, ["add", "bad.bin", ".gitignore", "tracked.txt"])
              await PackageTree.runGit(ws, ["commit", "-m", "init"])
              await expect(PackageTree.runGit(ws, ["cat-file", "-p", "HEAD:bad.bin"])).rejects.toThrow(/UTF-8/)

              const cacheDir = ".cache"
              await Fs.mkdir(NodePath.join(ws, "ignored-dir"), { recursive: true })
              await Fs.writeFile(NodePath.join(ws, "a.ign"), "v1")
              await Fs.writeFile(NodePath.join(ws, "b.ign"), "v2")
              const snap = await PackageTree.snapshotTree(ws, cacheDir)
              const ign = await PackageTree.snapshotIgnored(ws, cacheDir)
              await Fs.writeFile(NodePath.join(ws, "a.ign"), "modified")
              await Fs.unlink(NodePath.join(ws, "b.ign"))
              const changedIgn = await PackageTree.changedIgnored(ign, cacheDir)
              expect(changedIgn).toContain("a.ign")
              expect(changedIgn).toContain("b.ign")
              await PackageTree.revertIgnored(ign, "a.ign")
              await PackageTree.revertIgnored(ign, "b.ign")
              expect(await Fs.readFile(NodePath.join(ws, "a.ign"), "utf8")).toBe("v1")
              await PackageTree.releaseIgnored(ign)

              await Fs.mkdir(NodePath.join(ws, "extra-untracked-dir/nested"), { recursive: true })
              await Fs.writeFile(NodePath.join(ws, "extra-untracked-dir/nested/f.txt"), "x")
              await PackageTree.revertPath(snap, "extra-untracked-dir")
              await PackageTree.releaseSnapshot(snap)

              await Fs.mkdir(NodePath.join(ws, "out"), { recursive: true })
              await Fs.writeFile(NodePath.join(ws, "out/big.txt"), "B".repeat(200))
              await Fs.symlink("big.txt", NodePath.join(ws, "out/link.txt"))
              await expect(
                PackageTree.captureOutDir(ws, cacheDir, "out", ws, {
                  ...PackageTree.outDirLimits,
                  fileBytes: 50
                })
              ).rejects.toThrow()

              const outsideDir = NodePath.join(dir, "outside")
              await Fs.mkdir(NodePath.join(outsideDir, "out"), { recursive: true })
              await Fs.symlink(outsideDir, NodePath.join(ws, "symparent"))
              await expect(
                PackageTree.captureOutDir(ws, cacheDir, "symparent/out")
              ).rejects.toThrow(/outside the workspace|symlink/)

              await Fs.writeFile(NodePath.join(ws, "notadir"), "file")
              const manifestTmp = await PackageTree.captureOutDir(ws, cacheDir, "out")
              await expect(
                PackageTree.materializeManifest(ws, cacheDir, { ...manifestTmp, outDir: "notadir/out" })
              ).rejects.toThrow(/readable parent directory|EEXIST/)

              const manifest = await PackageTree.captureOutDir(ws, cacheDir, "out")
              await Fs.chmod(NodePath.join(ws, "out/big.txt"), 0o755)
              expect(await PackageTree.treeMatchesManifest(ws, manifest)).toContain("mode")
              await Fs.chmod(NodePath.join(ws, "out/big.txt"), 0o644)

              await Fs.unlink(NodePath.join(ws, "out/link.txt"))
              await Fs.symlink("other.txt", NodePath.join(ws, "out/link.txt"))
              expect(await PackageTree.treeMatchesManifest(ws, manifest)).toContain("symlink")
              await Fs.unlink(NodePath.join(ws, "out/link.txt"))
              await Fs.symlink("big.txt", NodePath.join(ws, "out/link.txt"))

              await Fs.mkdir(NodePath.join(ws, "out/extra/deep"), { recursive: true })
              expect(await PackageTree.treeMatchesManifest(ws, manifest)).toBeDefined()
              await Fs.rm(NodePath.join(ws, "out/extra"), { recursive: true, force: true })

              const badManifest = {
                ...manifest,
                entries: [{ kind: "file" as const, path: "../escape.txt", digest: "0".repeat(64), mode: 0o644, size: 1 }]
              }
              await expect(PackageTree.materializeManifest(ws, cacheDir, badManifest as never)).rejects.toThrow(/leaves the outDir/)

              const lockOwner = NodeCrypto.createHash("sha256").update(NodePath.join(ws, "out")).digest("hex")
              const lockPath = NodePath.join(ws, `.smthrs-lock-${lockOwner}`)
              await Fs.mkdir(lockPath)
              await expect(PackageTree.materializeManifest(ws, cacheDir, manifest)).rejects.toThrow(/publication lock exists/)
              await Fs.rmdir(lockPath)
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Cache local limits & remote HTTP 429-date/503/403/500/bad-json/limitWarned/hydrate", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            await withTempDir("wave9j-cache-", async (dir) => {
              const local = await Cache.openCache({ workspaceRoot: dir, cacheDirectory: "local" })
              await expect(
                local.put("k-big", makeCachedResult("k-big", { blob: "x".repeat(Cache.entryLimit + 128) }))
              ).rejects.toThrow(/exceeds its|exceeding its limit/)

              const sparse: Array<unknown> = []
              sparse[2] = "hole"
              await expect(
                local.put("k-sparse", makeCachedResult("k-sparse", { arr: sparse }))
              ).rejects.toThrow(/invalid array|sparse/)

              await expect(
                Cache.openCache({
                  workspaceRoot: dir,
                  cacheDirectory: "r-bad-url",
                  endpoint: "http://127.0.0.1:1/\uD800"
                })
              ).rejects.toThrow(/bounded well-formed text/)

              const badTokCache = await Cache.openCache({
                workspaceRoot: dir,
                cacheDirectory: "r-bad-tok",
                endpoint: "http://127.0.0.1:1",
                readToken: () => "tok\nnewline"
              })
              expect(await badTokCache.get("k-tok")).toBeNull()

              let mode: "429-date" | "503" | "403" | "500" | "huge-get" = "429-date"
              const server = NodeHttp.createServer((req, res) => {
                const chunks: Array<Buffer> = []
                req.on("data", (c) => chunks.push(c as Buffer))
                req.on("end", () => {
                  if (mode === "429-date") {
                    res.writeHead(429, { "Retry-After": new Date(Date.now() + 200).toUTCString() })
                    res.end("slow down")
                    return
                  }
                  if (mode === "503") {
                    res.writeHead(503)
                    res.end("busy")
                    return
                  }
                  if (mode === "403") {
                    res.writeHead(403)
                    res.end("forbidden")
                    return
                  }
                  if (mode === "500") {
                    res.writeHead(500)
                    res.end("boom")
                    return
                  }
                  if (mode === "huge-get" && req.method === "GET") {
                    res.writeHead(200, { "Content-Type": "application/json" })
                    res.end(
                      JSON.stringify(
                        makeCachedResult("k-miss-1", { big: "Z".repeat(Cache.remoteEntryLimit + 64) })
                      )
                    )
                    return
                  }
                  res.writeHead(404)
                  res.end("not found")
                })
              })
              await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
              const addr = server.address() as { readonly port: number }
              const endpoint = `http://127.0.0.1:${addr.port}`

              try {
                const warnings: Array<string> = []
                for (const nextMode of ["429-date", "503", "403", "500", "huge-get"] as const) {
                  mode = nextMode
                  const c = await Cache.openCache({
                    workspaceRoot: dir,
                    cacheDirectory: `rc-${nextMode}`,
                    endpoint,
                    readToken: () => "tok-r",
                    writeToken: () => "tok-w",
                    warn: (m: string) => warnings.push(m)
                  })
                  await c.get("k-miss-1")
                  await c.put("k-put-1", makeCachedResult("k-put-1", { ok: true }))
                  if (nextMode === "huge-get") {
                    await c.get("k-miss-2")
                  }
                }
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
  }, 60_000)

  it("Cli errors, bench regression (human+agent), results-file fail, affected shard, review, target, GoExec", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            await withTempDir("wave9j-cli-", async (dir) => {
              const emptyDir = NodePath.join(dir, "empty")
              await Fs.mkdir(emptyDir, { recursive: true })
              for (const cmd of [["index"], ["owners"], ["graph"], ["review", "--policy-revision", "HEAD", "--base", "HEAD"]]) {
                const res = await serveCli(emptyDir, cmd)
                expect(res.exitCode !== 0 || res.stdout.includes("error") || res.stderr.length > 0).toBe(true)
              }

              const ws = NodePath.join(dir, "ws")
              await Fs.mkdir(NodePath.join(ws, "lib"), { recursive: true })
              await Fs.mkdir(NodePath.join(ws, "app"), { recursive: true })
              NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })
              await Fs.writeFile(
                NodePath.join(ws, "WORKSPACE.ts"),
                [
                  `import { Smithers as S } from "@smthrs/targets"`,
                  `export const Workspace = S.Workspace("cli9j", {`,
                  `  repository: "git+https://github.com/org/cli9j.git",`,
                  `  cache: S.Cache({ directory: ".cache" }),`,
                  `  flags: S.Flags({ mode: "fast" })`,
                  `})`
                ].join("\n")
              )
              await Fs.writeFile(
                NodePath.join(ws, "lib/PACKAGE.ts"),
                [
                  `import { Smithers as S } from "@smthrs/targets"`,
                  `export const Package = S.Package({`,
                  `  owners: { owners: ["core"] },`,
                  `  targets: {`,
                  `    ok: S.Shell.Test({ shell: "echo ok", data: [S.file("a.txt")] })`,
                  `  }`,
                  `})`
                ].join("\n")
              )
              await Fs.writeFile(NodePath.join(ws, "lib/a.txt"), "v1\n")
              await Fs.writeFile(
                NodePath.join(ws, "app/PACKAGE.ts"),
                [
                  `import { Smithers as S } from "@smthrs/targets"`,
                  `import { Package as Lib } from "../lib/PACKAGE.ts"`,
                  `export const Package = S.Package({`,
                  `  owners: { owners: ["app"] },`,
                  `  targets: {`,
                  `    fail: S.Shell.Test({ shell: "exit 1", data: [Lib.ok] }),`,
                  `    benchTarget: S.Shell.Test({ shell: "printf 'BENCH_METRIC latency 100\\n'", data: [S.file("b.txt")] })`,
                  `  }`,
                  `})`
                ].join("\n")
              )
              await Fs.writeFile(NodePath.join(ws, "app/b.txt"), "b1\n")
              await PackageTree.runGit(ws, ["config", "user.email", "test@example.com"])
              await PackageTree.runGit(ws, ["config", "user.name", "Test"])
              await PackageTree.runGit(ws, ["add", "."])
              await PackageTree.runGit(ws, ["commit", "-m", "init"])

              const baselinePath = NodePath.join(dir, "baseline.json")
              await Fs.writeFile(
                baselinePath,
                JSON.stringify({
                  results: [{ label: "//app:benchTarget", status: "ran", output: { stdout: "BENCH_METRIC latency 1000\n" } }]
                })
              )
              const benchAgent = await serveCli(ws, [
                "test",
                "//app:benchTarget",
                "--baseline",
                baselinePath,
                "--fail-on-regression",
                "5"
              ])
              expect(benchAgent.exitCode !== 0 || benchAgent.stdout.includes("regression")).toBe(true)

              const benchHuman = await serveCli(
                ws,
                ["test", "//app:benchTarget", "--baseline", baselinePath, "--fail-on-regression", "5"],
                { audience: "human", passExit: true }
              )
              expect(benchHuman.exitCode === 1 || benchHuman.stderr.includes("regression")).toBe(true)

              const failHuman = await serveCli(ws, ["test", "//app:fail"], { audience: "human", passExit: true })
              expect(failHuman.exitCode).toBe(1)

              const badResultsDir = NodePath.join(dir, "dir-not-file")
              await Fs.mkdir(badResultsDir)
              const badResults = await serveCli(ws, ["test", "//lib:ok", "--results-file", badResultsDir])
              expect(badResults.exitCode !== 0 || badResults.stdout.includes("results")).toBe(true)

              const badFlag = await serveCli(ws, ["test", "//lib:ok", "--flag", "noSuchFlag=1"])
              expect(badFlag.exitCode !== 0 || badFlag.stdout.includes("noSuchFlag")).toBe(true)

              const bareTarget = await serveCli(ws, ["target", "//lib:ok"])
              if (bareTarget.exitCode !== 0) throw new Error("BARE: " + bareTarget.stdout + " | " + bareTarget.stderr)

              const ownersRes = await serveCli(ws, ["owners", "app/b.txt"])
              expect(ownersRes.stdout).toContain("app")

              await Fs.writeFile(NodePath.join(ws, "lib/a.txt"), "v2\n")
              const affShard = await serveCli(ws, ["affected", "test", "//...", "--base", "HEAD", "--shard", "1/2"])
              expect(affShard.stdout.length + affShard.stderr.length).toBeGreaterThan(0)
              const affPlan = await serveCli(ws, ["affected", "test", "//...", "--base", "HEAD", "--plan"])
              expect(affPlan.stdout.length + affPlan.stderr.length).toBeGreaterThan(0)
              const affBadBase = await serveCli(ws, ["affected", "//...", "--base", "nonexistent-ref-9j"])
              expect(affBadBase.exitCode !== 0 || affBadBase.stdout.includes("error")).toBe(true)

              // GoExec error & probe edge cases
              const goRes = await GoExec.resolveGo({ workspaceRoot: ws, packagePath: "", environment: { PATH: "" } } as never)
              expect(goRes.ok).toBe(false)
              const nixRes = await GoExec.resolveNix("missing-bin", {
                workspaceRoot: ws,
                packagePath: "",
                environment: { PATH: "" },
                nix: { hash: "abc", inputs: [], path: [ws] }
              } as never)
              expect(nixRes.ok).toBe(false)
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 120_000)
})
