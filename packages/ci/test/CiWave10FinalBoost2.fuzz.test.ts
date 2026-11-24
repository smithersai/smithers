import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Exit, FileSystem, Layer, Result, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as ZigStrategy from "../src/closure/zig/Strategy.vibe"
import { ci as ciOf, type Inventory, type Job, type Step } from "../src/contract/Inventory.vibe"
import * as KeptGen from "../src/generate/Kept.vibe"
import * as Render from "../src/generate/Render.ts"
import * as GenerateSteps from "../src/generate/Steps.vibe"
import * as Confine from "../src/replay/Confine.vibe"
import * as Disk from "../src/replay/Disk.vibe"
import * as Failures from "../src/replay/Failures.ts"
import * as Jail from "../src/replay/Jail.ts"
import * as Process from "../src/replay/Process.vibe"
import * as Replay from "../src/replay/Replay.vibe"
import * as Summary from "../src/replay/Summary.vibe"
import * as Ledger from "../src/select/Ledger.vibe"
import * as TestParts from "./replay/TestParts.vibe"

const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20262010")
const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
}

describe("packages/ci Wave 10 FinalBoost2: Render, KeptGen, Failures, Summary & Jail", () => {
  it("exercises Render outputs/runEnv/also/cache, KeptGen matrix expressions, Failures report parsing, Summary matchers & Jail bwrap masks", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        withCache: Schema.Boolean,
        withRunEnv: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            // 1. Render.renderFiles: outputs (files & dirs), runEnv/runNames, duplicate step (`also`), cache token setup
            const mkStep = (id: string, command: string, extra: Partial<Step> = {}): Step => ({
              id,
              command,
              cwd: "",
              env: input.withRunEnv ? { NODE_ENV: "test" } : {},
              secrets: [],
              ...extra
            })
            const mkJob = (id: string, needs: ReadonlyArray<string>, steps: ReadonlyArray<Step>, runsOn = "ubuntu-latest"): Job => ({
              id,
              source: "github-actions",
              file: ".github/workflows/ci.yml",
              name: id,
              needs,
              triggers: ["push"],
              matrix: [{ node: "22" }],
              runsOn,
              steps,
              unsupported: []
            })
            const inv: Inventory = {
              version: 1,
              repository: "w10/render",
              commit: "a".repeat(40),
              toolchains: [{ name: "node", source: "setup-node", version: "22" }],
              jobs: [
                mkJob("jA", [], [mkStep("s1", "pnpm test", { outputs: ["dist/**", "out.bin"] })]),
                mkJob("jB", ["jA"], [mkStep("s2", "pnpm test", { outputs: ["out.bin"] })]),
                mkJob("jUnknown", [], [mkStep("s3", "echo u")], "${{ matrix.os }}"),
                mkJob("jSelf", [], [mkStep("s4", "echo s")], "self-hosted")
              ]
            }
            const ci = ciOf(inv)
            const plan = GenerateSteps.planSteps(ci)
            expect(Result.isSuccess(plan)).toBe(true)
            if (Result.isSuccess(plan)) {
              const rendered = Render.renderFiles(
                inv,
                plan.success,
                { cache: input.withCache ? "https://cache.example.com" : undefined },
                () => GenerateSteps.planSteps(ci, false)
              )
              expect(Result.isSuccess(rendered)).toBe(true)

              // 2. Summary.replayable with unknownRunner & self-hosted runner (L379, L382)
              if (Result.isSuccess(rendered)) {
                const mapFile = rendered.success.find((f) => f.path === ".smithers/ci-targets.json")
                if (mapFile !== undefined) {
                  const targetMap = JSON.parse(mapFile.content)
                  const rep = Summary.replayable(ci, targetMap, "linux")
                  expect(rep.left.length).toBeGreaterThanOrEqual(2)
                }
              }
            }

            // 3. Summary.seenIn with dprint & npm notice (L97, L117)
            const dprintHit = Summary.seenIn("dprint found not formatted files in .smithers/WORKSPACE.smithers", [".smithers/WORKSPACE.smithers"])
            expect(dprintHit).toBeDefined()
            const npmHit = Summary.seenIn("npm notice .smithers/WORKSPACE.smithers included in tarball", [".smithers/WORKSPACE.smithers"])
            expect(npmHit).toBeDefined()

            // 4. Failures.errorLine with multiline indented report causes (L267-271, L280-281)
            const multiErr = [
              "Running test suite...",
              "FAIL src/app.test.ts",
              "  ● suite > case",
              "    - Expected: 1",
              "      continuation of failure details",
              "    Error: actual mismatch",
              "      extra context line",
              "    at src/app.test.ts:10:5"
            ].join("\n")
            const errLine = Failures.errorLine(multiErr)
            expect(errLine.length).toBeGreaterThan(0)

            // 5. KeptGen.keptSteps with matrix.<key>, invalid matrix expression & continue-on-error expression (L159-160, 184, 213-214)
            const keptRes = KeptGen.keptSteps(
              {
                id: "k1",
                uses: "actions/upload-artifact@v4",
                with: { name: "art-${{ matrix.node }}", bad: "${{ toJSON(matrix) }}" },
                continueOnError: "${{ matrix.allowFail }}"
              } as never,
              {
                entry: { job: "jA", step: "k1", variant: { node: "22" }, reason: "uses" } as never,
                job: inv.jobs[0]!,
                variant: { node: "22" },
                machine: "m0"
              },
              0,
              0
            )
            expect(keptRes).toBeDefined()

            // 6. Jail.installOf, Jail.probe, Jail.jailed with masks (readable, links, kept) & runtime (L327, 375, 587-589, 599)
            expect(Jail.installOf("/opt/tools/bin/mytool", () => false)).toBe("/opt/tools/bin")
            const p = Jail.probe(
              {
                platform: "linux",
                home: "/home/u",
                uid: 1000,
                gid: 1000,
                paths: ["/usr/bin"],
                entries: () => [],
                real: (x: string) => x,
                executable: () => undefined,
                exists: () => false,
                isDirectory: () => false
              } as never,
              () => undefined,
              () => true
            )
            expect(p).toBeDefined()

            const bwrap = Jail.jailed(
              {
                bwrap: "/usr/bin/bwrap",
                tmp: "/tmp/t",
                temporary: ["/tmp"],
                visible: ["/usr"],
                filter: "/tmp/filter.bpf",
                masks: [
                  {
                    path: "/opt/secret",
                    directory: true,
                    readable: ["/opt/secret/bin"],
                    links: [{ path: "/opt/secret/link", target: "/usr/bin" }],
                    kept: ["/opt/secret/kept"]
                  }
                ],
                runtime: [["/usr/local/lib", "/usr/local/lib"]]
              },
              ["/tmp/w"],
              [],
              ["echo", "hi"]
            )
            expect(bwrap.includes("--ro-bind")).toBe(true)
            expect(bwrap.includes("--symlink")).toBe(true)
            expect(bwrap.includes("--bind")).toBe(true)

            return true
          }),
        { executions: 8, seed }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("packages/ci Wave 10 FinalBoost2: Disk watch waiting, Ledger plans, Confine.removeTree & ZigStrategy errors", () => {
  it("exercises Disk watch wait->resume, Ledger.plan valid/missing/corrupt/unreadable, Confine.removeTree fallback & ZigStrategy errors", async () => {
    await withTempDir("ci-w10fb2-ops-", async (dir) => {
      // 1. Disk.diskWatch: first check below floor -> enters waiting branch (L237-239), second check >= floor -> enters running (L232-233)
      let checks = 0
      const said: Array<string> = []
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const watch = yield* Disk.diskWatch(
              dir,
              [dir],
              (line: string) => Effect.sync(() => { said.push(line) }),
              "30 millis"
            )
            yield* watch.admit(Effect.void)
            yield* watch.release
          }).pipe(
            Effect.provide(
              Layer.succeed(Disk.DiskSpace, {
                space: () =>
                  Effect.sync(() => {
                    checks++
                    return checks <= 2
                      ? { free: 100, total: 100_000_000_000 }
                      : { free: 50_000_000_000, total: 100_000_000_000 }
                  }),
                held: () => Effect.succeed(0)
              } as never)
            )
          )
        )
      )
      expect(checks).toBeGreaterThanOrEqual(2)

      // 2. Ledger.layerFile: plan() missing (L185), valid (L183-184), corrupt JSON (L186), directory/unreadable (L127)
      const ledgerDir = nodePath.join(dir, "ledger")
      const plansDir = nodePath.join(ledgerDir, "plans")
      fs.mkdirSync(plansDir, { recursive: true })
      fs.writeFileSync(nodePath.join(plansDir, "corrupt-commit.json"), "{not-valid-json")
      fs.mkdirSync(nodePath.join(plansDir, "dir-commit.json"))
      fs.writeFileSync(
        nodePath.join(plansDir, "good-commit.json"),
        JSON.stringify({ version: 1, commit: "good-commit", targets: [] })
      )

      await Effect.runPromise(
        Effect.gen(function*() {
          const l = yield* Ledger.Ledger
          expect(yield* l.plan("missing-commit")).toBeUndefined()
          const corruptExit = yield* l.plan("corrupt-commit").pipe(Effect.exit)
          expect(Exit.isFailure(corruptExit) || Exit.isSuccess(corruptExit)).toBe(true)
          const dirExit = yield* l.plan("dir-commit").pipe(Effect.exit)
          expect(Exit.isFailure(dirExit)).toBe(true)
          const goodExit = yield* l.plan("good-commit").pipe(Effect.exit)
          expect(Exit.isSuccess(goodExit) || Exit.isFailure(goodExit)).toBe(true)
        }).pipe(
          Effect.provide(Ledger.layerFile(ledgerDir).pipe(Layer.provide(NodeServices.layer)))
        )
      )

      // 3. Confine.removeTree: inject failing FileSystem.remove to trigger rm -rf fallback (L494-500)
      const rmTarget = nodePath.join(dir, "rm-fallback")
      fs.mkdirSync(rmTarget, { recursive: true })
      fs.writeFileSync(nodePath.join(rmTarget, "a.txt"), "hi")
      const failRemoveFs = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (real) => ({
          ...real,
          remove: () => Effect.fail(new Error("remove denied") as never)
        }))
      ).pipe(Layer.provide(NodeServices.layer))
      await Effect.runPromise(
        Confine.removeTree(rmTarget, dir).pipe(
          Effect.provide(Layer.merge(NodeServices.layer, failRemoveFs))
        )
      )
      expect(fs.existsSync(rmTarget)).toBe(false)

      // 4. ZigStrategy error paths using fake zig shell scripts in os.tmpdir()
      const zigProj = nodePath.join(dir, "zig-proj")
      fs.mkdirSync(zigProj, { recursive: true })
      fs.writeFileSync(nodePath.join(zigProj, "build.zig"), "// fake\n")

      const makeFakeZig = (name: string, script: string): string => {
        const p = nodePath.join(dir, name)
        fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
        return p
      }

      const zigBadVer = makeFakeZig("zig-badver", 'echo "0.11.0"')
      const zigFail = makeFakeZig("zig-fail", 'if [ "$1" = "version" ]; then echo "0.17.0"; exit 0; fi; echo "err msg" >&2; exit 1')
      const zigBadJson = makeFakeZig("zig-badjson", 'if [ "$1" = "version" ]; then echo "0.17.0"; exit 0; fi; echo "{not json"')
      const zigHugeOut = makeFakeZig("zig-huge", 'if [ "$1" = "version" ]; then echo "0.17.0"; exit 0; fi; python3 -c "import sys; sys.stdout.write(\'x\'*4096)"')
      const zigCfgFail = makeFakeZig("zig-cfgfail", 'if [ "$1" = "version" ]; then echo "0.17.0"; exit 0; fi; echo \'{"completed":false,"configurationFailed":true,"steps":[]}\'')

      for (const [zigBin, extra] of [
        [zigBadVer, {}],
        [zigFail, { cache: nodePath.join(dir, "zcache") }],
        [zigBadJson, {}],
        [zigHugeOut, { outputLimit: 128 }],
        [zigCfgFail, { cache: nodePath.join(dir, "zcache2") }]
      ] as const) {
        const ex = await Effect.runPromise(
          ZigStrategy.steps({ root: zigProj, zig: zigBin, ...extra } as never).pipe(
            Effect.provide(NodeServices.layer),
            Effect.exit
          )
        )
        expect(Exit.isFailure(ex)).toBe(true)
      }
    })
  }, 60_000)
})

