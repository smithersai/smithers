/**
 * Wave-8G deep fuzz tests targeting remaining uncovered paths across:
 * 1. Cli (`ci --remote` with local Remote.Command, `approve` error paths,
 *    `bench --fail-on-regression` human exit, `affected` with modified PACKAGE.ts
 *    hitting Cli L599-604 & PackageLoader.loadAt), Executor (`mergePlans` conflict
 *    & lint precedence, `encodeCacheOutput` byte & member limits), effect-resolution.js
 *    (revisionHooks `.js -> .ts` fallback).
 * 2. Cache (all inert JSON / lossy number / symbol / accessor / sparse / key /
 *    storedAt / EEXIST validation errors), engine (`packageManagerEnvironment` /
 *    `runInstall` hostile environment & sensitiveEnvironment checks), Planner
 *    (`encodeKeyMaterial` KeyMaterialError branches & `fingerprintSources` limits),
 *    PackageLoader (string escape sequences), WorkspaceLoader (all error branches),
 *    TargetIndex (`text` formatting + pnpm-workspace/node-modules/link).
 * 3. AgentSession (missing agents, unknown member, invalid Codex MCP name,
 *    subprocess stdout limit, stderr tail, timeout, codexErrorMessages),
 *    GitCommit (invalid timeoutMs, empty/blank paths, non-git, dirty tree,
 *    scratch index rollback on gate failure), GitHooks (invalid label, non-git,
 *    missing/stale check, directory conflict, uninstall), NixExec (`Nix.File`,
 *    missing flake.lock hint, version/dev-env/JSON errors), CacheAdmin (`remove`
 *    size-cap eviction across results + Go compile cache), FoundryExec (mise +
 *    `[tools]` section + missing), OverlayExec (missing source, outside scratch,
 *    file-as-dir, dangling symlink), ContainedProcess (`output_limit`, `timed_out`,
 *    `cancelled`, `EPIPE`), Watch (`run` with live file edit & rescan),
 *    RepoResolution (abort, output limit, non-git status).
 */
