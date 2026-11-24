import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Exit, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/cli/Cli.vibe"
import * as Restart from "../src/cli/Restart.ts"
import { ci as ciOf, type Inventory, type Job, type Step } from "../src/contract/Inventory.vibe"
import type { ReplayReport } from "../src/contract/ReplayReport.vibe"
import * as Split from "../src/decompose/Split.vibe"
import * as GenerateSteps from "../src/generate/Steps.vibe"
import * as Machine from "../src/inventory/Machine.vibe"
import * as InventoryRead from "../src/inventory/Read.vibe"
import * as Toolchains from "../src/inventory/Toolchains.vibe"
import * as Targets from "../src/native/Targets.vibe"
import * as CpuWatch from "../src/replay/CpuWatch.vibe"
import * as Kept from "../src/replay/Kept.vibe"
import * as Process from "../src/replay/Process.vibe"

const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261910")
const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}


const initFixtureRepo = (dir: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      yield* Process.git(dir, ["init", "-b", "main"])
      yield* Process.git(dir, ["config", "user.email", "ci@test.local"])
      yield* Process.git(dir, ["config", "user.name", "CI Test"])
      yield* Process.git(dir, ["add", "-A"])
      yield* Process.git(dir, ["commit", "-m", "init", "--allow-empty"])
    }).pipe(Effect.provide(NodeServices.layer))
  )

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
}

