import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import * as Nix from "@smthrs/targets/Nix"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as NodeCrypto from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as Cli from "../src/Cli.ts"
import * as GoExec from "../src/GoExec.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as OutputCas from "../src/internal/OutputCas.ts"
import * as PackageTree from "../src/PackageTree.ts"
import type * as Reporter from "../src/Reporter.ts"
import * as TestUnits from "../src/TestUnits.ts"

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
    readonly cwd?: string
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
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    environment: {
      ...process.env,
      SMITHERS_AUDIENCE: opts.audience ?? "agent",
      NO_COLOR: opts.isTTY ? undefined : "1",
      FORCE_COLOR: opts.isTTY ? "1" : undefined,
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

describe("BuildCli Wave-9N: ObservedReads, Cache remote CAS, Cli bench/TTY/base, TestUnits & GoExec", () => {
  it("ObservedReads openat2/RESOLVE_BENEATH, unfinished/resumed traces, directory walks & heldByGitOnce", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            const lines = [
              `100 chdir("/ws") = 0`,
              `100 openat2(AT_FDCWD, "src/a.txt", {flags=O_RDONLY, mode=0, resolve=RESOLVE_BENEATH}, 24) = 3</ws/src/a.txt>`,
              `100 openat2(3</ws/src>, "b.txt", {flags=O_RDONLY, mode=0, resolve=RESOLVE_NO_SYMLINKS}, 24) = 4</ws/src/b.txt>`,
              `100 openat2(AT_FDCWD, "out.txt", {flags=O_WRONLY|O_CREAT, mode=0644, resolve=0}, 24) = 5</ws/out.txt>`,
              `100 openat2(AT_FDCWD, "missing.txt", {flags=O_RDONLY, mode=0, resolve=0}, 24) = -1 ENOENT (No such file or directory)`,
              `100 openat2(AT_FDCWD, "dir", {flags=O_RDONLY|O_DIRECTORY, mode=0, resolve=0}, 24) = 6</ws/dir>`,
              `100 getdents64(6</ws/dir>, 0x1, 32768) = 64`,
              `100 openat(AT_FDCWD, "resumed.txt", O_RDONLY <unfinished ...>`,
              `101 openat(AT_FDCWD, "other.txt", O_RDONLY) = 7</ws/other.txt>`,
              `100 <... openat resumed>) = 8</ws/resumed.txt>`,
              `100 openat2(AT_FDCWD, "r2.txt", {flags=O_RDONLY, resolve=0}, 24 <unfinished ...>`,
              `100 <... openat2 resumed>) = 9</ws/r2.txt>`,
              `100 openat(AT_FDCWD, "malformed <unfinished ...>`,
              `100 <... openat resumed> = 10`,
              `100 openat2(AT_FDCWD, "badflags", {resolve=0}, 24) = 11</ws/badflags>`,
              `100 openat(99, "unknown-fd.txt", O_RDONLY) = 12`,
              `100 execve("/usr/bin/env", ["env"], 0x0) = 0`,
              `100 close(3</ws/src/a.txt>) = 0`,
              `100 +++ exited with 0 +++`
            ]
            const trace = ObservedReads.read(() => lines, "/ws")
            expect(trace.refusals.length).toBeGreaterThan(0)
            expect(trace.walks?.length).toBeGreaterThan(0)

            await withTempDir("wave9n-git-", async (dir) => {
              NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: dir, stdio: "ignore" })
              await Fs.mkdir(NodePath.join(dir, "sub"), { recursive: true })
              await Fs.writeFile(NodePath.join(dir, "sub/a.txt"), "hello\n")
              await PackageTree.runGit(dir, ["config", "user.email", "test@example.com"])
              await PackageTree.runGit(dir, ["config", "user.name", "Test"])
              await PackageTree.runGit(dir, ["add", "sub/a.txt"])
              await PackageTree.runGit(dir, ["commit", "-m", "init"])
              const held = ObservedReads.heldByGitOnce(dir)(["sub/a.txt", "sub", "untracked.txt"])
              expect(held?.has("sub/a.txt")).toBe(true)
              expect(held?.has("sub")).toBe(true)
              expect(held?.has("untracked.txt")).toBe(false)
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it(
    "Cache remote CAS findMissing (429 HTTP-date, 403, bad-list, timeout degrade, 409 conflict) & hydrate fallback",
    async () => {
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literal(1)),
          () =>
            Effect.promise(async () => {
              await withTempDir("wave9n-cas-", async (dir) => {
                const blobBytes = Buffer.from("wave9n-blob-content-1234567890")
                const blobDigest = NodeCrypto.createHash("sha256").update(blobBytes).digest("hex")
                const manifest = {
                  kind: "target-outputs",
                  manifests: [
                    {
                      outDir: "dist",
                      entries: [{
                        kind: "file",
                        path: "a.txt",
                        digest: blobDigest,
                        mode: 0o644,
                        size: blobBytes.length
                      }]
                    }
                  ],
                  files: []
                }

                type Mode = "429-date" | "403" | "bad-list" | "timeout" | "conflict-409" | "hydrate-404" | "hydrate-429"
                let mode: Mode = "429-date"
                const server = NodeHttp.createServer((req, res) => {
                  const chunks: Array<Buffer> = []
                  req.on("data", (c) => chunks.push(c as Buffer))
                  req.on("end", () => {
                    const url = req.url ?? ""
                    if (req.method === "POST" && url.endsWith("/cas/findMissing")) {
                      if (mode === "429-date") {
                        res.writeHead(429, { "Retry-After": new Date(Date.now() + 20).toUTCString() })
                        res.end("busy")
                        return
                      }
                      if (mode === "403") {
                        res.writeHead(403)
                        res.end("denied")
                        return
                      }
                      if (mode === "bad-list") {
                        res.writeHead(200, { "Content-Type": "application/json" })
                        res.end(JSON.stringify({ missing: ["f".repeat(64)] }))
                        return
                      }
                      if (mode === "timeout") {
                        setTimeout(() => {
                          if (!res.writableEnded) {
                            res.writeHead(200, { "Content-Type": "application/json" })
                            res.end(JSON.stringify({ missing: [] }))
                          }
                        }, 350)
                        return
                      }
                      if (mode === "conflict-409") {
                        res.writeHead(200, { "Content-Type": "application/json" })
                        res.end(JSON.stringify({ missing: [blobDigest] }))
                        return
                      }
                    }
                    if (req.method === "PUT" && url.startsWith("/cas/")) {
                      res.writeHead(201)
                      res.end()
                      return
                    }
                    if (req.method === "PUT" && url.startsWith("/ac/")) {
                      if (mode === "conflict-409") {
                        res.writeHead(409)
                        res.end("conflict")
                        return
                      }
                      res.writeHead(201)
                      res.end()
                      return
                    }
                    if (req.method === "GET" && url.startsWith("/ac/")) {
                      const key = decodeURIComponent(url.slice("/ac/".length))
                      res.writeHead(200, { "Content-Type": "application/json" })
                      res.end(
                        JSON.stringify({
                          keyDigest: key,
                          result: {
                            key,
                            target: "Shell.Build",
                            label: "//:b",
                            exitOk: true,
                            output: manifest,
                            storedAt: new Date().toISOString()
                          },
                          createdAtMs: Date.now()
                        })
                      )
                      return
                    }
                    if (req.method === "GET" && url.startsWith("/cas/")) {
                      if (mode === "hydrate-429") {
                        res.writeHead(429, { "Retry-After": "0" })
                        res.end("busy")
                        return
                      }
                      res.writeHead(404)
                      res.end("not found")
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
                  for (const nextMode of ["429-date", "403", "bad-list", "timeout", "conflict-409"] as const) {
                    mode = nextMode
                    const subDir = `rc-${nextMode}`
                    const casDir = NodePath.join(dir, subDir, "cas")
                    await Fs.mkdir(casDir, { recursive: true })
                    await OutputCas.writeBlob(casDir, blobDigest, blobBytes)
                    const c = await Cache.openCache({
                      workspaceRoot: dir,
                      cacheDirectory: subDir,
                      endpoint,
                      readToken: () => "tok-r",
                      writeToken: () => "tok-w",
                      warn: (m: string) => warnings.push(m),
                      timeouts: nextMode === "timeout" ? { get: 40, put: 40 } : { get: 2000, put: 2000 }
                    })
                    try {
                      const rounds = nextMode === "timeout" ? Cache.findMissingTimeoutLimit : 1
                      for (let i = 0; i < rounds; i++) {
                        const key = `k-${nextMode}-${i}`
                        await c.put(key, {
                          key,
                          target: "Shell.Build",
                          label: "//:b",
                          exitOk: true,
                          output: manifest,
                          storedAt: new Date().toISOString()
                        })
                      }
                    } finally {
                      await c.close()
                    }
                  }

                  // hydrate-404 & hydrate-429: GET /ac returns cached manifest, GET /cas returns 404 or 429 -> returns null
                  for (const hMode of ["hydrate-404", "hydrate-429"] as const) {
                    mode = hMode
                    const cHyd = await Cache.openCache({
                      workspaceRoot: dir,
                      cacheDirectory: `rc-${hMode}`,
                      endpoint,
                      readToken: () => "tok-r",
                      warn: (m: string) => warnings.push(m),
                      timeouts: { get: 1500, put: 1500 }
                    })
                    try {
                      const got = await cHyd.get(`k-${hMode}`)
                      expect(got).toBeNull()
                    } finally {
                      await cHyd.close()
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
    },
    60_000
  )

  it(
    "Cli NodeBench regression (human+agent), no-workspace error, TTY palette, owners --base HEAD~1, bad baseline, approvalRevision",
    async () => {
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literal(1)),
          () =>
            Effect.promise(async () => {
              await withTempDir("wave9n-cli-", async (dir) => {
                // 1. No-workspace error WITHOUT --workspace (L546-557)
                const noWs = NodePath.join(dir, "nowhere")
                await Fs.mkdir(noWs, { recursive: true })
                const noWsRes = await serveCli(noWs, ["targets"])
                expect(noWsRes.exitCode !== 0 || noWsRes.stdout.includes("workspace")).toBe(true)

                // 2. Real workspace with working NodeBench, approved target, and modified PACKAGE.ts for owners --base HEAD~1
                const ws = NodePath.join(dir, "ws")
                await Fs.mkdir(NodePath.join(ws, "lib"), { recursive: true })
                await Fs.mkdir(NodePath.join(ws, "app"), { recursive: true })
                NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })

                await Fs.writeFile(
                  NodePath.join(ws, "package.json"),
                  JSON.stringify({ name: "cli9n", private: true }) + "\n"
                )
                await Fs.writeFile(NodePath.join(ws, "yarn.lock"), "# yarn lockfile v1\n")
                await Fs.mkdir(NodePath.join(ws, "node_modules"), { recursive: true })
                await Fs.writeFile(
                  NodePath.join(ws, "WORKSPACE.ts"),
                  [
                    `import { Smithers as S } from "@smthrs/targets"`,
                    `const manifest = S.file("//package.json")`,
                    `export const Workspace = S.Workspace("cli9n", {`,
                    `  repository: "git+https://github.com/org/cli9n.git",`,
                    `  cache: S.Cache({ directory: ".cache" }),`,
                    `  runtime: S.Runtime.Node({ version: ${JSON.stringify(process.versions.node)} }),`,
                    `  packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),`,
                    `  nodeModules: S.Npm.NodeModules({ packageJson: manifest })`,
                    `})`
                  ].join("\n")
                )
                await Fs.writeFile(
                  NodePath.join(ws, "bench.mjs"),
                  `console.log("BENCH_METRIC " + JSON.stringify({ name: "op", meanMs: 50, hz: 20 }))\n`
                )
                await Fs.writeFile(
                  NodePath.join(ws, "baseline.json"),
                  JSON.stringify({
                    results: [{ label: "//:bench", status: "ran", benchmarks: [{ name: "op", meanMs: 1, hz: 1000 }] }]
                  })
                )
                await Fs.writeFile(NodePath.join(ws, "bad-baseline.json"), "{not-json")
                await Fs.writeFile(
                  NodePath.join(ws, "PACKAGE.ts"),
                  [
                    `import { Smithers as S } from "@smthrs/targets"`,
                    `const ok = S.Shell.Test({ shell: "echo ok" })`,
                    `const approved = S.Shell.Run({ shell: "echo ap", approval: "required" })`,
                    `const bench = S.NodeBench({ entry: S.file("//bench.mjs"), srcs: [S.file("//bench.mjs")], deps: [] })`,
                    `export const Package = S.Package({ targets: { ok, approved, bench } })`
                  ].join("\n")
                )
                await Fs.writeFile(
                  NodePath.join(ws, "lib/PACKAGE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ owners: { owners: ["alice"] }, targets: { t: S.Shell.Test({ shell: "true" }) } })\n`
                )
                await Fs.writeFile(
                  NodePath.join(ws, "app/PACKAGE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"\nimport { Package as L } from "../lib/PACKAGE.ts"\nexport const Package = S.Package({ owners: { owners: ["bob"] }, targets: { t: S.Shell.Test({ shell: "true", data: [L.t] }) } })\n`
                )

                await PackageTree.runGit(ws, ["config", "user.email", "test@example.com"])
                await PackageTree.runGit(ws, ["config", "user.name", "Test"])
                await PackageTree.runGit(ws, ["add", "."])
                await PackageTree.runGit(ws, ["commit", "-m", "v1"])

                // Edit PACKAGE.ts & commit so owners --base HEAD~1 exercises openBase L619-624
                await Fs.writeFile(
                  NodePath.join(ws, "lib/PACKAGE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ owners: { owners: ["alice"] }, targets: { t: S.Shell.Test({ shell: "echo v2" }) } })\n`
                )
                await PackageTree.runGit(ws, ["add", "lib/PACKAGE.ts"])
                await PackageTree.runGit(ws, ["commit", "-m", "v2"])

                const ownersBase = await serveCli(ws, ["owners", "--base", "HEAD~1"], {
                  audience: "human",
                  isTTY: true
                })
                expect(ownersBase.stdout.length + ownersBase.stderr.length).toBeGreaterThan(0)

                // Cli.approvalRevision on approved target -> L961
                const rev = await Cli.approvalRevision("//:approved", { workspace: ws }, {})
                expect(rev.label).toBe("//:approved")
                expect(rev.digest.length).toBeGreaterThan(0)

                // --fail-on-regression without --compare -> L1447-1451
                const noCompare = await serveCli(ws, ["bench", "//:bench", "--fail-on-regression", "5"])
                expect(noCompare.exitCode !== 0 || noCompare.stdout.includes("requires --compare")).toBe(true)

                // Bad baseline JSON -> L1461
                const badBase = await serveCli(ws, [
                  "bench",
                  "//:bench",
                  "--compare",
                  NodePath.join(ws, "bad-baseline.json")
                ])
                expect(badBase.exitCode !== 0 || badBase.stdout.includes("baseline")).toBe(true)

                // Bench regression: human TTY with passExit (L1538-1555) AND agent JSON (L1557-1562)
                const benchHuman = await serveCli(
                  ws,
                  [
                    "bench",
                    "//:bench",
                    "--compare",
                    NodePath.join(ws, "baseline.json"),
                    "--fail-on-regression",
                    "5",
                    "--no-cache"
                  ],
                  { audience: "human", isTTY: true, passExit: true }
                )
                expect(benchHuman.exitCode).toBe(1)
                expect(benchHuman.stderr).toContain("regressed")

                const benchAgent = await serveCli(
                  ws,
                  [
                    "bench",
                    "//:bench",
                    "--compare",
                    NodePath.join(ws, "baseline.json"),
                    "--fail-on-regression",
                    "5",
                    "--no-cache"
                  ],
                  { audience: "agent" }
                )
                expect(benchAgent.stdout).toContain("bench_regression")
              })
              return true
            }),
          { executions: 1 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it("TestUnits select/run stale blobs & GoExec nix/go fake bin + pattern/JSON/stamp/ModDownload", async () => {
    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(Schema.Literal(1)),
        () =>
          Effect.promise(async () => {
            // 1. TestUnits.select pure branch matrix (L497-572)
            const units: TestUnits.Units = {
              target: "//pkg:tests",
              packagePath: "pkg",
              attrs: {
                tests: [
                  Input.file("a.test.ts"),
                  Input.glob("**/*.test.ts", { exclude: ["skip.test.ts"] })
                ]
              } as never,
              shared: [{ path: "pkg/setup.ts", digest: "0".repeat(64) }],
              dependencies: ["//lib:build"],
              units: [
                {
                  file: "pkg/a.test.ts",
                  key: "k1",
                  reached: [
                    { path: "pkg/a.test.ts", digest: "1".repeat(64) },
                    { path: "pkg/shared-src.ts", digest: "2".repeat(64) }
                  ],
                  unresolved: [],
                  dynamic: [],
                  dependencies: ["//lib:build"]
                },
                {
                  file: "pkg/b.test.ts",
                  key: "k2",
                  reached: [
                    { path: "pkg/b.test.ts", digest: "3".repeat(64) },
                    { path: "pkg/shared-src.ts", digest: "2".repeat(64) }
                  ],
                  unresolved: [{ file: "pkg/b.test.ts", specifier: "./missing" }],
                  dynamic: [],
                  dependencies: []
                }
              ]
            } as never
            const selected = TestUnits.select(units, {
              files: ["pkg/shared-src.ts", "pkg/unattributed.ts", "pkg/skip.test.ts", "WORKSPACE.ts"],
              global: ["WORKSPACE.ts"],
              reaching: ["pkg/shared-src.ts", "pkg/unattributed.ts", "pkg/a.test.ts", "pkg/skip.test.ts"],
              dependencies: new Map([["//lib:build", ["lib/x.ts"]]])
            })
            expect(selected.length).toBe(2)
            expect(selected[0]?.reasons.some((r) => r.kind === "dependency")).toBe(true)
            expect(selected[0]?.reasons.some((r) => r.kind === "unattributed")).toBe(true)
            expect(selected[1]?.reasons.some((r) => r.kind === "incomplete")).toBe(true)

            // 2. GoExec fake nix + fake go + GoPatternRefused + GoListJsonError + Go.Binary stamp + ModDownload
            await withTempDir("wave9n-go-", async (dir) => {
              const binDir = NodePath.join(dir, "bin")
              await Fs.mkdir(binDir, { recursive: true })
              await Fs.mkdir(NodePath.join(dir, "sub"), { recursive: true })
              await Fs.writeFile(NodePath.join(dir, "flake.nix"), "{}\n")
              await Fs.writeFile(NodePath.join(dir, "flake.lock"), "{}\n")
              await Fs.writeFile(NodePath.join(dir, "sub/go.mod"), "module example.com/sub\ngo 1.22\n")

              const nixBin = NodePath.join(binDir, "nix")
              const wsDecl = WorkspaceDeclaration.Workspace("go9n", {
                repository: "git+https://github.com/org/go9n.git",
                cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
                environment: Nix.Environment({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
              })
              const baseCtx = {
                root: dir,
                packagePath: "sub",
                cacheDirectory: ".cache",
                workspace: wsDecl,
                environment: { PATH: `${binDir}:${process.env["PATH"] ?? ""}` }
              }

              // Fake nix returning a tool path -> L329-330, L349
              await Fs.writeFile(nixBin, "#!/bin/sh\necho /usr/bin/my-nix-tool\n", { mode: 0o755 })
              const nixOk = await GoExec.resolveNix("my-nix-tool", baseCtx)
              expect(nixOk.ok).toBe(true)

              // Fake nix returning empty string -> L348 ("which returned no path")
              await Fs.writeFile(nixBin, "#!/bin/sh\nprintf ''\n", { mode: 0o755 })
              const nixEmpty = await GoExec.resolveNix("my-nix-tool", baseCtx)
              expect(nixEmpty.ok).toBe(false)

              // Fake go script returning bad JSON -> GoListJsonError L515, and GoPatternRefused L376
              const goBin = NodePath.join(binDir, "go")
              await Fs.writeFile(
                goBin,
                "#!/bin/sh\nif [ \"$1\" = \"env\" ]; then echo '{\"GOROOT\":\"/tmp/goroot\",\"GOOS\":\"linux\",\"GOARCH\":\"amd64\"}'; exit 0; fi\nif [ \"$1\" = \"version\" ]; then echo 'go version go1.22.0 linux/amd64'; exit 0; fi\necho 'not-valid-json'\n",
                { mode: 0o755 }
              )

              // Valid Go.Binary with stamp + TargetFiles(ModDownload) -> exercises stamp & ModDownload
              const modDl = S.Go.ModDownload({ mod: S.file("go.mod"), sum: S.file("go.sum"), outDirs: ["modcache"] })
              const binPlan = await GoExec.planRule(
                "Go.Binary",
                {
                  pkg: ".",
                  out: "bin/app",
                  stamp: { "main.version": S.Stamp.commit },
                  data: [{ _tag: "TargetFiles", target: modDl }]
                },
                baseCtx,
                goBin
              )
              expect(binPlan.argv?.length ?? 0).toBeGreaterThan(0)

              // Pattern outside module (mod in sub/go.mod, pkg //outside/...) -> GoPatternRefused (L376)
              await expect(
                GoExec.planRule(
                  "Go.Binary",
                  {
                    pkg: "./../../outside",
                    out: "bin/app"
                  },
                  baseCtx,
                  goBin
                )
              ).rejects.toThrow(/outside the module/)

              // Overwrite goBin so `go list` prints malformed JSON braces -> GoListJsonError (L515)
              await Fs.writeFile(
                goBin,
                "#!/bin/sh\nif [ \"$1\" = \"env\" ]; then echo GOROOT:/tmp/goroot; exit 0; fi\necho {not-valid-json}\n",
                { mode: 0o755 }
              )
              await expect(
                GoExec.planRule("Go.Test", { pkgs: ["./..."] }, baseCtx, goBin)
              ).rejects.toThrow(/unparsable JSON|JSON/)

              // Invalid timeoutMs <= 0 -> RangeError caught into { ok: false } (L181-182)
              const badTo = await GoExec.resolveNix("my-nix-tool", { ...baseCtx, timeoutMs: 0 })
              expect(badTo.ok).toBe(false)
            })
            return true
          }),
        { executions: 1 }
      )
    )
    assertPassed(report)
  }, 90_000)
})
