import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as BenchReport from "../src/BenchReport.ts"
import type * as Executor from "../src/Executor.ts"
import * as GitHooks from "../src/GitHooks.ts"
import * as GithubRender from "../src/GithubRender.ts"
import * as CoreRuleSelection from "../src/internal/CoreRuleSelection.ts"
import * as FsUtil from "../src/internal/Fs.ts"
import * as FullDisk from "../src/internal/FullDisk.ts"
import { gitPathspecBatches } from "../src/internal/GitPathspecBatches.ts"
import * as HostProbes from "../src/internal/HostProbes.ts"
import * as MissingTool from "../src/internal/MissingTool.ts"
import { parseModule } from "../src/internal/ParseModule.ts"
import * as Parts from "../src/internal/Parts.ts"
import * as PathUtil from "../src/internal/Path.ts"
import * as PathTools from "../src/internal/PathTools.ts"
import * as RemoteCi from "../src/internal/RemoteCi.ts"
import * as RulePolicy from "../src/internal/RulePolicy.ts"
import * as Shards from "../src/internal/Shards.ts"
import * as ShellWords from "../src/internal/ShellWords.ts"
import * as TextUtil from "../src/internal/Text.ts"
import * as WorkspaceFiles from "../src/internal/WorkspaceFiles.ts"
import * as KnownRed from "../src/KnownRed.ts"
import * as MarkdownCodeBlocks from "../src/MarkdownCodeBlocks.ts"
import * as OutputStream from "../src/OutputStream.ts"
import * as OverlayExec from "../src/OverlayExec.ts"
import * as Owners from "../src/Owners.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as Resolver from "../src/Resolver.ts"
import * as StampExec from "../src/StampExec.ts"
import * as TestUnits from "../src/TestUnits.ts"
import { write } from "./helpers/WriteFile.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const fsExecutions = Math.min(executions, 25)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/build-cli graph, policy, resolver, affected, owners, CI render & utilities fuzz invariants", () => {
  it("KnownRed, Shards, RemoteCi, RulePolicy, ShellWords, BenchReport, MarkdownCodeBlocks, StampExec, OutputStream, TestUnits & internal utilities", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        label: Schema.Literals(["//:test", "//packages/a:test", "//apps/web:build", "//pkg/x:lint"]),
        platform: Schema.Literals(["linux", "darwin", "win32"]),
        expired: Schema.Boolean,
        advisory: Schema.Boolean,
        shardCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
        shardIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 })),
        rule: Schema.Literals([
          "Shell.Build",
          "Shell.Test",
          "Shell.Run",
          "Vitest",
          "Generate",
          "Fetch",
          "Docker.Build",
          "Go.Test",
          "Repo.Target",
          "Custom.Rule"
        ]),
        shellCmd: Schema.Literals([
          "echo hello && node script.js | grep ok",
          "FOO=1 BAR='a b' bun test --watch",
          "git status; (cd sub && ls -la)",
          "sh -c 'true'"
        ]),
        secretVal: Schema.Literals(["sk-fuzz-secret-999111", "tok_live_abcdef123456"]),
        textFrag: Schema.String.check(Schema.isMaxLength(80))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ label, platform, expired, advisory, shardCount, shardIdx, rule, shellCmd, secretVal, textFrag }) =>
          Effect.sync(() => {
            const safeFrag = textFrag.replace(/[\uD800-\uDFFF]/g, "")

            // KnownRed: fingerprint, parse, blocks, judge, describe, today
            const errMsg = `FAIL at /tmp/smthrs-test-AbCd12/file.ts: ${safeFrag}\nDuration 123ms (tests 10ms)`
            const fp1 = KnownRed.fingerprint(errMsg)
            const fp2 = KnownRed.fingerprint(errMsg.replace("AbCd12", "ZzYy99"))
            if (fp1 !== fp2 || !fp1.startsWith("sha256:")) throw new Error("KnownRed.fingerprint normalization")
            const todayStr = KnownRed.today(new Date("2026-11-23T12:00:00.000Z"))
            if (todayStr !== "2026-11-23") throw new Error("KnownRed.today")
            const expires = expired ? "2026-01-01" : "2027-12-31"
            const krJson = JSON.stringify({
              entries: [
                {
                  label,
                  platforms: [platform],
                  owner: "alice",
                  reason: "flaky test",
                  issue: "https://github.com/smithersai/smithers/issues/1",
                  expires,
                  failureDigest: fp1
                }
              ]
            })
            const parsedKr = KnownRed.parse("known-red.json", krJson)
            if (parsedKr.length !== 1) throw new Error("KnownRed.parse")
            const summary: Executor.Summary = {
              verb: "test",
              pattern: "//...",
              jobs: 2,
              ok: false,
              durationMs: 42,
              counts: { hit: 0, ran: 1, failed: 1, skipped: 1 },
              results: [
                { label, target: "Shell.Test", key: "a".repeat(64), status: "failed", durationMs: 10, error: errMsg },
                { label: "//:other", target: "Shell.Test", key: "b".repeat(64), status: "ran", durationMs: 5 },
                {
                  label: "//:dep",
                  target: "Shell.Test",
                  key: "c".repeat(64),
                  status: "skipped",
                  durationMs: 0,
                  blockedBy: label
                }
              ]
            }
            const judged = KnownRed.judge(
              summary,
              { source: "known-red.json", entries: parsedKr },
              { platform, today: todayStr, advisory: advisory ? new Set([label]) : undefined }
            )
            const lines = KnownRed.describe(judged.knownRed)
            if (!Array.isArray(lines)) throw new Error("KnownRed.describe")

            // Shards: parse, shardOf, measure, split
            const validIdx = shardIdx % shardCount
            const parsedShard = Shards.parse(`${validIdx}/${shardCount}`)
            if (parsedShard.index !== validIdx || parsedShard.count !== shardCount) throw new Error("Shards.parse")
            const s1 = Shards.shardOf(label, shardCount)
            const s2 = Shards.shardOf(label, shardCount)
            if (s1 !== s2 || s1 < 0 || s1 >= shardCount) throw new Error("Shards.shardOf")
            const measured = new Map<string, number>()
            Shards.measure(
              "results.json",
              JSON.stringify({
                results: [
                  { label: "//:a", status: "ran", durationMs: 100 },
                  { label: "//:b", status: "failed", durationMs: 50 },
                  { label: "//:c", status: "hit", durationMs: 2 }
                ]
              }),
              measured
            )
            const roots = ["//:a", "//:b", "//:c", "//:d", "//:e"]
            const parts = Shards.split(roots, measured, shardCount)
            const flat = parts.flat().sort()
            if (JSON.stringify(flat) !== JSON.stringify([...roots].sort())) throw new Error("Shards.split partition")

            // RemoteCi: parseResults, merge, failedRoots, pack, quote
            const rows: ReadonlyArray<RemoteCi.Row> = [
              { label: "//:a", status: "ran", key: "a".repeat(64), durationMs: 15 },
              { label: "//:b", status: "failed", key: "b".repeat(64), durationMs: 25, error: "fail" }
            ]
            const parsedRows = RemoteCi.parseResults(JSON.stringify({ results: rows }))
            if (parsedRows.length !== 2) throw new Error("RemoteCi.parseResults")
            const merged = RemoteCi.merge(
              [
                { label: "//:a", target: "Shell.Build" },
                { label: "//:b", target: "Shell.Test" }
              ],
              [parsedRows, [{ label: "//:a", status: "hit", key: "a".repeat(64), durationMs: 30 }]],
              { pattern: "//...", jobs: 2, durationMs: 30 }
            )
            if (merged.ok !== false || merged.results[0]!.status !== "ran" || merged.results[0]!.durationMs !== 30) {
              throw new Error("RemoteCi.merge lattice")
            }
            const failedR = RemoteCi.failedRoots(["//:x", "//:y"], "machine lost")
            if (failedR.length !== 2 || failedR.some((r) => r.status !== "failed")) throw new Error("failedRoots")
            const tar = RemoteCi.pack([
              { path: "src/a.txt", content: Buffer.from(`hi ${safeFrag}`), mode: 0o644, mtimeMs: 1_700_000_000_000 }
            ])
            if (tar.byteLength === 0) throw new Error("RemoteCi.pack empty")
            const quoted = RemoteCi.quote(`val's ${safeFrag}`)
            if (!quoted.startsWith("'") || !quoted.endsWith("'")) throw new Error("RemoteCi.quote")

            // RulePolicy & CoreRuleSelection & ShellWords
            RulePolicy.of(rule)
            RulePolicy.cacheable(rule, "execute", false)
            RulePolicy.cacheable(rule, "check", true)
            RulePolicy.sandbox(rule, undefined)
            RulePolicy.buildOutputs({ outDir: "dist", outFiles: ["a.js"] }, "packages/a")
            CoreRuleSelection.argvOf(["node", "-e", "1"])
            try {
              CoreRuleSelection.select(rule, ["node", "-v"])
            } catch {
              // lane rules require their own lane
            }
            const cmds = ShellWords.commands(shellCmd)
            if (cmds.length === 0) throw new Error("ShellWords.commands empty")

            // BenchReport
            const benchStdout = [
              "name             hz     min     max    mean     p75     p99    p995    p999     rme  samples",
              "· parse_json  12,345.67  0.0700  0.1200  0.0810  0.0820  0.0950  0.1000  0.1100  ±0.45%     500"
            ].join("\n")
            const parsedBench = BenchReport.parse(benchStdout)
            BenchReport.stdoutOf({ stdout: benchStdout })
            BenchReport.format([{ label, status: "ran", benchmarks: parsedBench }])

            // MarkdownCodeBlocks
            const md = [
              "# Doc",
              "```ts file=example.ts",
              `export const x = ${JSON.stringify(safeFrag)}`,
              "```",
              "```bash ignore",
              "echo skip",
              "```"
            ].join("\n")
            MarkdownCodeBlocks.parseMeta("file=example.ts")
            const extracted = MarkdownCodeBlocks.extract(md, ["ts", "typescript"])
            if (extracted.files.length !== 1) throw new Error("MarkdownCodeBlocks.extract")

            // StampExec
            const tok = StampExec.token("commit", S.Stamp.commit)
            const foundToks = StampExec.tokensIn([`build-${tok}-${safeFrag}`])
            if (!foundToks.includes(tok)) throw new Error("StampExec.tokensIn")
            if (StampExec.nameOf(tok) !== "commit") throw new Error("StampExec.nameOf")
            const sub = StampExec.substitute(`rev=${tok}`, new Map([[tok, "abc1234"]]))
            if (sub !== "rev=abc1234") throw new Error("StampExec.substitute")

            // OutputStream redactor & make
            const envWithSecret = { MY_API_TOKEN: secretVal, PUBLIC_VAR: "ok" }
            const redact = OutputStream.redactor(envWithSecret)
            const redacted = redact(`leaked=${secretVal} safe=${safeFrag}`)
            if (redacted.includes(secretVal)) throw new Error("OutputStream.redactor leaked secret")
            const chunks: Array<string> = []
            const obs = OutputStream.make({
              write: (_stream, text) => {
                chunks.push(text)
              },
              environment: envWithSecret,
              maximumLines: 3,
              lastLines: 2
            })
            for (let i = 0; i < 6; i++) {
              obs.onStdout(Buffer.from(`line ${i} secret=${secretVal}\n`))
            }
            obs.onStderr(Buffer.from(`err ${safeFrag}\n`))
            obs.close()
            if (chunks.join("").includes(secretVal)) throw new Error("OutputStream observer leaked secret")

            // TestUnits pure label/parse/blobDirectory
            const uLabel = TestUnits.label("//packages/a:test", "packages/a", "packages/a/test/foo.test.ts")
            const uParsed = TestUnits.parse(uLabel)
            if (uParsed === undefined || uParsed.target !== "//packages/a:test") throw new Error("TestUnits roundtrip")
            if (TestUnits.blobDirectory(".flows", "//packages/a:test").length === 0) throw new Error("blobDirectory")

            // Internal utilities: Path, WorkspaceFiles, GitPathspecBatches, Text, Fs, MissingTool, HostProbes, FullDisk, Parts, ParseModule
            if (!PathUtil.contains("/ws", "/ws/packages/a")) throw new Error("Path.contains")
            if (PathUtil.contains("/ws", "/other/a")) throw new Error("Path.contains escape")
            if (PathUtil.containedRelative("/ws", "/ws/a/b") !== "a/b") throw new Error("Path.containedRelative")
            WorkspaceFiles.isWorkspaceFileName("WORKSPACE.ts")
            WorkspaceFiles.isPlainWorkspaceFile(".smithers/WORKSPACE.smithers")
            const batches = gitPathspecBatches(["src/a.ts", "src/b.ts", "packages/x/c.ts"])
            if (batches.flat().length !== 3) throw new Error("gitPathspecBatches")
            if (TextUtil.byCodeUnit("a", "b") >= 0) throw new Error("byCodeUnit")
            TextUtil.posix("a/b/c")
            if (TextUtil.sha256Hex(safeFrag).length !== 64) throw new Error("sha256Hex")
            FsUtil.errorCode(Object.assign(new Error("enoent"), { code: "ENOENT" }))
            FsUtil.failureMessage(new Error("boom"))
            FsUtil.optionalOpenFlag("O_NOFOLLOW")
            MissingTool.named(127, "sh: 1: foobar: not found")
            MissingTool.headline("foobar")
            HostProbes.environmentKey(envWithSecret)
            HostProbes.make()
            const fullSpace = { free: 100, total: 100_000_000_000 }
            if (!FullDisk.isFull(fullSpace)) throw new Error("FullDisk.isFull")
            FullDisk.sizeOf(1024 * 1024 * 5)
            FullDisk.fullLine("/tmp/machines", fullSpace, 2, 1024, 512)
            const statSample =
              "123 (node) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42"
            Parts.waitedCpuMs(statSample)
            const clocks = Parts.clocksOf(() => statSample)
            const led = Parts.ledger(clocks)
            Parts.commandBegan(clocks)
            Parts.beforeRun(led, clocks, false)
            const sf = parseModule("src/sample.ts", `import { x } from "./dep.js"\nexport const y = x + 1\n`)
            if (sf.statements.length === 0) throw new Error("parseModule empty")
            return true
          }),
        { executions, seed: seed + 20 }
      )
    )
    assertPassed(report)
  })

  it("Real workspace Affected, Owners, Resolver closure, GithubRender, GitHooks, OverlayExec, PathTools, StampExec & KnownRed.read fuzz invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-buildcli-graph-")))
    try {
      await write(
        tmpRoot,
        "WORKSPACE.ts",
        `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("graphws", {
  repository: "git+https://example.invalid/graphws.git",
  cache: S.Cache({ directory: ".flows" }),
  owners: { owners: ["team:platform"], agents: { default: "human-approve", "auto-land": ["*.md"] } },
  teams: S.Teams({ platform: ["alice", "bob"], data: ["carol"] }),
  gitHooks: {
    preCommit: S.Shell.Test({ shell: "echo pre-commit", sandbox: "none" })
  }
})
`
      )
      await write(
        tmpRoot,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const preCommit = S.Shell.Test({ shell: "echo ok", sandbox: "none" })
const setup = S.Github.Setup({})
const ciWf = S.Github.Workflow({
  name: "ci",
  on: { push: { branches: ["main"] } },
  setup,
  run: [preCommit]
})
const ciGen = S.Github.CiGen({ workflows: [ciWf] })
const cronJob = S.Cron({
  schedule: "0 6 * * *",
  run: [preCommit]
})
export const Package = S.Package({
  owners: { owners: ["team:platform"] },
  targets: { preCommit, setup, ciWf, ciGen, cronJob }
})
`
      )
      await write(
        tmpRoot,
        "packages/lib/PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const build = S.Shell.Build({
  shell: "echo lib",
  data: [srcs],
  outFiles: ["dist/lib.js"],
  sandbox: "none"
})
export const Package = S.Package({
  owners: { owners: ["alice"], perFile: { "*.sql": ["team:data"] }, agents: { "auto-land": ["*.md"] } },
  targets: { srcs, build }
})
`
      )
      await write(
        tmpRoot,
        "packages/app/PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
import { Package as Lib } from "../lib/PACKAGE.ts"
const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const test = S.Shell.Test({
  shell: "echo app",
  data: [srcs, Lib.build],
  sandbox: "none"
})
const unitTest = S.Vitest({
  sources: [S.glob("src/**/*.ts")],
  tests: [S.glob("test/**/*.test.ts")],
  deps: [],
  config: null,
  environment: "node",
  passWithNoTests: true,
  units: "file"
})
export const Package = S.Package({
  owners: { owners: ["bob"] },
  targets: { srcs, test, unitTest }
})
`
      )
      await write(tmpRoot, "packages/lib/src/util.ts", `export const add = (a: number, b: number) => a + b\n`)
      await write(
        tmpRoot,
        "packages/lib/src/index.ts",
        `import * as Path from "node:path"\nimport { add } from "./util.js"\nimport { helper } from "#internal"\nexport const run = () => Path.join(String(add(1, 2)), helper())\n`
      )
      await write(tmpRoot, "packages/lib/src/internal.ts", `export const helper = () => "ok"\n`)
      await write(
        tmpRoot,
        "packages/lib/package.json",
        JSON.stringify({ name: "@graphws/lib", imports: { "#internal": "./src/internal.ts" } }, null, 2)
      )
      await write(
        tmpRoot,
        "packages/app/src/main.ts",
        `import { run } from "@lib/index"\nconsole.log(run())\n`
      )
      await write(
        tmpRoot,
        "packages/app/test/sample.test.ts",
        `import "../src/main.ts"\nexport const ok = true\n`
      )
      await write(
        tmpRoot,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@lib/*": ["packages/lib/src/*"] }
          }
        })
      )
      await write(tmpRoot, "packages/lib/schema.sql", "SELECT 1;\n")
      await write(tmpRoot, "README.md", "# GraphWS\n")
      await write(
        tmpRoot,
        "known-red.json",
        JSON.stringify({
          entries: [
            {
              label: "//packages/app:test",
              owner: "bob",
              reason: "known",
              issue: "https://github.com/smithersai/smithers/issues/2",
              expires: "2027-01-01",
              failureDigest: KnownRed.fingerprint("boom")
            }
          ]
        })
      )
      execFileSync("jj", ["git", "init"], { cwd: tmpRoot, stdio: "ignore" })

      const discovery = await PackageDiscovery.discover(tmpRoot)
      const graph = await PackageLoader.load(discovery)
      const index = PackageIndex.make(graph)

      // GithubRender: render, write, check (clean + stale)
      const ciGenRow = index.resolve("//:ciGen")[0]!
      const renderedCi = GithubRender.render({
        ciGen: ciGenRow.target,
        workspace: graph.workspace,
        resolve: {
          labelOf: (t) => index.labelOf(t),
          targets: () => index.targets().map((r) => ({ label: r.label, target: r.target }))
        },
        packageDir: ""
      })
      expect(renderedCi.files.length).toBeGreaterThanOrEqual(2)
      const wr = await GithubRender.write(tmpRoot, renderedCi)
      expect(wr.wrote.length).toBeGreaterThanOrEqual(2)
      const chkClean = await GithubRender.check(tmpRoot, renderedCi)
      expect(chkClean.clean).toBe(true)

      // GitHooks: render, install, check
      const hookRendered = GitHooks.render({ preCommit: "//:preCommit", prePush: "//packages/app:test" })
      expect(hookRendered.length).toBe(2)
      const hookInstalled = await GitHooks.install(tmpRoot, hookRendered)
      expect(hookInstalled.wrote.length).toBe(2)
      const hookChecked = await GitHooks.check(tmpRoot, hookRendered)
      expect(hookChecked.clean).toBe(true)

      // OverlayExec: resolve & apply into scratch copy
      const baseFg = S.Filegroup({ srcs: [S.file("packages/lib/src/util.ts")] })
      const overlayT = S.Overlay({
        base: baseFg,
        replace: { "packages/lib/src/util.ts": S.file("packages/lib/src/internal.ts") }
      })
      const consumerT = S.Shell.Build({ shell: "echo ok", data: [overlayT], outFiles: ["out.txt"] })
      const ovRes = await OverlayExec.resolve({
        root: tmpRoot,
        consumer: consumerT,
        packagePathOf: () => "",
        labelOf: () => "//:overlay"
      })
      expect(ovRes.refusal).toBeUndefined()
      expect(ovRes.replacements.length).toBe(1)
      const scratchRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-overlay-scratch-")))
      try {
        await write(scratchRoot, "packages/lib/src/util.ts", "old\n")
        await write(scratchRoot, "packages/lib/src/internal.ts", "new\n")
        await OverlayExec.apply(scratchRoot, ovRes.replacements)
        const replaced = await Fs.readFile(NodePath.join(scratchRoot, "packages/lib/src/util.ts"), "utf8")
        expect(replaced).toBe("new\n")
      } finally {
        await Fs.rm(scratchRoot, { recursive: true, force: true })
      }

      // KnownRed.read, PathTools, FullDisk, StampExec
      const readKr = await KnownRed.read(tmpRoot, "known-red.json")
      expect(readKr.entries.length).toBe(1)
      const toolsDir = await PathTools.directory(tmpRoot, "fuzz-tools", [{ name: "node", path: process.execPath }])
      expect(toolsDir.length).toBeGreaterThan(0)
      expect(PathTools.undeclaredLine("curl")).toContain("curl")
      await FullDisk.spaceOf(tmpRoot)
      await FullDisk.heldUnder(tmpRoot)
      await StampExec.resolveArgv(tmpRoot, ["plain", StampExec.token("UNKNOWN", "fallback")])

      // Resolver config + TestUnits.discover + fuzz closure, Affected, Owners & TestUnits.select
      const resCfg = await Resolver.loadResolverConfig({ workspaceRoot: tmpRoot })
      const discoveredUnits = await TestUnits.discover({ index, target: "//packages/app:unitTest" })
      expect(discoveredUnits.units.length).toBe(1)
      const firstUnit = discoveredUnits.units[0]!
      const unitClosure = TestUnits.closure(discoveredUnits, firstUnit)
      expect(unitClosure.files.length).toBeGreaterThanOrEqual(1)
      const arb = Arbitrary.schema(
        Schema.Struct({
          changedPath: Schema.Literals([
            "packages/lib/src/util.ts",
            "packages/lib/schema.sql",
            "packages/app/src/main.ts",
            "README.md",
            "WORKSPACE.ts"
          ]),
          explain: Schema.Boolean,
          entryFile: Schema.Literals(["packages/lib/src/index.ts", "packages/app/src/main.ts"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ changedPath, explain, entryFile }) =>
            Effect.gen(function*() {
              // Affected.select (both plain & explain)
              const sel = explain
                ? Affected.select(index, ["//..."], [changedPath], { explain: true })
                : Affected.select(index, ["//..."], [changedPath])
              if (changedPath === "packages/lib/src/util.ts") {
                const labels = sel.targets.map((t) => t.label)
                if (!labels.includes("//packages/lib:build") || !labels.includes("//packages/app:test")) {
                  throw new Error("Affected.select missed transitive dependent")
                }
              }

              // Owners resolution & renderers
              Owners.packageOf(index, changedPath)
              Owners.upstreamPackages(index, "packages/app")
              Owners.packageOwners(index, "packages/lib")
              const agPol = Owners.agentPolicyOf(index, changedPath)
              if (changedPath === "README.md" && agPol !== "auto-land") {
                throw new Error("Owners.agentPolicyOf missed auto-land")
              }
              const res = Owners.resolve(index, [changedPath])
              Owners.toJson(res)
              Owners.text(res)
              Owners.rdeps(index, "//packages/lib:build")
              const co = Owners.renderCodeowners(index, "acme")
              if (!co.includes("@acme/platform")) throw new Error("renderCodeowners")
              const tree = Owners.renderOwnersTree(index)
              if (tree.length === 0) throw new Error("renderOwnersTree")

              // Resolver.computeClosure + extractSpecifiers + rowCacheKey
              const closure = yield* Effect.promise(() =>
                Resolver.computeClosure({ config: resCfg, entries: [entryFile] })
              )
              if (!closure.result.files.some((f) => f.path === entryFile)) {
                throw new Error("computeClosure missing entry")
              }
              if (entryFile === "packages/app/src/main.ts") {
                if (!closure.result.files.some((f) => f.path === "packages/lib/src/util.ts")) {
                  throw new Error("computeClosure missed transitive path alias import")
                }
              }
              const rk = Resolver.rowCacheKey("a".repeat(64), resCfg.configDigest)
              if (rk.length === 0) throw new Error("rowCacheKey")

              // TestUnits.changeOf + TestUnits.select across changed paths
              const uChange = TestUnits.changeOf(index, discoveredUnits, [changedPath])
              const uSel = TestUnits.select(discoveredUnits, uChange)
              if (changedPath === "packages/app/src/main.ts" && uSel.length === 0) {
                throw new Error("TestUnits.select missed direct source import")
              }
              return true
            }),
          { executions: fsExecutions, seed: seed + 21 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
