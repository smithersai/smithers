import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Schema } from "effect"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/cli/Cli.vibe"
import * as Main from "../src/cli/main.vibe"
import * as Restart from "../src/cli/Restart.ts"
import { ci as ciOf, type Inventory, type Job } from "../src/contract/Inventory.vibe"
import type { Failure, ReplayParts } from "../src/contract/Parts.vibe"
import type { TargetResult } from "../src/contract/RunRecord.vibe"
import { read as readInventory } from "../src/inventory/index.vibe"
import * as NativeReplay from "../src/native/Replay.vibe"
import * as NativeResults from "../src/native/Results.vibe"
import * as NativeTargets from "../src/native/Targets.vibe"
import * as Disk from "../src/replay/Disk.vibe"
import * as DiskSpace from "../src/replay/DiskSpace.ts"
import { Options, Progress } from "../src/replay/Replay.vibe"
import { inProcess } from "./cli/inProcess.vibe"
import { parts as cliParts } from "./cli/parts.vibe"
import { commit as cliCommit, git as cliGit, recorder, temporary } from "./cli/repo.ts"
import { makeOwn, smthrs } from "./native/own.ts"
import { rows as nativeRows, scoreKeeping } from "./native/support.vibe"
import { unconfined } from "./replay/place.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261127")
const restartedScript = fileURLToPath(new URL("./cli/restarted.mjs", import.meta.url))

const makeJob = (id: string, command: string): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  runsOn: "ubuntu-latest",
  steps: [{ id: `${id}:1`, command, cwd: "", env: {}, secrets: [] }],
  unsupported: []
})

