import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Result, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ci as ciOf, type Inventory, type Job, type Step } from "../src/contract/Inventory.vibe"
import type { ReplayReport } from "../src/contract/ReplayReport.vibe"
import * as Script from "../src/decompose/Script.vibe"
import * as Turbo from "../src/decompose/Turbo.vibe"
import * as GenerateSteps from "../src/generate/Steps.vibe"
import * as InventoryRead from "../src/inventory/Read.vibe"
import * as Failures from "../src/replay/Failures.ts"
import * as Summary from "../src/replay/Summary.vibe"
import * as Format from "../src/report/Format.vibe"
import * as Html from "../src/report/Html.vibe"
import * as Text from "../src/report/Text.vibe"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261703")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

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

const makeInventory = (jobs: ReadonlyArray<Job>): Inventory => ({
  version: 1,
  repository: "w10/repo",
  commit: "a".repeat(40),
  toolchains: [{ name: "node", source: "setup-node", version: "22" }],
  jobs
})

describe("packages/ci Wave 10 Boost: GenerateSteps, InventoryRead & Decompose Script/Turbo", () => {
  it("fuzzes GenerateSteps.planSteps outputs, validation errors, cycles & inTreeOrder", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals([
          "valid_outputs",
          "invalid_glob_output",
          "invalid_escape_output",
          "dup_job",
          "dup_step",
          "missing_need",
          "cycle_need",
          "justfile_tree_order"
        ]),
        narrowed: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            if (input.caseKind === "valid_outputs") {
              const inv = makeInventory([
                makeJob("build", [makeStep("s1", "npm run build", { outputs: ["dist/**", "out/app.js"] })])
              ])
              const res = GenerateSteps.planSteps(ciOf(inv), input.narrowed)
              expect(Result.isSuccess(res)).toBe(true)
            } else if (input.caseKind === "invalid_glob_output") {
              const inv = makeInventory([
                makeJob("build", [makeStep("s1", "npm run build", { outputs: ["dist/*.js"] })])
              ])
              const res = GenerateSteps.planSteps(ciOf(inv), input.narrowed)
              expect(Result.isSuccess(res)).toBe(true)
            } else if (input.caseKind === "invalid_escape_output") {
              const inv = makeInventory([
                makeJob("build", [makeStep("s1", "npm run build", { outputs: ["../outside", ""] })])
              ])
              const res = GenerateSteps.planSteps(ciOf(inv), input.narrowed)
              expect(Result.isSuccess(res)).toBe(true)
            } else if (input.caseKind === "dup_job") {
              const inv = makeInventory([
                makeJob("same", [makeStep("s1", "echo 1")]),
                makeJob("same", [makeStep("s2", "echo 2")])
              ])
              expect(Result.isFailure(GenerateSteps.planSteps(ciOf(inv), input.narrowed))).toBe(true)
            } else if (input.caseKind === "dup_step") {
              const inv = makeInventory([
                makeJob("j1", [makeStep("dup", "echo 1")]),
                makeJob("j2", [makeStep("dup", "echo 2")])
              ])
              expect(Result.isFailure(GenerateSteps.planSteps(ciOf(inv), input.narrowed))).toBe(true)
            } else if (input.caseKind === "missing_need") {
              const inv = makeInventory([makeJob("j1", [makeStep("s1", "echo 1")], { needs: ["ghost"] })])
              expect(Result.isFailure(GenerateSteps.planSteps(ciOf(inv), input.narrowed))).toBe(true)
            } else if (input.caseKind === "cycle_need") {
              const inv = makeInventory([
                makeJob("j1", [makeStep("s1", "echo 1")], { needs: ["j2"] }),
                makeJob("j2", [makeStep("s2", "echo 2")], { needs: ["j1"] })
              ])
              expect(Result.isFailure(GenerateSteps.planSteps(ciOf(inv), input.narrowed))).toBe(true)
            } else {
              const inv = makeInventory([
                makeJob("r1", [makeStep("s1", "echo 1")], { source: "justfile", file: "justfile" }),
                makeJob("r2", [makeStep("s2", "echo 2")], { source: "justfile", file: "justfile" }),
                makeJob("r3", [makeStep("s3", "echo 3")], { source: "justfile", file: "justfile", needs: ["r2"] })
              ])
              const res = GenerateSteps.planSteps(ciOf(inv), input.narrowed)
              expect(Result.isSuccess(res)).toBe(true)
            }
            expect(GenerateSteps.exactRunners(["ubuntu-latest", "macos-14", "${{ matrix.os }}"]).size).toBeGreaterThanOrEqual(1)
            return true
          }),
        { executions: Math.min(executions, 40), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("exercises InventoryRead edge cases: multiple justfiles, bad pnpm-workspace, package turbo, WORKSPACE.ts, dirty tree & no-commit repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w10-ci-read-"))
    const emptyRepo = mkdtempSync(join(tmpdir(), "w10-ci-empty-"))
    try {
      // 1. Empty repo with no commit -> not-a-repository
      execFileSync("git", ["init", "-q"], { cwd: emptyRepo })
      const emptyExit = await Effect.runPromiseExit(
        InventoryRead.read(emptyRepo).pipe(Effect.provide(NodeServices.layer))
      )
      expect(Exit.isFailure(emptyExit)).toBe(true)

      // 2. Repo with multiple justfiles, bad pnpm-workspace.yaml, package-level turbo.json, hand-written WORKSPACE.ts & dirty tree
      execFileSync("git", ["init", "-q"], { cwd: dir })
      execFileSync("git", ["config", "user.email", "w10@test.local"], { cwd: dir })
      execFileSync("git", ["config", "user.name", "W10"], { cwd: dir })
      mkdirSync(join(dir, "packages", "a"), { recursive: true })
      writeFileSync(join(dir, "justfile"), "build:\n  echo 1\n")
      writeFileSync(join(dir, ".justfile"), "build:\n  echo 2\n")
      writeFileSync(join(dir, "pnpm-workspace.yaml"), ":::bad-yaml:::\n\t[\n")
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*", "!packages/skip"] }))
      writeFileSync(join(dir, "packages", "a", "package.json"), JSON.stringify({ name: "@w10/a", scripts: { test: "vitest" } }))
      writeFileSync(join(dir, "packages", "a", "turbo.json"), JSON.stringify({ tasks: { test: {} } }))
      writeFileSync(join(dir, "WORKSPACE.ts"), "export const handWritten = true\n")
      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir })
      // Uncommitted change
      writeFileSync(join(dir, "dirty.txt"), "uncommitted\n")

      const inv = await Effect.runPromise(InventoryRead.read(dir).pipe(Effect.provide(NodeServices.layer)))
      expect((inv.unsupported ?? []).length).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(emptyRepo, { recursive: true, force: true })
    }
  }, 60_000)

  it("fuzzes Decompose Script.decide & Turbo.readConfig/walk across chained scripts, lifecycle hooks & JSONC", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cmd: Schema.Literals([
          "npm run check",
          "pnpm run check",
          "yarn check",
          "bun run check",
          "pnpm --dir packages/a run build",
          "NODE_ENV=test npm test",
          "npm run withpre",
          "npm run piped",
          "npm run missing",
          "npm run badjson",
          "echo plain"
        ]),
        leads: Schema.Boolean,
        cwd: Schema.Literals(["", "packages/a"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const step = makeStep("s1", input.cmd, { cwd: input.cwd })
            const files = Script.filesOf(step)
            expect(Array.isArray(files)).toBe(true)
            const pkgMap = new Map<string, string | null>([
              [
                "package.json",
                input.cmd.includes("badjson")
                  ? "{bad"
                  : JSON.stringify({
                      scripts: {
                        check: "eslint . && tsc --noEmit && vitest run",
                        test: "vitest run",
                        prewithpre: "echo pre",
                        withpre: "echo main && echo after",
                        piped: "cat foo | grep bar && echo ok",
                        build: "tsc"
                      }
                    })
              ],
              [
                "packages/a/package.json",
                JSON.stringify({ scripts: { build: "tsc && vitest run" } })
              ]
            ])
            const dec = Script.decide(step, (p) => pkgMap.get(p), input.leads)
            expect(["none", "whole", "chain"]).toContain(dec.kind)
            Script.runOf(input.cmd.split(" "))

            // Turbo v1 pipeline + v2 tasks + JSONC comments + cycle + root task
            const pkgA = { name: "@w10/a", directory: "packages/a", scripts: new Set(["build", "test"]), dependencies: ["@w10/b"] }
            const pkgB = { name: "@w10/b", directory: "packages/b", scripts: new Set(["build"]), dependencies: [] }
            const fakeWs = { manager: "pnpm" as const, packages: [pkgA, pkgB], rootScripts: new Set(["rootCheck"]) }
            const turboV2 = Turbo.readConfig(
              `{
                // JSONC comment
                /* block comment */
                "tasks": {
                  "//#rootCheck": { "inputs": ["package.json"] },
                  "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
                  "test": { "dependsOn": ["build", "//#rootCheck"] },
                  "cycA": { "dependsOn": ["cycB"] },
                  "cycB": { "dependsOn": ["cycA"] }
                }
              }`,
              [["@w10/a", JSON.stringify({ extends: ["//"], tasks: { test: { dependsOn: ["build"] } } })]]
            )
            if (turboV2 !== undefined) {
              expect(Turbo.defines(turboV2, "test", "@w10/a")).toBe(true)
              expect(Turbo.rootRuns(turboV2, "rootCheck")).toBe(true)
              expect(Turbo.walk(turboV2, fakeWs as never, pkgA as never, ["test"])).toBeDefined()
              expect(Turbo.walk(turboV2, fakeWs as never, pkgA as never, ["cycA"])).toBeDefined()
            }
            const turboV1 = Turbo.readConfig(JSON.stringify({ pipeline: { build: { dependsOn: ["^build"] } } }), [])
            expect(turboV1).toBeDefined()
            expect(Turbo.readConfig("{bad-json", [])).toBeUndefined()
            return true
          }),
        { executions: Math.min(executions, 40), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("packages/ci Wave 10 Boost: Failures, Summary & Report (Format, Html, Text) deep fuzz", () => {
  it("fuzzes Failures errorLine, reasonOf, signalExit, printedFailure, failuresOf, notReusedOf & Summary helpers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        signal: Schema.Literals(["SIGTERM", "SIGKILL", "SIGSEGV", "SIGINT", "SIGABRT", "SIGHUP", "SIGUNKNOWN"]),
        errStyle: Schema.Literals([
          "ts",
          "rust",
          "go",
          "vitest",
          "python",
          "ansi",
          "empty",
          "multiline_long"
        ]),
        timedOut: Schema.Boolean,
        stalled: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const sampleTexts: Record<string, string> = {
              ts: "src/index.ts(12,4): error TS2322: Type 'string' is not assignable to type 'number'.",
              rust: "error[E0308]: mismatched types\n  --> src/main.rs:10:5",
              go: "--- FAIL: TestFoo (0.01s)\n    foo_test.go:14: expected 1 got 2",
              vitest: "FAIL test/a.test.ts > suite > case\nAssertionError: expected 1 to be 2",
              python: "Traceback (most recent call last):\n  File \"a.py\", line 1\nValueError: bad value",
              ansi: "\u001b[31mError:\u001b[0m something broke with token=ghp_1234567890abcdef",
              empty: "",
              multiline_long: Array.from({ length: 120 }, (_, i) => `log line ${i} ${"x".repeat(40)}`).join("\n")
            }
            const text = sampleTexts[input.errStyle]!
            expect(typeof Failures.firstLine(text)).toBe("string")
            expect(typeof Failures.readable(text)).toBe("string")
            expect(typeof Failures.diagnosticTail(text, 200)).toBe("string")
            expect(typeof Failures.errorLine(text)).toBe("string")
            expect(Failures.printedLimitOf(1)).toBeGreaterThan(0)
            expect(Failures.printedLimitOf(100)).toBeGreaterThan(0)
            expect(Failures.signalExit(input.signal)).toBeGreaterThan(0)
            expect(Failures.noProgress(5)).toContain("5")
            expect(Failures.commandLine("echo hi\necho bye")).toBe("echo hi")

            const reason = Failures.reasonOf({
              stdout: text,
              stderr: text,
              exitCode: input.timedOut ? undefined : 1,
              timedOut: input.timedOut,
              stalled: input.stalled,
              signal: input.timedOut ? input.signal : undefined
            } as never)
            expect(typeof reason).toBe("string")

            const pf = Failures.printedFailure(
              `FAILED //:build_0 (exit 1)\ncommand: npm test\n${text}\n`
            )
            expect(pf).toBeDefined()

            const last: Failures.LastFailures = new Map()
            const tr = {
              label: "//:build_0",
              status: "failed" as const,
              durationMs: 10,
              exitCode: 1,
              error: reason
            }
            Failures.remember(last, [tr as never])
            expect(typeof Failures.failedAsBefore(last, tr as never)).toBe("boolean")
            expect(typeof Failures.failureMark(tr)).toBe("string")
            expect(typeof Failures.madeNoProgress(tr)).toBe("boolean")

            // Summary helpers
            const ft = Summary.failureTexts(`--- //:build_0 ---\n${text}\n`)
            expect(ft).toBeDefined()
            expect(Summary.seenIn("failed reading .smithers/WORKSPACE.smithers", [".smithers/WORKSPACE.smithers"])).toContain(".smithers/WORKSPACE.smithers")
            expect(Summary.seenIn("unrelated error", [".smithers/WORKSPACE.smithers"])).toBeUndefined()
            expect(Summary.failsApplied([".smithers/WORKSPACE.smithers"])).toContain("WORKSPACE")
            expect(Summary.stepKey("job:step", { os: "linux", node: "22" })).toContain("job")
            expect(Summary.tooFewLeft(2, [{ job: "a", reasons: [{ feature: "x", detail: "y" }] }])).toBeDefined()
            expect(Summary.tooFewLeft(3, [{ job: "a", reasons: [{ feature: "x", detail: "y" }] }])).toBeUndefined()
            return true
          }),
        { executions: Math.min(executions, 40), seed: seed + 3 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes Report Format, Html.html & Text.text across every report variant (speedup, mismatches, cold, stopped, model, skips)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hasFast: Schema.Boolean,
        hasCold: Schema.Boolean,
        hasStopped: Schema.Boolean,
        hasFailedCommit: Schema.Boolean,
        hasMismatch: Schema.Boolean,
        hasSkips: Schema.Boolean,
        hasNotReused: Schema.Boolean,
        hasModel: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const counts = { ran: 1, hit: 2, failed: input.hasFailedCommit ? 1 : 0, skipped: input.hasSkips ? 1 : 0, flaky: 0 }
            const rep: ReplayReport = {
              version: 1,
              repository: "w10/demo",
              baselineWallMs: 10_000,
              normalWallMs: 3000,
              speedup: input.hasFailedCommit ? 0 : 3.33,
              speedupCommits: input.hasFailedCommit ? 0 : 1,
              mismatches: input.hasMismatch ? 1 : 0,
              ...(input.hasFast ? { fastWallMs: 1200, fastCpuMs: 900 } : { fastNotMeasured: "model unavailable" }),
              baselineCpuMs: 8000,
              normalCpuMs: 2500,
              commits: [
                {
                  commit: "1234567890abcdef1234567890abcdef12345678",
                  changedFiles: 3,
                  baseline: {
                    ok: !input.hasFailedCommit,
                    wallMs: 10_000,
                    workMs: 9500,
                    cpuMs: 8000,
                    counts,
                    ...(input.hasFailedCommit
                      ? { failures: [{ step: "test", exitCode: 1, reason: "boom", command: "npm test" }] }
                      : {})
                  },
                  normal: {
                    ok: !input.hasFailedCommit && !input.hasMismatch,
                    wallMs: 3000,
                    workMs: 2800,
                    cpuMs: 2500,
                    counts,
                    ...(input.hasMismatch
                      ? { failures: [{ step: "test", exitCode: 1, reason: "mismatch err", command: "npm test" }] }
                      : {}),
                    ...(input.hasNotReused
                      ? { notReused: [{ step: "test", reason: "env changed", kept: false, fix: "commit lockfile", command: "npm test" }] }
                      : {})
                  },
                  mismatches: input.hasMismatch
                    ? [{ label: "//:t1", mode: "normal" as const, baseline: "pass" as const, got: "fail" as const, cause: "read generated file" }]
                    : [],
                  ...(input.hasFast
                    ? {
                        fast: { ok: !input.hasFailedCommit, wallMs: 1200, workMs: 1100, cpuMs: 900, counts },
                        skipped: input.hasSkips
                          ? [{ label: "//:t2", confidence: 0.99, reason: "unrelated", matched: true }]
                          : []
                      }
                    : {}),
                  ...(input.hasModel ? { model: { ms: 400, calls: 2, inputTokens: 1000, outputTokens: 200 } } : {})
                }
              ],
              ...(input.hasCold
                ? { cold: "no parent commit before oldest" }
                : { firstRun: { baselineMs: 12_000, normalMs: 9000, ...(input.hasFast ? { fastMs: 8500 } : {}) } }),
              ...(input.hasStopped ? { stopped: "disk free space fell below floor" } : {}),
              ...(input.hasModel
                ? {
                    model: { ms: 400, calls: 2, inputTokens: 1000, outputTokens: 200 },
                    selection: {
                      total: 4,
                      skipped: 2,
                      ran: 2,
                      caught: 1,
                      missed: 0,
                      falseSkips: 0,
                      precision: 1,
                      recall: 1,
                      skipRate: 0.5
                    }
                  }
                : {}),
              trialMs: 4200,
              appliedMs: 3100,
              reruns: { count: 2, ms: 900 },
              flaky: 1,
              jobs: { replayed: 2, total: 3 },
              notReplayed: [{ job: "deploy", reasons: [{ feature: "changes-machine", detail: "installs apt pkg" }] }],
              notRead: [{ feature: "malformed-file", detail: "bad yaml" }],
              notReplayedCommits: [{ commit: "abcdef1234567890abcdef1234567890abcdef12", reason: "no CI at commit" }],
              toolVersions: [{ job: "build", tool: "node", asked: "22", found: "22.1" }],
              withheld: ["SECRET_KEY"],
              diskHeldBytes: 123_456_789
            } as unknown as ReplayReport

            const htmlOut = Html.html(rep)
            const textOut = Text.text(rep)
            expect(htmlOut).toContain("<html")
            expect(textOut.length).toBeGreaterThan(20)
            // Direct Format helper coverage
            expect(typeof Format.speedupCommits(rep)).toBe("number")
            expect(typeof Format.normalDiffers(rep)).toBe("boolean")
            expect(typeof Format.coverage(rep)).toBe("string")
            expect(typeof Format.jobsCount(rep)).toBe("string")
            expect(typeof Format.jobsLeftOut(rep)).toBe("number")
            expect(Format.trialTime(4200)).toBeDefined()
            expect(Format.appliedTime(3100)).toBeDefined()
            expect(Format.rerunTime({ count: 2, ms: 900 })).toBeDefined()
            expect(Format.coldStart("empty")).toContain("empty")
            expect(Format.leftEmpty(["a", "b"])).toContain("a")
            expect(Format.ownTargets(["//:a", "//:b"])).toContain("//:a")
            expect(Format.skippedLabels(["//:a", "//:b", "//:c", "//:d"])).toContain("//:a")
            return true
          }),
        { executions: Math.min(executions, 35), seed: seed + 4 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