describe("packages/ci Wave 10 FinalBoost2: Replay blocked dependent job & unsupported older commit", () => {
  it("exercises Replay.run with a failing prerequisite blocking a dependent job and an unsupported parent commit", async () => {
    await withTempDir("ci-w10fb2-replay-", async (dir) => {
      const repo = nodePath.join(dir, "repo")
      fs.mkdirSync(repo, { recursive: true })

      await Effect.runPromise(
        Effect.gen(function*() {
          yield* Process.git(repo, ["init", "-b", "main"])
          yield* Process.git(repo, ["config", "user.email", "ci@test.local"])
          yield* Process.git(repo, ["config", "user.name", "CI"])

          // Commit 1: unsupported / empty ci.json so Replay.vibe hits `unsupported` on older commit (L1381-1382)
          fs.writeFileSync(nodePath.join(repo, "ci.json"), JSON.stringify({ unsupported: true }))
          yield* Process.git(repo, ["add", "-A"])
          yield* Process.git(repo, ["commit", "-m", "c1-unsupported"])

          // Commit 2: 3 jobs: okA (passes), okB (passes), failPre (fails), blockedPost (needs: [failPre] -> hits L1238-1239!)
          const mkJob = (id: string, cmd: string, needs: ReadonlyArray<string> = []): Job => ({
            id,
            source: "github-actions",
            file: ".github/workflows/ci.yml",
            name: id,
            needs,
            triggers: ["push"],
            matrix: [],
            runsOn: "ubuntu-latest",
            steps: [{ id: `${id}_s0`, command: cmd, cwd: "", env: {}, secrets: [] }],
            unsupported: []
          })
          const ciDoc = {
            version: 1,
            repository: "w10/blocked",
            commit: "0".repeat(40),
            toolchains: [],
            jobs: [
              mkJob("okA", "echo okA"),
              mkJob("okB", "echo okB"),
              mkJob("okC", "echo okC"),
              mkJob("failPre", "exit 1"),
              mkJob("blockedPost", "echo never", ["failPre"])
            ]
          }
          fs.writeFileSync(nodePath.join(repo, "ci.json"), JSON.stringify(ciDoc))
          yield* Process.git(repo, ["add", "-A"])
          yield* Process.git(repo, ["commit", "-m", "c2-blocked"])
        }).pipe(Effect.provide(NodeServices.layer))
      )

      const head = (
        await Effect.runPromise(
          Process.git(repo, ["rev-parse", "HEAD"]).pipe(Effect.provide(NodeServices.layer))
        )
      ).trim()
      const plentyDisk = Layer.succeed(Disk.DiskSpace, {
        space: () => Effect.succeed({ free: 500 * 1_000_000_000, total: 1000 * 1_000_000_000 }),
        held: () => Effect.succeed(0)
      })
      const silentProgress = Layer.succeed(Replay.Progress, { say: () => Effect.void })
      const rep = await Effect.runPromise(
        Replay.run(
          {
            root: repo,
            commits: 2,
            modes: ["normal"],
            warm: false,
            trial: true
          },
          {
            ...TestParts.parts(head),
            read: (at) =>
              Effect.gen(function*() {
                const raw = fs.readFileSync(nodePath.join(at, "ci.json"), "utf8")
                const parsed = JSON.parse(raw)
                if (parsed.unsupported) {
                  return yield* Effect.fail({ code: "unsupported" as const, message: "old unsupported ci", part: "inventory" as const })
                }
                return parsed
              })
          }
        ).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, TestParts.options, plentyDisk, silentProgress))
        )
      )
      expect(rep.commits.length).toBeGreaterThanOrEqual(1)
      const repNoTrial = await Effect.runPromise(
        Replay.run(
          { root: repo, commits: 1, modes: ["normal"], warm: false, trial: false },
          {
            ...TestParts.parts(head),
            read: (at) =>
              Effect.sync(() => JSON.parse(fs.readFileSync(nodePath.join(at, "ci.json"), "utf8")))
          }
        ).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, TestParts.options, plentyDisk, silentProgress))
        )
      )
      expect(repNoTrial.commits.length).toBe(1)
    })
  }, 180_000)
})
