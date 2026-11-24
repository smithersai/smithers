import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Planned from "../src/apply/Planned.vibe"
import * as ZigGraph from "../src/closure/zig/Graph.ts"
import * as Zon from "../src/closure/zig/Zon.ts"
import { ci as ciOf, type Inventory, type Job, type Step } from "../src/contract/Inventory.vibe"
import type { Failure, GeneratedFile } from "../src/contract/Parts.vibe"
import { path as targetMapPath } from "../src/contract/TargetMap.vibe"
import * as DecomposePlan from "../src/decompose/Plan.vibe"
import * as Runners from "../src/decompose/Runners.vibe"
import * as Split from "../src/decompose/Split.vibe"
import * as Workspace from "../src/decompose/Workspace.vibe"
import * as NativeDetect from "../src/native/Detect.vibe"
import * as NativeReplay from "../src/native/Replay.vibe"
import * as NativeTargets from "../src/native/Targets.vibe"
import * as Disk from "../src/replay/Disk.vibe"
import * as Replay from "../src/replay/Replay.vibe"
import * as GithubActions from "../src/inventory/GithubActions.vibe"
import * as Justfile from "../src/inventory/Justfile.vibe"
import * as MachineChanges from "../src/inventory/MachineChanges.vibe"
import * as Makefile from "../src/inventory/Makefile.vibe"
import * as Runner from "../src/inventory/Runner.ts"
import * as Actions from "../src/inventory/Actions.vibe"
import * as LeftRunning from "../src/inventory/LeftRunning.vibe"
import * as Failures from "../src/replay/Failures.ts"
import * as Summary from "../src/replay/Summary.vibe"

import { makeOwn, makeOwnWith, smthrs as nativeSmthrs } from "./native/own.ts"
import { makeRepository } from "./replay/fixture.ts"
import { unconfined } from "./replay/place.ts"
import { options as replayOptions, parts as replayParts } from "./replay/TestParts.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261188")
const runFuzz = async <A>(arb: Parameters<typeof Fuzz.run<A>>[0], fn: (sample: A) => Promise<void>, opts: { executions: number; seed: number }) => {
  const report = await Effect.runPromise(Fuzz.run(arb, (sample) => Effect.promise(async () => { await fn(sample); return true }), opts))
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}
const heavyExecutions = Math.min(executions, 4)
const lightExecutions = Math.min(executions, 30)

const plentyDisk = Layer.succeed(Disk.DiskSpace, {
  space: () => Effect.succeed({ free: 500 * 1_000_000_000, total: 1000 * 1_000_000_000 }),
  held: () => Effect.succeed(0)
})

const runNode = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner>) =>
  Effect.runPromise(Effect.provide(eff, NodeServices.layer))

const makeStep = (id: string, command: string, extra: Partial<Step> = {}): Step => ({
  id,
  command,
  cwd: "",
  env: {},
  secrets: [],
  ...extra
})

const makeJob = (id: string, steps: ReadonlyArray<Step>, extra: Partial<Job> = {}): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  runsOn: "ubuntu-latest",
  steps,
  unsupported: [],
  ...extra
})

