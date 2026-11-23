import * as NodeServices from "@effect/platform-node/NodeServices"
import { WebCrypto } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import { Fuzz } from "@smthrs/fuzz"
import { Evaluator } from "@smthrs/model"
import { NodeHost } from "@smthrs/platform-node"
import { Arbitrary, Effect, FileSystem, Layer, Path, Schema } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Planned from "../src/apply/Planned.vibe"
import * as ZigGraph from "../src/closure/zig/Graph.ts"
import * as ZigClosure from "../src/closure/zig/index.ts"
import * as Zon from "../src/closure/zig/Zon.ts"
import { ci as ciOf, type Job, type Step } from "../src/contract/Inventory.vibe"
import { type GeneratedFile } from "../src/contract/Parts.vibe"
import { path as targetMapPath } from "../src/contract/TargetMap.vibe"
import { splitWith } from "../src/decompose/index.ts"
import * as Runners from "../src/decompose/Runners.vibe"
import * as Generate from "../src/generate/index.vibe"
import * as Render from "../src/generate/Render.ts"
import { Options } from "../src/replay/Replay.vibe"
import * as Eval from "../src/select/Eval.vibe"
import { day } from "../src/select/Features.vibe"
import { type Host as SelectHost, score } from "../src/select/Score.vibe"
import type * as Scoring from "../src/select/Scoring.vibe"
import { seen } from "./select/support.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const fsExecutions = Math.min(executions, 10)
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")

const zigFixture = new URL("./fixtures/closure-zig/project", import.meta.url).pathname

const makeStep = (id: string, command: string, extra: Partial<Step> = {}): Step => ({
  id,
  command,
  cwd: "",
  env: {},
  secrets: [],
  ...extra
})

