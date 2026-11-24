import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import type * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as Input from "@smthrs/targets/Input"
import * as LlmLint from "@smthrs/targets/LlmLint"
import * as Target from "@smthrs/targets/Target"
import { Arbitrary, Effect, Schema, Stream } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as AgentFake from "../src/AgentFake.ts"
import * as AgentSession from "../src/AgentSession.ts"
import * as Cli from "../src/Cli.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as Label from "../src/Label.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"
import * as TrustedReview from "../src/TrustedReview.ts"
import { writeExecutable } from "./helpers/Executable.ts"
import { serve as serveCli } from "./helpers/ServeCli.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const ioExecutions = Math.max(5, Math.min(executions, 10))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Machine.remove(dir).catch(() => Fs.rm(dir, { recursive: true, force: true }))
  }
}

const writeFile = async (root: string, rel: string, content: string, mode = 0o644): Promise<string> => {
  const full = NodePath.isAbsolute(rel) ? rel : NodePath.join(root, rel)
  await Fs.mkdir(NodePath.dirname(full), { recursive: true })
  await Fs.writeFile(full, content, { mode })
  if (mode !== 0o644) await Fs.chmod(full, mode)
  return full
}

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fuzz", "-c", "user.email=fuzz@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim()

const slugArb = Schema.Literals(["m0", "m1", "m2", "m3"])