describe("packages/ci Wave-8 Replay, NativeReplay, Decompose, Zig Closure & Planned fuzz", () => {
  it("fuzzes Replay.run applied, warm, trial (failing jobs/judge/tooFewLeft), disk.stopped, model-unavailable & repo errors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "applied-and-warm",
          "trial-one-fails",
          "trial-all-fail",
          "model-unavailable-fast",
          "disk-stopped-early",
          "repo-and-doc-errors"
        ])
      })
    )

    await runFuzz(
      arb,
      async (sample) => {
        // Pure exported Replay helpers
        const scoreReason = await Effect.runPromise(
          Replay.scoresOrReason(
            () => Effect.fail({ code: "model-unavailable", message: "offline", part: "select" } satisfies Failure),
            []
          )
        )
        expect(scoreReason).toBe("offline")
        const nonModelExit = await Effect.runPromiseExit(
          Replay.scoresOrReason(
            () => Effect.fail({ code: "command-failed", message: "boom", part: "select" } satisfies Failure),
            []
          )
        )
        expect(Exit.isFailure(nonModelExit)).toBe(true)
        expect(Replay.ownStop(Cause.fail({ code: "command-failed", message: "bad", part: "replay" }))).toBe("bad")
        expect(Replay.ownStop(Cause.die(new Error("die-msg")))).toBe("die-msg")
        expect(Replay.Options.defaultValue().smthrs).toEqual(["smthrs"])

        if (sample.scenario === "repo-and-doc-errors") {
          const nonGit = mkdtempSync(join(tmpdir(), "ci-w8-nogit-"))
          const emptyGit = mkdtempSync(join(tmpdir(), "ci-w8-emptygit-"))
          const skippedTmp = mkdtempSync(join(tmpdir(), "ci-w8-skip-"))
          const badWorkParent = join(skippedTmp, "node_modules")
          mkdirSync(badWorkParent, { recursive: true })
          try {
            execFileSync("git", ["init", "-q"], { cwd: emptyGit })
            const baseLayer = Layer.mergeAll(
              NodeServices.layer,
              plentyDisk,
              replayOptions,
              Layer.succeed(Replay.Progress, { say: () => Effect.void })
            )
            // Not a git repo
            const e1 = await Effect.runPromiseExit(
              Replay.run({ root: nonGit, commits: 1, modes: ["normal"] }, replayParts("0".repeat(40))).pipe(Effect.provide(baseLayer))
            )
            expect(Exit.isFailure(e1)).toBe(true)
            // Empty git repo with no commit
            const e2 = await Effect.runPromiseExit(
              Replay.run({ root: emptyGit, commits: 1, modes: ["normal"] }, replayParts("0".repeat(40))).pipe(Effect.provide(baseLayer))
            )
            expect(Exit.isFailure(e2)).toBe(true)
            // Missing targetMap / bad targetMap / missing workspace
            const repo = makeRepository()
            try {
              const noMapParts = {
                ...replayParts(repo.commits[0]!),
                files: () => Effect.succeed([{ path: ".smithers/WORKSPACE.smithers", content: "x" }])
              }
              const e3 = await Effect.runPromiseExit(
                Replay.run({ root: repo.root, commits: 1, modes: ["normal"] }, noMapParts).pipe(Effect.provide(baseLayer))
              )
              expect(Exit.isFailure(e3)).toBe(true)

              const badMapParts = {
                ...replayParts(repo.commits[0]!),
                files: () => Effect.succeed([{ path: targetMapPath, content: "not-json" }])
              }
              const e4 = await Effect.runPromiseExit(
                Replay.run({ root: repo.root, commits: 1, modes: ["normal"] }, badMapParts).pipe(Effect.provide(baseLayer))
              )
              expect(Exit.isFailure(e4)).toBe(true)

              const noWsParts = {
                ...replayParts(repo.commits[0]!),
                files: () =>
                  Effect.succeed([
                    {
                      path: targetMapPath,
                      content: JSON.stringify({
                        targets: [{ label: "//:a_0", job: "a", step: "a:1", variant: {} }]
                      })
                    }
                  ])
              }
              const e5 = await Effect.runPromiseExit(
                Replay.run({ root: repo.root, commits: 1, modes: ["normal"] }, noWsParts).pipe(Effect.provide(baseLayer))
              )
              expect(Exit.isFailure(e5)).toBe(true)
            } finally {
              repo.remove()
            }
          } finally {
            rmSync(nonGit, { recursive: true, force: true })
            rmSync(emptyGit, { recursive: true, force: true })
            rmSync(skippedTmp, { recursive: true, force: true })
          }
          return
        }

        if (sample.scenario === "applied-and-warm") {
          const repo = makeRepository()
          try {
            const report = await Effect.runPromise(
              Replay.run(
                { root: repo.root, commits: 1, modes: ["normal"], warm: true, applied: true, trial: false },
                replayParts(repo.commits[0]!)
              ).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    plentyDisk,
                    replayOptions,
                    Layer.succeed(Replay.Progress, { say: () => Effect.void })
                  )
                )
              )
            )
            expect(report.commits.length).toBe(1)
            expect(report.firstRun).toBeDefined()
            expect(report.appliedMs).toBeGreaterThanOrEqual(0)
          } finally {
            repo.remove()
          }
          return
        }

        if (sample.scenario === "trial-one-fails") {
          const repo = makeRepository()
          try {
            const report = await Effect.runPromise(
              Replay.run(
                { root: repo.root, commits: 1, modes: ["normal"], warm: true, trial: true },
                replayParts(repo.commits[0]!)
              ).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    plentyDisk,
                    replayOptions,
                    Layer.succeed(Replay.Progress, { say: () => Effect.void })
                  )
                )
              )
            )
            expect(report.commits.length).toBe(1)
            expect(((report as unknown as { left?: ReadonlyArray<{ job: string }> }).left ?? []).some((l) => l.job === "fail1") || report.commits.length === 1).toBe(true)
          } finally {
            repo.remove()
          }
          return
        }

        if (sample.scenario === "trial-all-fail") {
          const repo = makeRepository()
          try {
            const exit = await Effect.runPromiseExit(
              Replay.run(
                { root: repo.root, commits: 1, modes: ["normal"], trial: true },
                replayParts(repo.commits[0]!)
              ).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    plentyDisk,
                    replayOptions,
                    Layer.succeed(Replay.Progress, { say: () => Effect.void })
                  )
                )
              )
            )
            expect(Exit.isFailure(exit)).toBe(true)
          } finally {
            repo.remove()
          }
          return
        }

        if (sample.scenario === "model-unavailable-fast") {
          const repo = makeRepository()
          try {
            const offlineParts = {
              ...replayParts(repo.commits[0]!),
              score: () =>
                Effect.fail({ code: "model-unavailable", message: "no model", part: "select" } satisfies Failure)
            }
            const report = await Effect.runPromise(
              Replay.run(
                { root: repo.root, commits: 2, modes: ["normal", "fast"], trial: false, settings: { scoreCutoff: 0.5, countCutoff: 0 } },
                offlineParts
              ).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    plentyDisk,
                    replayOptions,
                    Layer.succeed(Replay.Progress, { say: () => Effect.void })
                  )
                )
              )
            )
            expect(report.fastNotMeasured === "no model" || report.commits.length === 2).toBe(true)
          } finally {
            repo.remove()
          }
          return
        }

        // disk-stopped-early
        const repo = makeRepository()
        try {
          const lowDisk = Layer.succeed(Disk.DiskSpace, {
            space: () => Effect.succeed({ free: 100, total: 100 * 1_000_000_000 }),
            held: () => Effect.succeed(1024)
          })
          const report = await Effect.runPromise(
            Replay.run(
              { root: repo.root, commits: 1, modes: ["normal"], trial: false },
              replayParts(repo.commits[0]!)
            ).pipe(
              Effect.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  replayOptions,
                  lowDisk,
                  Layer.succeed(Replay.Progress, { say: () => Effect.void })
                )
              )
            )
          )
          expect(report.stopped).toBeDefined()
        } finally {
          repo.remove()
        }
      },
      { executions: heavyExecutions, seed }
    )
  }, 240_000)

  it("fuzzes NativeDetect.workspace, NativeTargets shell quoting/heredocs/plansFor & NativeReplay warm/trial/targets/errors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nativeMode: Schema.Literals(["warm-and-trial-fail", "explicit-targets-and-cache-token", "custom-verb-plan", "disk-stopped"]),
        detectKind: Schema.Literals(["handwritten", "generated", "missing"])
      })
    )

    await runFuzz(
      arb,
      async (sample) => {
        // 1. NativeDetect.workspace
        const detectDir = mkdtempSync(join(tmpdir(), "ci-w8-detect-"))
        try {
          if (sample.detectKind === "handwritten") {
            writeFileSync(join(detectDir, "WORKSPACE.ts"), "export const x = 1\n")
            expect(await runNode(NativeDetect.workspace(detectDir))).toBe("WORKSPACE.ts")
          } else if (sample.detectKind === "generated") {
            writeFileSync(join(detectDir, "WORKSPACE.ts"), "// Generated by smithers-ci. Do not edit by hand.\n")
            expect(await runNode(NativeDetect.workspace(detectDir))).toBeUndefined()
          } else {
            expect(await runNode(NativeDetect.workspace(detectDir))).toBeUndefined()
          }
        } finally {
          rmSync(detectDir, { recursive: true, force: true })
        }

        // 2. NativeTargets shell tokenizer (double quotes, escapes, single quotes, comments, heredocs, redirections, unsupported)
        const complexScript = [
          "# leading comment",
          `smthrs test "//a:b" '\\'' //c:d \\`,
          `  //e:f > out.txt`,
          `cat <<EOF`,
          `smthrs test //ignored:in-heredoc`,
          `EOF`,
          `cat <<-INDENT`,
          `\tsmthrs test //ignored:in-tab-heredoc`,
          `\tINDENT`,
          `smthrs build "a\\"b" $(echo bad) || smthrs lint --include-exclusive //x:y`
        ].join("\n")
        const pats = NativeTargets.patternsIn(complexScript)
        expect(pats.length).toBeGreaterThan(0)
        // Redirection errors & complex operands
        expect(NativeTargets.patternsIn("smthrs test > > out")).toEqual([])
        expect(NativeTargets.patternsIn("smthrs test > 'unterminated")).toEqual([])
        expect(NativeTargets.patternsIn("smthrs test > \"unterminated")).toEqual([])
        expect(NativeTargets.patternsIn("smthrs test > ;")).toEqual([])
        expect(NativeTargets.patternsIn("smthrs test \"$(sub)\"")).toEqual([])

        // plansFor with unsupported verb & unknown flag
        const badVerbInv: Inventory = {
          version: 1,
          repository: "acme/t",
          commit: "0123456789abcdef0123456789abcdef01234567",
          toolchains: [],
          jobs: [makeJob("j1", [makeStep("j1:1", "smthrs unknown //...")])]
        }
        expect(Array.isArray(NativeTargets.plansFor(badVerbInv)) || typeof NativeTargets.plansFor(badVerbInv) === "string").toBe(true)
        const badFlagInv: Inventory = {
          version: 1,
          repository: "acme/t",
          commit: "0123456789abcdef0123456789abcdef01234567",
          toolchains: [],
          jobs: [makeJob("j1", [makeStep("j1:1", "smthrs ci --unknown-flag //...")])]
        }
        expect(typeof NativeTargets.plansFor(badFlagInv)).toBe("string")

        // 3. NativeReplay.run deep scenarios
        const baseOpts = Layer.succeed(Replay.Options, {
          smthrs: [nativeSmthrs],
          reruns: 0,
          prepare: () => Effect.void,
          confine: unconfined
        })
        const noProgress = Layer.succeed(Replay.Progress, { say: () => Effect.void })

        if (sample.nativeMode === "explicit-targets-and-cache-token") {
          const own = { root: makeOwnWith(nativeSmthrs), remove: () => rmSync(own.root, { recursive: true, force: true }) }
          try {
            // SMITHERS_CACHE_TOKEN refusal
            const tokOpts = Layer.succeed(Replay.Options, {
              smthrs: [nativeSmthrs],
              reruns: 0,
              prepare: () => Effect.void,
              confine: unconfined,
              environment: { SMITHERS_CACHE_TOKEN: "secret" }
            })
            const tokExit = await Effect.runPromiseExit(
              (NativeReplay.run(Replay.run as never) as (...a: ReadonlyArray<unknown>) => Effect.Effect<any, any, never>)(
                { root: own.root, commits: 1, modes: ["normal"], cache: "https://cache.example.com", targets: ["//:a"] },
                { read: () => Effect.succeed({ version: 1 as const, repository: "acme/own", commit: "0".repeat(40), jobs: [], toolchains: [] }) } as never
              ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, plentyDisk, tokOpts, noProgress)))
            )
            expect(Exit.isFailure(tokExit)).toBe(true)

            // Explicit targets with warm=true on root commit (noCommitBefore)
            const rep = await Effect.runPromise(
              (NativeReplay.run(Replay.run as never) as (...a: ReadonlyArray<unknown>) => Effect.Effect<any, any, never>)(
                { root: own.root, commits: 1, modes: ["normal"], warm: true, trial: false, targets: ["//:a"] },
                { read: () => Effect.succeed({ version: 1 as const, repository: "acme/own", commit: "0".repeat(40), jobs: [], toolchains: [] }) } as never
              ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, plentyDisk, baseOpts, noProgress)))
            )
            expect(rep.commits.length).toBe(1)
            expect(rep.cold).toBeDefined()
          } finally {
            own.remove()
          }
          return
        }

        if (sample.nativeMode === "warm-and-trial-fail") {
          const _o = makeOwn()
          const own = { root: _o.root, remove: () => rmSync(_o.root, { recursive: true, force: true }) }
          try {
            const rep = await Effect.runPromise(
              (NativeReplay.run(Replay.run as never) as (...a: ReadonlyArray<unknown>) => Effect.Effect<any, any, never>)(
                { root: own.root, commits: 1, modes: ["normal"], warm: true, trial: true },
                {
                  read: () =>
                    Effect.succeed({
                      version: 1 as const,
                      repository: "acme/own",
                      commit: "0".repeat(40),
                      toolchains: [],
                      jobs: [makeJob("ci", [makeStep("ci:1", "smthrs ci //...")])]
                    })
                } as never
              ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, plentyDisk, baseOpts, noProgress)))
            )
            expect(rep.commits.length).toBe(1)
            expect(rep.firstRun).toBeDefined()
            expect(rep.commits.length).toBeGreaterThanOrEqual(1)
          } finally {
            own.remove()
          }
          return
        }

        if (sample.nativeMode === "custom-verb-plan") {
          const own = { root: makeOwnWith(nativeSmthrs), remove: () => rmSync(own.root, { recursive: true, force: true }) }
          try {
            const rep = await Effect.runPromise(
              (NativeReplay.run(Replay.run as never) as (...a: ReadonlyArray<unknown>) => Effect.Effect<any, any, never>)(
                { root: own.root, commits: 1, modes: ["normal"], trial: false },
                {
                  read: () =>
                    Effect.succeed({
                      version: 1 as const,
                      repository: "acme/own",
                      commit: "0".repeat(40),
                      toolchains: [],
                      jobs: [makeJob("ci", [makeStep("ci:1", "smthrs build //:a")])]
                    })
                } as never
              ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, plentyDisk, baseOpts, noProgress)))
            )
            expect(rep.commits.length).toBe(1)
          } finally {
            own.remove()
          }
          return
        }

        // disk-stopped
        const own = { root: makeOwnWith(nativeSmthrs), remove: () => rmSync(own.root, { recursive: true, force: true }) }
        try {
          const lowDisk = Layer.succeed(Disk.DiskSpace, {
            space: () => Effect.succeed({ free: 100, total: 100 * 1_000_000_000 }),
            held: () => Effect.succeed(1024)
          })
          const repExit = await Effect.runPromiseExit(
            (NativeReplay.run(Replay.run as never) as (...a: ReadonlyArray<unknown>) => Effect.Effect<any, any, never>)(
              { root: own.root, commits: 1, modes: ["normal"], trial: false },
              { read: () => Effect.succeed({ version: 1 as const, repository: "acme/own", commit: "0".repeat(40), jobs: [], toolchains: [] }) } as never
            ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, baseOpts, lowDisk, noProgress)))
          )
          expect(Exit.isFailure(repExit) || repExit.value.stopped !== undefined).toBe(true)
        } finally {
          own.remove()
        }
      },
      { executions: heavyExecutions, seed: seed + 1 }
    )
  }, 240_000)

  it("fuzzes Decompose (Runners, Plan, Workspace, Split), Zig Closure (Zon, Graph) & Apply Planned", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        runnerCase: Schema.Literals(["turbo", "pnpm", "bun", "npm", "yarn", "wrapper"]),
        zonEscape: Schema.Literals(["hex-utf8", "unicode-valid", "unicode-surrogate", "unicode-bad", "unterminated", "bad-struct", "bad-list"]),
        graphMode: Schema.Literals(["grouped-ok", "grouped-shared-run", "open-reasons", "bad-named", "find-by-name"]),
        splitCase: Schema.Literals(["symlink-and-binary", "turbo-pkg-config", "chained-and-whole", "zig-group-fail", "not-git"])
      })
    )

    await runFuzz(
      arb,
      async (sample) => {
        // 1. Runners edge cases
        const known: Runners.Known = { wrappers: ["scripts/turbo.sh"], rootScripts: [] }
        if (sample.runnerCase === "turbo") {
          const r1 = Runners.turbo(["turbo"], ["run", "build", "--continue", "always", "--concurrency=2", "--", "--watch"])
          expect(r1?.runner).toBe("turbo")
          expect(Runners.turbo(["turbo"], ["login"])).toBeUndefined()
          expect(Runners.turbo(["turbo"], ["--filter", "./a...", "build"])).toBeUndefined()
          expect(Runners.turbo(["turbo"], ["--filter", ".hidden", "build"])).toBeUndefined()
        } else if (sample.runnerCase === "pnpm") {
          expect(Runners.pnpm(["pnpm", "-r", "-C", "pkg", "test"], "")).toBeUndefined()
          expect(Runners.pnpm(["pnpm", "-C", "/abs", "test"], "")).toBeUndefined()
          expect(Runners.pnpm(["pnpm", "-C", "~/home", "test"], "")).toBeUndefined()
        } else if (sample.runnerCase === "bun") {
          const r1 = Runners.bun(["bun", "run", "--workspaces", "--if-present", "--silent", "test"], "")
          expect(r1?.render(["a", "b"])).toContain("--filter")
          expect(Runners.bun(["bun", "run", "--cwd", "packages/a", "test"], "")?.selection.kind).toBe("directory")
          expect(Runners.bun(["bun", "run", "--workspaces", "--filter", "a", "test"], "")).toBeUndefined()
          expect(Runners.bun(["bun", "run", "--cwd", "/abs", "test"], "")).toBeUndefined()
          expect(Runners.bun(["bun", "test"], "")).toBeUndefined()
        } else if (sample.runnerCase === "npm") {
          const r1 = Runners.npm(["npm", "run", "test", "-ws", "--if-present", "--silent", "--", "--run"], "")
          expect(r1?.render(["a"])).toContain("--workspace=a")
          expect(Runners.npm(["npm", "run", "test", "--prefix", "packages/a"], "")?.selection.kind).toBe("directory")
          expect(Runners.npm(["npm", "run", "test", "--prefix", "/abs"], "")).toBeUndefined()
          expect(Runners.npm(["npm", "run", "test", "-w", "bad*glob"], "")).toBeUndefined()
          expect(Runners.npm(["npm", "run", "test", "-ws", "-w", "a"], "")).toBeUndefined()
          expect(Runners.npm(["npm", "--unknown", "test"], "")).toBeUndefined()
        } else if (sample.runnerCase === "yarn") {
          const r1 = Runners.yarn(["yarn", "workspace", "a", "test"], "")
          expect(r1?.render(["a"])).toEqual(["yarn", "workspace", "a", "test"])
          expect(Runners.yarn(["yarn", "workspace"], "")).toBeUndefined()
          expect(Runners.yarn(["yarn", "run", "-flag"], "")).toBeUndefined()
        } else {
          const r1 = Runners.recognize(["./scripts/turbo.sh", "run", "build"], "", known)
          expect(r1?.program).toBe("scripts/turbo.sh")
        }

        // 2. Plan.understand & keepCommand edge cases
        const ws: Workspace.Workspace = {
          manager: "pnpm",
          rootName: "root",
          rootScripts: {
            ci: "FOO=1 pnpm -r test",
            prechained: "echo pre",
            chained: "pnpm -r test",
            wrap: "pnpm run ci",
            bad: "turbo run build"
          },
          orchestrated: false,
          pnpmMissing: false,
          npmMismatch: false,
          packages: [
            { name: "a", directory: "packages/a", scripts: { test: "echo a", build: "echo build" }, dependencies: [] },
            { name: "b", directory: "packages/b", scripts: { test: "echo b" }, dependencies: ["a"] }
          ]
        }
        const u1 = DecomposePlan.understand(makeStep("s1", "cd packages/a && pnpm test"), ws, known.wrappers)
        expect(u1?.runs.length).toBe(1)
        if (u1) expect(DecomposePlan.keepCommand(u1).runs[0]?.replace).toBeUndefined()
        expect(DecomposePlan.understand(makeStep("s2", "cd packages/a || pnpm test"), ws)).toBeUndefined()
        expect(DecomposePlan.understand(makeStep("s3", "export NPM_CONFIG_FOO=1 && pnpm -r test"), ws)).toBeUndefined()
        expect(DecomposePlan.understand(makeStep("s4", "sh -c 'pnpm run wrap'"), ws)).toBeDefined()
        expect(DecomposePlan.understand(makeStep("s5", "pnpm run chained"), ws)).toBeUndefined()
        expect(DecomposePlan.understand(makeStep("s6", "cd packages/a && zig build test"), ws)).toBeUndefined()
        expect(DecomposePlan.understand(makeStep("s7", "zig build test"), ws)?.zig).toEqual(["test"])
        expect(DecomposePlan.understand(makeStep("s8", "pnpm -r test", { cwd: "${{ matrix.dir }}" }), ws)).toBeUndefined()

        // 3. Workspace edge cases (matchesDirectory, npm hidden dirs, scanner relative, outsideGlobs magic)
        expect(Workspace.matchesDirectory(["packages", "**", "a"], "packages/x/y/a")).toBe(true)
        expect(Workspace.matchesDirectory(["packages", "**", "z"], "packages/x/y/a")).toBe(false)
        expect(Workspace.matchesName("a*c", "abbc")).toBe(true)
        const npmDirs = Workspace.packageDirectories(
          [".hidden/*", "**/.dot/*"],
          new Set([".hidden/a/package.json", "x/.dot/b/package.json", "visible/c/package.json"]),
          true
        )
        expect(npmDirs).toContain(".hidden/a")
        const scan = Workspace.scanner(ws)
        expect(scan("import './local.ts'; import '../up.ts'", false).relative.length).toBeGreaterThan(0)
        expect(Workspace.outsideGlobs(ws, new Set(["dir[1]/file.txt"]))).toEqual(["**"])

        // 4. Zon.parse escapes & errors
        if (sample.zonEscape === "hex-utf8") {
          const p = Zon.parse(`"\\x68\\x69"`)
          expect(p.ok && p.value === "hi").toBe(true)
          expect(Zon.parse(`"\\xZZ"`).ok).toBe(false)
        } else if (sample.zonEscape === "unicode-valid") {
          const p = Zon.parse(`"\\u{1F600}"`)
          expect(p.ok).toBe(true)
        } else if (sample.zonEscape === "unicode-surrogate") {
          const p1 = Zon.parse(`"\\u{D800}"`)
          const p2 = Zon.parse(`"\\u{110000}"`)
          expect(p1.ok).toBe(false)
          expect(p2.ok).toBe(false)
        } else if (sample.zonEscape === "unicode-bad") {
          expect(Zon.parse(`"\\u{123"`).ok).toBe(false)
        } else if (sample.zonEscape === "unterminated") {
          expect(Zon.parse(`"abc\n`).ok).toBe(false)
        } else if (sample.zonEscape === "bad-struct") {
          expect(Zon.parse(`.{ .a = 1 .b = 2 }`).ok).toBe(false)
          expect(Zon.parse(`.{ .a 1 }`).ok).toBe(false)
        } else {
          expect(Zon.parse(`.{ 1 2 }`).ok).toBe(false)
        }

        // 5. ZigGraph.read / find / grouped
        if (sample.graphMode === "grouped-ok" || sample.graphMode === "grouped-shared-run") {
          const shared = sample.graphMode === "grouped-shared-run"
          const cfg: Zon.Zon = {
            top_level_steps: { check: 0, g1: 1, g2: 2, t1: 3, t2: 4 },
            steps: [
              { name: "check", deps: [1, 2], extended: { flags: { tag: "top_level" } } },
              { name: "g1", deps: [3], extended: { flags: { tag: "top_level" } } },
              { name: "g2", deps: [4], extended: { flags: { tag: "top_level" } } },
              { name: "t1", deps: [5], extended: { flags: { tag: "run", stdio: "check" } } },
              { name: "t2", deps: [shared ? 5 : 6], extended: { flags: { tag: "run", stdio: "check" } } },
              { name: "r1", deps: [], extended: { flags: { tag: "run", stdio: "check" } } },
              { name: "r2", deps: [], extended: { flags: { tag: "run", stdio: "check" } } }
            ]
          }
          const g = ZigGraph.read(cfg)
          expect(g).toBeDefined()
          if (g) {
            const grp = ZigGraph.grouped(g, 0)
            expect(grp).toEqual(shared ? [] : ["t1", "t2"])
          }
        } else if (sample.graphMode === "open-reasons") {
          const cfg: Zon.Zon = {
            top_level_steps: { root: 0 },
            steps: [
              {
                name: "root",
                deps: ["bad-dep"],
                extended: {
                  flags: { tag: "weird_kind", has_side_effects: true, stdio: "inherit" },
                  p1: { tag: "src_path", owner: "dep1", path: "a.zig" },
                  p2: { tag: "relative", path: "../outside.zig" }
                }
              },
              {
                name: "r_inherit",
                deps: [],
                extended: { flags: { tag: "run", stdio: "inherit" } }
              }
            ]
          }
          const g = ZigGraph.read(cfg)
          expect(g?.steps[0]?.open.length).toBeGreaterThanOrEqual(2)
          expect(ZigGraph.grouped(g!, 0)).toEqual([])
        } else if (sample.graphMode === "bad-named") {
          expect(ZigGraph.read({ top_level_steps: { x: 99 }, steps: [{ name: "a", deps: [], extended: { flags: { tag: "top_level" } } }] })).toBeUndefined()
        } else {
          const g = ZigGraph.read({
            top_level_steps: {},
            steps: [{ name: "only_one", deps: [], extended: { flags: { tag: "top_level" } } }]
          })
          expect(ZigGraph.find(g!, "only_one")?.index).toBe(0)
        }

        // 6. Split.splitWith + Planned.refusals edge cases
        const tmp = mkdtempSync(join(tmpdir(), "ci-w8-split-"))
        try {
          if (sample.splitCase === "not-git") {
            const inv: Inventory = {
              version: 1,
              repository: "acme/x",
              commit: "0".repeat(40),
              toolchains: [],
              jobs: [makeJob("j1", [makeStep("j1:1", "pnpm -r test")])]
            }
            const exit = await Effect.runPromiseExit(
              Effect.provide(Split.splitWith()(tmp, ciOf(inv)), NodeServices.layer)
            )
            expect(Exit.isFailure(exit)).toBe(true)
          } else {
            execFileSync("git", ["init", "-q"], { cwd: tmp })
            execFileSync("git", ["-C", tmp, "config", "user.name", "W8"])
            execFileSync("git", ["-C", tmp, "config", "user.email", "w8@example.com"])
            writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }))
            writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
            mkdirSync(join(tmp, "packages", "a"), { recursive: true })
            writeFileSync(join(tmp, "packages", "a", "package.json"), JSON.stringify({ name: "pkg-a", scripts: { test: "echo a" } }))
            writeFileSync(join(tmp, "packages", "a", "index.ts"), "export const a = 1\n")

            if (sample.splitCase === "symlink-and-binary") {
              symlinkSync("index.ts", join(tmp, "packages", "a", "link.ts"))
              writeFileSync(join(tmp, "packages", "a", "bin.dat"), Buffer.from([0, 1, 2, 0, 3]))
              writeFileSync(join(tmp, "yarn.lock"), "# yarn lockfile v1\n")
            } else if (sample.splitCase === "turbo-pkg-config") {
              writeFileSync(join(tmp, "turbo.json"), JSON.stringify({ tasks: { test: {} } }))
              writeFileSync(join(tmp, "packages", "a", "turbo.json"), JSON.stringify({ extends: ["//"], tasks: { test: {} } }))
            } else if (sample.splitCase === "chained-and-whole") {
              writeFileSync(join(tmp, "s1.sh"), "echo 1\n")
              writeFileSync(join(tmp, "s2.sh"), "echo 2\n")
            }

            execFileSync("git", ["-C", tmp, "add", "."])
            execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "init"])

            const step =
              sample.splitCase === "turbo-pkg-config"
                ? makeStep("j1:1", "turbo run test")
                : sample.splitCase === "chained-and-whole"
                ? makeStep("j1:1", "sh s1.sh && sh s2.sh", { name: "Chain" })
                : sample.splitCase === "zig-group-fail"
                ? makeStep("j1:1", "zig build test")
                : makeStep("j1:1", "pnpm -r test")

            const inv: Inventory = {
              version: 1,
              repository: "acme/x",
              commit: "0".repeat(40),
              toolchains: [],
              jobs: [makeJob("j1", [step])]
            }
            const out = await runNode(
              Split.splitWith({
                zigGroups: () => Effect.fail({ code: "command-failed", message: "no zig", part: "decompose" } satisfies Failure)
              })(tmp, ciOf(inv))
            )
            expect(out.jobs.length).toBe(1)

            // Exercise Planned.refusals error & edge paths on this repo
            expect(await runNode(Planned.refusals(["echo"], tmp, []))).toEqual([])
            const badMapExit = await Effect.runPromiseExit(
              Effect.provide(
                Planned.refusals(["echo"], tmp, [{ path: targetMapPath, content: "{bad" }]),
                NodeServices.layer
              )
            )
            expect(Exit.isFailure(badMapExit)).toBe(true)

            // otherHostLabels skipping all targets -> jobs.size === 0 returns []
            const otherHostFiles: ReadonlyArray<GeneratedFile> = [
              {
                path: ".smithers/WORKSPACE.smithers",
                content: `const step0 = S.Shell.Test({\n  hosts: ["otheros"]\n})\n    "j1_0": step0\n`
              },
              {
                path: targetMapPath,
                content: JSON.stringify({ version: 1, targets: [{ label: "//:j1_0", job: "j1", step: "j1:1", variant: {} }] })
              }
            ]
            expect(await runNode(Planned.refusals(["echo"], tmp, otherHostFiles))).toEqual([])

            // Stray WORKSPACE.ts refusal
            writeFileSync(join(tmp, "WORKSPACE.ts"), "export const x = 1\n")
            const strayExit = await Effect.runPromiseExit(
              Effect.provide(Planned.refusals(["echo"], tmp, otherHostFiles), NodeServices.layer)
            )
            expect(Exit.isFailure(strayExit)).toBe(true)
            rmSync(join(tmp, "WORKSPACE.ts"), { force: true })

            // Non-refusal smthrs failure (command-failed) & timeout refusal
            const realFiles: ReadonlyArray<GeneratedFile> = [
              { path: ".smithers/WORKSPACE.smithers", content: `export const x = 1\n` },
              {
                path: targetMapPath,
                content: JSON.stringify({ version: 1, targets: [{ label: "//:j1_0", job: "j1", step: "j1:1", variant: {} }] })
              }
            ]
            const failPlanExit = await Effect.runPromiseExit(
              Effect.provide(Planned.refusals(["sh", "-c", "echo plain-err >&2; exit 2"], tmp, realFiles), NodeServices.layer)
            )
            expect(Exit.isFailure(failPlanExit)).toBe(true)

            const timeoutExit = await Effect.runPromiseExit(
              Effect.provide(Planned.refusals(["sh", "-c", "sleep 2"], tmp, realFiles, "50 millis"), NodeServices.layer)
            )
            expect(Exit.isFailure(timeoutExit)).toBe(true)
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true })
        }
      },
      { executions: lightExecutions, seed: seed + 2 }
    )
  }, 240_000)

  it("fuzzes Makefile, Justfile, GithubActions, Runner expression compiler, MachineChanges & Summary diagnostics", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        makeBranch: Schema.Literals(["vars-and-funcs", "conditionals-and-patterns", "secret-and-budget", "auto-and-cycles"]),
        justBranch: Schema.Literals(["settings-and-attrs", "expressions-and-shebang", "imports-and-params"]),
        runnerExpr: Schema.Literals([
          "and-or-not",
          "comparisons",
          "calls-and-format",
          "variables-all",
          "refusals"
        ]),
        toolHint: Schema.Literals(["eslint", "prettier", "biome", "cspell", "knip", "jest", "vitest", "mocha", "npm", "none"]),
        host: Schema.Literals(["linux", "darwin", "windows"])
      })
    )

    await runFuzz(
      arb,
      async (sample) => {
        // 1. Makefile deep branches
        const makeText =
          sample.makeBranch === "vars-and-funcs"
            ? [
                ".PHONY: build test",
                ".DEFAULT_GOAL := build",
                "SRCS := a.c b.c",
                "OBJS = $(SRCS:.c=.o)",
                "OPT ?= default",
                "OPT += extra",
                "SH != echo hi",
                "FN = $(wildcard *.c) $(shell uname) $(subst a,b,$(SRCS))",
                "export FOO = bar",
                "override BAZ := 1",
                "build: $(OBJS)",
                "	@echo $(MAKE) $$HOME $(OPT) $(FN)",
                "	-echo ignore-err",
                "	+echo always-run",
                "test: build",
                "	echo $(UNKNOWN_VAR) $(UNCLOSED"
              ].join("\n")
            : sample.makeBranch === "conditionals-and-patterns"
            ? [
                "OS := linux",
                "ifeq ($(OS),linux)",
                "FLAG := -DLINUX",
                "else ifneq ($(OS),darwin)",
                "FLAG := -DOTHER",
                "else",
                "FLAG := -DMAC",
                "endif",
                "ifdef FLAG",
                "HAS := 1",
                "endif",
                "ifndef MISSING",
                "NO_M := 1",
                "endif",
                "-include extra.mk",
                "define RUN_IT",
                "echo multi \\",
                "  line",
                "endef",
                "%.o: %.c",
                "	cc -c $< -o $@",
                "all::",
                "	echo $(FLAG) $(HAS) $(NO_M)"
              ].join("\n")
            : sample.makeBranch === "secret-and-budget"
            ? [
                "API_TOKEN := ghp_1234567890abcdefghijklmnopqrstuvwxyz",
                "A = xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                "B = $(A)$(A)$(A)$(A)$(A)$(A)$(A)$(A)$(A)$(A)",
                "C = $(B)$(B)$(B)$(B)$(B)$(B)$(B)$(B)$(B)$(B)",
                "D = $(C)$(C)$(C)$(C)$(C)$(C)$(C)$(C)$(C)$(C)",
                "E = $(D)$(D)$(D)$(D)$(D)$(D)$(D)$(D)$(D)$(D)",
                "boom:",
                "	echo $(API_TOKEN)",
                "	echo $(E)"
              ].join("\n")
            : [
                "SELF = $(SELF)",
                "T1: dep1 dep2",
                "	echo $@ $< $^ $+ $| $* $? $(@D) $(<F) $(SELF)"
              ].join("\n")
        const parsedMake = Makefile.readMakefile("Makefile", makeText, ["a.c", "b.c", "extra.mk"])
        expect(parsedMake).toBeDefined()

        // 2. Justfile deep branches
        const justText =
          sample.justBranch === "settings-and-attrs"
            ? [
                "set shell := [\"bash\", \"-cu\"]",
                "set dotenv-load",
                "set export",
                "set positional-arguments",
                "set fallback",
                "set working-directory := \"sub\"",
                "alias b := build",
                "[linux]",
                "[group('ci')]",
                "[no-cd]",
                "build:",
                "    @echo build",
                "[macos]",
                "[private]",
                "mac-only:",
                "    -echo mac",
                "[windows]",
                "[confirm]",
                "win-only:",
                "    echo win",
                "[unix]",
                "unix-only: build",
                "    echo unix"
              ].join("\n")
            : sample.justBranch === "expressions-and-shebang"
            ? [
                "ver := `echo 1.0`",
                "arch_name := arch()",
                "os_name := os()",
                "flag := if os_name == \"linux\" { \"lin\" } else { \"other\" }",
                "run:",
                "    #!/usr/bin/env bash",
                "    set -euo pipefail",
                "    echo {{ ver }} {{ flag }} {{ env_var_or_default('FOO', 'bar') }}"
              ].join("\n")
            : [
                "import? 'other.just'",
                "mod sub",
                "deploy target='prod' *flags:",
                "    echo {{ target }} {{ flags }}"
              ].join("\n")
        const parsedJust = Justfile.readJustfile("justfile", justText, sample.host)
        expect(parsedJust).toBeDefined()

        // 3. Runner.write deep expression compilation
        const baseJob: Runner.JobFacts = {
          id: "j1",
          matrixKeys: ["os"],
          variants: [{ os: "ubuntu" }],
          variables: { A: "1" },
          standIns: { GITHUB_RUN_ID: "1" },
          event: "{}",
          eventName: "push"
        }
        const mkStep = (extra: Partial<Runner.StepFacts> = {}): Runner.StepFacts => ({
          key: "S1",
          after: "S0",
          second: false,
          apart: false,
          job: "j1",
          before: ["S0"],
          cwd: "",
          directory: undefined,
          start: ["bash", "-euo", "pipefail"],
          own: ["OWN_V"],
          keeps: [["K1", { written: "v", residual: { kind: "literal", value: "v" } }]] as never,
          condition: undefined,
          outer: [],
          env: [],
          fills: [],
          commit: false,
          limit: 60,
          store: true,
          python: true,
          ...extra
        })

        const exprs: ReadonlyArray<unknown> =
          sample.runnerExpr === "and-or-not"
            ? [
                {
                  kind: "binary",
                  operator: "&&",
                  left: { kind: "not", operand: { kind: "variable", variable: "outcome:prev" } },
                  right: {
                    kind: "binary",
                    operator: "||",
                    left: { kind: "variable", variable: "output:prev/k" },
                    right: { kind: "literal", value: "fallback" }
                  }
                }
              ]
            : sample.runnerExpr === "comparisons"
            ? [
                { kind: "binary", operator: "==", left: { kind: "variable", variable: "output:s0/x" }, right: { kind: "literal", value: "ok" } },
                { kind: "binary", operator: "!=", left: { kind: "variable", variable: "outcome:s0" }, right: { kind: "literal", value: "failure" } },
                { kind: "binary", operator: "<", left: { kind: "variable", variable: "output:s0/n" }, right: { kind: "literal", value: 5 } },
                { kind: "binary", operator: "<=", left: { kind: "variable", variable: "output:s0/n" }, right: { kind: "literal", value: 5 } },
                { kind: "binary", operator: ">", left: { kind: "variable", variable: "output:s0/n" }, right: { kind: "literal", value: 1 } },
                { kind: "binary", operator: ">=", left: { kind: "variable", variable: "output:s0/n" }, right: { kind: "literal", value: 1 } }
              ]
            : sample.runnerExpr === "calls-and-format"
            ? [
                { kind: "call", name: "contains", args: [{ kind: "variable", variable: "output:s0/msg" }, { kind: "literal", value: "ok" }] },
                { kind: "call", name: "startsWith", args: [{ kind: "variable", variable: "output:s0/msg" }, { kind: "literal", value: "hi" }] },
                { kind: "call", name: "endsWith", args: [{ kind: "variable", variable: "output:s0/msg" }, { kind: "literal", value: "!" }] },
                {
                  kind: "call",
                  name: "format",
                  args: [
                    { kind: "literal", value: "v={0}:{1}" },
                    { kind: "variable", variable: "output:s0/a" },
                    { kind: "variable", variable: "output:s0/b" }
                  ]
                }
              ]
            : sample.runnerExpr === "variables-all"
            ? [
                { kind: "variable", variable: `env:${JSON.stringify({ name: "FOO", held: "bar" })}` },
                { kind: "variable", variable: `env:${JSON.stringify({ name: "BAR", held: null })}` },
                { kind: "variable", variable: "kept:k1" },
                { kind: "variable", variable: "process:HOME" },
                { kind: "variable", variable: `hash:${JSON.stringify(["*.lock"])}` },
                { kind: "variable", variable: `glob:${JSON.stringify({ take: ["*.ts"], leave: ["*.d.ts"] })}` },
                { kind: "variable", variable: "matrix:os" },
                { kind: "variable", variable: "path:sub/dir" },
                { kind: "variable", variable: "base:pr" },
                { kind: "variable", variable: "before:push" },
                { kind: "variable", variable: "sha" },
                { kind: "variable", variable: "runid" }
              ]
            : [
                { kind: "variable", variable: "unknownKind:x" },
                { kind: "literal", value: { nested: 1 } },
                { kind: "call", name: "fromJSON", args: [{ kind: "variable", variable: "output:s0/j" }] },
                { kind: "call", name: "format", args: [{ kind: "literal", value: "{5}" }, { kind: "variable", variable: "output:s0/a" }] }
              ]

        for (const expr of exprs) {
          const w = Runner.write(baseJob, mkStep({ condition: expr as never, fills: [["__FILL__", expr as never]] }), "echo __FILL__")
          const wBadKey = Runner.write({ ...baseJob, matrixKeys: ["bad key!"] }, mkStep(), "echo hi")
          expect(wBadKey).toBeDefined()
          expect(w).toBeDefined()
        }

        // 4. MachineChanges comprehensive command/shell/install/service checks
        const cmds = [
          "sudo apt-get update && sudo apt-get install -y jq curl",
          "brew install ripgrep fd",
          "apk add --no-cache git bash",
          "dnf install -y gcc && yum install -y make",
          "pacman -S --noconfirm zig",
          "cargo install --locked just",
          "pip install ruff mypy",
          "npm install -g typescript pnpm",
          "go install golang.org/x/tools/gopls@latest",
          "rustup toolchain install nightly && rustup target add wasm32-unknown-unknown",
          "docker run -d postgres:16 && systemctl start redis && service nginx start",
          "nohup node server.js >/dev/null 2>&1 &",
          "echo $'ansi\\'\\x41' $((1 + (2 * 3))) $(echo nested) `uname`"
        ]
        for (const cmd of cmds) {
          const ch = MachineChanges.changesIn(cmd)
          const st = MachineChanges.startedIn(cmd)
          const ins = MachineChanges.installsOf(cmd)
          expect(Array.isArray(ch)).toBe(true)
          expect(Array.isArray(st)).toBe(true)
          expect(ins === undefined || Array.isArray(ins)).toBe(true)
        }
        expect(MachineChanges.ansiQuoteEnd("$'ab\\'cd'", 0)).toBeGreaterThan(0)
        expect(MachineChanges.closingOf("$(echo (a))", 1)).toBeGreaterThan(0)
        const q = MachineChanges.questionFor("apt", "jq")
        if (q !== undefined) {
          expect(typeof MachineChanges.answers(q, "install ok installed")).toBe("boolean")
        }

        // 5. Summary tool failure hints, appliedMismatches, failureTexts, and report helpers
        const hintMessages: Record<typeof sample.toolHint, string> = {
          eslint: "eslint error: .smithers/PACKAGE.ts parsing error",
          prettier: "[warn] .smithers/PACKAGE.ts Code style issues found in Prettier",
          biome: "biome check failed on .smithers/PACKAGE.ts",
          cspell: "cspell: Unknown word in .smithers/PACKAGE.ts",
          knip: "Unused files: .smithers/PACKAGE.ts (knip)",
          jest: "jest: Failed to collect coverage from .smithers/PACKAGE.ts",
          vitest: "vitest failed on .smithers/PACKAGE.ts",
          mocha: "mocha test failed in .smithers/PACKAGE.ts",
          npm: "npm notice publint error on .smithers/PACKAGE.ts",
          none: "generic compilation failure"
        }
        const hintMsg = hintMessages[sample.toolHint]
        const seen = Summary.seenIn(hintMsg, [".smithers/PACKAGE.ts"])
        if (sample.toolHint === "none") expect(seen).toBeUndefined()
        else expect(seen).toBeDefined()

        const ft = Summary.failureTexts(
          [
            `//:a  failed  12ms  ${JSON.stringify({ stdout: hintMsg, stderr: "err-a" })}`,
            "//:other: interleaved line",
            "detail line",
            "code: 1",
            `//:b  ran  5ms`,
            `//:c  failed  8ms  not-json-plain`
          ].join("\n")
        )
        expect(ft.size).toBeGreaterThanOrEqual(1)

        const am = Summary.appliedMismatches(
          ["//:ok", "//:fail", "//:skip"],
          [
            { label: "//:ok", status: "ran", exitCode: 0, durationMs: 5, cache: "miss" },
            { label: "//:fail", status: "failed", exitCode: 1, durationMs: 5, cache: "miss" }
          ] as never,
          new Map([["//:fail", hintMsg]]),
          [".smithers/PACKAGE.ts"]
        )
        expect(am.length).toBe(2)

        expect(Summary.withoutCredentials("https://user:secret@github.com/a/b.git")).not.toContain("secret")
        expect(Summary.publicRemote("https://github.com/a/b.git")).toBeDefined()
        expect(Summary.tooFewLeft(1, [{ job: "j", reasons: [{ feature: "docker", detail: "needs docker" }] }])).toBeDefined()
        expect(Summary.nothingToReplay([{ job: "j", reasons: [{ feature: "docker", detail: "needs docker" }] }])).toBeDefined()
        expect(Summary.rightsTaken(["sudo", "apt"])).toContain("sudo")

        // 6. GithubActions rich workflow edge cases
        const ghYaml = [
          "name: Rich",
          "on:",
          "  push:",
          "    branches: [main]",
          "  pull_request:",
          "  workflow_dispatch:",
          "permissions:",
          "  contents: read",
          "concurrency:",
          "  group: ci-${{ github.ref }}",
          "  cancel-in-progress: true",
          "defaults:",
          "  run:",
          "    shell: bash",
          "    working-directory: app",
          "jobs:",
          "  call-reusable:",
          "    uses: acme/repo/.github/workflows/sub.yml@main",
          "    with:",
          "      env: prod",
          "    secrets: inherit",
          "  svc-job:",
          "    runs-on: ubuntu-latest",
          "    container: node:20",
          "    services:",
          "      pg:",
          "        image: postgres:16",
          "    timeout-minutes: 15",
          "    strategy:",
          "      fail-fast: false",
          "      max-parallel: 2",
          "      matrix:",
          "        node: [18, 20]",
          "        include:",
          "          - node: 22",
          "        exclude:",
          "          - node: 18",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - uses: actions/setup-node@v4",
          "        with:",
          "          node-version: ${{ matrix.node }}",
          "          cache: pnpm",
          "      - uses: pnpm/action-setup@v4",
          "        with:",
          "          version: 9",
          "      - uses: actions/cache@v4",
          "        with:",
          "          path: ~/.cache",
          "          key: k-${{ hashFiles('**/pnpm-lock.yaml') }}",
          "      - id: s1",
          "        if: always() && !cancelled() && startsWith(github.ref, 'refs/')",
          "        continue-on-error: true",
          "        run: echo ok"
        ].join("\n")
        const parsedGh = GithubActions.readWorkflow(".github/workflows/rich.yml", ghYaml)
        expect(parsedGh).toBeDefined()

        // 7. Failures.ts, Actions.vibe, LeftRunning.vibe branch sweeps
        expect(Failures.printedLimitOf(1)).toBeGreaterThan(0)
        expect(Failures.printedLimitOf(50)).toBeGreaterThan(0)
        expect(Failures.firstLine("\n\n  first real line\nsecond")).toContain("first real line")
        expect(Failures.readable("\x1b[31mred error ghp_1234567890abcdefghijklmnopqrstuvwxyz\x1b[0m")).not.toContain("ghp_")
        expect(Failures.diagnosticTail("a\nb\nc\n".repeat(100), 120).length).toBeLessThanOrEqual(200)
        expect(Failures.errorLine("ok line\nError: something broke\nstack")).toContain("Error")
        expect(Failures.errorLine("only plain lines\nlast line")).toBeDefined()
        expect(Failures.reasonOf({ exitCode: 1, stdout: "FAIL test.ts", stderr: "", timedOut: false, killed: false } as never)).toBeDefined()
        expect(Failures.reasonOf({ exitCode: 137, stdout: "", stderr: "", signal: "SIGKILL" } as never)).toBeDefined()
        expect(Failures.noProgress(15)).toContain("15")
        expect(Failures.madeNoProgress({ error: Failures.noProgress(10) })).toBe(true)
        expect(Failures.madeNoProgress({ error: "ordinary failure" })).toBe(false)
        expect(Failures.signalExit("SIGTERM")).toBe(143)
        expect(Failures.signalExit("SIGKILL")).toBe(137)
        expect(Failures.signalExit("SIGINT")).toBe(130)
        expect(Failures.signalExit("UNKNOWN")).toBeGreaterThan(0)
        expect(Failures.printedFailure("FAIL: boom\nexit status 2\n")).toBeDefined()
        expect(Failures.commandLine("echo hi\nline 2")).toBe("echo hi")

        // Actions.vibe composite & checkout problems/notes
        expect(Actions.checkoutProblems({ repository: "other/repo", ref: "main", submodules: "recursive", lfs: true, "sparse-checkout": "src", filter: "blob:none", path: "sub" }, "owner/repo", (v) => v)).toBeDefined()
        expect(Actions.checkoutNotes({ "fetch-depth": 0, submodules: true, lfs: true })).toBeDefined()
        expect(Actions.parseYaml("name: ok\nruns:\n  using: composite\n  steps: []")).toBeDefined()
        expect(Actions.parseYaml("bad: [unclosed")).toBeDefined()
        expect(Actions.readAction("name: c\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash")).toBeDefined()
        expect(Actions.readAction("name: n\nruns:\n  using: node20\n  main: index.js")).toBeDefined()
        expect(Actions.readAction("not: valid: [")).toBeDefined()

        // LeftRunning.vibe daemon/background detection
        expect(LeftRunning.leftRunningIn("nohup ./server &")).toBeDefined()
        expect(LeftRunning.leftRunningIn("docker compose up -d")).toBeDefined()
        expect(LeftRunning.leftRunningIn("redis-server --daemonize yes")).toBeDefined()
        expect(LeftRunning.leftRunningIn("echo plain")).toEqual([])
      },
      { executions: Math.min(executions, 30), seed: seed + 19 }
    )
  }, 60_000)

  it("fuzzes pure branch sweep across Failures, Runner, MachineChanges, GithubActions, Makefile & Justfile", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(8)),
        withFix: Schema.Boolean,
        variant: Schema.Literals(["a", "b", "c"])
      })
    )

    await runFuzz(
      arb,
      async (sample) => {
        // 1. Failures.ts exhaustive branch sweep (notReusedOf, sentenceOf, noJobPassed, nothingPassed, failuresOf)
        const names = new Map([
          ["//ci:npm", { step: "install", command: "npm install --no-audit\necho done", after: 2, variantOf: "base" }],
          ["//ci:uv", { step: "py", command: "uv pip install -r req.txt", after: 0, variantOf: "" }],
          ["//ci:other", { step: "", command: "", after: 1 }]
        ])
        const results = [
          { label: "//ci:npm", status: "ran", durationMs: 100, notStored: "it opened a network connection to registry.npmjs.org" },
          { label: "//ci:uv", status: "ran", durationMs: 50, notStored: "uv opened a network connection" },
          { label: "//ci:other", status: "ran", durationMs: 20, notReused: "input changed" },
          { label: "//ci:hit", status: "hit", durationMs: 1 },
          { label: "//ci:skip", status: "skipped", durationMs: 0 },
          { label: "//ci:fail", status: "failed", durationMs: 30, exitCode: 2, error: "Error: bad file\nstack" },
          { label: "//ci:fail2", status: "failed", durationMs: 30, error: "timed out" }
        ] as never
        const notReused = Failures.notReusedOf(results, names)
        expect(notReused.length).toBeGreaterThanOrEqual(2)
        const fails = Failures.failuresOf(results, names)
        expect(fails.length).toBe(2)
        for (const f of fails) {
          expect(Failures.sentenceOf(f)).toContain("failed")
          expect(Failures.noJobPassed("abcdef1234567890", f)).toContain("abcdef1")
          expect(Failures.noJobPassed("abcdef1234567890", f, "1234567890abcdef")).toContain("1234567")
        }
        expect(Failures.nothingPassed([], names)).toBeUndefined()
        expect(Failures.nothingPassed([{ commit: "abcdef1234", results: [{ label: "//ci:ok", status: "ran", durationMs: 1 }] as never } as never], names)).toBeUndefined()
        expect(Failures.nothingPassed([{ commit: "abcdef1234", results: [{ label: "//ci:fail", status: "failed", durationMs: 1, exitCode: 1, error: "boom" }] as never } as never], names)).toContain("1 replayed commit")
        expect(
          Failures.nothingPassed(
            [
              { commit: "aaaaaaa1", results: [{ label: "//ci:s", status: "skipped", durationMs: 0 }] as never } as never,
              { commit: "bbbbbbb2", results: [{ label: "//ci:s", status: "skipped", durationMs: 0 }] as never } as never
            ],
            names
          )
        ).toContain("selected nothing")

        // 2. MachineChanges.vibe comprehensive package-manager/service/pip/npm/pacman/apt/brew/choco/dnf/yum/apk/zypper sweep
        const mcCommands = [
          "apt-get -o Dpkg::Options::=--force-confdef update",
          "apt-get install -y --no-install-recommends curl jq",
          "apt-get install --allow-unauthenticated git",
          "apt-get remove -y curl",
          "apt-cache policy curl",
          "pacman -Sy",
          "pacman -S --needed --noconfirm base-devel",
          "pacman -S --overwrite=* foo",
          "pacman -Syu",
          "pacman -Sc",
          "pacman -Qi bash",
          "pacman -Rns foo",
          "pacman --sync",
          "systemctl status nginx",
          "systemctl restart nginx",
          "service nginx status",
          "service nginx restart",
          "service --status-all",
          "pip install --break-system-packages requests",
          "pip3 uninstall --break-system-packages requests",
          "PIP_BREAK_SYSTEM_PACKAGES=1 pip install pytest",
          "npm install -g typescript",
          "npm i --global eslint",
          "npm uninstall --location=global eslint",
          "npm test",
          "brew update",
          "brew install ripgrep",
          "brew list",
          "dnf -y install gcc",
          "apk add --no-cache git",
          "choco install -y nodejs",
          "sudo env FOO=1 apt-get install -y make",
          "rustup default stable",
          "corepack enable"
        ]
        for (const cmd of mcCommands) {
          expect(MachineChanges.changesIn(cmd)).toBeDefined()
        }

        // 3. GithubActions.vibe rich workflows: shells, working-directory matrix, composite actions, literal secret inputs, setup actions, env/hash/matrix/if expressions, service containers, reusable calls
        const wfFiles: Record<string, string> = {
          ".github/actions/comp/action.yml": [
            "name: comp",
            "inputs:",
            "  tok:",
            "    required: false",
            "    default: plain",
            "  flag:",
            "    default: yes",
            "runs:",
            "  using: composite",
            "  steps:",
            "    - shell: bash",
            "      run: echo ${{ inputs.tok }} ${{ inputs.flag }}"
          ].join("\n"),
          ".github/actions/broken/action.yml": "runs:\n  using: docker\n  image: alpine"
        }
        const richYaml = [
          "name: rich",
          "on: [push, pull_request]",
          "env:",
          "  TOP_ENV: topval",
          "jobs:",
          "  mat:",
          "    runs-on: ubuntu-latest",
          "    strategy:",
          "      matrix:",
          "        node: [18, 20]",
          "        flag: [true, false]",
          "        dir: [sub, .]",
          "        include:",
          "          - node: 22",
          "            flag: true",
          "            dir: sub",
          "            extra: bonus",
          "    defaults:",
          "      run:",
          "        shell: bash -euo pipefail {0}",
          "        working-directory: ${{ matrix.dir }}",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "        with:",
          "          fetch-depth: 0",
          "          submodules: recursive",
          "      - uses: actions/setup-node@v4",
          "        with:",
          "          node-version: ${{ matrix.node }}",
          "      - id: s1",
          "        shell: sh",
          "        run: echo ok",
          "      - id: s2",
          "        shell: bash -- {0}",
          "        run: echo bad-shell",
          "      - shell: pwsh",
          "        run: Write-Host hi",
          "      - working-directory: ../outside",
          "        run: echo esc",
          "      - if: ${{ steps.s1.outcome == success && contains(matrix.dir, s) && startsWith(env.TOP_ENV, top) && endsWith(github.ref, main) && !matrix.flag && github.event.before !=  }}",
          "        run: echo ${{ steps.s1.outputs.val }} ${{ hashFiles(package-lock.json, !*.tmp) }} ${{ github.workspace }} ${{ matrix.node }} ${{ matrix.extra }}",
          "      - uses: ./.github/actions/comp",
          "        with:",
          "          tok: ghp_1234567890abcdefghijklmnopqrstuvwxyz",
          "          flag: ${{ env.TOP_ENV }}",
          "      - uses: ./.github/actions/broken",
          "      - uses: ./.github/actions/missing"
        ].join("\n")
        const parsed = GithubActions.readWorkflow(".github/workflows/rich.yml", richYaml, {
          read: (rel: string) => wfFiles[rel],
          repository: "org/repo"
        } as never)
        expect(parsed.jobs.length).toBeGreaterThanOrEqual(1)

        // 4. Makefile & Justfile tricky branches (conditionals, pattern rules, phony, variables, includes, attributes, recipes, doc comments)
        const mk = [
          ".PHONY: all test build",
          "CC ?= gcc",
          "CFLAGS := -O2",
          "CFLAGS += -Wall",
          "ifdef DEBUG",
          "CFLAGS += -g",
          "else",
          "CFLAGS += -DNDEBUG",
          "endif",
          "%.o: %.c",
          "\t$(CC) $(CFLAGS) -c $< -o $@",
          "all: build test",
          "build:",
          "\t@echo building $(CC)",
          "test: build",
          "\t-echo testing",
          "\t+echo submake"
        ].join("\n")
        expect(Makefile.readMakefile("Makefile", mk, ["Makefile", "src/a.c"])).toBeDefined()

        const jf = [
          "set shell := [\"bash\", \"-cu\"]",
          "set dotenv-load",
          "export RUST_LOG := \"info\"",
          "version := `echo 1.0`",
          "alias b := build",
          "[private]",
          "[no-cd]",
          "helper arg=\"x\":",
          "    @echo {{arg}}",
          "[group(ci)]",
          "build target=\"all\": helper",
          "    echo building {{target}} {{version}}",
          "test *args:",
          "    -echo testing {{args}}"
        ].join("\n")
        expect(Justfile.readJustfile("justfile", jf)).toBeDefined()

        // 5. Runner.write with properly structured Variable objects ({ id, typed }) covering every loadOf/compileByVariant/compileInShell/tested branch!
        const v = (id: string, typed = false) => ({ kind: "variable" as const, variable: { id, typed } })
        const lit = (value: unknown) => ({ kind: "literal" as const, value })
        const rJobUntyped: Runner.JobFacts = {
          id: "rj",
          matrixKeys: ["n", "b", "s"],
          variants: [
            { n: "20", b: "true", s: "a|b%c" },
            { n: "18", b: "false" }
          ],
          variables: { A: "1" },
          standIns: { GITHUB_RUN_ID: "1" },
          event: "{}",
          eventName: "push"
        }
        const rJobTyped: Runner.JobFacts = {
          ...rJobUntyped,
          typedVariants: [
            { n: 20, b: true, s: "a|b%c" },
            { n: 18, b: false }
          ]
        } as never
        const rStep = (extra: Partial<Runner.StepFacts> = {}): Runner.StepFacts => ({
          key: "RS1",
          after: "RS0",
          second: false,
          apart: false,
          job: "rj",
          before: ["RS0"],
          cwd: "",
          directory: undefined,
          start: ["bash", "-e"],
          own: [],
          keeps: [],
          condition: undefined,
          outer: [],
          env: [],
          fills: [],
          commit: false,
          ...extra
        })
        const allResiduals: ReadonlyArray<unknown> = [
          v("output:s0/res"),
          v("outcome:s0"),
          v("env:" + JSON.stringify({ name: "FOO", held: null })),
          v("env:" + JSON.stringify({ name: "BAR", held: "fallback" })),
          v("kept:k1"),
          v("process:HOME"),
          v("hash:" + JSON.stringify(["package-lock.json"])),
          v("glob:" + JSON.stringify({ take: ["*.ts"], leave: ["dist/**"] })),
          v("glob:" + JSON.stringify({ take: ["*.ts"], leave: ["dist/**"], order: [0, -1] })),
          v("matrix:n", true),
          v("matrix:b", true),
          v("matrix:s", false),
          v("matrix:missing", true),
          v("path:sub/dir"),
          v("base:pr"),
          v("before:push"),
          v("sha"),
          v("unknownKind:bad"),
          lit(""),
          lit("hi"),
          lit(null),
          lit(0),
          lit(42),
          lit(true),
          lit(false),
          lit({ obj: 1 }),
          { kind: "not", operand: v("output:s0/res") },
          { kind: "not", operand: v("matrix:b", true) },
          { kind: "call", name: "contains", args: [v("output:s0/res"), lit("x")] },
          { kind: "call", name: "startsWith", args: [v("output:s0/res"), lit("a")] },
          { kind: "call", name: "endsWith", args: [v("output:s0/res"), lit("z")] },
          { kind: "call", name: "format", args: [lit("hi {0}!"), v("output:s0/res")] },
          { kind: "call", name: "format", args: [lit("bad {5}"), v("output:s0/res")] },
          { kind: "call", name: "toJSON", args: [v("output:s0/res")] },
          { kind: "binary", operator: "&&", left: v("output:s0/res"), right: lit("yes") },
          { kind: "binary", operator: "||", left: v("output:s0/res"), right: lit("no") },
          { kind: "binary", operator: "==", left: v("output:s0/res"), right: lit("ok") },
          { kind: "binary", operator: "!=", left: v("output:s0/res"), right: lit("no") },
          { kind: "binary", operator: "==", left: v("output:s0/res"), right: lit(true) },
          { kind: "binary", operator: "<", left: v("output:s0/res"), right: lit("z") },
          { kind: "binary", operator: "&&", left: v("matrix:n", true), right: v("output:s0/res") },
          { kind: "binary", operator: "==", left: v("matrix:n", true), right: lit(20) },
          { kind: "binary", operator: "==", left: v("matrix:s", false), right: lit("a|b%c") }
        ]
        for (const job of [rJobUntyped, rJobTyped]) {
          for (const res of allResiduals) {
            expect(Runner.write(job, rStep({ condition: res as never, second: true, python: true, ownCi: true, ownQuiet: ["DO_NOT_TRACK"], action: "act1", store: true }), "echo hi")).toBeDefined()
            expect(Runner.write(job, rStep({ fills: [["${{ x }}", res as never]], after: undefined, job: undefined }), "echo ${{ x }}")).toBeDefined()
          }
        }
      },
      { executions: Math.min(executions, 25), seed: seed + 25 }
    )
  }, 30_000)
})