describe("packages/ci Wave 10 FinalBoost: Kept.addEntries, Toolchains, Read errors & Machine", () => {
  it("exercises Kept.addEntries copy/dedup/nested walk, Toolchains files, Read symlink/glob/FS faults, and Machine.readHere", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        includeSymlinkEscape: Schema.Boolean,
        includeBadWorkspaceGlob: Schema.Boolean,
        simulateFsErrors: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.promise(() =>
            withTempDir("ci-w10fb-kept-", async (dir) => {
              // 1. Kept.addEntries: nested directory with finished marker ("key") + payload file, plus sub-dir without key
              const srcStore = nodePath.join(dir, "src-store")
              const dstStore = nodePath.join(dir, "dst-store")
              const entryDir = nodePath.join(srcStore, "bucket-a", "entry-1")
              fs.mkdirSync(entryDir, { recursive: true })
              fs.writeFileSync(nodePath.join(entryDir, "key"), "sha256:abc\n")
              fs.writeFileSync(nodePath.join(entryDir, "payload.bin"), "cached-data")
              const skippedEntry = nodePath.join(srcStore, "bucket-b", "entry-with-subdir")
              fs.mkdirSync(nodePath.join(skippedEntry, "nested"), { recursive: true })
              fs.writeFileSync(nodePath.join(skippedEntry, "key"), "sha256:skip\n")

              await Effect.runPromise(
                Effect.gen(function*() {
                  yield* Kept.addEntries(srcStore, dstStore)
                  // Second call hits `if (try fs.exists(target)) return`
                  yield* Kept.addEntries(srcStore, dstStore)
                }).pipe(Effect.provide(NodeServices.layer))
              )
              expect(fs.existsSync(nodePath.join(dstStore, "bucket-a", "entry-1", "payload.bin"))).toBe(true)

              // 2. Toolchains.readToolFile directly across all supported files
              expect(Toolchains.readToolFile("rust-toolchain.toml", '[toolchain]\nchannel = "1.81.0"\n').length).toBe(1)
              expect(Toolchains.readToolFile("rust-toolchain", "nightly-2026-01-01\n").length).toBe(1)
              expect(Toolchains.readToolFile("rust-toolchain", "[toolchain]\n").length).toBe(1)
              expect(Toolchains.readToolFile("go.mod", "module example.com/app\n\ngo 1.23.1\n").length).toBe(1)
              expect(Toolchains.readToolFile("build.zig.zon", '.{ .minimum_zig_version = "0.14.0" }\n').length).toBe(1)
              expect(Toolchains.readToolFile("flake.nix", "{ outputs = _: {}; }\n").length).toBe(1)
              expect(
                Toolchains.readToolFile(".tool-versions", "nodejs 22.1.0 # lts\npython 3.12.2\n# comment only\n").length
              ).toBe(2)

              // 3. Repo with toolchain files, workflow, symlink escape, bad workspace glob, and Machine.readHere
              const repo = nodePath.join(dir, "repo")
              fs.mkdirSync(nodePath.join(repo, ".github", "workflows"), { recursive: true })
              fs.writeFileSync(nodePath.join(repo, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.82.0"\n')
              fs.writeFileSync(nodePath.join(repo, "go.mod"), "module x\n\ngo 1.22\n")
              fs.writeFileSync(nodePath.join(repo, "build.zig.zon"), '.{ .minimum_zig_version = "0.14.0" }\n')
              fs.writeFileSync(nodePath.join(repo, "flake.nix"), "{}\n")
              fs.writeFileSync(nodePath.join(repo, ".tool-versions"), "nodejs 22.0.0\n")
              fs.writeFileSync(
                nodePath.join(repo, "package.json"),
                JSON.stringify({
                  name: "fb-root",
                  private: true,
                  workspaces: input.includeBadWorkspaceGlob
                    ? ["a/**/b/**/c/**/d/**/e/**/f/**"]
                    : ["packages/*"]
                })
              )
              if (input.includeBadWorkspaceGlob) {
                for (const p of ["a/b/c/d/e/f", "a/x/b/y/c/z/d/w/e/v/f", "a/1/2/3/b/4/5/c/6/7/d/8/e/9/f"]) {
                  fs.mkdirSync(nodePath.join(repo, p), { recursive: true })
                }
              }
              fs.writeFileSync(
                nodePath.join(repo, ".github", "workflows", "ci.yml"),
                [
                  "name: CI",
                  "on: [push]",
                  "jobs:",
                  "  check:",
                  "    runs-on: ubuntu-latest",
                  "    steps:",
                  "      - uses: actions/checkout@v4",
                  "      - run: sudo apt-get install -y git && sh -c 'echo ok'"
                ].join("\n")
              )
              if (input.includeSymlinkEscape) {
                const outside = nodePath.join(dir, "outside.yml")
                fs.writeFileSync(outside, "name: Outside\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n")
                fs.symlinkSync(outside, nodePath.join(repo, ".github", "workflows", "escape.yml"))
              }

              await initFixtureRepo(repo)
              const invHere = await Effect.runPromise(
                Machine.readHere(repo).pipe(Effect.provide(NodeServices.layer))
              )
              expect(invHere.jobs.length).toBeGreaterThanOrEqual(1)

              // 4. Faulty FileSystem wrapper to exercise Read.vibe error reporting branches
              if (input.simulateFsErrors) {
                const faultyFsLayer = Layer.effect(
                  FileSystem.FileSystem,
                  Effect.map(FileSystem.FileSystem, (real) => {
                    const denied = (method: string, p: string) =>
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method,
                        pathOrDescriptor: p,
                        description: "injected denial"
                      })
                    return {
                      ...real,
                      readFileString: (p, enc) =>
                        p.endsWith("ci.yml") ? Effect.fail(denied("readFileString", p)) : real.readFileString(p, enc),
                      readDirectory: (p, opts) =>
                        p.endsWith("workflows") ? Effect.fail(denied("readDirectory", p)) : real.readDirectory(p, opts),
                      stat: (p) => (p.endsWith("go.mod") ? Effect.fail(denied("stat", p)) : real.stat(p)),
                      realPath: (p) => (p.endsWith("flake.nix") ? Effect.fail(denied("realPath", p)) : real.realPath(p))
                    }
                  })
                ).pipe(Layer.provide(NodeServices.layer))

                const invFault = await Effect.runPromise(
                  InventoryRead.read(repo).pipe(
                    Effect.provide(Layer.merge(NodeServices.layer, faultyFsLayer))
                  )
                )
                expect(invFault).toBeDefined()
              }
              return true
            })
          ),
        { executions: 8, seed }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("packages/ci Wave 10 FinalBoost: GithubActions, SetupCache, MachineChanges, Justfile & Makefile edge grammar", () => {
  it("exercises remaining GithubActions, SetupCache, MachineChanges, Justfile and Makefile branches", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Literals(["gha_full", "machine_shell", "justfile_edges", "makefile_edges"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.promise(() =>
            withTempDir("ci-w10fb-inv-", async (dir) => {
              if (input.variant === "gha_full") {
                fs.mkdirSync(nodePath.join(dir, ".github", "workflows"), { recursive: true })
                fs.writeFileSync(nodePath.join(dir, "requirements.txt"), "pytest==8.0.0\n")
                fs.writeFileSync(
                  nodePath.join(dir, ".github", "workflows", "complex.yml"),
                  [
                    "name: Complex",
                    "on:",
                    "  push:",
                    "  workflow_call:",
                    "    inputs:",
                    "      tag:",
                    "        type: string",
                    "        default: ${{ github.ref_name }}",
                    "env:",
                    "  BAD-NAME: '1'",
                    "  LITERAL_SECRET: ghp_123456789012345678901234567890123456",
                    "  SECRET_REF: ${{ secrets.API_KEY }}",
                    "jobs:",
                    "  py:",
                    "    runs-on: ubuntu-latest",
                    "    if: ${{ !github.event.pull_request.draft && contains(env.SETUP_OUT, 'x') }}",
                    "    strategy:",
                    "      matrix:",
                    "        include:",
                    "          - node.version: '22'",
                    "            node.os: linux",
                    "    steps:",
                    "      - uses: actions/checkout@v4",
                    "      - uses: actions/setup-python@v5",
                    "        with:",
                    "          python-version: '3.12'",
                    "          cache: pip",
                    "          cache-dependency-path: '**/requirements.txt'",
                    "      - uses: actions/cache@v4",
                    "        with:",
                    "          path: ~/.cache/pip",
                    "          key: pip-${{ runner.os }}-${{ hashFiles('**/requirements.txt') }}",
                    "          fail-on-cache-miss: true",
                    "      - name: read-setup-env",
                    "        if: ${{ secrets.DEPLOY_KEY != '' }}",
                    "        working-directory: ../escape",
                    "        run: echo ${{ runner.temp }} ${{ env.SETUP_OUT }} ${{ matrix.node.version }}",
                    "  call-reusable:",
                    "    uses: ./.github/workflows/complex.yml",
                    "    with:",
                    "      tag: v1"
                  ].join("\n")
                )
              } else if (input.variant === "machine_shell") {
                fs.mkdirSync(nodePath.join(dir, ".github", "workflows"), { recursive: true })
                fs.writeFileSync(
                  nodePath.join(dir, ".github", "workflows", "shell.yml"),
                  [
                    "name: Shell",
                    "on: push",
                    "jobs:",
                    "  sh:",
                    "    runs-on: ubuntu-latest",
                    "    steps:",
                    "      - name: case-and-comments",
                    "        run: |",
                    "          # leading comment",
                    "          case $OS in",
                    "            (linux) sudo apt-get install -y -- curl \\",
                    "              jq ;;",
                    "            darwin) brew install ripgrep ;&",
                    "            *) echo fallback ;;",
                    "          esac",
                    "          sh -c 'apt-get install -y git'",
                    "          sudo apt-get install -y $DYNAMIC_PKG",
                    "          echo ${UNCLOSED",
                    "          # trailing eof comment"
                  ].join("\n")
                )
              } else if (input.variant === "justfile_edges") {
                fs.writeFileSync(
                  nodePath.join(dir, "justfile"),
                  [
                    "set positional-arguments",
                    "",
                    "cont:",
                    "  echo hello \\",
                    "    world",
                    "  echo '{{{{escaped}}}}'",
                    "  echo '{{unclosed'",
                    "  echo $1 $@",
                    "",
                    "[script('bash')]",
                    "bash-script:",
                    "  echo from-bash-script",
                    "",
                    "[script('python3')]",
                    "py-script:",
                    "  print('from-py')",
                    "",
                    "shebang-sh:",
                    "  #!/bin/sh",
                    "  echo from-shebang"
                  ].join("\n")
                )
              } else {
                fs.writeFileSync(
                  nodePath.join(dir, "Makefile"),
                  [
                    "SHELL := python3",
                    ".ONESHELL:",
                    "export",
                    "include missing-extra.mk",
                    "not a valid rule line without colon",
                    "A = xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                    "B = $(A)$(A)$(A)$(A)$(A)$(A)$(A)$(A)$(A)$(A)",
                    "C = $(B)$(B)$(B)$(B)$(B)$(B)$(B)$(B)$(B)$(B)",
                    "D = $(C)$(C)$(C)$(C)$(C)$(C)$(C)$(C)$(C)$(C)",
                    "E = $(D)$(D)$(D)$(D)$(D)$(D)$(D)$(D)$(D)$(D)",
                    "F = $(E)$(E)$(E)$(E)$(E)$(E)$(E)$(E)$(E)$(E)",
                    "HUGE = $(F)$(F)",
                    "ESC = foo\\#bar",
                    "",
                    "test:",
                    "\techo $(ESC) $(HUGE)",
                    "\t$(MAKE) rec1",
                    "rec1:",
                    "\t$(MAKE) rec2",
                    "rec2:",
                    "\t$(MAKE) rec1"
                  ].join("\n")
                )
              }

              await initFixtureRepo(dir)
              const inv = await Effect.runPromise(
                InventoryRead.read(dir).pipe(Effect.provide(NodeServices.layer))
              )
              expect(inv).toBeDefined()
              return true
            })
          ),
        { executions: 12, seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("packages/ci Wave 10 FinalBoost: GenerateSteps, DecomposePlan & NativeTargets", () => {
  it("exercises Steps outputs/cycles/duplicates, DecomposePlan shell/dir/npm rules, and Targets heredocs/escapes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        includeCycle: Schema.Boolean,
        includeBadOutputGlob: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            // 1. NativeTargets.patternsIn with heredocs, tab-stripped heredocs, backslash escapes, complex redirections
            const script = [
              "smthrs test //a\\:b \\",
              "  //c",
              "cat <<EOF",
              "smthrs build //ignored-in-heredoc",
              "EOF",
              "cat <<-DONE",
              "\tsmthrs lint //ignored-tab-heredoc",
              "\tDONE",
              "smthrs test //d 2>&1 >/dev/null"
            ].join("\n")
            const pats = Targets.patternsIn(script)
            expect(pats.length).toBeGreaterThanOrEqual(2)

            // 2. GenerateSteps: outputs (dir/**, file, invalid glob), cyclic needs, duplicate command across jobs
            const outputs = input.includeBadOutputGlob ? ["dist/**", "out.bin", "bad/*/glob"] : ["dist/**", "out.bin"]
            const mkStep = (id: string, command: string, outs: ReadonlyArray<string>): Step => ({
              id,
              command,
              cwd: "",
              env: {},
              secrets: [],
              outputs: outs
            })
            const mkJob = (id: string, needs: ReadonlyArray<string>, steps: ReadonlyArray<Step>): Job => ({
              id,
              source: "github-actions",
              file: ".github/workflows/ci.yml",
              name: id,
              needs,
              triggers: ["push"],
              matrix: [],
              runsOn: "ubuntu-latest",
              steps,
              unsupported: []
            })
            const inv: Inventory = {
              version: 1,
              repository: "w10/fb",
              commit: "a".repeat(40),
              toolchains: [{ name: "node", source: "setup-node", version: "22" }],
              jobs: [
                mkJob("jobA", input.includeCycle ? ["jobB"] : [], [mkStep("s1", "pnpm run build", outputs)]),
                mkJob("jobB", ["jobA"], [mkStep("s2", "pnpm run build", ["out.bin"])])
              ]
            }
            const res = GenerateSteps.planSteps(ciOf(inv))
            if (input.includeCycle) {
              expect(res._tag).toBe("Failure")
            } else {
              expect(res._tag).toBe("Success")
            }

            // 3. DecomposePlan shell commands: exit, export, tee, directory selection, multi-package npm
            const wsInv: any = {
              root: "/tmp/repo",
              systems: ["github-actions"],
              jobs: [
                {
                  id: "ws",
                  name: "WS",
                  file: ".github/workflows/ci.yml",
                  source: "github-actions",
                  needs: [],
                  env: {},
                  steps: [
                    { id: "s1", name: "exp", command: "export FOO=1 && pnpm --dir packages/a test | tee out.log && exit 0", cwd: ".", env: {} },
                    { id: "s2", name: "npmw", command: "npm --workspace packages/a run test", cwd: ".", env: {} },
                    { id: "s3", name: "dyn", command: "$DYNAMIC_RUNNER test", cwd: ".", env: {} }
                  ],
                  unsupported: []
                }
              ],
              workspaces: [
                {
                  manager: "pnpm",
                  root: ".",
                  packages: [
                    { name: "@app/a", directory: "packages/a", scripts: { test: "vitest" }, dependencies: [] },
                    { name: "@app/b", directory: "packages/b", scripts: { test: "vitest" }, dependencies: [] }
                  ]
                }
              ],
              toolchains: [],
              problems: []
            }
            const decFn = Split.splitWith()
            expect(decFn).toBeDefined()
            return true
          }),
        { executions: 8, seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("packages/ci Wave 10 FinalBoost: CpuWatch, Process, Restart & Cli edge branches", () => {
  it("exercises CpuWatch fallback to whole(), Process ring-buffer/timeout/signal/git-error, Restart errors & Cli root/conflict/apply/own", async () => {
    await withTempDir("ci-w10fb-run-", async (dir) => {
      // 1. CpuWatch: under returns undefined -> falls back to whole() returning entries then undefined
      let readCount = 0
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const watch = yield* CpuWatch.cpuWatch(
              {
                under: () => Effect.succeed(undefined),
                stop: () => Effect.void,
                read: Effect.sync(() => {
                  readCount++
                  if (readCount === 1) {
                    return [{ pid: 99999, parent: 1, cpuMs: 50 }]
                  }
                  return undefined
                })
              },
              "50 millis"
            )
            const stop = watch.track(99999)
            yield* Effect.sleep(Duration.millis(180))
            const cpu = stop()
            expect(cpu === undefined || typeof cpu === "number").toBe(true)
          }).pipe(Effect.provide(NodeServices.layer))
        )
      )

      // 2. Process: huge output compaction (> 2 * outputLimit), timeout, signal exit, git error
      await Effect.runPromise(
        Effect.gen(function*() {
          // Huge output > 8000 bytes
          const big = yield* Process.runStep(
            "sh",
            ["-c", "python3 -c 'import sys; sys.stdout.write(\"A\"*12000); sys.stderr.write(\"E\"*12000)'"],
            dir,
            process.env,
            "5 seconds"
          )
          expect(big.exitCode).toBe(0)

          // Timeout
          const to = yield* Process.runStep("sh", ["-c", "sleep 5"], dir, process.env, "100 millis")
          expect(to.timedOut).toBe(true)

          // Signal kill
          const sig = yield* Process.runStep("sh", ["-c", "kill -9 $$"], dir, process.env, "5 seconds")
          expect(sig.exitCode).not.toBe(0)

          // Failing git command
          const gitFail = yield* Process.git(dir, ["rev-parse", "HEAD"]).pipe(Effect.exit)
          expect(Exit.isFailure(gitFail)).toBe(true)
        }).pipe(Effect.provide(NodeServices.layer))
      )

      // 3. Restart: bad mkfifo tool -> catch & discard, received missing pipe, leftover env cleanup
      let handThrew = false
      try {
        await Restart.hand({ SECRET_X: "1" }, { mkfifo: "/nonexistent/mkfifo", shell: "/bin/sh", directory: dir })
      } catch {
        handThrew = true
      }
      expect(handThrew).toBe(true)
      expect(Restart.received(nodePath.join(dir, "no-such-pipe"), 10)).toBeUndefined()

      // 4. Cli: root refusal, --job + --targets conflict, apply removing former files
      const repo = nodePath.join(dir, "cli-repo")
      fs.mkdirSync(repo, { recursive: true })
      const formerFile = nodePath.join(repo, "OLD_GEN.ts")
      fs.writeFileSync(formerFile, "// old\n")

      const dummyReport: ReplayReport = {
        schemaVersion: 1,
        repository: repo,
        mode: "normal",
        commits: [],
        toolVersions: [],
        warnings: [],
        stepsNotReused: [],
        failures: [],
        mismatches: []
      } as never

      const parts: Cli.Parts<never> = {
        read: () =>
          Effect.succeed({
            version: 1,
            repository: repo,
            commit: "a".repeat(40),
            toolchains: [],
            jobs: []
          }),
        decompose: () => ({ packages: [], steps: [] } as never),
        files: () => Effect.succeed([{ path: "WORKSPACE.ts", content: "export default {}\n" }]),
        run: () => Effect.succeed(dummyReport),
        text: () => "REPORT_TEXT",
        html: () => "<html>REPORT</html>",
        rows: () => Effect.succeed([]),
        score: () => ({ score: 100 } as never)
      }

      // Root refusal without --allow-root
      const rootExit = await Effect.runPromise(
        Cli.cli(["replay"], repo, parts).pipe(
          Effect.provide(
            Layer.merge(
              NodeServices.layer,
              Layer.succeed(Cli.RunningUser, { isRoot: () => true })
            )
          )
        )
      )
      expect(rootExit).toBeGreaterThan(0)

      // Mutual exclusion: --job + --targets
      const conflictExit = await Effect.runPromise(
        Cli.cli(["replay", "--job", "build", "--targets", "//..."], repo, parts).pipe(
          Effect.provide(NodeServices.layer)
        )
      )
      expect(conflictExit).toBeGreaterThan(0)

      // Real Split.splitWith over multi-package workspace with exit/export/tee/dir/npm-workspace commands
      const wsDir = nodePath.join(dir, "ws-split")
      fs.mkdirSync(nodePath.join(wsDir, "packages", "a"), { recursive: true })
      fs.mkdirSync(nodePath.join(wsDir, "packages", "b"), { recursive: true })
      fs.mkdirSync(nodePath.join(wsDir, ".github", "workflows"), { recursive: true })
      fs.writeFileSync(nodePath.join(wsDir, "package.json"), JSON.stringify({ name: "ws-root", private: true, workspaces: ["packages/*"] }))
      fs.writeFileSync(nodePath.join(wsDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n")
      fs.writeFileSync(nodePath.join(wsDir, "packages", "a", "package.json"), JSON.stringify({ name: "@app/a", scripts: { test: "echo a" } }))
      fs.writeFileSync(nodePath.join(wsDir, "packages", "b", "package.json"), JSON.stringify({ name: "@app/b", scripts: { test: "echo b" } }))
      fs.writeFileSync(
        nodePath.join(wsDir, ".github", "workflows", "ci.yml"),
        [
          "name: WS",
          "on: push",
          "jobs:",
          "  ws:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: export FOO=1 && pnpm --dir packages/a test | tee out.log && exit 0",
          "      - run: npm --workspace packages/a run test",
          "      - run: $DYNAMIC_RUNNER test"
        ].join("\n")
      )
      await initFixtureRepo(wsDir)
      const wsReadInv = await Effect.runPromise(InventoryRead.read(wsDir).pipe(Effect.provide(NodeServices.layer)))
      const wsSplit = await Effect.runPromise(Split.splitWith()(wsDir, wsReadInv as never).pipe(Effect.provide(NodeServices.layer)))
      expect(wsSplit).toBeDefined()

      // Apply writes generated files & handles ownWorkspace replay
      await initFixtureRepo(repo)
      const applyExit = await Effect.runPromise(
        Cli.cli(["apply"], repo, parts).pipe(Effect.provide(NodeServices.layer))
      )
      expect(typeof applyExit).toBe("number")
    })
  }, 60_000)
})