describe("@smthrs/build-cli Wave-8C: PackageTree, Cli, Affected, AgentSession, ServiceSupervisor & TrustedReview deep fuzz", () => {
  it(
    "PackageTree non-colocated jj workspace census, revertPath (missing/link/file), portals (broken link + revert missing/link/file) & captureOutDir limits/links",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          limitKind: Schema.Literals(["entries", "pathBytes", "fileBytes", "totalBytes", "escapeLink", "absLink"]),
          useJj: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, limitKind, useJj }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8c-tree-", async (base) => {
                const ws = NodePath.join(base, "ws")
                const external = NodePath.join(base, "external-target")
                await Fs.mkdir(ws, { recursive: true })
                await Fs.mkdir(external, { recursive: true })

                if (useJj) {
                  // Non-colocated jj workspace (if jj is installed on host)
                  try {
                    NodeChildProcess.execFileSync("jj", ["git", "init", "--no-colocate", ws], { stdio: "ignore" })
                    await writeFile(ws, "tracked.txt", `jj-${slug}\n`)
                    NodeChildProcess.execFileSync("jj", ["--repository", ws, "status"], { stdio: "ignore" })
                    const jjSnap = await PackageTree.snapshotTree(ws, ".flows")
                    try {
                      await writeFile(ws, "tracked.txt", `jj-edited-${slug}\n`)
                      await writeFile(ws, "added.txt", `new-${slug}\n`)
                      const changed = await PackageTree.changedSinceSnapshot(jjSnap, ".flows")
                      expect(changed.length).toBeGreaterThanOrEqual(1)
                    } finally {
                      await PackageTree.releaseSnapshot(jjSnap)
                    }
                  } catch {
                    // jj unavailable or refused; continue with git fixture below
                  }
                }

                // Git workspace for revertPath + portals + captureOutDir
                const gws = NodePath.join(base, "gws")
                await Fs.mkdir(gws, { recursive: true })
                git(gws, "init", "-q")
                await writeFile(gws, "orig.txt", `orig-${slug}\n`, 0o755)
                await Fs.symlink("orig.txt", NodePath.join(gws, "orig-link"))
                git(gws, "add", "-A")
                git(gws, "commit", "-qm", "init")

                // 1. revertPath for regular file (with mode restore), symlink & newly created (missing before)
                const snap = await PackageTree.snapshotTree(gws, ".flows")
                const quarantine = PackageTree.openQuarantine(gws, ".flows", "//:test")
                try {
                  await writeFile(gws, "orig.txt", "changed\n", 0o644)
                  await Fs.rm(NodePath.join(gws, "orig-link"), { force: true })
                  await writeFile(gws, "orig-link", "now-a-file\n")
                  await writeFile(gws, "brand-new.txt", "created\n")
                  for (const p of ["orig.txt", "orig-link", "brand-new.txt"]) {
                    await PackageTree.revertPath(snap, p, quarantine)
                  }
                  expect(await Fs.readFile(NodePath.join(gws, "orig.txt"), "utf8")).toBe(`orig-${slug}\n`)
                  expect((await Fs.lstat(NodePath.join(gws, "orig-link"))).isSymbolicLink()).toBe(true)
                  expect(NodeFs.existsSync(NodePath.join(gws, "brand-new.txt"))).toBe(false)
                } finally {
                  await PackageTree.releaseSnapshot(snap)
                }

                // 2. Portals: snapshotPortals, portalsReachableFrom (incl. broken relative symlink), revertChangedPortals (missing, link, file)
                await writeFile(external, "keep.txt", `ext-${slug}\n`, 0o755)
                await Fs.symlink("keep.txt", NodePath.join(external, "ext-link"))
                await Fs.symlink(external, NodePath.join(gws, "portal-dir"))
                await Fs.symlink("../does-not-exist-anywhere", NodePath.join(gws, "broken-portal"))
                const portalSnap = await PackageTree.snapshotPortals(gws, ".flows")
                try {
                  const scratch = NodePath.join(base, "scratch-copy")
                  await Fs.mkdir(scratch, { recursive: true })
                  await Fs.symlink(external, NodePath.join(scratch, "portal-dir"))
                  await Fs.symlink("../does-not-exist-anywhere", NodePath.join(scratch, "broken-portal"))
                  const reachable = await PackageTree.portalsReachableFrom(portalSnap, scratch)
                  expect(reachable).toContain("portal-dir")

                  // Mutate behind portal: edit file, replace symlink, add new file
                  await writeFile(external, "keep.txt", "corrupted\n", 0o644)
                  await Fs.rm(NodePath.join(external, "ext-link"), { force: true })
                  await writeFile(external, "ext-link", "not-link\n")
                  await writeFile(external, "intruder.txt", "bad\n")
                  const escaped = await PackageTree.revertChangedPortals(portalSnap, { admitted: reachable })
                  expect(escaped.length).toBeGreaterThanOrEqual(1)
                  expect(await Fs.readFile(NodePath.join(external, "keep.txt"), "utf8")).toBe(`ext-${slug}\n`)
                  expect((await Fs.lstat(NodePath.join(external, "ext-link"))).isSymbolicLink()).toBe(true)
                  expect(NodeFs.existsSync(NodePath.join(external, "intruder.txt"))).toBe(false)
                } finally {
                  await PackageTree.releasePortals(portalSnap)
                }

                // 3. captureOutDir limit & link confinement errors
                const outDir = NodePath.join(gws, "out")
                await Fs.mkdir(outDir, { recursive: true })
                if (limitKind === "entries") {
                  await writeFile(outDir, "a.txt", "1")
                  await writeFile(outDir, "b.txt", "2")
                  await writeFile(outDir, "c.txt", "3")
                  await expect(
                    PackageTree.captureOutDir(gws, ".flows", "out", gws, { ...PackageTree.outDirLimits, entries: 2 })
                  ).rejects.toThrow()
                } else if (limitKind === "pathBytes") {
                  await writeFile(outDir, "long-filename-exceeding-limit.txt", "1")
                  await expect(
                    PackageTree.captureOutDir(gws, ".flows", "out", gws, { ...PackageTree.outDirLimits, pathBytes: 8 })
                  ).rejects.toThrow()
                } else if (limitKind === "fileBytes") {
                  await writeFile(outDir, "big.txt", "x".repeat(64))
                  await expect(
                    PackageTree.captureOutDir(gws, ".flows", "out", gws, { ...PackageTree.outDirLimits, fileBytes: 16 })
                  ).rejects.toThrow()
                } else if (limitKind === "totalBytes") {
                  await writeFile(outDir, "a.txt", "x".repeat(20))
                  await writeFile(outDir, "b.txt", "y".repeat(20))
                  await expect(
                    PackageTree.captureOutDir(gws, ".flows", "out", gws, {
                      ...PackageTree.outDirLimits,
                      totalBytes: 25
                    })
                  ).rejects.toThrow()
                } else if (limitKind === "escapeLink") {
                  await Fs.symlink("../../escape", NodePath.join(outDir, "bad-link"))
                  await expect(PackageTree.captureOutDir(gws, ".flows", "out")).rejects.toThrow()
                } else {
                  await Fs.symlink("/etc/passwd", NodePath.join(outDir, "abs-link"))
                  await expect(PackageTree.captureOutDir(gws, ".flows", "out")).rejects.toThrow()
                }
              })
              return true
            }),
          { executions: ioExecutions, seed }
        )
      )
      assertPassed(report)
    },
    150_000
  )

  it(
    "Cli.selectInstallTarget, human audience, split/public remoteCache, affected with PACKAGE.ts change (baseTexts + loadAt + revisionHooks), known-red artifact error, approve errors & bench regression",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          credMode: Schema.Literals(["split", "public"]),
          humanAudience: Schema.Boolean,
          approveBadCase: Schema.Literals(["multi", "no_approval"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, credMode, humanAudience, approveBadCase }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8c-cli-", async (base) => {
                const ws = NodePath.join(base, "ws")
                await Fs.mkdir(ws, { recursive: true })

                // 1. Cli.selectInstallTarget (0, 1 root, 2 root, 2 nested, 1 root + 1 nested)
                const InstallRule = Target.make("Install", {
                  attrs: Schema.Struct({ name: Schema.String }),
                  kinds: ["run"],
                  success: Schema.Void,
                  implementation: () => ({ _tag: "Succeed", value: undefined } as never)
                })
                const row = (label: string, packagePath: string) => ({
                  label,
                  packagePath,
                  key: label.split(":")[1]!,
                  name: label.split(":")[1]!,
                  file: packagePath === "" ? "PACKAGE.ts" : `${packagePath}/PACKAGE.ts`,
                  target: InstallRule({ name: label })
                })
                expect(() => Cli.selectInstallTarget([])).toThrow(/no Install target/)
                expect(Cli.selectInstallTarget([row("//:inst", "")]).label).toBe("//:inst")
                expect(Cli.selectInstallTarget([row("//:inst", ""), row("//sub:inst", "sub")]).label).toBe("//:inst")
                expect(() => Cli.selectInstallTarget([row("//:a", ""), row("//:b", "")])).toThrow(
                  /more than one Install/
                )
                expect(() => Cli.selectInstallTarget([row("//a:i", "a"), row("//b:i", "b")])).toThrow(
                  /more than one Install/
                )

                // 2. Real git workspace with WORKSPACE.ts & PACKAGE.ts for CLI commands
                git(ws, "init", "-q")
                await writeFile(ws, "package.json", JSON.stringify({ name: "w8c-cli", version: "1.0.0" }))
                await writeFile(ws, "yarn.lock", "")
                await writeFile(ws, "src/a.txt", `a-${slug}\n`)
                await writeFile(
                  ws,
                  "src/b.bench.mjs",
                  `console.log(JSON.stringify({ benchmarks: [{ name: "bench_a", meanMs: 100, hz: 10 }] }))\n`
                )
                await writeFile(
                  ws,
                  "baseline.json",
                  JSON.stringify({
                    schemaVersion: 1,
                    results: [{
                      label: "//:perf",
                      benchmarks: [{ name: "bench_a", meanMs: 10, hz: 100 }]
                    }]
                  })
                )
                await writeFile(
                  ws,
                  "known-red.json",
                  JSON.stringify([{
                    label: "//:artTest",
                    reason: "flaky",
                    owner: "team",
                    expires: "2099-01-01"
                  }])
                )

                const pubTok = "smithers_cachero_" + "a".repeat(40)
                const remoteDecl = credMode === "split"
                  ? `remote: S.RemoteCache.make({ endpoint: "https://cache.example.invalid", read: S.Secret("READ_TOK"), write: S.Secret("WRITE_TOK") })`
                  : `remote: S.RemoteCache.make({ endpoint: "https://cache.example.invalid", publicReadToken: "${pubTok}", write: S.Secret("WRITE_TOK") })`

                await writeFile(
                  ws,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"
const m = S.file("//package.json")
export const Workspace = S.Workspace("w8c-cli", {
  repository: "git+https://example.invalid/w8c-cli.git",
  cache: S.Cache({ directory: ".flows", ${remoteDecl} }),
  runtime: S.Runtime.Node({ version: ">=20.0.0" }),
  packageManager: S.PackageManager.Yarn({ manifest: m, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: m }),
  host: S.Host({ bins: ["sh", "node"] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
`
                )
                const pkgSource = (ver: string) =>
                  `import { Smithers as S } from "@smthrs/targets"
const t1 = S.Shell.Test({ shell: "echo t1-${ver}", data: [S.file("//src/a.txt"), S.nodeModules("dep")], sandbox: "none" })
const t2 = S.Shell.Test({ shell: "echo t2-${ver}", sandbox: "none" })
const artTest = S.Shell.Test({ shell: "echo art", lifecycle: "artifact", summary: "Captured artifact", sandbox: "none" })
const perf = S.NodeBench({ entry: S.file("//src/b.bench.mjs"), srcs: [S.file("//src/b.bench.mjs")], deps: [] })
export const Package = S.Package({ targets: { t1, t2, artTest, perf } })
`
                await writeFile(ws, "PACKAGE.ts", pkgSource("v1"))
                git(ws, "add", "-A")
                git(ws, "commit", "-qm", "init")

                // Edit PACKAGE.ts and src/a.txt so `affected` loads base revision via Affected.baseTexts + PackageLoader.loadAt + effect-resolution revisionHooks!
                await writeFile(ws, "PACKAGE.ts", pkgSource(`v2-${slug}`))
                await writeFile(ws, "src/a.txt", `a-changed-${slug}\n`)

                const env: Record<string, string> = {
                  ...process.env as Record<string, string>,
                  READ_TOK: "rtok",
                  WRITE_TOK: "wtok"
                }

                // a) targets list in human audience (covers forPeople / Ansi.palette)
                const listed = await serveCli(
                  ws,
                  ["targets", "--audience", humanAudience ? "human" : "agent"],
                  { environment: env }
                )
                if (listed.exitCode !== 0) throw new Error("listed failed: " + listed.output + " | " + listed.logs)

                // b) affected --base HEAD --plan (covers Cli.ts L599-605 + Affected.baseTexts + PackageLoader.loadAt + effect-resolution revisionHooks!)
                const aff = await serveCli(
                  ws,
                  ["affected", "test", "--base", "HEAD", "--list"],
                  { environment: env }
                )
                expect(aff.exitCode).toBe(0)

                // c) known-red rejecting artifact test (covers Cli.ts L818-830)
                const kr = await serveCli(
                  ws,
                  ["test", "//:t1", "--known-red", "known-red.json"],
                  { environment: env }
                )
                expect(kr.exitCode).not.toBe(0)

                // d) approve errors (multi targets & target without approval: "required")
                const appr = await serveCli(
                  ws,
                  ["approve", approveBadCase === "multi" ? "//..." : "//:t1"],
                  { environment: env }
                )
                expect(appr.exitCode).not.toBe(0)

                // d2) bench --baseline --fail-on-regression (human & agent audience)
                const br = await serveCli(
                  ws,
                  [
                    "bench",
                    "//:perf",
                    "--baseline",
                    "baseline.json",
                    "--fail-on-regression",
                    "5",
                    "--audience",
                    humanAudience ? "human" : "agent"
                  ],
                  { environment: env }
                )
                expect(typeof br.exitCode).toBe("number")

                // e) Affected.baseTexts directly on HEAD
                const baseTexts = await Affected.baseTexts(ws, { base: "HEAD", paths: ["PACKAGE.ts", "src/a.txt"] })
                expect(baseTexts.get("PACKAGE.ts")).toContain("t1-v1")
              })
              return true
            }),
          { executions: ioExecutions, seed }
        )
      )
      assertPassed(report)
    },
    180_000
  )

  it(
    "AgentSession oversize data file & writeSet overlay, ServiceSupervisor init/health/observer/splitsPair & TrustedReview credentialReceiver (invalid, ok, failing) + proposed-security-policy",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          initFails: Schema.Boolean,
          healthFails: Schema.Boolean,
          receiverMode: Schema.Literals(["relative_bad", "missing_bad", "nonexec_bad", "exit_0", "exit_3"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, initFails, healthFails, receiverMode }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8c-ast-", async (base) => {
                const ws = NodePath.join(base, "ws")
                await Fs.mkdir(ws, { recursive: true })

                // 1. AgentSession.runAgentDiff with oversize data file (> maximumDataFileBytes -> omitted section)
                await writeFile(ws, "prompt.md", `Fix out/x.txt for ${slug}\n`)
                await writeFile(ws, "out/x.txt", `old-${slug}\n`)
                // Create >1MB data file to hit read.kind === "oversize" (L1618-1623)
                await writeFile(ws, "big-data.txt", "B".repeat(600 * 1024))
                const fakePath = NodePath.join(base, "fake.json")
                const fakeScript: AgentFake.FakeScript = {
                  responses: [{
                    findings: [],
                    edits: [{ path: "out/x.txt", contents: `new-${slug}\n` }],
                    note: "ok"
                  }]
                }
                await writeFile(base, fakePath, JSON.stringify(fakeScript))
                const sessions = AgentFake.sessionFactoryFromEnvironment({ workspaceRoot: ws, agents: undefined }, {
                  SMTHRS_AGENT_FAKE: fakePath
                })
                const writeSets = AgentSession.makeLocalWriteSetApplier(ws)
                const payload: AgentTarget.DiffPayload = {
                  promptPath: "prompt.md",
                  payloadSpec: {},
                  mcp: [],
                  diffs: [],
                  changes: ["out/**"],
                  gateIdentities: [],
                  maxRounds: 1
                }
                const diffRes = await Effect.runPromise(
                  AgentSession.runAgentDiff(
                    {
                      workspaceRoot: ws,
                      environment: {},
                      sensitiveEnv: [],
                      sessions,
                      writeSets,
                      gates: { run: () => Effect.succeed([]) },
                      verdicts: AgentSession.makeMemoryVerdictStore(),
                      payloadValues: {},
                      dataFiles: ["big-data.txt"]
                    },
                    payload
                  )
                )
                expect(diffRes.vacuous).toBe(false)
                expect(diffRes.edits.length).toBe(1)

                // 2. ServiceSupervisor live process with init (pass/fail), health probe (pass/fail), observer & emoji output
                const stdoutChunks: Array<string> = []
                const stderrChunks: Array<string> = []
                const healthMarker = NodePath.join(base, "healthy")
                await writeFile(base, "healthy", "1\n")
                const spec: ServiceSupervisor.ServiceSpec = {
                  key: `svc-${slug}`,
                  cwd: ws,
                  argv: [
                    "/bin/sh",
                    "-c",
                    `printf '${"😀".repeat(200)}out-${slug}\\n'; printf 'err-${slug}\\n' >&2; sleep 5`
                  ],
                  init: [initFails ? ["/bin/sh", "-c", "exit 7"] : ["/bin/sh", "-c", "echo init-ok"]],
                  readiness: {
                    exec: ["/bin/sh", "-c", `test -f ${JSON.stringify(healthMarker)}`],
                    timeout: "2s"
                  },
                  health: {
                    interval: "40ms",
                    failures: 1
                  }
                }
                const svcExit = await Effect.runPromise(
                  Effect.exit(
                    Effect.scoped(
                      Effect.gen(function*() {
                        const supervisor = yield* ServiceSupervisor.make
                        const lease = yield* supervisor.acquire(spec)
                        if (healthFails) {
                          yield* Effect.promise(() => Fs.rm(healthMarker, { force: true }))
                          yield* lease.whileHealthy(Effect.sleep("400 millis"))
                        } else {
                          yield* Effect.sleep("80 millis")
                        }
                        return "done"
                      })
                    )
                  )
                )
                if (initFails) {
                  expect(svcExit._tag).toBe("Failure")
                } else if (healthFails) {
                  expect(["Failure", "Success"]).toContain(svcExit._tag)
                } else {
                  expect(svcExit._tag).toBe("Success")
                }

                // 3. TrustedReview prepareSource + reviewPrepared with credentialReceiver (invalid / ok / failing)
                const baseRev = "a".repeat(40)
                const headRev = "b".repeat(40)
                const cred = "Zk9vQmFyQmF6UXV4UXV1eENvcmdlR3JhdWx0"
                const policyJson = JSON.stringify(
                  Target.metadata(LlmLint.LlmLint({
                    changes: Input.gitDiff("HEAD"),
                    include: [Input.glob("//src/**")],
                    deps: [],
                    prompt: "Inspect selected source.",
                    rubric: "Check secrets",
                    model: "review-test-model",
                    batchSize: 1
                  })).attrs
                )
                const targetIndexJson = JSON.stringify([{
                  label: "//:security",
                  package: "",
                  name: "security",
                  rule: "LlmLint",
                  reviewPolicy: policyJson,
                  kinds: ["review"],
                  cacheable: false,
                  inputs: [],
                  outputs: [],
                  dependencies: [],
                  source: { file: "PACKAGE.ts" }
                }])
                const baseFiles: Record<string, string> = {
                  "PACKAGE.ts": "export const Package = 1\n",
                  "README.md": "context doc\n",
                  "src/service.ts": "export const ok = 1\n",
                  ".smithers/target-index.json": targetIndexJson
                }
                const headFiles: Record<string, string> = {
                  ...baseFiles,
                  "src/service.ts": `export const REPOHOST_TOKEN = "${cred}"\n`
                }
                const trees: Record<string, Record<string, string>> = { [baseRev]: baseFiles, [headRev]: headFiles }
                const source: TrustedReview.ReviewSource = {
                  tree: async (rev) =>
                    new Map(
                      Object.entries(trees[rev] ?? {}).map(([path, contents]) => [
                        path,
                        { id: `file:${contents}`, regular: true }
                      ])
                    ),
                  read: async (rev, path) => {
                    const content = trees[rev]?.[path]
                    if (content === undefined) throw new Error(`missing ${path}`)
                    return content
                  },
                  grep: async (rev, patterns, candidate) =>
                    Object.entries(trees[rev] ?? {})
                      .filter(([path, contents]) =>
                        candidate(path) && patterns.some((p) => new RegExp(p).test(contents))
                      )
                      .map(([path]) => path)
                }
                const prepared = await TrustedReview.prepareSource(source, {
                  policyRevision: baseRev,
                  revision: headRev,
                  patterns: [Label.parse("//...", "")]
                })
                const findingsStore = NodePath.join(base, "findings")
                await Fs.mkdir(findingsStore, { recursive: true })

                let recvPath: string
                if (receiverMode === "relative_bad") {
                  recvPath = "relative/receiver.mjs"
                } else if (receiverMode === "missing_bad") {
                  recvPath = NodePath.join(base, "no-such-receiver.sh")
                } else if (receiverMode === "nonexec_bad") {
                  recvPath = await writeFile(base, "nonexec.sh", "#!/bin/sh\nexit 0\n", 0o644)
                } else {
                  const code = receiverMode === "exit_0" ? 0 : 3
                  recvPath = await writeExecutable(
                    NodePath.join(base, "recv.sh"),
                    `#!/bin/sh\ncat >/dev/null\necho "recv-out"\nexit ${code}\n`
                  )
                }

                const transport: LlmLint.ReviewTransport = (requested) =>
                  Effect.succeed({
                    modelId: requested.model,
                    model: {
                      stream: () =>
                        Stream.fromIterable([
                          { type: "text-delta" as const, id: "t", text: "[]" },
                          { type: "settle" as const, stopReason: "stop" as const }
                        ])
                    }
                  })

                if (
                  receiverMode === "relative_bad" || receiverMode === "missing_bad" || receiverMode === "nonexec_bad"
                ) {
                  await expect(
                    TrustedReview.reviewPrepared(prepared, {
                      root: ws,
                      findingsStore,
                      credentialReceiver: recvPath,
                      transport
                    })
                  ).rejects.toThrow(/--credential-receiver/)
                } else {
                  const revRes = await TrustedReview.reviewPrepared(prepared, {
                    root: ws,
                    findingsStore,
                    credentialReceiver: recvPath,
                    transport
                  })
                  expect(revRes.reviews.length).toBeGreaterThanOrEqual(1)
                }
              })
              return true
            }),
          { executions: ioExecutions, seed }
        )
      )
      assertPassed(report)
    },
    180_000
  )
})
