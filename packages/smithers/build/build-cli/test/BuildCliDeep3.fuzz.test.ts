import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import * as Input from "@smthrs/targets/Input"
import * as LlmLint from "@smthrs/targets/LlmLint"
import * as Target from "@smthrs/targets/Target"
import { Arbitrary, Effect, Layer, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as BenchReport from "../src/BenchReport.ts"
import { layerNonInteractiveNodeServices } from "../src/engine.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as Label from "../src/Label.ts"
import * as Mount from "../src/Mount.ts"
import * as RepoResolution from "../src/RepoResolution.ts"
import * as RspackRunner from "../src/RspackRunner.ts"
import * as TrustedReview from "../src/TrustedReview.ts"
import * as Watch from "../src/Watch.ts"
import { fixture as repoFixture } from "./helpers/RepositoryProcess.ts"

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
    await Machine.remove(dir).catch(() => Fs.rm(dir, { recursive: true, force: true }))
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

describe("@smthrs/build-cli deep fuzz suite 3: Machine, Mount, TrustedReview, RepoResolution, Watch, RspackRunner & BenchReport", () => {
  it(
    "Machine full lifecycle: holding, hold/unstale, fresh/make/keep/discard, homeLinks/unmade, withoutCredentials, mountsOf/mounting & neutral/actual/recorded",
    async () => {
      const gen = Arbitrary.schema(
        Schema.Struct({
          slug: Slug,
          withGit: Schema.Boolean,
          keepMachines: Schema.Literals(["", "1", "all", "worker-a"]),
          relocateMode: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          gen,
          ({ slug, withGit, keepMachines, relocateMode }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-bc3-mach-", async (base) => {
                const repo = NodePath.join(base, "repo")
                const holdBase = NodePath.join(base, "machines-hold")
                const keepDir = NodePath.join(base, "kept-machines")
                await Fs.mkdir(repo, { recursive: true })
                await writeFiles(repo, {
                  ".gitignore": "node_modules\n.flows\n",
                  "src/a.txt": `hello ${slug}\n`,
                  "tool.sh": "#!/bin/sh\nexit 0\n",
                  ".flows/cache.bin": "cached"
                })
                await Fs.chmod(NodePath.join(repo, "tool.sh"), 0o755)
                await Fs.symlink("src/a.txt", NodePath.join(repo, "link"))

                if (withGit) {
                  await gitExec(repo, ["init", "--quiet", "--initial-branch=main"])
                  await gitExec(repo, ["config", "user.name", "Machine"])
                  await gitExec(repo, ["config", "user.email", "machine@example.invalid"])
                  await gitExec(repo, ["config", "commit.gpgsign", "false"])
                  await gitExec(repo, ["add", "-A"])
                  await gitExec(repo, ["commit", "--quiet", "-m", "seed"])
                  await gitExec(repo, ["remote", "add", "origin", "https://user:secret@example.invalid/repo.git"])
                }

                const env = {
                  [Machine.holdingVariable]: holdBase,
                  [Machine.keepVariable]: keepMachines
                }
                expect(Machine.skippedPart(".git/config")).toBe(".git")
                expect(Machine.skippedPart("src/a.txt")).toBeUndefined()
                const kept = Machine.holding(repo, env)
                expect(kept.startsWith(holdBase)).toBe(true)
                void Machine.formerHolding(repo, env)
                expect(Machine.holdPath(kept, "linux")).toBeTruthy()
                expect(Machine.holdPath(kept, "win32")).toBeTruthy()
                void Machine.toKeep(env)
                expect(
                  Machine.withoutCredentials("[remote \"origin\"]\n\turl = https://user:pass@github.com/org/repo.git\n")
                ).not.toContain("pass")

                // hold + prepare + fresh + named + make + environment
                const heldLock = await Machine.hold(repo, env, () => {})
                try {
                  await Machine.prepare(repo, env)
                  const freshRes = await Machine.fresh(repo, ".flows")
                  if (withGit) expect(freshRes).toBeDefined()
                  else expect(freshRes).toBeUndefined()

                  const m = Machine.named(kept, repo, `worker-${slug}`)
                  const made = await Machine.make({
                    root: repo,
                    cacheDirectory: ".flows",
                    held: freshRes,
                    kept,
                    machine: m,
                    links: []
                  })
                  expect(made.tree).toBe(m.tree)
                  const mEnv = Machine.environment(made)
                  expect(mEnv["HOME"]).toBe(made.home)
                  expect(mEnv["TMPDIR"]).toBe(made.tmp)

                  // homeLinks / unmade / keep / discard
                  expect(Machine.homeLinks([{ path: "home/.cache/x", target: "/tmp/x" }]).length).toBe(1)
                  void Machine.unmade({
                    root: repo,
                    cacheDirectory: ".flows",
                    held: freshRes,
                    kept,
                    links: [{ path: "home/.cache/x", target: "/tmp/x" }]
                  })
                  await Machine.keep(made, keepDir)

                  // Own tmp / binds / sharedRefusal / mountsOf / relocated / neutral / actual / through / recorded
                  expect(Machine.sharedRefusal("a", "b", "conflict")).toContain("conflict")
                  expect(Machine.inSight([made.tmp, "/tmp/example"])).toBeDefined()
                  expect(Machine.withOwnTmp("/usr/bin/bwrap", made, ["/bin/echo", "hi"]).length).toBeGreaterThan(2)
                  expect(Machine.tmpBinds(made, []).length).toBeGreaterThan(0)
                  expect(Machine.own(`${Machine.anchor}/home/x`)).toBe(true)
                  expect(Machine.own("UNRELATED")).toBe(false)
                  expect(Machine.remover(made.directory).length).toBeGreaterThan(1)
                  const toNeutral = Machine.neutral(made)
                  const toActual = Machine.actual(made)
                  const nPath = toNeutral(NodePath.join(made.tree, "src/a.txt"))
                  expect(nPath).toContain(Machine.anchor)
                  expect(toActual(nPath)).toBe(NodePath.join(made.tree, "src/a.txt"))
                  const throughIo = Machine.through(toActual)
                  expect(throughIo.lstat(nPath)).toBeDefined()
                  expect(throughIo.digest?.(nPath)).toBeTruthy()

                  const baseRec = {
                    format: ObservedReads.format,
                    reads: [[NodePath.join(made.tree, "src/a.txt"), "deadbeef"]] as const,
                    lists: [[made.tree, "cafebabe"]] as const,
                    links: [[made.tree, 1]] as const
                  }
                  const obs: ObservedReads.Observation = {
                    record: { id: ObservedReads.idOf(baseRec as never), ...baseRec },
                    left: {
                      keep: [NodePath.join(made.home, "kept.txt")],
                      gone: [NodePath.join(made.tmp, "gone.txt")],
                      outside: [[NodePath.join(made.tree, "out.txt"), "digest1"]]
                    }
                  } as unknown as ObservedReads.Observation
                  const rewritten = Machine.recorded(obs, made)
                  expect(rewritten).toBeDefined()

                  if (relocateMode) {
                    const reloc = Machine.relocated(`${repo}/src/a.txt:${repo}/.flows/x`, repo, made.tree, ".flows")
                    expect(reloc).toContain(made.tree)
                  }

                  await Machine.discard(made.directory)
                } finally {
                  await heldLock.release()
                }
              })
              return true
            }),
          { executions: fsExecutions, seed: 20261210 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "Mount loadConfig/materialize/summary/resolveWorkspace & TrustedReview prepareSource/prepare/governing/restrictFindings/reviewPrepared fuzz invariants",
    async () => {
      const gen = Arbitrary.schema(
        Schema.Struct({
          slug: Slug,
          withPatch: Schema.Boolean,
          manualPolicy: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          gen,
          ({ slug, withPatch, manualPolicy }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-bc3-mnt-", async (base) => {
                // --- Upstream git repo ---
                const upstream = NodePath.join(base, "upstream")
                await Fs.mkdir(upstream, { recursive: true })
                await gitExec(upstream, ["init", "--quiet", "--initial-branch=main"])
                await gitExec(upstream, ["config", "user.name", "Up"])
                await gitExec(upstream, ["config", "user.email", "up@example.invalid"])
                await gitExec(upstream, ["config", "commit.gpgsign", "false"])
                await writeFiles(upstream, {
                  "src/value.txt": `one-${slug}\n`,
                  "package.json": `{"name":"up-${slug}","private":true}\n`
                })
                await gitExec(upstream, ["add", "-A"])
                await gitExec(upstream, ["commit", "--quiet", "-m", "first"])
                const firstSha = await gitExec(upstream, ["rev-parse", "HEAD"])
                await writeFiles(upstream, { "src/value.txt": `two-${slug}\n` })
                await gitExec(upstream, ["add", "-A"])
                await gitExec(upstream, ["commit", "--quiet", "-m", "second"])

                // --- Overlay repo with .smithers/config.ts ---
                const overlay = NodePath.join(base, "overlay")
                await Fs.mkdir(overlay, { recursive: true })
                const patchFiles: Record<string, string> = {}
                const mountOpts: Record<string, unknown> = {
                  repository: upstream,
                  ref: firstSha,
                  track: "main"
                }
                if (withPatch) {
                  const diff = await gitExec(upstream, ["diff", firstSha, "HEAD"])
                  patchFiles[".smithers/patches/01-two.patch"] = `${diff}\n`
                  mountOpts["patches"] = ["patches/01-two.patch"]
                }
                await writeFiles(overlay, {
                  ...patchFiles,
                  ".smithers/config.ts":
                    `import { Smithers as S } from "@smthrs/targets"\nexport default S.Mounts({\n  up: S.Mount(${
                      JSON.stringify(mountOpts)
                    })\n})\n`,
                  ".smithers/WORKSPACE.ts":
                    `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("mounted-${slug}", { repository: "git+https://example.invalid/m.git", cache: S.Cache({ directory: ".flows" }) })\n`
                })

                const cfg = await Mount.loadConfig(overlay)
                expect(cfg.mounts["up"]).toBeDefined()

                const mat = await Mount.materialize(overlay, "up", { environment: process.env, report: () => {} })
                expect(mat.name).toBe("up")
                expect(Mount.summary(mat)).toContain("up")
                // Re-materialize idempotently (reuses checkout)
                const mat2 = await Mount.materialize(overlay, "up", { environment: process.env, report: () => {} })
                expect(mat2.root).toBe(mat.root)

                const resolved = await Mount.resolveWorkspace(overlay, { report: () => {} } as never)
                expect(resolved.workspace).toBeTruthy()

                // Error case: unknown mount name
                let badMount = false
                try {
                  await Mount.materialize(overlay, "missing", { environment: process.env, report: () => {} })
                } catch (e) {
                  badMount = e instanceof Mount.MountError
                }
                expect(badMount).toBe(true)

                // --- TrustedReview ---
                const revRepo = NodePath.join(base, "review-repo")
                await Fs.mkdir(revRepo, { recursive: true })
                await gitExec(revRepo, ["init", "--quiet", "--initial-branch=main"])
                await gitExec(revRepo, ["config", "user.name", "Rev"])
                await gitExec(revRepo, ["config", "user.email", "rev@example.invalid"])
                await gitExec(revRepo, ["config", "commit.gpgsign", "false"])

                const policyJson = JSON.stringify(
                  Target.metadata(
                    LlmLint.LlmLint({
                      changes: Input.gitDiff("HEAD"),
                      include: [Input.glob("//src/**")],
                      deps: [],
                      prompt: "Check code quality.",
                      rubric: `No issues in ${slug}`,
                      model: "review-test-model",
                      batchSize: 1,
                      manual: manualPolicy
                    })
                  ).attrs as LlmLint.Attrs
                )
                const indexJson = JSON.stringify([
                  {
                    label: "//:lint",
                    package: "",
                    name: "lint",
                    rule: "LlmLint",
                    reviewPolicy: policyJson,
                    kinds: ["review"],
                    cacheable: false,
                    inputs: [],
                    outputs: [],
                    dependencies: [],
                    source: { file: "PACKAGE.ts" }
                  }
                ])
                await writeFiles(revRepo, {
                  "WORKSPACE.ts": "export const Workspace = {}\n",
                  ".smithers/target-index.json": indexJson,
                  "src/app.ts": `export const v = "${slug}"\n`
                })
                await gitExec(revRepo, ["add", "-A"])
                await gitExec(revRepo, ["commit", "--quiet", "-m", "base"])
                const baseSha = await gitExec(revRepo, ["rev-parse", "HEAD"])

                await writeFiles(revRepo, {
                  "src/app.ts": `export const v = "${slug}-updated"\n`
                })
                await gitExec(revRepo, ["add", "-A"])
                await gitExec(revRepo, ["commit", "--quiet", "-m", "change"])
                const headSha = await gitExec(revRepo, ["rev-parse", "HEAD"])

                const prepared = await TrustedReview.prepare({
                  workspace: revRepo,
                  policyRevision: baseSha,
                  revision: headSha,
                  patterns: manualPolicy ? ["//:lint"] : [],
                  plan: true
                })
                expect(prepared.policies.length).toBeGreaterThanOrEqual(1)
                const gov = TrustedReview.governing(prepared)
                expect(gov.policies.length).toBe(prepared.policies.length)

                // Also cover prepareSource with in-memory ReviewSource + restrictFindings
                const inMemFiles = new Map<string, string>([
                  [".smithers/target-index.json", indexJson],
                  ["src/app.ts", `export const mem = "${slug}"\n`]
                ])
                const memSource: TrustedReview.ReviewSource = {
                  tree: async (rev) => {
                    const m = new Map<string, TrustedReview.SourceEntry>()
                    for (const [k, v] of inMemFiles) {
                      m.set(k, { id: `100644 blob ${rev === "base" ? "a" : "b"}${k.length}`, regular: true })
                      void v
                    }
                    return m
                  },
                  read: async (_rev, path) => inMemFiles.get(path) ?? "",
                  grep: async () => ["src/app.ts"]
                }
                const memPrep = await TrustedReview.prepareSource(memSource, {
                  policyRevision: "base",
                  revision: "head",
                  patterns: [Label.parse("//:lint", "")]
                })
                expect(memPrep.policies.length).toBeGreaterThanOrEqual(1)
                const restricted = await TrustedReview.restrictFindings(NodePath.join(base, "findings"), {
                  ok: true,
                  findings: []
                } as never)
                expect(restricted).toBeDefined()

                // Plan-only TrustedReview.run
                const planRun = await TrustedReview.run({
                  workspace: revRepo,
                  policyRevision: baseSha,
                  revision: headSha,
                  patterns: manualPolicy ? ["//:lint"] : [],
                  plan: true
                })
                expect(planRun).toBeDefined()
              })
              return true
            }),
          { executions: fsExecutions, seed: 20261211 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "RepoResolution execute/redaction/gitState/effectiveKinds, Watch digest, RspackRunner layers & BenchReport parse/compare/regressions/format fuzz invariants",
    async () => {
      const gen = Arbitrary.schema(
        Schema.Struct({
          slug: Slug,
          exitCode: Schema.Literals([0, 1]),
          meanA: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)),
          meanB: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500))
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          gen,
          ({ slug, exitCode, meanA, meanB }) =>
            Effect.promise(async () => {
              // --- RepoResolution.execute with fake RepositoryProcess ---
              const host = repoFixture()
              try {
                const secret = `ZqSynthetic7Secret4${slug}`
                const seen: Array<string> = []
                const resolution = {
                  repoName: slug,
                  repoPath: slug,
                  absolutePath: `/${slug}`,
                  label: "//:test",
                  args: [],
                  kinds: ["test"],
                  refusal: undefined,
                  externalLabel: `@${slug}//:test`
                } as RepoResolution.Resolution
                const res = RepoResolution.Resolver.make({} as RepoResolution.Resolver["index"], {}, host.services)
                const execPromise = RepoResolution.execute(res, resolution, {
                  output: (stream, text) => seen.push(`${stream}:${text}`)
                })
                await host.write("stdout", `Authorization: Bearer ${secret}\n`)
                await host.write("stderr", `sshpass -p ${secret.slice(0, 8)}`)
                await host.write("stderr", `${secret.slice(8)} ssh host\n`)
                await host.write("stdout", `${"x".repeat(65_540)} tail\n`)
                const done = execPromise.then(
                  () => ({ ok: true as const }),
                  (cause: unknown) => ({ ok: false as const, cause })
                )
                await host.finish(exitCode)
                const outcome = await done
                expect(seen.join("")).not.toContain(secret)
                if (exitCode === 0) {
                  expect(outcome.ok).toBe(true)
                } else {
                  expect(outcome.ok).toBe(false)
                  if (!outcome.ok) expect(outcome.cause).toBeInstanceOf(RepoResolution.ExecutionError)
                }
              } finally {
                await host.cleanup()
              }

              // --- Watch digest + RepoResolution gitState + RspackRunner ---
              await withTempDir("smthrs-bc3-wrs-", async (root) => {
                await writeFiles(root, {
                  "src/a.txt": `a-${slug}`,
                  "src/b.txt": `b-${slug}`,
                  "ignored/x.bin": "ignore-me",
                  "package.json": `{"name":"${slug}","private":true}\n`,
                  "rsbuild.config.mjs": "export default {}\n"
                })

                // Watch tree digest
                const svc = Watch.makeServices()
                const relevant = (p: string) => p !== "ignored" && !p.startsWith("ignored/")
                const d1 = await Effect.runPromise(svc.digest(root, relevant))
                const d2 = await Effect.runPromise(svc.digest(root, relevant))
                expect(d1).toBe(d2)
                await Fs.writeFile(NodePath.join(root, "ignored", "x.bin"), "changed-ignored")
                expect(await Effect.runPromise(svc.digest(root, relevant))).toBe(d1)
                await Fs.writeFile(NodePath.join(root, "src", "a.txt"), `a-${slug}-mutated`)
                expect(await Effect.runPromise(svc.digest(root, relevant))).not.toBe(d1)

                // RepoResolution.gitState on real git repo
                await gitExec(root, ["init", "--quiet", "--initial-branch=main"])
                await gitExec(root, ["config", "user.name", "Test"])
                await gitExec(root, ["config", "user.email", "t@example.invalid"])
                await gitExec(root, ["config", "commit.gpgsign", "false"])
                await gitExec(root, ["add", "-A"])
                await gitExec(root, ["commit", "--quiet", "-m", "init"])
                const realResolver = RepoResolution.Resolver.make({} as RepoResolution.Resolver["index"], process.env)
                const gs = await RepoResolution.gitState(realResolver, {
                  repoName: slug,
                  repoPath: slug,
                  absolutePath: root,
                  label: "//:test",
                  args: [],
                  kinds: ["test"],
                  refusal: undefined,
                  externalLabel: `@${slug}//:test`
                } as RepoResolution.Resolution)
                expect(gs).toBeDefined()

                // RspackRunner ResolveLive & BuildLive through real FlowEngine
                const scratch = NodePath.join(root, "scratch")
                await Fs.mkdir(scratch, { recursive: true })
                const runFlow = (body: () => import("@smthrs/plan/Node").Node<unknown, unknown, never>) => {
                  const flow = Flow.make(`rspack-fuzz-${slug}`, {
                    payload: {},
                    success: Schema.Unknown,
                    error: Schema.Unknown,
                    body
                  })
                  const opts = { workspaceRoot: root, scratchDirectory: scratch }
                  const runtime = Layer.mergeAll(
                    RspackRunner.ResolveLive(opts),
                    RspackRunner.BuildLive(opts),
                    Interpreter.layer(flow)
                  ).pipe(
                    Layer.provideMerge(Action.layerImplementations),
                    Layer.provideMerge(FlowEngine.layerMemory),
                    Layer.provideMerge(layerNonInteractiveNodeServices)
                  )
                  return Effect.runPromiseExit(
                    flow.execute({}, { executionId: `rspack-fuzz-${slug}` }).pipe(Effect.provide(runtime))
                  )
                }
                const resolveExit = await runFlow(() =>
                  BundlerTarget.Resolve.call({
                    configPath: "rsbuild.config.mjs",
                    entries: ["src/index.ts"],
                    mode: "development"
                  }) as never
                )
                expect(resolveExit._tag).toBe("Failure")
              })

              // --- BenchReport full surface ---
              const benchStdout = [
                `\u001b[32m ✓ \u001b[39m|bench| test/${slug}.bench.ts > Suite > case ${slug} 100ms`,
                "   name          hz      min     max     mean      p75     p99    p995    p999      rme  samples",
                `   op1  100.0  1.0  5.0  ${meanA.toFixed(2)}  2.0  4.0  4.5  4.9  ±1.5%  50`,
                `BENCH_METRIC {"suite":"custom","name":"op2","hz":50,"meanMs":${meanB.toFixed(2)},"p99Ms":${
                  (meanB * 1.2).toFixed(2)
                },"samples":20}`,
                "BENCH_METRIC invalid-json"
              ].join("\n")
              const parsed = BenchReport.parse(benchStdout)
              expect(parsed.length).toBe(2)
              expect(BenchReport.stdoutOf({ stdout: benchStdout })).toBe(benchStdout)
              expect(BenchReport.stdoutOf(null)).toBeUndefined()

              const baseline: ReadonlyArray<BenchReport.TargetBenchmarks> = [
                {
                  label: `//pkg/${slug}:bench`,
                  status: "ran",
                  benchmarks: parsed
                }
              ]
              const loaded = BenchReport.loadBaseline(baseline)
              expect(loaded.length).toBe(1)
              const current: ReadonlyArray<BenchReport.TargetBenchmarks> = [
                {
                  label: `//pkg/${slug}:bench`,
                  status: "ran",
                  benchmarks: parsed.map((row) => ({
                    ...row,
                    meanMs: (row.meanMs ?? 1) * 1.5,
                    hz: (row.hz ?? 1) / 1.5
                  }))
                }
              ]
              const deltas = BenchReport.compare(current, loaded)
              expect(deltas.length).toBe(2)
              const regs = BenchReport.regressions(deltas, 10)
              expect(Array.isArray(regs)).toBe(true)
              const formatted = BenchReport.format(current, undefined, loaded)
              expect(formatted).toContain(slug)
              return true
            }),
          { executions: fsExecutions, seed: 20261212 }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