describe("@smthrs/ci decompose, zig closure, apply/planned, generate & select/eval fuzz invariants", () => {
  it("Runners.recognize/turbo/pnpm/bun/npm/yarn parse arbitrary package-manager & turbo invocations", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        manager: Schema.Literals(["pnpm", "bun", "npm", "yarn", "turbo"]),
        mode: Schema.Literals([
          "recursive",
          "filter-single",
          "filter-multi",
          "workspace-flag",
          "workspaces-all",
          "exec-cmd",
          "direct-script",
          "with-flags",
          "unknown"
        ]),
        script: Schema.Literals(["test", "build", "lint", "typecheck", "check"]),
        pkg: Schema.Literals(["web", "ui", "@acme/core", "./packages/web", "...web", "web^..."]),
        cwd: Schema.Literals(["", "packages/web", "apps/site"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ manager, mode, script, pkg, cwd }) =>
          Effect.sync(() => {
            const words: Array<string> =
              manager === "turbo"
                ? mode === "filter-single"
                  ? ["turbo", "run", script, "--filter", pkg]
                  : mode === "filter-multi"
                  ? ["turbo", script, `--filter=${pkg}`, "--concurrency=4", "--no-daemon"]
                  : mode === "with-flags"
                  ? ["turbo", "run", script, "--continue", "--dry=json", "--", "--watch=false"]
                  : ["turbo", "run", script]
                : manager === "pnpm"
                ? mode === "recursive"
                  ? ["pnpm", "-r", "run", script]
                  : mode === "filter-single"
                  ? ["pnpm", "--filter", pkg, "run", script]
                  : mode === "filter-multi"
                  ? ["pnpm", "-F", pkg, "--stream", "--parallel", script]
                  : mode === "exec-cmd"
                  ? ["pnpm", "-r", "exec", "tsc", "--noEmit"]
                  : mode === "direct-script"
                  ? ["pnpm", script]
                  : ["pnpm", "--dir", "packages/web", "run", script]
                : manager === "bun"
                ? mode === "filter-single"
                  ? ["bun", "--filter", pkg, "run", script]
                  : mode === "filter-multi"
                  ? ["bun", "run", "--filter", "*", script]
                  : mode === "exec-cmd"
                  ? ["bunx", "turbo", "run", script]
                  : ["bun", "run", script]
                : manager === "npm"
                ? mode === "workspaces-all"
                  ? ["npm", "run", script, "--workspaces", "--if-present"]
                  : mode === "workspace-flag"
                  ? ["npm", "run", script, "-w", pkg]
                  : mode === "filter-multi"
                  ? ["npm", "test", `--workspace=${pkg}`]
                  : ["npm", "run", script]
                : mode === "workspaces-all"
                ? ["yarn", "workspaces", "run", script]
                : mode === "workspace-flag"
                ? ["yarn", "workspace", pkg, "run", script]
                : mode === "filter-multi"
                ? ["yarn", "workspaces", "foreach", "-A", "run", script]
                : ["yarn", script]

            const known: Runners.Known = {
              wrappers: ["turbo"],
              rootScripts: ["test", "build", "lint", "check"]
            }

            Runners.pnpm(words, cwd)
            Runners.bun(words, cwd)
            Runners.npm(words, cwd)
            Runners.yarn(words, cwd)
            Runners.turbo(["turbo"], words.slice(1))
            const rec = Runners.recognize(words, cwd, known)
            return rec === undefined || typeof rec === "object"
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ZigGraph.read/reach/find/grouped handle arbitrary ZON build graphs including cycles & missing steps", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        stepCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 }))),
        hasCycle: Schema.Boolean,
        hasWriteFile: Schema.Boolean,
        hasRunStep: Schema.Boolean,
        queryIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 6 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ stepCount, hasCycle, hasWriteFile, hasRunStep, queryIdx }) =>
          Effect.sync(() => {
            const entries: Array<string> = []
            for (let i = 0; i < stepCount; i++) {
              const deps: Array<number> = []
              if (i > 0) deps.push(i - 1)
              if (hasCycle && i === 0 && stepCount > 1) deps.push(stepCount - 1)
              const kind =
                i === stepCount - 1 && hasRunStep
                  ? ".run"
                  : i === 1 && hasWriteFile
                  ? ".write_file"
                  : ".top_level"
              entries.push(
                `.{ .name = "step-${i}", .id = ${kind}, .dependencies = .{ ${deps.join(", ")} } }`
              )
            }
            const zonText = `.{ .steps = .{ ${entries.join(", ")} } }`
            const parsed = Zon.parse(zonText)
            if (parsed === undefined) return false
            const graph = ZigGraph.read(parsed)
            if (graph === undefined) return true
            const found = ZigGraph.find(graph, `step-${queryIdx % stepCount}`)
            const missing = ZigGraph.find(graph, "no-such-step")
            const reached = ZigGraph.reach(graph, queryIdx % stepCount)
            const grouped = ZigGraph.grouped(graph, queryIdx % stepCount)
            const bad = ZigGraph.read({ kind: "atom", value: "nope" } as never)
            return (
              found !== undefined &&
              missing === undefined &&
              Array.isArray(reached) &&
              Array.isArray(grouped) &&
              bad === undefined
            )
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ZigClosure.steps/groupsOf/ofSteps/ofFiles/close/groups analyze real Zig 0.17 project closures", async () => {
    const host = Layer.mergeAll(NodeHost.layer, WebCrypto.layer)
    const arb = Arbitrary.schema(
      Schema.Struct({
        stepPair: Schema.Literals([
          "alpha-beta",
          "gamma-all",
          "broken-run",
          "unknown-step"
        ]),
        fileKind: Schema.Literals(["alpha", "beta", "shared"])
      })
    )

    const report = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-ci-zig-fuzz-" })
          yield* fs.copy(zigFixture, path.join(root, "project"))
          const project: ZigClosure.Project = { root, directory: "project" }

          const allSteps = yield* ZigClosure.steps(project)
          const grouped = yield* ZigClosure.groupsOf(project, ["test-alpha", "test-beta", "test-gamma"])
          const rootGrouped = yield* ZigClosure.groups(path.join(root, "project"), ["test-alpha", "test-beta"])
          if (allSteps.length === 0 || grouped.length === 0 || rootGrouped.length === 0) {
            return { _tag: "Failed" as const }
          }

          return yield* Fuzz.run(
            arb,
            ({ stepPair, fileKind }) =>
              Effect.gen(function* () {
                if (stepPair === "alpha-beta") {
                  const res = yield* ZigClosure.ofSteps(project, ["test-alpha", "test-beta"])
                  return res.length === 2
                }
                if (stepPair === "gamma-all") {
                  const res = yield* ZigClosure.ofSteps(project, ["test-gamma", "test"])
                  const c = yield* ZigClosure.close(path.join(root, "project"), ["test-gamma"])
                  return res.length === 2 && c[0]?.strategy === "zig"
                }
                if (stepPair === "broken-run") {
                  const res = yield* ZigClosure.ofSteps(project, ["test-broken", "run"])
                  return res.length === 2
                }
                const targetFile =
                  fileKind === "alpha"
                    ? "src/alpha.zig"
                    : fileKind === "beta"
                    ? "src/beta.zig"
                    : "src/shared.zig"
                const byFile = yield* ZigClosure.ofFiles(project, [targetFile])
                const missing = yield* Effect.flip(ZigClosure.ofSteps(project, ["does-not-exist"]))
                return byFile[0]?.strategy === "zig" && missing !== undefined
              }),
            { seed, executions: Math.min(executions, 4) }
          )
        })
      ).pipe(Effect.provide(host))
    )
    if (report._tag === "Falsified") {
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
    }
    expect(report._tag).toBe("Passed")
  })

  it("Decompose.splitWith & Generate.files decompose real pnpm/bun/npm/yarn/turbo/zig repositories and render legs/notes/targets", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pkgManager: Schema.Literals(["pnpm", "bun", "npm", "yarn"]),
        commandKind: Schema.Literals(["recursive", "turbo", "zig", "filter", "plain"]),
        hasMultiToolchains: Schema.Boolean,
        hasUnsupported: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pkgManager, commandKind, hasMultiToolchains, hasUnsupported }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const spawner = yield* ChildProcessSpawner
              const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-ci-split-fuzz-" })

              const write = (rel: string, text: string) =>
                Effect.gen(function* () {
                  const full = path.join(root, rel)
                  yield* fs.makeDirectory(path.dirname(full), { recursive: true })
                  yield* fs.writeFileString(full, text)
                })

              yield* write(
                "package.json",
                JSON.stringify({
                  name: "root",
                  packageManager: `${pkgManager}@10.0.0`,
                  workspaces: ["packages/*"],
                  scripts: { test: `${pkgManager} -r run test`, build: "turbo run build" }
                })
              )
              if (pkgManager === "pnpm") {
                yield* write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n")
                yield* write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
              } else if (pkgManager === "bun") {
                yield* write("bun.lock", "")
              } else if (pkgManager === "yarn") {
                yield* write("yarn.lock", "")
              } else {
                yield* write("package-lock.json", "{}")
              }
              yield* write("turbo.json", JSON.stringify({ tasks: { build: { dependsOn: ["^build"] }, test: { dependsOn: ["build"] } } }))
              yield* write("packages/ui/package.json", JSON.stringify({ name: "ui", scripts: { test: "node -e 0", build: "node -e 0" } }))
              yield* write("packages/web/package.json", JSON.stringify({ name: "web", scripts: { test: "node -e 0", build: "node -e 0" }, dependencies: { ui: "workspace:*" } }))
              yield* write("packages/web/index.js", "export const x = 1\n")

              const git = (args: ReadonlyArray<string>) =>
                spawner.exitCode(ChildProcess.make("git", ["-C", root, ...args]))
              yield* git(["init", "--quiet"])
              yield* git(["add", "--all"])
              yield* git(["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "--allow-empty", "-m", "init"])

              const cmd =
                commandKind === "recursive"
                  ? pkgManager === "pnpm"
                    ? "pnpm -r run test"
                    : pkgManager === "bun"
                    ? "bun --filter '*' test"
                    : pkgManager === "npm"
                    ? "npm run test --workspaces"
                    : "yarn workspaces run test"
                  : commandKind === "turbo"
                  ? "turbo run build"
                  : commandKind === "zig"
                  ? "zig build test-a test-b"
                  : commandKind === "filter"
                  ? pkgManager === "pnpm"
                    ? "pnpm --filter web run test"
                    : "npm run test -w web"
                  : "node -e 0"

              const jobs: Array<Job> = [
                {
                  id: "ci.yml:test",
                  source: "github-actions",
                  file: ".github/workflows/ci.yml",
                  name: "test",
                  needs: [],
                  triggers: ["push", "pull_request"],
                  matrix: hasMultiToolchains ? [{ node: "20" }, { node: "22" }] : [],
                  runsOn: "ubuntu-latest",
                  steps: [
                    makeStep("ci.yml:test:1", cmd)
                  ],
                  unsupported: hasUnsupported ? [{ feature: "service-container", detail: "postgres service" }] : []
                },
                {
                  id: "ci.yml:lint",
                  source: "github-actions",
                  file: ".github/workflows/ci.yml",
                  name: "lint",
                  needs: [],
                  triggers: ["push"],
                  matrix: [],
                  runsOn: "ubuntu-latest",
                  steps: [makeStep("ci.yml:lint:1", "node -e 0")],
                  unsupported: []
                }
              ]

              const inv = ciOf({
                version: 1,
                repository: "acme/fuzz",
                commit: "0".repeat(40),
                toolchains: [{ name: "node", version: "22", source: ".nvmrc" }],
                jobs
              })

              const split = splitWith({
                zigGroups: (_r, steps) => Effect.succeed(steps.map((s) => [s]))
              })
              const decomposed = yield* split(root, inv)
              const generated = yield* Generate.files(decomposed)
              return (
                decomposed.version === 1 &&
                generated.some((f) => f.path === Render.workspacePath) &&
                generated.some((f) => f.path === targetMapPath)
              )
            })
          ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, WebCrypto.layer))),
        { seed, executions: fsExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Planned.refusalOf & Planned.refusals/planned classify build refusals across valid and failing smthrs outputs", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        printed: Schema.Literals([
          '{"code":"ci_failed","message":"link_input_refused: refused [docs/x]"}',
          "\u001b[31mError: bad target\u001b[0m\n",
          "(node:1234) ExperimentalWarning: foo\nreal error line\n",
          "   \n\n",
          "plain failure message"
        ]),
        refuseMode: Schema.Literals(["ok", "refuse-one", "refuse-all"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ printed, refuseMode }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const ref = Planned.refusalOf(printed)
              if (typeof ref !== "string" || ref.length === 0) return false

              const fs = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const spawner = yield* ChildProcessSpawner
              const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-ci-planned-fuzz-" })
              const git = (args: ReadonlyArray<string>) =>
                spawner.exitCode(ChildProcess.make("git", ["-C", root, ...args]))
              yield* git(["init", "--quiet"])
              yield* fs.writeFileString(path.join(root, "README.md"), "hi\n")
              yield* git(["add", "--all"])
              yield* git(["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "init"])

              const fakeBin = path.join(root, "fake-smthrs.sh")
              const body =
                refuseMode === "ok"
                  ? "#!/bin/sh\necho '{\"targets\":[]}'\nexit 0\n"
                  : refuseMode === "refuse-one"
                  ? "#!/bin/sh\ncase \" $* \" in *\"//:a\"*) echo '{\"code\":\"ci_failed\",\"message\":\"refused a\"}'; exit 1;; esac\ncase \" $* \" in *\" //... \"*) echo '{\"code\":\"ci_failed\",\"message\":\"refused all\"}'; exit 1;; esac\necho '{\"targets\":[]}'\nexit 0\n"
                  : "#!/bin/sh\necho '{\"code\":\"ci_failed\",\"message\":\"all refused\"}'\nexit 1\n"
              yield* fs.writeFileString(fakeBin, body)
              yield* fs.chmod(fakeBin, 0o755)

              const generatedFiles: ReadonlyArray<GeneratedFile> = [
                {
                  path: targetMapPath,
                  content: JSON.stringify({
                    version: 1,
                    targets: [
                      { label: "//:a", job: "ci.yml:a", step: "ci.yml:a:1", variant: {} },
                      { label: "//:b", job: "ci.yml:b", step: "ci.yml:b:1", variant: {} }
                    ]
                  })
                },
                { path: Render.workspacePath, content: "// workspace\n" }
              ]

              const found = yield* Planned.planned(root, generatedFiles).pipe(
                Effect.provide(
                  Layer.succeed(Options, {
                    smthrs: [fakeBin],
                    reruns: 1,
                    prepare: () => Effect.void
                  })
                )
              )
              if (refuseMode === "ok") return found.length === 0
              if (refuseMode === "refuse-one") return found.some((r) => r.job === "ci.yml:a")
              return found.length === 2
            })
          ).pipe(Effect.provide(NodeServices.layer)),
        { seed, executions: fsExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Select.Eval.run/suite/executor/caught/skipped evaluate scripted failure histories and reject invalid sample counts", async () => {
    const judge = Evaluator.layerScripted((request) => {
      const state = request.state as typeof Scoring.State.Type
      return Object.fromEntries(
        state.items.flatMap(({ item, targetFailureRate }) => [
          [`fails${item}`, { probability: targetFailureRate.last7Days }],
          [`why${item}`, { choice: targetFailureRate.last7Days > 0 ? "history" : "none" }]
        ])
      )
    })
    const host = Layer.mergeAll(FlowEngine.layerMemory, WebCrypto.layer, judge)

    const arb = Arbitrary.schema(
      Schema.Struct({
        rateA: Schema.Literals([0, 0.5, 1]),
        rateB: Schema.Literals([0, 0.5, 1]),
        failA: Schema.Boolean,
        failB: Schema.Boolean,
        badChanges: Schema.Literals([0, -1, 1.5])
      })
    )

    const now = Date.UTC(2026, 10, 14)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rateA, rateB, failA, failB, badChanges }) =>
          Effect.gen(function* () {
            const services = yield* Effect.context<SelectHost>()
            const obs = [
              seen(now - 20 * day, "c1", "//a:test", true),
              seen(now - 2 * day, "c2", "//a:test", failA, { failureRates: { d7: rateA, d14: rateA, d28: rateA, d56: rateA } }),
              seen(now - 2 * day, "c2", "//b:test", failB, { failureRates: { d7: rateB, d14: rateB, d28: rateB, d56: rateB } }),
              seen(now, "c3", "//a:test", false, { failureRates: { d7: rateA, d14: rateA, d28: rateA, d56: rateA } })
            ]
            const opts = { name: "fuzz-eval", runId: "run-fuzz", at: "2026-11-14T00:00:00.000Z" }
            const outcome = yield* Eval.run(opts, obs, (rows) => Effect.provideContext(score(rows), services))
            const invalid = yield* Effect.flip(
              Eval.run({ ...opts, changes: badChanges }, obs, () => Effect.succeed([]))
            )
            return outcome.run.cases.length >= 1 && invalid.code === "invalid_suite"
          }).pipe(Effect.provide(host)),
        { seed, executions: Math.min(executions, 8) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