describe("@smthrs/ci native targets, results, replay, CLI & Restart fuzz invariants", () => {
  it("NativeTargets.patternsIn/plansFor/covers/chosenFor handle arbitrary smthrs target patterns and inventories", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pattern: Schema.Literals([
          "//...",
          "//packages/ci:test",
          "//packages/ci/...",
          "//apps/mvp:build",
          ":test",
          "packages/a:lint"
        ]),
        asked: Schema.Literals([
          "//...",
          "//packages/ci/...",
          "//packages/ci:test",
          "//apps/mvp:build",
          "//other:x"
        ]),
        scriptKind: Schema.Literals(["ci", "test", "build", "multi", "none"]),
        hasRequested: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pattern, asked, scriptKind, hasRequested }) =>
          Effect.sync(() => {
            const script = scriptKind === "ci"
              ? `node_modules/.bin/smthrs ci '${pattern}' --ui plain`
              : scriptKind === "test"
              ? `smthrs test ${pattern}`
              : scriptKind === "build"
              ? `pnpm exec smthrs build ${pattern}`
              : scriptKind === "multi"
              ? `smthrs ci ${pattern} && smthrs test //packages/ci:test`
              : "pnpm test"

            const pats = NativeTargets.patternsIn(script)
            const inv: Inventory = ciOf({
              version: 1,
              repository: "acme/own",
              commit: "0".repeat(40),
              toolchains: [],
              jobs: [makeJob("ci.yml:targets", script), makeJob("ci.yml:docs", "echo docs")]
            })
            const plans = NativeTargets.plansFor(inv)
            const cov = NativeTargets.covers(asked, pattern)
            const chosen = NativeTargets.chosenFor(inv, hasRequested ? [asked] : undefined)
            return (
              Array.isArray(pats) &&
              (Array.isArray(plans) || typeof plans === "string") &&
              typeof cov === "boolean" &&
              typeof chosen === "object"
            )
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("NativeResults exercises reasonsIn, withReasons, whyNoRecord, noRecord, linesOf, ranAgain, ranAgainLines", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        output: Schema.Literals([
          "//:a FAIL exit code 1\nassert failed\n//:b PASS\n",
          "{\"code\":\"ci_failed\",\"message\":\"build broken\"}\n",
          "(node:1) ExperimentalWarning: x\nreal error\n",
          ""
        ]),
        statusA: Schema.Literals(["ran", "hit", "failed", "skipped"]),
        statusB: Schema.Literals(["ran", "hit", "failed", "skipped"]),
        commitShort: Schema.Literals(["abc1234", "deadbee"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ output, statusA, statusB, commitShort }) =>
          Effect.sync(() => {
            const reasons = NativeResults.reasonsIn(output)
            const results: Array<TargetResult> = [
              { label: "//:a", status: statusA, key: "k1", durationMs: 12 },
              { label: "//:b", status: statusB, key: "k2", durationMs: 8 }
            ]
            const withR = NativeResults.withReasons(results, output)
            const why = NativeResults.whyNoRecord(output)
            const nr = NativeResults.noRecord(output)
            const lines = NativeResults.linesOf(commitShort, withR, 1)
            const again = NativeResults.ranAgain(new Map([["//:a", "k1"], ["//:b", "k2"]]), results)
            const againLines = NativeResults.ranAgainLines(commitShort, again)
            return (
              reasons instanceof Map &&
              withR.length === 2 &&
              typeof why === "string" &&
              nr.label === NativeResults.noRecordLabel &&
              Array.isArray(lines) &&
              Array.isArray(again) &&
              Array.isArray(againLines)
            )
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Restart.split/hand/received/taken/own preserve secret env over real FIFO and strip withheld vars", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        platform: Schema.Literals(["linux", "darwin", "win32"]),
        secretVal: Schema.Literals([
          "ghp_abc123",
          "line1\nline2 'quote' \"dq\" $x `y`",
          "unicode-ü-✓",
          ""
        ]),
        hasSecret: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ platform, secretVal, hasSecret }) =>
          Effect.promise(async () => {
            const env: Record<string, string | undefined> = {
              PATH: process.env["PATH"],
              HOME: process.env["HOME"],
              TERM: "xterm",
              NODE_COMPILE_CACHE: "/tmp/nc",
              ...(hasSecret ? { GITHUB_TOKEN: secretVal, NPM_TOKEN: "npm_tok" } : {}),
              UNSET_VAR: undefined
            }
            const { short, withheld } = Restart.split(env, platform)
            if (hasSecret && withheld["GITHUB_TOKEN"] !== secretVal) return false
            if ("GITHUB_TOKEN" in short) return false

            const notH = Restart.notHidden
            const notHO = Restart.notHandedOver
            if (typeof notH !== "string" || typeof notHO !== "string") return false

            if (platform === "linux" && hasSecret) {
              const dir = mkdtempSync(join(tmpdir(), "ci-restart-fuzz-"))
              try {
                const pipe = await Restart.hand(withheld, { ...Restart.tools(), directory: dir })
                const got = Restart.taken(pipe, 5000)
                if (got["GITHUB_TOKEN"] !== secretVal) return false

                // Exercise Restart.own with fake execve running restarted.mjs
                const starts: Array<string> = []
                await Restart.own(
                  {
                    env,
                    platform: process.platform,
                    execPath: process.execPath,
                    execArgv: [],
                    argv: [process.execPath, restartedScript, "inventory"],
                    execve: (file, args, childEnv) => {
                      const ran = spawnSync(file, args.slice(1), { env: childEnv, encoding: "utf8" })
                      starts.push(ran.stdout)
                    }
                  },
                  (w) => Restart.hand(w, { ...Restart.tools(), directory: dir }),
                  () => {}
                )
                return starts.length === 1
              } finally {
                rmSync(dir, { recursive: true, force: true })
              }
            }
            return true
          }),
        { seed, executions: Math.min(executions, 10) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Cli.cli, Main.rootOf, Main.run & helper formatters handle all commands, flags & error codes", async () => {
    const repo = temporary("ci-cli-fuzz")
    const outDir = temporary("ci-cli-out")
    const fakeHome = temporary("ci-cli-home")
    try {
      cliGit(repo, "init", "--quiet", "--initial-branch=main")
      cliCommit(repo, "init", {
        ".github/workflows/ci.yml":
          "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
        "Justfile": "test:\n  echo ok\n"
      })
      writeFileSync(join(outDir, "placeholder"), "")

      const arb = Arbitrary.schema(
        Schema.Struct({
          cmd: Schema.Literals([
            "help",
            "version",
            "inventory",
            "inventory-json",
            "apply",
            "apply-check",
            "replay-default",
            "replay-fast-json",
            "replay-flags",
            "unknown-cmd",
            "bad-flag",
            "bad-commits"
          ]),
          failCode: Schema.Literals(["invalid-document", "unsupported", "command-failed", "model-unavailable"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ cmd, failCode }) =>
            Effect.promise(async () => {
              const failure: Failure = { code: failCode, message: "boom\nline2", part: "cli" }
              const code = Cli.exitCodeOf(failure)
              const line = Cli.lineOf(failure)
              const s = Cli.shown("hello\nworld")
              const inside = Cli.insideOf(posix, "sub/file.ts")
              const outside = Cli.insideOf(posix, "../outside")
              if (
                typeof code !== "number" || line.length === 0 || s.length === 0 || inside === undefined ||
                outside !== undefined
              ) {
                return false
              }

              const env = { HOME: fakeHome, PATH: process.env["PATH"] }
              const args: ReadonlyArray<string> = cmd === "help" ?
                ["--help"]
                : cmd === "version" ?
                ["--version"]
                : cmd === "inventory" ?
                ["inventory"]
                : cmd === "inventory-json" ?
                ["inventory", "--json"]
                : cmd === "apply" ?
                ["apply", "--no-apply-check"]
                : cmd === "apply-check" ?
                ["apply", "--check", "--no-apply-check"]
                : cmd === "replay-default" ?
                ["replay", "--commits", "1"]
                : cmd === "replay-fast-json" ?
                ["replay", "--commits", "1", "--mode", "fast", "--json", "--out", join(outDir, "r.html")]
                : cmd === "replay-flags" ?
                [
                  "replay",
                  "--commits",
                  "2",
                  "--jobs",
                  "2",
                  "--job",
                  "justfile:test",
                  "--targets",
                  "//...",
                  "--no-trial",
                  "--cold",
                  "--reruns",
                  "1",
                  "--stall-minutes",
                  "5",
                  "--allow-docker"
                ]
                : cmd === "unknown-cmd" ?
                ["nope"]
                : cmd === "bad-flag" ?
                ["inventory", "--unknown-flag"]
                : ["replay", "--commits", "0"]

              const sink = recorder()
              const exitCode = await inProcess(args, repo, cliParts, sink.service as never, env)

              const root = await Effect.runPromise(
                Main.rootOf(repo).pipe(Effect.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    Layer.succeed(Disk.DiskSpace, {
                      space: () => Effect.succeed({ total: 200 * DiskSpace.gigabyte, free: 100 * DiskSpace.gigabyte }),
                      held: () => Effect.succeed(0)
                    })
                  )
                ))
              )
              return typeof exitCode === "number" && root.length > 0
            }),
          { seed, executions: Math.min(executions, 14) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(outDir, { recursive: true, force: true })
      rmSync(fakeHome, { recursive: true, force: true })
    }
  }, 120_000)

  it(
    "NativeReplay.run replays a real repository with its own Smithers workspace targets across normal & fast modes",
    async () => {
      const repo = makeOwn()
      try {
        const said: Array<string> = []
        const host = Layer.mergeAll(
          Layer.succeed(Options, { smthrs: [smthrs], reruns: 1, prepare: () => Effect.void, confine: unconfined }),
          Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) }),
          Layer.succeed(Disk.DiskSpace, {
            space: () => Effect.succeed({ total: 200 * DiskSpace.gigabyte, free: 100 * DiskSpace.gigabyte }),
            held: () => Effect.succeed(0)
          }),
          NodeServices.layer
        )
        const nativeParts: ReplayParts<NativeReplay.Host> = {
          read: readInventory,
          files: () => Effect.fail({ code: "invalid-document", message: "nothing generated", part: "generate" }),
          rows: nativeRows,
          score: scoreKeeping("//:c", repo.commits[0]!)
        }
        const neverGeneric: import("../src/contract/Parts.vibe").RunReplay<NativeReplay.Host> = () =>
          Effect.fail<Failure>({ code: "invalid-document", message: "generic called", part: "replay" })

        const arb = Arbitrary.schema(
          Schema.Struct({
            commits: Schema.Literals([2]),
            includeFast: Schema.Literals([true])
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ commits, includeFast }) =>
              NativeReplay.run(neverGeneric)(
                {
                  root: repo.root,
                  commits,
                  modes: includeFast ? ["normal", "fast"] : ["normal"],
                  settings: { scoreCutoff: 0.5, countCutoff: 0 }
                },
                nativeParts
              ).pipe(
                Effect.map((res) => res.commits.length === commits),
                Effect.provide(host)
              ),
            { seed, executions: 1 }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        rmSync(repo.root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
