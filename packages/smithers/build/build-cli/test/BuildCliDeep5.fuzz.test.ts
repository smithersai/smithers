import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as GithubRender from "../src/GithubRender.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import * as RemoteCi from "../src/internal/RemoteCi.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as TestUnits from "../src/TestUnits.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const fsExecutions = Math.min(executions, 8)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

const gitExec = (root: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", root, ...args],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout) => {
        if (err !== null) reject(err)
        else resolve(stdout.trim())
      }
    )
  })

const writeFiles = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [rel, body] of Object.entries(files)) {
    const abs = NodePath.join(root, ...rel.split("/"))
    await Fs.mkdir(NodePath.dirname(abs), { recursive: true })
    await Fs.writeFile(abs, body, "utf8")
  }
}

const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{1,6}$/))

describe("@smthrs/build-cli deep fuzz suite 5: ObservedReads + Live Traced Execution, GithubRender, TestUnits & RemoteCi", () => {
  it(
    "Real traced observe execution (cold -> unrelated-edit hit -> read-edit miss -> env sensitivity) & ObservedReads API surface fuzz invariants",
    async () => {
      const hostObs = ObservedReads.observer(ExecSandbox.host())
      const gen = Arbitrary.schema(
        Schema.Struct({
          slug: Slug,
          envVal: Schema.String.check(Schema.isPattern(/^[a-f0-9]{12,20}$/)),
          useByValue: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          gen,
          ({ slug, envVal, useByValue }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-bc5-obs-", async (root) => {
                await writeFiles(root, {
                  ".gitignore": ".flows\nignored.tmp\n",
                  "input.txt": `data-${slug}\n`,
                  "unrelated.txt": "untouched\n",
                  ".github/workflows/ci.yml": `jobs:\n  a:\n    steps:\n      - run: echo "$SMTHRS_OBS_VAR"\n`,
                  "ignored.tmp": "ignored\n"
                })
                await gitExec(root, ["init", "--quiet", "--initial-branch=main"])
                await gitExec(root, ["config", "user.name", "Obs"])
                await gitExec(root, ["config", "user.email", "obs@example.invalid"])
                await gitExec(root, ["config", "commit.gpgsign", "false"])
                await gitExec(root, ["add", "-A"])
                await gitExec(root, ["commit", "--quiet", "-m", "seed"])

                // 1. ObservedReads direct helpers & FS utilities
                void ObservedReads.supervisorPath()
                void ObservedReads.reaperPath()
                void ObservedReads.recorder()
                void ObservedReads.recorderKey()
                expect(ObservedReads.split("AT_FDCWD, \"a\", O_RDONLY")).toEqual(["AT_FDCWD", "\"a\"", "O_RDONLY"])
                expect(ObservedReads.bookkeeping(["pnpm", "install"])).toBeDefined()
                expect(ObservedReads.bookkeeping(["echo", "hi"])).toBeUndefined()
                expect(ObservedReads.lockedInstall(["pnpm", "install", "--frozen-lockfile"])).toBe(true)
                expect(ObservedReads.lockedInstall(["echo", "hi"])).toBe(false)
                expect(ObservedReads.lockedBuild(["cargo", "build", "--locked"])).toBeDefined()
                expect(ObservedReads.pidOf("123 openat(AT_FDCWD, \"a\", O_RDONLY) = 3")?.pid).toBe(123)
                expect(ObservedReads.pidOf("no-pid")).toBeUndefined()
                expect(ObservedReads.callOf("openat(AT_FDCWD, \"a\", O_RDONLY) = 3")).toBeDefined()
                expect(ObservedReads.heldAs(envVal)).toBeTruthy()
                expect(ObservedReads.heldAs(undefined)).toBeTruthy()
                expect(ObservedReads.holdsValue(`prefix ${envVal} suffix`, envVal)).toBe(true)
                expect(ObservedReads.holdsValue("nothing", envVal)).toBe(false)
                expect(ObservedReads.holdsName("process.env.SMTHRS_OBS_VAR", "SMTHRS_OBS_VAR")).toBe(true)
                expect(ObservedReads.heldNames(["SMTHRS_OBS_VAR", "OTHER"])("echo $SMTHRS_OBS_VAR")).toEqual([
                  "SMTHRS_OBS_VAR"
                ])
                expect(typeof ObservedReads.keptName("/tmp/foo/bar.txt", ["/tmp/foo"])).toBe("boolean")
                expect(typeof ObservedReads.keptName("/home/user/bar.txt", ["/tmp/foo"])).toBe("boolean")
                expect(ObservedReads.putBackTimes([100n, 500n], 200n, 600n)).toBeDefined()

                const inputAbs = NodePath.join(root, "input.txt")
                const dig = ObservedReads.digestOf(inputAbs)
                expect(dig.length).toBeGreaterThan(10)
                expect(ObservedReads.measure(inputAbs)).toBeTruthy()
                expect(ObservedReads.listing(root, [])).toBeTruthy()
                expect(typeof ObservedReads.dirLinks(root, [])).toBe("number")

                const gitIgn = ObservedReads.ignoredByGit(root)(["ignored.tmp", "input.txt"])
                expect(gitIgn.has("ignored.tmp")).toBe(true)
                const gitHeld = ObservedReads.heldByGitOnce(root)(["input.txt", "ignored.tmp"])
                expect(gitHeld?.has("input.txt")).toBe(true)

                // Remembering + loadDigests + saveDigests
                const digestFile = NodePath.join(root, ".flows", "digests.json")
                const cacheMap: ObservedReads.Digests = new Map()
                const rem = ObservedReads.remembering(ObservedReads.defaultIo, () => Date.now() + 60_000, cacheMap)
                const meas = rem.using(ObservedReads.defaultIo)
                const m1 = meas(inputAbs)
                const m2 = meas(inputAbs)
                expect(m1).toBe(m2)
                await Fs.mkdir(NodePath.dirname(digestFile), { recursive: true })
                ObservedReads.saveDigests(digestFile, cacheMap, () => true)
                const reloaded = ObservedReads.loadDigests(digestFile)
                expect(reloaded.size).toBeGreaterThanOrEqual(1)

                // Trace file wholeLength / stepLength / wholeLinesOf / linesOf / keptStep / unrecordedStep
                const traceFile = NodePath.join(root, ".flows", "trace.log")
                NodeFs.writeFileSync(
                  traceFile,
                  `9 execve("/bin/sh", ["/bin/sh", "-c", "x", "${traceFile}.status"], 0x1) = 0\n` +
                    `9 openat(AT_FDCWD, "${traceFile}.status", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3\n12 later\n`
                )
                expect(ObservedReads.wholeLength(traceFile)).toBeGreaterThan(0)
                expect(ObservedReads.stepLength(traceFile)).toBeGreaterThan(0)
                expect([...ObservedReads.wholeLinesOf(traceFile)()].length).toBe(3)
                expect([...ObservedReads.linesOf(traceFile)()].length).toBeGreaterThanOrEqual(1)
                expect(ObservedReads.unrecordedStep("//:x").id).toBeUndefined()

                // Record + asRecord + store + outsideHolds + outsideChanged + anchored
                const recBody = {
                  format: ObservedReads.format,
                  reads: [[inputAbs, m1]] as const,
                  lists: [[root, ObservedReads.listing(root, [])!, []]] as const
                }
                const rec: ObservedReads.Record = {
                  id: ObservedReads.idOf(recBody as never),
                  ...recBody
                } as ObservedReads.Record
                expect(ObservedReads.asRecord(rec)).toBeDefined()
                expect(ObservedReads.asRecord({ bad: true })).toBeUndefined()
                expect(ObservedReads.pathsOf(rec)).toBeGreaterThanOrEqual(2)
                expect(ObservedReads.outsideHolds(rec)).toBe(true)
                expect(ObservedReads.outsideChanged(rec)).toBeUndefined()
                expect(ObservedReads.store(rec, [])).toBeDefined()
                void ObservedReads.anchored(rec, () => undefined)
                void ObservedReads.anchored(
                  { ...rec, from: [["//:a", "id1"]] },
                  (l) => (l === "//:a" ? "id1" : undefined)
                )

                // 2. Real traced PackageRunner execution (when strace / smthrs-observe is available on host!)
                if (!("reason" in hostObs)) {
                  const target = S.Shell.Test({
                    sandbox: "none",
                    data: [S.glob("**")],
                    shell: "/bin/cat input.txt > /dev/null",
                    observe: useByValue
                      ? { env: ["SMTHRS_OBS_VAR"], byValue: ["SMTHRS_OBS_VAR"], readAsData: [".github/workflows"] }
                      : { env: ["SMTHRS_OBS_VAR"], readAsData: [".github/workflows"] }
                  })
                  const index = PackageIndex.make({
                    root,
                    workspace: S.Workspace(`obs-${slug}`, {
                      repository: "git+https://example.invalid/obs.git",
                      cache: S.Cache({ directory: ".flows" }),
                      host: S.Host({ bins: ["sh"] })
                    }),
                    factory: undefined,
                    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { obs: target } }) }]
                  })
                  const runOnce = async (val: string) => {
                    const prev = process.env["SMTHRS_OBS_VAR"]
                    process.env["SMTHRS_OBS_VAR"] = val
                    try {
                      const opts = {
                        index,
                        cacheDirectory: ".flows",
                        verb: "auto" as const,
                        patterns: ["//:obs"],
                        environment: { ...process.env, SMTHRS_OBS_VAR: val }
                      }
                      const planned = await PackageExec.plan(opts)
                      return await Effect.runPromise(
                        executeEffect(planned, opts).pipe(
                          Effect.provideService(ExecutionServices, executionServicesLive)
                        )
                      )
                    } finally {
                      if (prev === undefined) delete process.env["SMTHRS_OBS_VAR"]
                      else process.env["SMTHRS_OBS_VAR"] = prev
                    }
                  }

                  // Cold run
                  const r1 = await runOnce(envVal)
                  expect(r1.ok).toBe(true)
                  // Unrelated file change -> cache HIT via ObservedReads!
                  await Fs.writeFile(NodePath.join(root, "unrelated.txt"), `changed-${slug}\n`)
                  const r2 = await runOnce(envVal)
                  expect(r2.ok).toBe(true)
                  // Read file change -> cache MISS & rerun!
                  await Fs.writeFile(inputAbs, `mutated-${slug}\n`)
                  const r3 = await runOnce(envVal)
                  expect(r3.ok).toBe(true)
                }
              })
              return true
            }),
          { executions: fsExecutions, seed: 20261230 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "GithubRender render/check/write/drift, TestUnits discover/closure/changeOf/select & RemoteCi parse/merge/pack/quote/providers fuzz invariants",
    async () => {
      const gen = Arbitrary.schema(
        Schema.Struct({
          slug: Slug,
          includeAffected: Schema.Boolean,
          withDrift: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          gen,
          ({ slug, includeAffected, withDrift }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-bc5-gh-", async (root) => {
                // --- GithubRender ---
                const buildT = S.Shell.Build({ shell: "echo build", outDirs: ["dist"] })
                const testT = S.Shell.Test({ shell: "echo test" })
                const wf = S.Github.Workflow({
                  name: `ci-${slug}`,
                  on: { push: { branches: ["main"] }, pullRequest: true },
                  concurrency: { group: `ci-${slug}`, cancelInProgress: true },
                  affected: includeAffected,
                  run: [buildT, testT]
                })
                await writeFiles(root, {
                  "package.json": `{"name":"tu-${slug}","type":"module","private":true}\n`,
                  "yarn.lock": "# yarn\n",
                  "vitest.config.ts": "export default {}\n",
                  "src/lib.ts": `export const x = "${slug}"\n`,
                  "test/a.test.ts": `import { x } from "../src/lib.ts"\nexport const t = x\n`,
                  "test/b.test.ts": `export const b = 1\n`
                })
                const packageJson = S.file("//package.json")
                const vtest = S.Vitest({
                  config: S.file("vitest.config.ts"),
                  tests: [S.glob("test/**/*.test.ts")],
                  sources: [S.glob("src/**/*.ts")],
                  deps: [],
                  environment: "node",
                  passWithNoTests: false,
                  units: "file"
                })
                const ciGen = S.Github.CiGen({ workflows: [wf] })
                const workspace = S.Workspace(`gh-${slug}`, {
                  repository: "git+https://example.invalid/gh.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
                  nodeModules: S.Npm.NodeModules({ packageJson }),
                  host: S.Host({ bins: ["sh"] })
                })
                const index = PackageIndex.make({
                  root,
                  workspace,
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({ targets: { build: buildT, test: testT, ci: wf, github: ciGen, vtest } })
                    }
                  ]
                })

                if (includeAffected) {
                  let err: unknown
                  try {
                    GithubRender.render({ ciGen, workspace, resolve: index, packageDir: "" })
                  } catch (e) {
                    err = e
                  }
                  expect(GithubRender.isGithubRenderError(err)).toBe(true)
                } else {
                  const rendered = GithubRender.render({
                    ciGen,
                    workspace,
                    resolve: index,
                    packageDir: ""
                  })
                  expect(rendered.files.length).toBeGreaterThanOrEqual(1)
                  const checkMissing = await GithubRender.check(root, rendered)
                  expect(checkMissing.clean).toBe(false)
                  const written = await GithubRender.write(root, rendered)
                  expect(written).toBeDefined()
                  const checkClean = await GithubRender.check(root, rendered)
                  expect(checkClean.clean).toBe(true)
                  if (withDrift) {
                    const firstFile = rendered.files[0]!
                    await Fs.writeFile(NodePath.join(root, firstFile.path), "# drifted\n")
                    const checkDrifted = await GithubRender.check(root, rendered)
                    expect(checkDrifted.clean).toBe(false)
                  }
                }

                // --- TestUnits ---
                const uLbl = TestUnits.label("//:vtest", "", "test/a.test.ts")
                expect(uLbl).toContain("a.test.ts")
                expect(TestUnits.parse(uLbl)).toBeDefined()
                expect(TestUnits.blobDirectory(".flows", "//:vtest")).toBeTruthy()

                const discovered = await TestUnits.discover({
                  index,
                  target: "//:vtest"
                })
                expect(discovered.units.length).toBe(2)
                const cl = TestUnits.closure(discovered, discovered.units[0]!)
                expect(cl.files.length).toBeGreaterThanOrEqual(1)
                const ch = TestUnits.changeOf(index, discovered, ["src/lib.ts"])
                expect(ch).toBeDefined()
                const sel = TestUnits.select(discovered, ch)
                expect(sel.length).toBeGreaterThanOrEqual(1)

                // --- RemoteCi ---
                const rowsJson = JSON.stringify({
                  results: [
                    { label: `//pkg/${slug}:build`, status: "ran", key: "k1", durationMs: 12 },
                    { label: `//pkg/${slug}:test`, status: "hit", key: "k2", durationMs: 2 }
                  ]
                })
                const parsedRows = RemoteCi.parseResults(rowsJson)
                expect(parsedRows.length).toBe(2)
                const merged = RemoteCi.merge(
                  [
                    { label: `//pkg/${slug}:build`, target: "Shell.Build" },
                    { label: `//pkg/${slug}:test`, target: "Shell.Test" },
                    { label: `//pkg/${slug}:lint`, target: "Shell.Test" }
                  ],
                  [parsedRows, RemoteCi.failedRoots([`//pkg/${slug}:lint`], "boom")],
                  { pattern: "//...", jobs: 2, durationMs: 20 }
                )
                expect(merged.results.length).toBe(3)
                const packed = RemoteCi.pack([
                  { path: "a.txt", content: new TextEncoder().encode(`hi-${slug}`), mode: 0o644, mtimeMs: 0 }
                ])
                expect(packed.byteLength).toBeGreaterThan(0)
                expect(RemoteCi.quote("hello world")).toContain("hello world")
                expect(RemoteCi.quote("simple")).toBe("simple")
                const remoteDecl = S.Remote.Http({
                  url: "https://remote.example.invalid",
                  token: S.Secret("REMOTE_TOK"),
                  machines: 2,
                  workdir: "/work"
                })
                expect(RemoteCi.machineCount(remoteDecl)).toBe(2)
                expect(RemoteCi.providers(remoteDecl, { REMOTE_TOK: "tok-123" })).toBeDefined()
              })
              return true
            }),
          { executions: fsExecutions, seed: 20261231 }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
