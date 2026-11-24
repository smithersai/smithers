import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as AgentFake from "../src/AgentFake.ts"
import * as AgentSession from "../src/AgentSession.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { serve } from "./helpers/ServeCli.ts"

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

const writeExecutable = async (path: string, content: string): Promise<void> => {
  await Fs.writeFile(path, content, { mode: 0o755 })
  await Fs.chmod(path, 0o755)
}

const slugArb = Schema.Literals(["aa", "b1", "c2", "d3", "e4", "f5"])

describe("@smthrs/build-cli Wave-6F: ObservedReads deep trace/limits, Cli subcommands/bench/remote, AgentSession diff/payload/mcp & Affected jj/unskipped fuzz", () => {
  it(
    "ObservedReads package-manager execve, ipv6/getsockname/syscall_0x, carry rename, RENAME_EXCHANGE, removedEmpty, whole/askFlush, holdsValue/holdsName & kept limits",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          pmCase: Schema.Literals([
            "npm",
            "pnpm",
            "bun",
            "yarn",
            "uv_sync",
            "uv_run",
            "pip",
            "go",
            "cargo",
            "deno"
          ]),
          keepRefusal: Schema.Literals([
            "ok",
            "git_store",
            "too_many_paths",
            "too_many_bytes",
            "too_many_outside",
            "link_outside"
          ]),
          exchangeKind: Schema.Literals(["dir", "link", "file"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, pmCase, keepRefusal, exchangeKind }) =>
            Effect.promise(async () => {
              // 1. Package-manager locked-install detection + socket/setsockopt/getsockname/syscall_0x + carry directory rename
              const pmArgv: Record<typeof pmCase, string> = {
                npm: `"/usr/bin/npm", ["npm", "ci"]`,
                pnpm: `"/usr/bin/pnpm", ["pnpm", "install", "--frozen-lockfile"]`,
                bun: `"/usr/bin/bun", ["bun", "ci"]`,
                yarn: `"/usr/bin/yarn", ["yarn", "install", "--immutable"]`,
                uv_sync: `"/usr/bin/uv", ["uv", "sync", "--locked"]`,
                uv_run: `"/usr/bin/uv", ["uv", "run", "--frozen", "pytest"]`,
                pip: `"/usr/bin/pip", ["pip", "install", "--require-hashes", "-r", "req.txt"]`,
                go: `"/usr/bin/go", ["go", "mod", "download"]`,
                cargo: `"/usr/bin/cargo", ["cargo", "fetch", "--locked"]`,
                deno: `"/usr/bin/deno", ["deno", "install", "--frozen"]`
              }
              const lines = [
                `100 execve(${pmArgv[pmCase]}, 0x1 /* 1 vars */) = 0`,
                `100 socket(AF_INET6, SOCK_STREAM|SOCK_NONBLOCK, IPPROTO_TCP) = 5<TCP:[1001]>`,
                `100 setsockopt(5<TCP:[1001]>, SOL_IPV6, IPV6_V6ONLY, [0], 4) = 0`,
                `100 setsockopt(5<TCP:[1001]>, SOL_IPV6, IPV6_V6ONLY, [1], 4) = 0`,
                `100 setsockopt(5<TCP:[1001]>, SOL_SOCKET, SO_REUSEPORT, [1], 4) = 0`,
                `100 bind(5<TCP:[1001]>, {sa_family=AF_INET6, sin6_port=htons(0), sin6_addr=inet_pton(AF_INET6, "::1")}, 28) = 0`,
                `100 getsockname(5<TCP:[1001]>, {sa_family=AF_INET6, sin6_port=htons(8443), sin6_addr=inet_pton(AF_INET6, "::1")}, [28]) = 0`,
                `100 listen(5<TCP:[1001]>, 128) = 0`,
                `100 mkdirat(AT_FDCWD, "/ws/src-${slug}", 0755) = 0`,
                `100 openat(AT_FDCWD, "/ws/src-${slug}/file.txt", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 6</ws/src-${slug}/file.txt>`,
                `100 close(6</ws/src-${slug}/file.txt>) = 0`,
                `100 symlinkat("/ws/src-${slug}/file.txt", AT_FDCWD, "/ws/src-${slug}/lnk") = 0`,
                `100 renameat2(AT_FDCWD, "/ws/src-${slug}", AT_FDCWD, "/ws/dst-${slug}", 0) = 0`,
                `100 mkdirat(AT_FDCWD, "/ws/tmp-empty-${slug}", 0755) = 0`,
                `100 unlinkat(AT_FDCWD, "/ws/tmp-empty-${slug}", AT_REMOVEDIR) = 0`,
                `100 syscall_0x9999(1, 2) = -1 ENOSYS`
              ]
              const parsed = ObservedReads.read(() => lines, "/ws")
              expect(parsed.refusals.length).toBeGreaterThanOrEqual(1)

              // 2. holdsValue (UTF-8 non-ASCII + 40-hex commit SHA full & 7-char short) + holdsName (ASCII + UTF-16LE)
              const sha = "0123456789abcdef0123456789abcdef01234567"
              expect(ObservedReads.holdsValue(`hello café-${slug}`, `café-${slug}`)).toBe(true)
              expect(ObservedReads.holdsValue(`commit ${sha.slice(0, 7)} ok`, sha)).toBe(true)
              expect(ObservedReads.holdsValue(`commit ${sha} ok`, sha)).toBe(true)
              expect(ObservedReads.holdsValue(`notshort ${sha.slice(0, 7)}f`, sha)).toBe(false)
              expect(ObservedReads.holdsName(`MY_VAR_${slug}`, `MY_VAR_${slug}`)).toBe(true)
              expect(ObservedReads.holdsName([...`MY_VAR_${slug}`].join("\0"), `MY_VAR_${slug}`)).toBe(true)

              // 3. whole() & askFlush() + observe() with RENAME_EXCHANGE, removedEmpty, and kept limits on real temp dir
              await withTempDir("smthrs-w6f-obs-", async (root) => {
                const traceFile = NodePath.join(root, "trace.log")
                expect(ObservedReads.whole(traceFile)).toBe(false)
                await Fs.writeFile(traceFile, "100 openat(AT_FDCWD, \"/ws/a\", O_RDONLY) = 3\n")
                expect(ObservedReads.whole(traceFile)).toBe(false)
                await Fs.appendFile(traceFile, "100 +++ complete +++\n")
                expect(ObservedReads.whole(traceFile)).toBe(true)

                // askFlush: unanswered times out quickly, answered succeeds immediately
                expect(await ObservedReads.askFlush(traceFile, 15)).toBe(false)
                await Fs.writeFile(`${traceFile}.answered`, "999999\n")
                expect(await ObservedReads.askFlush(traceFile, 50)).toBe(true)

                // RENAME_EXCHANGE trace observation
                const exA = NodePath.join(root, "ex-a")
                const exB = NodePath.join(root, "ex-b")
                if (exchangeKind === "dir") {
                  await Fs.mkdir(exA, { recursive: true })
                  await Fs.mkdir(exB, { recursive: true })
                } else if (exchangeKind === "link") {
                  await Fs.writeFile(NodePath.join(root, "target.txt"), "t")
                  await Fs.symlink(NodePath.join(root, "target.txt"), exA)
                  await Fs.writeFile(exB, "b")
                } else {
                  await Fs.writeFile(exA, "a")
                  await Fs.writeFile(exB, "b")
                }
                const exTrace = ObservedReads.read(
                  () => [
                    `100 renameat2(AT_FDCWD, ${JSON.stringify(exA)}, AT_FDCWD, ${
                      JSON.stringify(exB)
                    }, RENAME_EXCHANGE) = 0`,
                    `100 mkdirat(AT_FDCWD, ${JSON.stringify(NodePath.join(root, "empty-rm"))}, 0755) = 0`,
                    `100 unlinkat(AT_FDCWD, ${JSON.stringify(NodePath.join(root, "empty-rm"))}, AT_REMOVEDIR) = 0`
                  ],
                  root
                )
                const exObs = ObservedReads.observe(exTrace, {
                  root,
                  ignore: [],
                  startedMs: Date.now() - 1000
                })
                if (exchangeKind === "dir" || exchangeKind === "link") {
                  expect("refusal" in exObs ? exObs.refusal : undefined).toContain("RENAME_EXCHANGE")
                }

                // Kept limits & refusal cases on survivors
                const outsideDir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-w6f-out-")))
                try {
                  const traceLines: Array<string> = []
                  if (keepRefusal === "git_store") {
                    await Fs.mkdir(NodePath.join(root, ".git"), { recursive: true })
                    const gf = NodePath.join(root, ".git", "HEAD")
                    await Fs.writeFile(gf, "ref: refs/heads/main\n")
                    traceLines.push(
                      `100 openat(AT_FDCWD, ${JSON.stringify(gf)}, O_WRONLY|O_CREAT|O_TRUNC, 0644) = 4<${gf}>`
                    )
                  } else if (keepRefusal === "too_many_paths") {
                    for (let i = 0; i < 4; i++) {
                      const fp = NodePath.join(root, `p-${i}.txt`)
                      await Fs.writeFile(fp, "x")
                      traceLines.push(
                        `100 openat(AT_FDCWD, ${JSON.stringify(fp)}, O_WRONLY|O_CREAT|O_TRUNC, 0644) = 4<${fp}>`
                      )
                    }
                  } else if (keepRefusal === "too_many_bytes") {
                    const fp = NodePath.join(root, "big.txt")
                    await Fs.writeFile(fp, "x".repeat(256))
                    traceLines.push(
                      `100 openat(AT_FDCWD, ${JSON.stringify(fp)}, O_WRONLY|O_CREAT|O_TRUNC, 0644) = 4<${fp}>`
                    )
                  } else if (keepRefusal === "too_many_outside") {
                    for (let i = 0; i < 3; i++) {
                      const fp = NodePath.join(outsideDir, `out-${i}.txt`)
                      await Fs.writeFile(fp, "o")
                      traceLines.push(
                        `100 openat(AT_FDCWD, ${JSON.stringify(fp)}, O_WRONLY|O_CREAT|O_TRUNC, 0644) = 4<${fp}>`
                      )
                    }
                  } else if (keepRefusal === "link_outside") {
                    const extFile = NodePath.join(outsideDir, "ext.txt")
                    await Fs.writeFile(extFile, "ext")
                    const lnk = NodePath.join(root, "bad-link")
                    await Fs.symlink(extFile, lnk)
                    traceLines.push(
                      `100 openat(AT_FDCWD, ${JSON.stringify(extFile)}, O_WRONLY|O_CREAT|O_TRUNC, 0644) = 4<${extFile}>`
                    )
                    traceLines.push(`100 symlinkat(${JSON.stringify(extFile)}, AT_FDCWD, ${JSON.stringify(lnk)}) = 0`)
                  } else {
                    const fp = NodePath.join(root, `ok-${slug}.txt`)
                    await Fs.writeFile(fp, `ok café-${slug} ${sha.slice(0, 7)} ${sha}`)
                    traceLines.push(
                      `100 openat(AT_FDCWD, ${JSON.stringify(fp)}, O_WRONLY|O_CREAT|O_TRUNC, 0644) = 4<${fp}>`
                    )
                  }
                  const tr = ObservedReads.read(() => traceLines, root)
                  const obs = ObservedReads.observe(tr, {
                    root,
                    ignore: [],
                    startedMs: Date.now() - 1000,
                    limits: { paths: 2, bytes: 128, outside: 1 },
                    variables: { values: { CAFE: `café-${slug}`, COMMIT: sha }, text: `CAFE COMMIT` }
                  })
                  const obsRefusal = "refusal" in obs ? obs.refusal : undefined
                  const leftRefusal = !("refusal" in obs) && obs.left !== undefined && "refusal" in obs.left
                    ? obs.left.refusal
                    : undefined
                  if (keepRefusal === "ok") {
                    expect(obsRefusal).toBeUndefined()
                    expect(leftRefusal).toBeUndefined()
                  } else {
                    expect(obsRefusal ?? leftRefusal).toBeDefined()
                  }
                } finally {
                  await Fs.rm(outsideDir, { recursive: true, force: true })
                }
              })
              return true
            }),
          { seed: 20261801, executions: 12 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "AgentSession decodePayloadValues, expandDiffSlice (quoted/escaped git patch paths), file verdict store, claudeMcpConfig, codexErrorMessages & precheckMcp",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          badInputCase: Schema.Literals(["ok", "missing", "empty", "bad_enum", "undeclared"]),
          mcpStatus: Schema.Literals([200, 503])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, badInputCase, mcpStatus }) =>
            Effect.promise(async () => {
              // 1. decodePayloadValues (all AgentNeedsInput branches)
              const spec = {
                req: S.Input.String("required field"),
                choice: S.Input.Literals(["alpha", "beta"]),
                opt: S.Input.Optional(S.Input.String("optional"))
              }
              const values: Record<string, string> = badInputCase === "ok"
                ? { req: `v-${slug}`, choice: "alpha" }
                : badInputCase === "missing"
                ? { choice: "alpha" }
                : badInputCase === "empty"
                ? { req: "", choice: "alpha" }
                : badInputCase === "bad_enum"
                ? { req: "x", choice: "gamma" }
                : { req: "x", choice: "alpha", extra: "nope" }
              const decodedExit = await Effect.runPromiseExit(AgentSession.decodePayloadValues(spec, values))
              if (badInputCase === "ok") {
                expect(decodedExit._tag).toBe("Success")
              } else {
                expect(decodedExit._tag).toBe("Failure")
              }

              // 2. codexErrorMessages + claudeMcpConfig + precheckMcp over real loopback server
              const codexErrs = AgentSession.codexErrorMessages(
                [
                  JSON.stringify({ type: "error", message: `boom-${slug}` }),
                  JSON.stringify({ type: "turn.failed", error: { message: `turn-fail-${slug}` } }),
                  "not-json-line"
                ].join("\n")
              )
              expect(codexErrs.length).toBe(2)

              const server = Http.createServer((_req, res) => {
                res.writeHead(mcpStatus)
                res.end(mcpStatus === 200 ? "ok" : "down")
              })
              await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
              const port = (server.address() as AddressInfo).port
              let closed = false
              try {
                const mcpDecl = S.Mcp.Http("demo", `http://127.0.0.1:${port}/mcp`)
                const cfgJson = AgentSession.claudeMcpConfig([mcpDecl])
                expect(cfgJson).toContain(`http://127.0.0.1:${port}/mcp`)
                if (mcpStatus !== 200) {
                  closed = true
                  await new Promise<void>((resolve) => server.close(() => resolve()))
                }
                const checkExit = await Effect.runPromiseExit(AgentSession.precheckMcp([mcpDecl], 500))
                expect(checkExit._tag).toBe(mcpStatus === 200 ? "Success" : "Failure")
              } finally {
                if (!closed) await new Promise<void>((resolve) => server.close(() => resolve()))
              }

              // 3. expandDiffSlice with addedLinePattern + git-quoted paths (non-ASCII + quotes + spaces) + makeFileVerdictStore + runAgentLint
              await withTempDir("smthrs-w6f-ag-", async (root) => {
                execFileSync("git", ["init", "-q"], { cwd: root })
                execFileSync("git", ["config", "user.email", "w6f@example.invalid"], { cwd: root })
                execFileSync("git", ["config", "user.name", "w6f"], { cwd: root })
                await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
                const weirdName = `src/café "q" ${slug}.ts`
                await Fs.writeFile(NodePath.join(root, "src/plain.ts"), "export const a = 1\n")
                await Fs.writeFile(NodePath.join(root, weirdName), "export const b = 1\n")
                execFileSync("git", ["add", "."], { cwd: root })
                execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root })

                await Fs.writeFile(NodePath.join(root, "src/plain.ts"), `export const a = 2 // MATCH_${slug}\n`)
                await Fs.writeFile(NodePath.join(root, weirdName), `export const b = 2 // MATCH_${slug}\n`)

                const diffSpec = S.gitDiff({ base: "HEAD", paths: ["src/**"], addedLines: `MATCH_${slug}` })
                const slice = await Effect.runPromise(
                  AgentSession.expandDiffSlice(root, [diffSpec])
                )
                expect(slice.files.length).toBeGreaterThanOrEqual(2)

                // File verdict store round-trip
                const store = AgentSession.makeFileVerdictStore(NodePath.join(root, ".verdicts"))
                const key = AgentSession.verdictKey({
                  kind: "lint",
                  diffDigest: "1".repeat(64),
                  promptDigest: "0".repeat(64),
                  agentIdentity: "fake",
                  mode: "check",
                  gateIdentities: []
                })
                expect(await Effect.runPromise(store.get(key))).toBeUndefined()
                await Effect.runPromise(
                  store.put(key, JSON.stringify({ status: "passed", findings: [], summary: `ok-${slug}` }))
                )
                const got = await Effect.runPromise(store.get(key))
                expect(got).toContain("passed")

                // Run Agent.Lint (check + fix mode) with scripted session factory + renderDataFiles
                const promptFile = NodePath.join(root, "PROMPT.md")
                await Fs.writeFile(promptFile, `Review ${slug}\n`)
                const lintRes = await Effect.runPromise(
                  AgentSession.runAgentLint(
                    {
                      workspaceRoot: root,
                      sessions: AgentFake.makeScriptedSessionFactory({
                        responses: [{ findings: [], edits: [], note: `clean-${slug}` }]
                      }),
                      verdicts: store,
                      writeSets: AgentSession.makeLocalWriteSetApplier(root),
                      gates: AgentSession.unavailableGateRunner,
                      prOpener: AgentSession.unavailablePrOpener,
                      dataFiles: ["src/plain.ts"]
                    },
                    {
                      agent: S.Agent.ClaudeCode({ model: "claude-sonnet-4" }),
                      promptPath: "PROMPT.md",
                      packageDirectory: root,
                      diffs: [diffSpec],
                      mode: "check",
                      fixes: []
                    }
                  )
                )
                expect(lintRes.findings.length).toBe(0)
              })
              return true
            }),
          { seed: 20261802, executions: 6 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "Cli ci refusals/--remote --plan/--timings, bench --baseline regression, owners/targets/index/graph/explain/show/install/multi-pattern & Affected jj/Suite/selectors/unskipped",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          jjFails: Schema.Boolean,
          benchRegressed: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, jjFails, benchRegressed }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w6f-cli-", async (root) => {
                execFileSync("git", ["init", "-q"], { cwd: root })
                execFileSync("git", ["config", "user.email", "w6f@example.invalid"], { cwd: root })
                execFileSync("git", ["config", "user.name", "w6f"], { cwd: root })

                // 1. Affected.changedPaths with .jj directory and fake jj binary (exit 0 and exit 1)
                const jjRepo = NodePath.join(root, "jj-ws")
                await Fs.mkdir(NodePath.join(jjRepo, ".jj"), { recursive: true })
                const binDir = NodePath.join(root, "fake-bin")
                await Fs.mkdir(binDir, { recursive: true })
                await writeExecutable(
                  NodePath.join(binDir, "jj"),
                  `#!${process.execPath}
if (${jjFails}) { console.error("jj boom"); process.exit(2); }
console.log("src/a.ts\\nsrc/b.ts\\nsrc/a.ts");
process.exit(0);
`
                )
                const prevPath = process.env["PATH"]
                process.env["PATH"] = `${binDir}:${prevPath ?? ""}`
                try {
                  if (jjFails) {
                    await expect(Affected.changedPaths(jjRepo, { base: "main" })).rejects.toThrow(/jj diff/)
                  } else {
                    const changed = await Affected.changedPaths(jjRepo, { base: "main" })
                    expect(changed).toEqual(["src/a.ts", "src/b.ts"])
                  }
                } finally {
                  process.env["PATH"] = prevPath
                }

                // 2. Affected.select (Suite, S.link, NodeModules, GitDiff, dependencySelectors) & Affected.unskipped
                const leafBuild = S.Shell.Build({
                  shell: "mkdir -p out && echo hi > out/a.txt",
                  outDirs: ["out"],
                  data: [S.file("//a.txt"), S.link("//lnk.txt")]
                })
                const leafTest = S.Shell.Test({
                  shell: "true",
                  data: [leafBuild, S.nodeModules("//deps"), S.gitDiff("HEAD")]
                })
                const suite = S.Suite({ tests: [leafTest] })
                const affIdx = PackageIndex.make({
                  root,
                  workspace: S.Workspace("aff-w6f", {
                    repository: "git+https://example.invalid/aff.git",
                    cache: S.Cache({ directory: ".flows" })
                  }),
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({ targets: { leafBuild, leafTest, suite } })
                    }
                  ]
                })
                const selected = Affected.select(affIdx, ["//:suite"], ["lnk.txt"])
                expect(selected.targets.length).toBeGreaterThanOrEqual(1)

                const unskipShadowed = Affected.unskipped(["//:b"], {
                  ok: false,
                  counts: { failed: 1, skipped: 1 },
                  results: [
                    { label: "//:a", status: "failed", error: "boom" },
                    { label: "//:b", status: "skipped", blockedBy: "//:a" }
                  ]
                })
                expect(unskipShadowed.counts.failed).toBe(1)

                const unskipOrphan = Affected.unskipped(["//:b", "//:c"], {
                  ok: true,
                  counts: { failed: 0, skipped: 2 },
                  results: [
                    { label: "//:b", status: "skipped", blockedBy: "//:c" },
                    { label: "//:c", status: "skipped", blockedBy: "//:b" }
                  ]
                })
                expect(unskipOrphan.ok).toBe(false)
                expect(unskipOrphan.counts.failed).toBe(2)

                // 3. Cli subcommands on a real workspace
                await Fs.writeFile(
                  NodePath.join(root, "package.json"),
                  JSON.stringify({ name: `w6f-${slug}`, version: "1.0.0" })
                )
                await Fs.writeFile(NodePath.join(root, "a.txt"), `v-${slug}\n`)
                await Fs.writeFile(
                  NodePath.join(root, "WORKSPACE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("w6f-${slug}", {
  repository: "git+https://example.invalid/w6f.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["sh"] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() }),
  owners: { owners: ["ws-owner"] },
  remotes: S.Remotes({
    cloud: S.Remote.Command({
      machines: [["sh", "-c"], ["sh", "-c"]],
      workdir: "/tmp/w6f-remote"
    })
  })
})
`
                )
                await Fs.writeFile(
                  NodePath.join(root, "bench.mjs"),
                  `console.log(JSON.stringify([{ name: "hot", opsPerSec: ${benchRegressed ? 50 : 100}, meanMs: ${
                    benchRegressed ? 200 : 100
                  } }]))\n`
                )
                await Fs.writeFile(
                  NodePath.join(root, "PACKAGE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"
const bld = S.Shell.Build({
  shell: "mkdir -p out && echo ok > out/x.txt",
  outDirs: ["out"],
  data: [S.file("//a.txt")],
  sandbox: "none"
})
const t1 = S.Shell.Test({ shell: "true", data: [bld], sandbox: "none" })
const t2 = S.Shell.Test({ shell: "true", data: [bld], sandbox: "none" })
const perf = S.NodeBench({
  entry: S.file("//bench.mjs"),
  srcs: [S.file("//bench.mjs")],
  deps: []
})
export const Package = S.Package({
  owners: { owners: ["pkg-owner"] },
  targets: { bld, t1, t2, perf }
})
`
                )
                execFileSync("git", ["add", "."], { cwd: root })
                execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root })

                const runCli = async (argv: ReadonlyArray<string>) => {
                  const r = await serve(root, argv)
                  return { out: r.output, err: r.logs, exitCode: r.exitCode }
                }

                // ci flag refusal matrix (L968-997)
                expect((await runCli(["ci", "//...", "--remote", "cloud", "--shard", "1/2"])).exitCode).not.toBe(0)
                expect((await runCli(["ci", "//...", "--remote", "cloud", "--known-red", "kr.json"])).exitCode).not
                  .toBe(0)
                expect(
                  (await runCli(["ci", "//...", "--remote", "cloud", "--workspace-file", "WORKSPACE.ts"])).exitCode
                ).not.toBe(0)
                expect((await runCli(["ci", "//...", "--timings", "t.json"])).exitCode).not.toBe(0)
                expect(
                  (await runCli(["ci", "//...", "--remote", "cloud", "--timings", "missing-timings.json"])).exitCode
                ).not.toBe(0)

                // ci --remote cloud --plan --timings <valid> (L1158-1167)
                await Fs.writeFile(
                  NodePath.join(root, "timings.json"),
                  JSON.stringify({
                    results: [{ label: "//:t1", status: "ran", durationMs: 120 }, {
                      label: "//:t2",
                      status: "ran",
                      durationMs: 80
                    }]
                  })
                )
                const ciPlan = await runCli([
                  "ci",
                  "//...",
                  "--remote",
                  "cloud",
                  "--timings",
                  "timings.json",
                  "--plan",
                  "--format",
                  "json"
                ])
                if (ciPlan.exitCode !== 0) throw new Error("ciPlan failed: " + ciPlan.err + " | " + ciPlan.out)
                expect(ciPlan.out).toContain("cloud")

                // bench --compare + --fail-on-regression (L1390, L1480-1505)
                expect((await runCli(["bench", "//:perf", "--fail-on-regression", "5"])).exitCode).not.toBe(0)
                await Fs.writeFile(
                  NodePath.join(root, "baseline.json"),
                  JSON.stringify({
                    results: [{
                      label: "//:perf",
                      status: "ran",
                      benchmarks: [{ name: "hot", opsPerSec: 100, meanMs: 100 }]
                    }]
                  })
                )
                const benchRes = await runCli([
                  "bench",
                  "//:perf",
                  "--compare",
                  "baseline.json",
                  "--fail-on-regression",
                  "5"
                ])
                if (benchRegressed) {
                  expect(benchRes.exitCode).not.toBe(0)
                }

                // Auxiliary Cli subcommands & multi-pattern resolution
                expect((await runCli(["targets", "//...", "--format", "json"])).exitCode).toBe(0)
                expect((await runCli(["index", "//...", "--format", "json"])).exitCode).toBe(0)
                expect((await runCli(["graph", "//...", "--mermaid"])).exitCode).toBe(0)
                expect((await runCli(["owners", "--diff", "HEAD"])).exitCode).toBe(0)
                expect((await runCli(["show", "target", "//:bld"])).exitCode).toBe(0)
                expect((await runCli(["show", "workspace"])).exitCode).toBe(0)
                expect((await runCli(["explain", "//:bld", "--format", "json"])).exitCode).toBe(0)
                expect((await runCli(["owners", "a.txt", "--format", "json"])).exitCode).toBe(0)
                expect((await runCli(["test", "//:t1", "//:t2"])).exitCode).toBe(0)
              })
              return true
            }),
          { seed: 20261803, executions: 2 }
        )
      )
      assertPassed(report)
    },
    90_000
  )
})