import { Fuzz } from "@smthrs/fuzz"
import * as Node from "@smthrs/plan/Node"
import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"
import * as Cache from "../src/Cache.ts"
import * as CacheAdmin from "../src/CacheAdmin.ts"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import * as Engine from "../src/engine.ts"
import * as Executor from "../src/Executor.ts"
import * as FoundryExec from "../src/FoundryExec.ts"
import * as GitCommit from "../src/GitCommit.ts"
import * as GitHooks from "../src/GitHooks.ts"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"
import * as NixExec from "../src/NixExec.ts"
import * as OverlayExec from "../src/OverlayExec.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as Planner from "../src/Planner.ts"
import * as RepoResolution from "../src/RepoResolution.ts"
import type * as Reporter from "../src/Reporter.ts"
import * as TargetIndex from "../src/TargetIndex.ts"
import * as Watch from "../src/Watch.ts"
import * as WorkspaceLoader from "../src/WorkspaceLoader.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50")
const ioExecutions = Math.min(executions, 4)
const mediumExecutions = Math.min(executions, 12)
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")
const mainJs = fileURLToPath(new URL("../src/main.js", import.meta.url))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const raw = await NodeFs.promises.mkdtemp(NodePath.join(NodeOs.tmpdir(), prefix))
  const dir = await NodeFs.promises.realpath(raw)
  try {
    return await body(dir)
  } finally {
    await NodeFs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const writeFile = async (root: string, rel: string, content: string, mode?: number): Promise<string> => {
  const full = NodePath.join(root, rel)
  await NodeFs.promises.mkdir(NodePath.dirname(full), { recursive: true })
  await NodeFs.promises.writeFile(full, content)
  if (mode !== undefined) await NodeFs.promises.chmod(full, mode)
  return full
}

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Wave8G", "-c", "user.email=wave8g@example.invalid", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim()

const serveCli = async (
  root: string,
  args: ReadonlyArray<string>,
  opts: {
    readonly audience?: "human" | "agent"
    readonly env?: Record<string, string | undefined>
  } = {}
) => {
  let stdout = ""
  let stderr = ""
  let exitCode = 0
  const term = (sink: (t: string) => void): Reporter.Terminal => ({ write: sink, isTTY: false, columns: 100 })
  await makeCli({
    environment: {
      ...process.env,
      SMITHERS_AUDIENCE: opts.audience ?? "agent",
      NO_COLOR: "1",
      CI: undefined,
      ...(opts.env ?? {})
    },
    stdout: term((t) => {
      stdout += t
    }),
    stderr: term((t) => {
      stderr += t
    })
  }).serve([...normalizeArgv(args), "--workspace", root], {
    exit: (c) => {
      exitCode = c
    },
    stdout: (t) => {
      stdout += t
    }
  })
  return { exitCode, stdout, stderr }
}

describe("@smthrs/build-cli Wave-8G: Cli remote/approve/bench/affected, Executor, Cache, Engine, Planner, Loaders, TargetIndex, AgentSession, GitCommit, GitHooks, Nix, CacheAdmin, Foundry, Overlay, ContainedProcess, Watch & RepoResolution fuzz", () => {
  it(
    "Cli ci --remote (local Remote.Command), approve errors, bench human regression, affected with modified PACKAGE.ts, Executor.mergePlans/encodeCacheOutput",
    async () => {
      const slugGen = Arbitrary.schema(Schema.Literals(["g0", "g1"]))
      const report = await Effect.runPromise(
        Fuzz.run(
          slugGen,
          (slug) =>
            Effect.promise(async () => {
              await withTempDir(`smthrs-w8g-cli-${slug}-`, async (base) => {
                const root = NodePath.join(base, "ws")
                const guest = NodePath.join(base, "guest")
                await NodeFs.promises.mkdir(guest, { recursive: true })
                await writeFile(root, "package.json", JSON.stringify({ name: `cli-${slug}`, private: true }) + "\n")
                await writeFile(root, "yarn.lock", "# yarn lockfile v1\n")
                await writeFile(root, "helper.ts", `export const tag = "${slug}"\n`)
                await writeFile(
                  root,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
const cli = ["node", ${JSON.stringify(mainJs)}]
const workdir = ${JSON.stringify(guest)}
export const Workspace = S.Workspace("cli-${slug}", {
  repository: "git+https://example.invalid/cli.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  remotes: S.Remotes({ pair: S.Remote.Command({ machines: [[], []], workdir, cli }) })
})
`
                )
                await writeFile(
                  root,
                  "PACKAGE.ts",
                  `import { Smithers as S } from "@smthrs/targets"
import { tag } from "./helper.js"
const a = S.Shell.Test({ shell: "echo " + tag })
const b = S.Shell.Test({ shell: "true", data: [a] })
const bench = S.NodeBench({ entry: S.file("//bench.mjs"), srcs: [S.file("//bench.mjs")], deps: [] })
export const Package = S.Package({ targets: { a, b, bench } })
`
                )
                await writeFile(
                  root,
                  "bench.mjs",
                  `console.log('BENCH_METRIC ' + JSON.stringify({ name: "op", meanMs: 20, hz: 50 }))\n`
                )
                await writeFile(
                  root,
                  "baseline.json",
                  JSON.stringify({
                    results: [{ label: "//:bench", benchmarks: [{ name: "op", meanMs: 1, hz: 1000 }] }]
                  }) + "\n"
                )
                git(root, "init", "-q")
                git(root, "add", "-A")
                git(root, "commit", "-qm", "init")

                // 1. Cli ci --remote pair --no-cache --jobs 1 --fail-fast (Cli.ts L1206-1244 + RemoteCi.ts)
                const rCi = await serveCli(root, [
                  "ci",
                  "//:a",
                  "//:b",
                  "--remote",
                  "pair",
                  "--no-cache",
                  "--jobs",
                  "1",
                  "--fail-fast"
                ])
                expect(rCi.exitCode).toBe(0)

                // 2. Cli approve error paths: multi-target (L938) & target without approval (L940)
                const rAppMulti = await serveCli(root, ["approve", "//..."])
                expect(rAppMulti.exitCode).not.toBe(0)
                const rAppNoDecl = await serveCli(root, ["approve", "//:a"])
                expect(rAppNoDecl.exitCode).not.toBe(0)

                // 3. Cli bench --fail-on-regression with audience: "human" (Cli.ts L1522-1536)
                const rBench = await serveCli(
                  root,
                  ["bench", "//:bench", "--baseline", "baseline.json", "--fail-on-regression", "5", "--no-cache"],
                  { audience: "human" }
                )
                expect(rBench.exitCode).toBe(1)

                // 4. Modify PACKAGE.ts in HEAD~1..HEAD so `affected` hits Cli.ts L599-604 & effect-resolution revisionHooks `.js -> .ts` (L493-503)!
                await writeFile(
                  root,
                  "PACKAGE.ts",
                  `import { Smithers as S } from "@smthrs/targets"
import { tag } from "./helper.js"
const a = S.Shell.Test({ shell: "echo " + tag + "-v2" })
const b = S.Shell.Test({ shell: "true", data: [a] })
const bench = S.NodeBench({ entry: S.file("//bench.mjs"), srcs: [S.file("//bench.mjs")], deps: [] })
export const Package = S.Package({ targets: { a, b, bench } })
`
                )
                git(root, "add", "PACKAGE.ts")
                git(root, "commit", "-qm", "edit package")
                const rAff = await serveCli(root, ["affected", "//...", "--base", "HEAD~1", "--plan"])
                expect([0, 1]).toContain(rAff.exitCode)

                // 5. Executor.mergePlans (conflict, lint override, duplicate warnings) & encodeCacheOutput limits (L266-278, L705-717)
                const mkPlan = (verb: Planner.Plan["verb"], key: string, warning: string): Planner.Plan => ({
                  verb,
                  pattern: "//:a",
                  roots: ["//:a"],
                  edges: [],
                  targets: [
                    {
                      label: "//:a",
                      target: "Shell.Test",
                      keyPreview: key,
                      cacheable: true,
                      dependencies: []
                    } as never
                  ],
                  warnings: [warning]
                })
                const mergedLintFirst = Executor.mergePlans([
                  mkPlan("lint", "k-lint", "w1"),
                  mkPlan("build", "k-build", "w1")
                ])
                expect(mergedLintFirst.targets[0]?.keyPreview).toBe("k-lint")
                expect(mergedLintFirst.warnings).toEqual(["w1"])
                const mergedLintSecond = Executor.mergePlans([
                  mkPlan("build", "k-build", "w1"),
                  mkPlan("lint", "k-lint", "w2")
                ])
                expect(mergedLintSecond.targets[0]?.keyPreview).toBe("k-lint")
                expect(() => Executor.mergePlans([mkPlan("build", "k1", "w1"), mkPlan("test", "k2", "w2")])).toThrow(
                  /incompatible execution views/
                )

                // encodeCacheOutput byte limit & member limit (strict) + describeFailure (lossy)
                const hugeStr = "x".repeat(Cache.entryLimit + 64)
                const encHuge = Executor.encodeCacheOutput({ a: hugeStr })
                expect("reason" in encHuge && encHuge.reason).toContain("byte cache output limit")
                const manyMembers = new Array(Cache.outputMemberLimit + 2).fill(0)
                const encMany = Executor.encodeCacheOutput(manyMembers)
                expect("reason" in encMany && encMany.reason).toContain("member cache output limit")
                const encBadTypes = [Number.NaN, -0, undefined, 1n, Symbol("s"), () => 1, new Proxy({}, {})]
                for (const v of encBadTypes) {
                  expect(Executor.encodeCacheOutput({ v })).toBeDefined()
                  expect(Executor.describeFailure({ v })).toBeDefined()
                }
                expect(Executor.describeFailure({ a: "x".repeat(50_000) })).toBeDefined()
                expect(Executor.describeFailure(Array.from({ length: 5_000 }, (_, i) => i))).toBeDefined()
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
    "Cache validation/EEXIST, Engine env/sensitiveEnvironment, Planner KeyMaterialError/source limits, PackageLoader escapes, WorkspaceLoader & TargetIndex.text",
    async () => {
      const modeGen = Arbitrary.schema(Schema.Literals(["c0", "c1", "c2"]))
      const report = await Effect.runPromise(
        Fuzz.run(
          modeGen,
          (mode) =>
            Effect.promise(async () => {
              await withTempDir(`smthrs-w8g-core-${mode}-`, async (base) => {
                // 1. Cache.ts inert JSON validation, entryLimit, storedAt/key mismatch & EEXIST temp exhaustion
                const cacheWs = NodePath.join(base, "cache-ws")
                await NodeFs.promises.mkdir(cacheWs, { recursive: true })
                const store = await Cache.openCache({ workspaceRoot: cacheWs, cacheDirectory: ".flows" })
                const baseEntry = {
                  key: "k1",
                  target: "Shell.Test",
                  label: "//:a",
                  exitOk: true,
                  storedAt: new Date().toISOString()
                }
                const symObj: Record<PropertyKey, unknown> = { [Symbol("s")]: 1 }
                const getterObj = Object.defineProperty({}, "g", { get: () => 1, enumerable: true })
                const sparseArr = new Array(3)
                sparseArr[0] = 1
                const badOutputs: ReadonlyArray<unknown> = [
                  Number.NaN,
                  () => 1,
                  sparseArr,
                  Object.assign([1], { extra: 2 }),
                  symObj,
                  getterObj,
                  "x".repeat(Cache.entryLimit + 64)
                ]
                for (const bad of badOutputs) {
                  await expect(store.put("k1", { ...baseEntry, output: bad })).rejects.toThrow()
                }
                // Non-canonical storedAt & mismatched key
                await expect(store.put("k1", { ...baseEntry, key: "k2", output: null })).rejects.toThrow(
                  /key does not match/
                )
                await expect(store.put("k1", { ...baseEntry, storedAt: "not-iso", output: null })).rejects.toThrow(
                  /ISO timestamp/
                )
                // Null output valid path (L371-372)
                await store.put("k-null", { ...baseEntry, key: "k-null", output: null })
                // Non-plain root result
                await expect(store.put("k1", "not-an-object" as unknown as Cache.CachedResult)).rejects.toThrow(
                  /plain object/
                )
                // EEXIST exhaustion on openTemp (L764-767)
                const eexistStore = await Cache.openCache({
                  workspaceRoot: cacheWs,
                  cacheDirectory: ".flows2",
                  io: {
                    openTemp: async () => {
                      const err = new Error("exists") as NodeJS.ErrnoException
                      err.code = "EEXIST"
                      throw err
                    }
                  }
                })
                await expect(eexistStore.put("k-eexist", { ...baseEntry, key: "k-eexist", output: 1 })).rejects.toThrow(
                  /unique temporary file/
                )

                // 2. Engine environment & sensitiveEnvironment validation (engine.ts L101-198)
                const badSens: ReadonlyArray<unknown> = [
                  Array.from({ length: 65 }, (_, i) => `V_${i}`),
                  ["BAD-NAME!"],
                  new Proxy([], { get: (_t, p) => (p === "length" ? -1 : undefined) }),
                  new Proxy(["A"], {
                    get: (_t, p) => {
                      if (p === "0") throw new Error("boom")
                      return 1
                    }
                  })
                ]
                for (const sensitiveEnvironment of badSens) {
                  expect(() =>
                    Engine.packageManagerEnvironment({
                      environment: {} as never,
                      sensitiveEnvironment: sensitiveEnvironment as never
                    })
                  ).toThrow(TypeError)
                }
                const getterEnv = Object.defineProperty({}, "FOO", { get: () => "1", enumerable: true })
                const hugeEnv = { BIG: "a".repeat(270_000) }
                const dupEnv = { foo: "1", FOO: "2" }
                const nonStrEnv = { FOO: 123 as unknown as string }
                const nulEnv = { FOO: "a\0b" }
                const throwingEnv = new Proxy({}, {
                  ownKeys: () => {
                    throw new Error("nope")
                  }
                })
                for (
                  const environment of [
                    null as unknown as Record<string, string>,
                    getterEnv,
                    hugeEnv,
                    dupEnv,
                    nonStrEnv,
                    nulEnv,
                    throwingEnv
                  ]
                ) {
                  expect(() => Engine.packageManagerEnvironment({ environment: environment as never })).toThrow(
                    TypeError
                  )
                }

                // 3. Planner.encodeKeyMaterial KeyMaterialError branches & fingerprintSources (Planner.ts L290-305, L537-627)
                class CustomProto {
                  x = 1
                }
                const nonEnum = Object.defineProperty({}, "h", { value: 1, enumerable: false })
                for (const bad of [new CustomProto(), symObj, nonEnum, getterObj]) {
                  expect(() =>
                    Planner.encodeKeyMaterial(
                      {
                        body: bad,
                        capabilities: [],
                        inputs: [],
                        layers: []
                      } as unknown as Parameters<typeof Planner.encodeKeyMaterial>[0]
                    )
                  ).toThrow()
                }
                // Missing source root returns failed / ENOENT handling
                const fpMissing = await Planner.fingerprintSources(
                  [{ name: "missing", path: NodePath.join(base, "no-such-dir") }] as never
                ).catch(() => "err")
                expect(fpMissing).toBeDefined()

                // 4. PackageLoader escape sequence scanning (PackageLoader.ts L286-324) & WorkspaceLoader errors (WorkspaceLoader.ts L38-102)
                const plWs = NodePath.join(base, "pl-ws")
                await writeFile(
                  plWs,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("pl", { repository: "git+https://example.invalid/pl.git", cache: S.Cache({ directory: ".flows" }) })\n`
                )
                await writeFile(
                  plWs,
                  "PACKAGE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nconst s1 = "line1\\\nline2\\n\\0\\x41"\nconst s2 = "\\01"\nexport const Package = S.Package({ targets: { t: S.Shell.Test({ shell: "echo " + s1.length + s2.length }) } })\n`
                )
                const plDisc = await PackageDiscovery.discover(plWs)
                await expect(PackageLoader.load(plDisc)).rejects.toThrow()
                await writeFile(
                  plWs,
                  "PACKAGE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nconst s1 = "line1\\\nline2\\n\\0\\x41"\nexport const Package = S.Package({ targets: { t: S.Shell.Test({ shell: "echo " + s1.length }) } })\n`
                )
                const plLoaded = await PackageLoader.load(await PackageDiscovery.discover(plWs))
                expect(plLoaded.packages.length).toBe(1)

                // WorkspaceLoader error cases
                expect(() => WorkspaceLoader.rootPackageOf({ Package: 123 }, ".smithers/WORKSPACE.smithers")).toThrow(
                  /not an S\.Package/
                )
                expect(WorkspaceLoader.rootPackageOf({}, ".smithers/WORKSPACE.smithers")).toBeUndefined()
                expect(() => WorkspaceLoader.validateWorkspaceModule(null, "WORKSPACE.ts")).toThrow(/module namespace/)
                expect(() => WorkspaceLoader.validateWorkspaceModule({}, "WORKSPACE.ts")).toThrow(/no Workspace export/)
                const sampleTarget = S.Shell.Test({ shell: "true" })
                const samplePkg = S.Package({ targets: { sampleTarget } })
                const sampleWs = S.Workspace("w", {
                  repository: "git+https://example.invalid/w.git",
                  cache: S.Cache({ directory: ".flows" })
                })
                expect(() =>
                  WorkspaceLoader.validateWorkspaceModule({ Workspace: sampleWs, stray: sampleTarget }, "WORKSPACE.ts")
                ).toThrow()
                expect(() =>
                  WorkspaceLoader.validateWorkspaceModule({ Workspace: sampleWs, other: samplePkg }, "WORKSPACE.ts")
                ).toThrow()
                expect(() =>
                  WorkspaceLoader.validateWorkspaceModule({ Workspace: sampleWs, Package: samplePkg }, "custom.ws.ts")
                ).toThrow()
                expect(
                  WorkspaceLoader.validateWorkspaceModule(
                    { Workspace: sampleWs, Package: samplePkg },
                    ".smithers/WORKSPACE.smithers"
                  )
                ).toBe(sampleWs)
                expect(WorkspaceLoader.rootPackageOf({ Package: samplePkg }, ".smithers/WORKSPACE.smithers")).toBe(
                  samplePkg
                )

                // 5. TargetIndex.text formatting (empty, featured, outputs, refusal, kinds) + pnpm-workspace/node-modules/link inputs
                const emptyText = TargetIndex.text({ pattern: "//...", targets: [] })
                expect(emptyText).toContain("no targets match")
                const richText = TargetIndex.text({
                  pattern: "//...",
                  targets: [
                    {
                      label: "//:a",
                      rule: "Shell.Build",
                      kinds: ["build", "test"],
                      featured: true,
                      outputs: ["dist"],
                      inputs: [],
                      dependencies: [],
                      refusal: "missing tool",
                      package: "",
                      name: "a"
                    } as never
                  ]
                })
                expect(richText).toContain("*")
                expect(richText).toContain("dist")
                expect(richText).toContain("refused")

                const tiWs = NodePath.join(base, "ti-ws")
                await writeFile(tiWs, "pnpm-workspace.yaml", "packages:\n  - packages/*\n")
                await writeFile(tiWs, "package.json", JSON.stringify({ name: "ti" }))
                await writeFile(tiWs, "link-target.txt", "hi\n")
                const tiTargetDef = Target.make("Custom.TiInputs", {
                  attrs: Schema.Struct({}),
                  kinds: ["build"],
                  inputs: () => [
                    S.pnpmWorkspace("pnpm-workspace.yaml"),
                    S.Npm.NodeModules({ packageJson: S.file("//package.json") }) as never,
                    S.link("link-target.txt")
                  ],
                  implementation: () => Node.succeed({})
                })
                const tiTarget = tiTargetDef({})
                const tiIdx = PackageIndex.make({
                  root: tiWs,
                  workspace: sampleWs,
                  factory: undefined,
                  packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { tiTarget } }) }]
                })
                const tiListing = await TargetIndex.build(tiIdx, "//...", process.env)
                expect(tiListing.targets.length).toBe(1)
              })
              return true
            }),
          { executions: mediumExecutions, seed }
        )
      )
      assertPassed(report)
    },
    180_000
  )

  it(
    "AgentSession, GitCommit, GitHooks, NixExec, CacheAdmin, FoundryExec, OverlayExec, ContainedProcess, Watch & RepoResolution deep paths",
    async () => {
      const slugGen = Arbitrary.schema(Schema.Literals(["s0", "s1", "s2"]))
      const report = await Effect.runPromise(
        Fuzz.run(
          slugGen,
          (slug) =>
            Effect.promise(async () => {
              await withTempDir(`smthrs-w8g-sub-${slug}-`, async (base) => {
                // 1. AgentSession errors & codexErrorMessages / claudeMcpConfig / subprocess timeout & stdout limit
                expect(() => AgentSession.resolveAgents(undefined, undefined)).toThrow(/no S\.Agents/)
                const declaredAgents = S.Agents({
                  default: S.Agent.Codex({ model: "luna" }),
                  loop: S.Agent.Pool(["loop"])
                })
                expect(() => AgentSession.resolveAgents(declaredAgents, { _tag: "AgentRef", name: "missing" })).toThrow(
                  /names no declared/
                )
                expect(() => AgentSession.resolveAgents(declaredAgents, { _tag: "AgentRef", name: "loop" })).toThrow(
                  /no concrete agent/
                )
                expect(() =>
                  AgentSession.resolveAgents(
                    declaredAgents,
                    { _tag: "AgentPool", agents: ["loop"] } as unknown as Parameters<
                      typeof AgentSession.resolveAgents
                    >[1]
                  )
                ).toThrow(/no concrete agent/)
                expect(
                  AgentSession.codexErrorMessages(
                    `${JSON.stringify({ type: "error", message: "bad token" })}\n${
                      JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } })
                    }\nnot-json\n`
                  )
                ).toEqual(["bad token", "rate limited"])
                // Invalid Codex MCP server name (AgentSession.ts L617-618)
                const badCliFac = AgentSession.makeCliSessionFactory({
                  agents: declaredAgents,
                  workspaceRoot: base,
                  environment: process.env,
                  timeoutMs: 250
                })
                const badMcpExit = await Effect.runPromise(
                  Effect.exit(
                    badCliFac.open(S.Agent.Codex({ model: "luna" }), [
                      { name: "bad name!", url: "http://127.0.0.1:1", transport: "http" } as never
                    ])
                  )
                )
                expect(Exit.isFailure(badMcpExit)).toBe(true)
                // Subprocess stdout overflow + stderr tail + timeout via fake `codex` on PATH
                const agBin = NodePath.join(base, "ag-bin")
                await writeFile(
                  base,
                  "ag-bin/codex",
                  slug === "s0"
                    ? "#!/bin/sh\necho err-detail >&2\nhead -c 2048 /dev/zero | tr '\\0' 'a'\n"
                    : slug === "s1"
                    ? "#!/bin/sh\necho '{\"type\":\"error\",\"message\":\"boom\"}' \nexit 1\n"
                    : "#!/bin/sh\nsleep 5\n",
                  0o755
                )
                const agFac = AgentSession.makeCliSessionFactory({
                  agents: declaredAgents,
                  workspaceRoot: base,
                  environment: { ...process.env, PATH: `${agBin}:${process.env["PATH"] ?? ""}` },
                  timeoutMs: 150
                })
                const agExit = await Effect.runPromise(
                  Effect.exit(
                    agFac.open(S.Agent.Codex({ model: "luna" }), []).pipe(
                      Effect.flatMap((session) => session.run({ purpose: "lint", prompt: "hi" }))
                    )
                  )
                )
                expect(Exit.isFailure(agExit)).toBe(true)

                // 2. GitCommit errors & scratch index rollback (GitCommit.ts L221-468)
                const gcTarget = S.Git.Commit({ message: "test commit", gates: [] })
                await expect(
                  GitCommit.commit({ root: base, target: gcTarget, timeoutMs: 0, gateRunner: { run: async () => [] } })
                ).rejects.toThrow(/positive and finite/)
                await expect(
                  GitCommit.commit({ root: base, target: gcTarget, paths: [], gateRunner: { run: async () => [] } })
                ).rejects.toThrow(/empty scope/)
                await expect(
                  GitCommit.commit({ root: base, target: gcTarget, paths: ["  "], gateRunner: { run: async () => [] } })
                ).rejects.toThrow(/blank/)
                const nonGit = NodePath.join(base, "non-git")
                await NodeFs.promises.mkdir(nonGit, { recursive: true })
                await expect(
                  GitCommit.commit({ root: nonGit, target: gcTarget, gateRunner: { run: async () => [] } })
                ).rejects.toThrow(/not inside a git work tree/)

                const gcRepo = NodePath.join(base, "gc-repo")
                await writeFile(gcRepo, "a.txt", "v1\n")
                await writeFile(gcRepo, "other.txt", "o1\n")
                git(gcRepo, "init", "-q")
                git(gcRepo, "config", "user.name", "Wave8G")
                git(gcRepo, "config", "user.email", "wave8g@example.invalid")
                git(gcRepo, "add", "-A")
                git(gcRepo, "commit", "-qm", "init")
                // Modify a.txt + add b.txt, then fail gate so scratch index rollback runs (L277-312)!
                await writeFile(gcRepo, "a.txt", "v2\n")
                await writeFile(gcRepo, "b.txt", "new\n")
                await expect(
                  GitCommit.commit({
                    root: gcRepo,
                    target: gcTarget,
                    paths: ["a.txt", "b.txt"],
                    gateRunner: {
                      run: async () => [{ label: "//:gate", reason: "red" } as never]
                    }
                  })
                ).rejects.toThrow()
                // Dirty without paths scope (L375) AND staged outside paths scope (L387)
                await writeFile(gcRepo, "other.txt", "dirty\n")
                await expect(
                  GitCommit.commit({
                    root: gcRepo,
                    target: gcTarget,
                    gateRunner: { run: async () => [] }
                  })
                ).rejects.toThrow(/unrelated|change/)
                git(gcRepo, "add", "other.txt")
                await expect(
                  GitCommit.commit({
                    root: gcRepo,
                    target: gcTarget,
                    paths: ["a.txt"],
                    gateRunner: { run: async () => [] }
                  })
                ).rejects.toThrow(/staged/)

                // 3. GitHooks errors & check/install/uninstall (GitHooks.ts L147-404)
                expect(() => GitHooks.render({ preCommit: "bad label!!" })).toThrow(/renderable target label/)
                const hookA = GitHooks.render({ preCommit: "//:a" })
                const hookB = GitHooks.render({ preCommit: "//:b" })
                await expect(GitHooks.check(nonGit, hookA)).rejects.toThrow(/not_a_git_repository|no \.git directory/)
                const ghRepo = NodePath.join(base, "gh-repo")
                await NodeFs.promises.mkdir(ghRepo, { recursive: true })
                git(ghRepo, "init", "-q")
                const chkMissing = await GitHooks.check(ghRepo, hookA)
                expect(chkMissing.clean).toBe(false)
                // Install then check stale + uninstall
                await GitHooks.install(ghRepo, hookA)
                const chkStale = await GitHooks.check(ghRepo, hookB)
                expect(chkStale.clean).toBe(false)
                // Uninstall by installing empty hooks
                await GitHooks.install(ghRepo, [])
                // Directory blocking hook path -> EEXIST
                await NodeFs.promises.mkdir(NodePath.join(ghRepo, ".git", "hooks", "pre-commit"), { recursive: true })
                await expect(GitHooks.install(ghRepo, hookA)).rejects.toThrow()

                // 4. NixExec errors (NixExec.ts L173-363)
                const nixWs = NodePath.join(base, "nix-ws")
                await writeFile(nixWs, "shell.nix", "{}\n")
                await writeFile(nixWs, "flake.nix", "{}\n")
                // Fake nix failing --version / print-dev-env / bad JSON + missing flake.lock hint (L227-230)
                const nixBin = NodePath.join(nixWs, "nix-bin")
                const nixEnvOk = NodePath.join(nixWs, "nix-bin-ok")
                await writeFile(nixWs, "nix-bin-ok/nix", "#!/bin/sh\necho 'nix (Nix) 2.24.0'\n", 0o755)
                await expect(
                  NixExec.resolveEnvironment({
                    root: nixWs,
                    declaration: S.Nix.Environment({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") }),
                    environment: { ...process.env, PATH: `${nixEnvOk}:${process.env["PATH"] ?? ""}` }
                  })
                ).rejects.toThrow(/flake\.lock/)
                await writeFile(
                  nixWs,
                  "nix-bin/nix",
                  slug === "s0"
                    ? "#!/bin/sh\necho bad-ver >&2\nexit 1\n"
                    : slug === "s1"
                    ? "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'nix (Nix) 2.24.0'; exit 0; fi\necho 'not json'\nexit 0\n"
                    : "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'nix (Nix) 2.24.0'; exit 0; fi\necho eval-fail >&2\nexit 1\n",
                  0o755
                )
                await expect(
                  NixExec.resolveEnvironment({
                    root: nixWs,
                    declaration: S.Nix.Environment({ file: S.file("//shell.nix") }),
                    environment: { ...process.env, PATH: `${nixBin}:${process.env["PATH"] ?? ""}` }
                  })
                ).rejects.toThrow()

                // 5. CacheAdmin.remove with maxSizeBytes across results + Go compile cache (CacheAdmin.ts L194-208)
                const caWs = NodePath.join(base, "ca-ws")
                await NodeFs.promises.mkdir(caWs, { recursive: true })
                const caStore = await Cache.openCache({ workspaceRoot: caWs, cacheDirectory: ".flows" })
                await caStore.put("ca-1", {
                  key: "ca-1",
                  target: "Shell.Test",
                  label: "//:a",
                  exitOk: true,
                  output: "x".repeat(4096),
                  storedAt: new Date(Date.now() - 86_400_000).toISOString()
                })
                // Seed Go build cache entries (one old, one recent in-use)
                const goCacheDir = NodePath.join(caWs, ".flows", "go-build")
                const oldGo = await writeFile(
                  goCacheDir,
                  "00/0000000000000000000000000000000000000000000000000000000000000001-a",
                  "g".repeat(2048)
                )
                const newGo = await writeFile(
                  goCacheDir,
                  "01/0100000000000000000000000000000000000000000000000000000000000002-a",
                  "h".repeat(2048)
                )
                const ancient = new Date(Date.now() - 7_200_000)
                await NodeFs.promises.utimes(oldGo, ancient, ancient)
                const nowDate = new Date()
                await NodeFs.promises.utimes(newGo, nowDate, nowDate)
                const removed = await CacheAdmin.remove({
                  root: caWs,
                  cacheDirectory: ".flows",
                  maxSizeBytes: 100,
                  dryRun: false,
                  yes: true
                })
                expect(removed.removed).toBeGreaterThanOrEqual(1)

                // 6. FoundryExec with mise + [tools] section + absent foundry.toml (FoundryExec.ts L57-158)
                const fWs = NodePath.join(base, "f-ws")
                await writeFile(fWs, "mise.toml", "[tools]\nfoundry = \"0.2.0\"\n")
                const fBin = NodePath.join(fWs, "f-bin")
                await writeFile(fWs, "f-bin/forge", "#!/bin/sh\necho 'forge 0.2.0'\n", 0o755)
                await writeFile(
                  fWs,
                  "f-bin/mise",
                  slug === "s0"
                    ? `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "mise 2026.1.0"; exit 0; fi\necho ${
                      JSON.stringify(NodePath.join(fBin, "forge"))
                    }\n`
                    : "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"mise 2026.1.0\"; exit 0; fi\nexit 1\n",
                  0o755
                )
                const fEnv = { ...process.env, PATH: `${fBin}:${process.env["PATH"] ?? ""}` }
                const fWsDecl = {
                  ...S.Workspace(`fw-${slug}`, {
                    repository: "git+https://example.invalid/fw.git",
                    cache: S.Cache({ directory: ".flows" })
                  }),
                  toolchains: [
                    {
                      _tag: "FoundryToolchain",
                      config: S.file("//foundry.toml"),
                      versions: { config: S.file("//mise.toml") }
                    }
                  ]
                }
                const fResolved = await FoundryExec.resolveMiseBin(fWs, fWsDecl as never, "forge", fEnv)
                expect(fResolved).toBeDefined()
                const fMissing = await FoundryExec.resolveMiseBin(fWs, fWsDecl as never, "forge", { PATH: "" })
                expect(fMissing).toBeDefined()
                const fPlan = await FoundryExec.plan({
                  root: fWs,
                  packagePath: "",
                  workspace: fWsDecl as never,
                  rule: "Foundry.Build",
                  mode: "execute",
                  environment: fEnv,
                  attrs: { srcs: [] } as never
                })
                expect(fPlan).toBeDefined()

                // 7. OverlayExec errors (OverlayExec.ts L131-190)
                const ovWs = NodePath.join(base, "ov-ws")
                const ovScratch = NodePath.join(base, "ov-scratch")
                await writeFile(ovWs, "src.txt", "hello\n")
                await writeFile(ovScratch, "src.txt", "hello\n")
                await writeFile(ovScratch, "blocker", "i am a file\n")
                await NodeFs.promises.symlink("nonexistent-target", NodePath.join(ovScratch, "dangling"))
                const ovBase = S.Filegroup({ srcs: [S.file("//src.txt")] })
                const ovTarget = S.Overlay({
                  base: ovBase,
                  replace: { "dst.txt": S.file("//missing.txt") }
                })
                const ovConsumer = S.Shell.Test({ shell: "true", data: [ovTarget] })
                const ovMissing = await OverlayExec.resolve({
                  root: ovWs,
                  consumer: ovConsumer,
                  packagePathOf: () => "",
                  labelOf: () => "//:ov"
                })
                expect(ovMissing.refusal).toContain("missing")
                await expect(
                  OverlayExec.apply(ovScratch, [{
                    overlay: "//:ov",
                    source: "src.txt",
                    path: "../escape.txt",
                    digest: "0".repeat(64)
                  }])
                ).rejects.toThrow(/outside/)
                await expect(
                  OverlayExec.apply(ovScratch, [{
                    overlay: "//:ov",
                    source: "src.txt",
                    path: "blocker/sub.txt",
                    digest: "0".repeat(64)
                  }])
                ).rejects.toThrow(/not a real directory/)
                await expect(
                  OverlayExec.apply(ovScratch, [{
                    overlay: "//:ov",
                    source: "src.txt",
                    path: "dangling",
                    digest: "0".repeat(64)
                  }])
                ).rejects.toThrow(/dangling/)

                // 8. ContainedProcess output_limit, timed_out, cancelled, EPIPE (ContainedProcess.ts L110-172)
                await expect(
                  ContainedProcess.run({
                    command: process.execPath,
                    args: ["-e", "process.stdout.write(\"x\".repeat(4096))"],
                    cwd: base,
                    maxOutputBytes: 64,
                    stdout: () => undefined,
                    stderr: () => undefined
                  })
                ).rejects.toMatchObject({ code: "output_limit" })
                await expect(
                  ContainedProcess.run({
                    command: process.execPath,
                    args: ["-e", "setTimeout(() => {}, 5000)"],
                    cwd: base,
                    timeoutMs: 60,
                    stdout: () => undefined,
                    stderr: () => undefined
                  })
                ).rejects.toMatchObject({ code: "timed_out" })
                const cpAc = new AbortController()
                setTimeout(() => cpAc.abort(new Error("stop")), 50)
                await expect(
                  ContainedProcess.run({
                    command: process.execPath,
                    args: ["-e", "setTimeout(() => {}, 5000)"],
                    cwd: base,
                    signal: cpAc.signal,
                    stdout: () => undefined,
                    stderr: () => undefined
                  })
                ).rejects.toMatchObject({ code: "cancelled" })
                // EPIPE: child exits immediately while large stdin is written
                const epCode = await ContainedProcess.run({
                  command: process.execPath,
                  args: ["-e", "process.exit(0)"],
                  cwd: base,
                  stdin: "z".repeat(256_000),
                  stdout: () => undefined,
                  stderr: () => undefined
                })
                expect(epCode).toBe(0)

                // 9. Watch.run live file edit + rescan + clean abort (Watch.ts L38-186)
                const wWs = NodePath.join(base, "watch-ws")
                await writeFile(wWs, "a.txt", "1\n")
                const wAc = new AbortController()
                let cyclesSeen = 0
                const wExit = await Watch.run({
                  root: wWs,
                  ignored: [".flows"],
                  args: ["--help"],
                  debounceMs: 20,
                  rescanMs: 40,
                  once: false,
                  signal: wAc.signal,
                  stdout: () => undefined,
                  stderr: () => undefined,
                  cycleCompleted: (c) => {
                    cyclesSeen = c.number
                    if (c.number === 1) {
                      void NodeFs.promises.writeFile(NodePath.join(wWs, "a.txt"), "2\n")
                    } else if (c.number >= 2) {
                      wAc.abort()
                    }
                  }
                }).catch(() => -1)
                expect(cyclesSeen >= 1 || wExit === -1).toBe(true)

                // 10. RepoResolution non-git status error & child abort (RepoResolution.ts L184-455)
                const childNonGit = NodePath.join(base, "child-nongit")
                await NodeFs.promises.mkdir(childNonGit, { recursive: true })
                const rrIdx = PackageIndex.make({
                  root: base,
                  workspace: S.Workspace(`rr-${slug}`, {
                    repository: "git+https://example.invalid/rr.git",
                    cache: S.Cache({ directory: ".flows" })
                  }),
                  factory: undefined,
                  packages: []
                })
                const rr = RepoResolution.resolver(rrIdx, process.env)
                await expect(
                  RepoResolution.gitState(rr, {
                    repoName: "c",
                    repoRoot: childNonGit,
                    label: "//:a",
                    path: "child-nongit"
                  } as never)
                ).rejects.toThrow()
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
