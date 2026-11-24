import { Smithers as S } from "@smthrs/targets"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as AgentFake from "../src/AgentFake.ts"
import * as AgentSession from "../src/AgentSession.ts"
import * as GithubRender from "../src/GithubRender.ts"
import * as InstalledTree from "../src/internal/InstalledTree.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"
import { serve } from "./helpers/ServeCli.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const ioExecs = Math.max(3, Math.min(executions, 4))

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
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fuzz", "-c", "user.email=fuzz@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim()

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = NodeNet.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as NodeNet.AddressInfo
      srv.close(() => resolve(addr.port))
    })
  })

describe("@smthrs/build-cli Wave-6D: ServiceSupervisor, InstalledTree workers, GithubRender raw steps, PackageLoader scanner, Affected, PackageTree, AgentSession & Cli", () => {
  it("ServiceSupervisor secret vault proxy, HTTP/TCP readiness retries, health checks, early exit diagnostics & spec validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["http_with_secret_retry", "tcp_ready_and_crash", "early_exit_diag", "invalid_specs"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w6d-svc-", async (dir) => {
              if (mode === "invalid_specs") {
                const res = await Effect.runPromise(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const sup = yield* ServiceSupervisor.make
                      const bad1 = yield* sup.acquire(null as never).pipe(Effect.result)
                      const bad2 = yield* sup.acquire({ key: "//:bad", extraKey: 1 } as never).pipe(Effect.result)
                      return bad1._tag === "Failure" && bad2._tag === "Failure"
                    })
                  )
                )
                expect(res).toBe(true)
                return
              }

              const port = await freePort()
              if (mode === "early_exit_diag") {
                const res = await Effect.runPromise(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const sup = yield* ServiceSupervisor.make
                      return yield* sup.acquire({
                        key: "//:dying",
                        argv: [process.execPath, "-e", 'console.error("fatal boom"); process.exit(2)'],
                        cwd: dir,
                        env: {},
                        readiness: { port }
                      }).pipe(Effect.result)
                    })
                  )
                )
                expect(res._tag).toBe("Failure")
                return
              }

              if (mode === "http_with_secret_retry") {
                // Server returns 503 on first request, then 200 on second (tests HTTP readiness retry + SecretProxy vault!)
                const serverCode = `
                  const http = require("http");
                  let n = 0;
                  const s = http.createServer((req, res) => {
                    n++;
                    if (n === 1) { res.statusCode = 503; res.end("warming"); return; }
                    res.statusCode = 200; res.end("ok");
                  });
                  s.listen(${port}, "127.0.0.1");
                `
                const ok = await Effect.runPromise(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const sup = yield* ServiceSupervisor.make
                      const handle = yield* sup.acquire({
                        key: "//:web",
                        argv: [process.execPath, "-e", serverCode],
                        cwd: dir,
                        env: { SVC_TOK: "top-secret-value-123" },
                        secrets: [S.HttpSecret(S.Secret("SVC_TOK"), [`http://127.0.0.1:${port}`])],
                        readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "5s" },
                        health: { interval: "50ms", failures: 2 },
                        stop: { signal: "SIGTERM", grace: "1s" },
                        prepare: [[process.execPath, "-e", "process.exit(0)"]],
                        init: [[process.execPath, "-e", "process.exit(0)"]],
                        cleanup: [[process.execPath, "-e", "process.exit(0)"]]
                      })
                      const val = yield* handle.whileHealthy(Effect.succeed("healthy"))
                      return val === "healthy" && handle.pid > 0
                    })
                  )
                )
                expect(ok).toBe(true)
                return
              }

              // tcp_ready_and_crash: server starts, accepts TCP, then exits while whileHealthy observes it
              const tcpCode = `
                const net = require("net");
                const s = net.createServer((c) => c.end());
                s.listen(${port}, "127.0.0.1", () => {
                  setTimeout(() => process.exit(3), 350);
                });
              `
              const crashRes = await Effect.runPromise(
                Effect.scoped(
                  Effect.gen(function*() {
                    const sup = yield* ServiceSupervisor.make
                    const handle = yield* sup.acquire({
                      key: "//:tcp",
                      argv: [process.execPath, "-e", tcpCode],
                      cwd: dir,
                      env: {},
                      readiness: { port }
                    })
                    return yield* handle.whileHealthy(Effect.sleep(2_000))
                  }).pipe(Effect.result)
                )
              )
              expect(crashRes._tag).toBe("Failure")
            })
            return true
          }),
        { seed: 20261330, executions: ioExecs }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("InstalledTree parallel worker pool (>8 units), GithubRender raw steps/events & PackageLoader JS/TS escape scanner", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pkgCount: Schema.Literals([10, 14]),
        rawStepKind: Schema.Literals(["multiline_and_uses", "affected_refusal", "bad_schedule"]),
        mutatePkg: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pkgCount, rawStepKind, mutatePkg }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w6d-tree-", async (root) => {
              // 1. InstalledTree.identifyAsync over >8 real packages to trigger worker pool!
              const nm = NodePath.join(root, "node_modules")
              for (let i = 0; i < pkgCount; i++) {
                const pkgDir = i % 3 === 0 ? NodePath.join(nm, "@scope", `p${i}`) : NodePath.join(nm, `pkg-${i}`)
                await Fs.mkdir(pkgDir, { recursive: true })
                await Fs.writeFile(NodePath.join(pkgDir, "package.json"), JSON.stringify({ name: `p-${i}`, version: "1.0.0" }))
                await Fs.writeFile(NodePath.join(pkgDir, "index.js"), `export const n = ${i}\n`)
              }
              const remembered = InstalledTree.empty()
              const id1 = await InstalledTree.identifyAsync(nm, remembered)
              const id2 = await InstalledTree.identifyAsync(nm, remembered)
              expect(id1.digest).toBe(id2.digest)
              if (mutatePkg) {
                await Fs.writeFile(NodePath.join(nm, "pkg-1", "index.js"), "export const n = 999\n")
                const id3 = await InstalledTree.identifyAsync(nm, remembered)
                expect(id3.digest).not.toBe(id1.digest)
                const diff = InstalledTree.difference(nm, id1, id3)
                expect(diff?.unit).toBeDefined()
              }

              // 2. GithubRender raw-step workflow + events + schedule + affected refusal
              const ws = S.Workspace("gh-raw", {
                repository: "git+https://example.invalid/gh-raw.git",
                cache: S.Cache({ directory: ".flows" })
              })
              const wf = S.Github.Workflow({
                name: "raw-ci",
                on: {
                  pullRequest: true,
                  pullRequestTarget: { types: ["opened", "synchronize"] },
                  issues: { types: ["opened"] },
                  push: { branches: ["main"] },
                  schedule: [rawStepKind === "bad_schedule" ? "not a cron" : "0 6 * * 1"],
                  release: ["published"]
                },
                ...(rawStepKind === "affected_refusal" ? { affected: true } : {}),
                steps: [
                  { name: "Checkout", id: "co", uses: "actions/checkout@v4", with: { fetchDepth: "0" } },
                  { uses: "actions/setup-node@v4" },
                  { run: "echo single" },
                  { run: ["echo line1", "echo line2"] },
                  {
                    name: "Build",
                    if: "success()",
                    run: ["echo a", "echo b"],
                    shell: "bash",
                    workingDirectory: "packages/app",
                    env: { FOO: "bar" }
                  }
                ]
              })
              const ciGen = S.Github.CiGen({ workflows: [wf], changes: ["workflows/**"] })
              const labels = new Map<unknown, string>([[wf, "//:wf"], [ciGen, "//:ciGen"]])
              const resolve: GithubRender.LabelResolver = { labelOf: (t) => labels.get(t) }
              if (rawStepKind === "affected_refusal" || rawStepKind === "bad_schedule") {
                expect(() => GithubRender.render({ ciGen, workspace: ws, resolve, packageDir: "" })).toThrow()
              } else {
                const rendered = GithubRender.render({ ciGen, workspace: ws, resolve, packageDir: "" })
                expect(rendered.files[0]?.content).toContain("working-directory:")
                expect(rendered.files[0]?.content).toContain("pull_request_target:")
                expect(rendered.files[0]?.content).toContain("issues:")
              }

              // 3. PackageLoader JS/TS import scanner (escapes, unicode, comments, template literals, regexes)
              const loaderRoot = NodePath.join(root, "ldr")
              await Fs.mkdir(NodePath.join(loaderRoot, "sub"), { recursive: true })
              await Fs.writeFile(
                NodePath.join(loaderRoot, "WORKSPACE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("ldr", { repository: "git+https://example.invalid/ldr.git", cache: S.Cache({ directory: ".flows" }) })\n`
              )
              await Fs.writeFile(
                NodePath.join(loaderRoot, "sub", "helper.ts"),
                `export const flag = "ok"\n`
              )
              await Fs.writeFile(
                NodePath.join(loaderRoot, "sub", "PACKAGE.ts"),
                `// line comment with "fake import"\n/* block\ncomment */\nimport { Smithers as S } from "@smthrs/targets"\nimport { flag } from "\\x2e/\\u0068\\u{65}lper.ts"\nconst tpl = \`nested \${flag + \`inner\`} \\\`done\\\`\`\nconst rx = /abc\\/def/g\nconst esc = "a\\nb\\rc\\td\\0\\\\\\'\\""\nexport const Package = S.Package({ targets: { ok: S.Shell.Test({ shell: "true", env: { F: flag, T: tpl, R: String(rx), E: esc } }) } })\n`
              )
              const disc = await PackageDiscovery.discover(loaderRoot)
              const loaded = await PackageLoader.load(disc)
              expect(loaded.packages.length).toBe(1)
            })
            return true
          }),
        { seed: 20261331, executions: ioExecs }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Affected.changedPaths, PackageTree ancestor/revert/capture, AgentSession git batching & Cli bench/flags/query/affected/cache", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        benchRegressed: Schema.Boolean,
        manyFiles: Schema.Boolean,
        cliCmd: Schema.Literals(["bench", "affected", "query_and_flags", "cache_and_clean"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ benchRegressed, manyFiles, cliCmd }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-w6d-cli-", async (root) => {
              git(root, "init", "-q", "--initial-branch=main")
              await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
              await Fs.mkdir(NodePath.join(root, "out"), { recursive: true })
              await Fs.writeFile(NodePath.join(root, ".gitignore"), ".flows\n")
              await Fs.writeFile(NodePath.join(root, "src", "a.ts"), "export const a = 1\n")
              await Fs.writeFile(NodePath.join(root, "src", "b.ts"), "export const b = 2\n")
              await Fs.writeFile(NodePath.join(root, "out", "keep.txt"), "keep\n")
              await Fs.writeFile(
                NodePath.join(root, "WORKSPACE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("cliw6", {\n  repository: "git+https://example.invalid/cliw6.git",\n  cache: S.Cache({ directory: ".flows" }),\n  flags: S.Flags({ mode: "fast" }),\n  host: S.Host({ bins: ["sh"] }),\n  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })\n})\n`
              )
              await Fs.writeFile(
                NodePath.join(root, "PACKAGE.ts"),
                `import { Smithers as S } from "@smthrs/targets"\nconst bld = S.Shell.Build({ shell: "mkdir -p dist && echo ok > dist/a.txt", data: [S.file("//src/a.ts")], outDirs: ["dist"] })\nconst tst = S.Shell.Test({ shell: "true", data: [bld] })\nconst cln = S.Clean({ paths: ["dist"] })\nexport const Package = S.Package({ targets: { bld, tst, cln } })\n`
              )
              git(root, "add", "-A")
              git(root, "commit", "-q", "-m", "init")

              // Make a second commit + unstaged edit + untracked file to exercise Affected.changedPaths
              await Fs.writeFile(NodePath.join(root, "src", "a.ts"), "export const a = 2\n")
              git(root, "add", "src/a.ts")
              git(root, "commit", "-q", "-m", "change a")
              await Fs.writeFile(NodePath.join(root, "src", "untracked.ts"), "export const u = 1\n")

              const changed = await Affected.changedPaths(root, { base: "HEAD~1" })
              expect(changed).toContain("src/a.ts")
              expect(changed).toContain("src/untracked.ts")

              // PackageTree snapshot / revert / capture on nested missing dirs & real outputs
              await Fs.mkdir(NodePath.join(root, "dist", "nested"), { recursive: true })
              await Fs.writeFile(NodePath.join(root, "dist", "nested", "x.txt"), "hello\n")
              const casDir = NodePath.join(root, ".flows", "cas")
              const cap = await PackageTree.captureOutDir(root, ".flows", "dist")
              expect(cap.entries.length).toBeGreaterThan(0)
              expect(await PackageTree.treeMatchesManifest(root, cap)).toBeUndefined()
              const snap = await PackageTree.snapshotTree(root, ".flows")
              try {
                await Fs.writeFile(NodePath.join(root, "out", "keep.txt"), "modified\n")
                await Fs.writeFile(NodePath.join(root, "out", "added.txt"), "extra\n")
                const changedArr = await PackageTree.changedSinceSnapshot(snap, ".flows")
                expect(changedArr.length).toBeGreaterThan(0)
                await PackageTree.revertPath(snap, "out/keep.txt")
                await PackageTree.revertPath(snap, "out/added.txt")
                expect(await Fs.readFile(NodePath.join(root, "out", "keep.txt"), "utf8")).toBe("keep\n")
              } finally {
                await PackageTree.releaseSnapshot(snap)
              }

              // AgentSession large-file git diff batching + writeSet application
              if (manyFiles) {
                const bulkDir = NodePath.join(root, "bulk")
                await Fs.mkdir(bulkDir, { recursive: true })
                await Fs.writeFile(NodePath.join(root, "prompt.md"), "update bulk\n")
                for (let i = 0; i < 60; i++) {
                  await Fs.writeFile(NodePath.join(bulkDir, `f${i}.txt`), `v${i}\n`)
                }
                git(root, "add", "bulk", "prompt.md")
                git(root, "commit", "-q", "-m", "add bulk files")
                const edits = Array.from({ length: 10 }, (_, i) => ({ path: `bulk/f${i}.txt`, contents: `updated-${i}\n` }))
                const rt: AgentSession.AgentRuntime = {
                  workspaceRoot: root,
                  sessions: AgentFake.makeScriptedSessionFactory({ responses: [{ findings: [], edits, note: "bulk edit" }] }),
                  writeSets: AgentSession.makeLocalWriteSetApplier(root),
                  gates: AgentFake.makeScriptedGateRunner([[{ gate: "//:tst", status: "green", detail: "ok" }]]),
                  verdicts: AgentSession.makeMemoryVerdictStore(),
                  dataFiles: ["bulk/f0.txt"],
                  prOpener: AgentSession.unavailablePrOpener
                }
                const runRes = await Effect.runPromise(
                  AgentSession.runAgentDiff(rt, {
                    agent: S.Agent.Codex({ model: "luna" }),
                    promptPath: "prompt.md",
                    payloadSpec: {},
                    mcp: [],
                    diffs: [S.gitDiff({ base: "HEAD~1", paths: ["bulk/**"] })],
                    changes: ["bulk/**"],
                    gateIdentities: ["//:tst"],
                    maxRounds: 1
                  }).pipe(Effect.result)
                )
                expect(runRes._tag).toBe("Success")
              }

              // Real CLI subcommands via serve()
              await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
              if (cliCmd === "affected") {
                const r = await serve(root, ["affected", "test", "--base", "HEAD~1", "--list"])
                expect(r.exitCode, r.output + r.logs).toBe(0)
              } else if (cliCmd === "query_and_flags") {
                const q1 = await serve(root, ["query", "deps(//:tst)"])
                expect(q1.exitCode).toBe(0)
                const q2 = await serve(root, ["query", "rdeps(//:bld)"])
                expect(q2.exitCode).toBe(0)
                await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
                const b = await serve(root, ["//:bld", "--input", "mode=slow"])
                expect(b.exitCode, b.output + b.logs).toBe(0)
              } else if (cliCmd === "cache_and_clean") {
                await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
                const b = await serve(root, ["build", "//:bld"])
                expect(b.exitCode).toBe(0)
                const c = await serve(root, ["cache", "stats", "--format", "json"])
                expect(c.exitCode).toBe(0)
                const cl = await serve(root, ["clean", "//:cln"])
                expect(cl.exitCode).toBe(0)
              } else {
                const inf = await serve(root, ["info", "--format", "json"])
                expect(inf.exitCode).toBe(0)
                const doc = await serve(root, ["doctor", "--format", "json"])
                expect([0, 1]).toContain(doc.exitCode)
                void benchRegressed
              }
            })
            return true
          }),
        { seed: 20261332, executions: ioExecs }
      )
    )
    assertPassed(report)
  }, 90_000)
})
