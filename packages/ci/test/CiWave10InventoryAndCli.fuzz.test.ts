import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Console, Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/cli/Cli.vibe"
import { ci as ciOf, type Inventory, type Job, type Step } from "../src/contract/Inventory.vibe"
import type { Failure } from "../src/contract/Parts.vibe"
import * as DecomposePlan from "../src/decompose/Plan.vibe"
import * as Split from "../src/decompose/Split.vibe"
import * as GithubActions from "../src/inventory/GithubActions.vibe"
import * as Justfile from "../src/inventory/Justfile.vibe"
import * as MachineChanges from "../src/inventory/MachineChanges.vibe"
import * as Makefile from "../src/inventory/Makefile.vibe"
import * as InventoryRead from "../src/inventory/Read.vibe"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261702")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

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

const makeInventory = (jobs: ReadonlyArray<Job>, unsupported?: Inventory["unsupported"]): Inventory => ({
  version: 1,
  repository: "w10/repo",
  commit: "0".repeat(40),
  toolchains: [],
  jobs,
  ...(unsupported === undefined ? {} : { unsupported })
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

describe("packages/ci Wave 10: Makefile, GithubActions, Justfile & MachineChanges deep fuzz", () => {
  it("fuzzes Makefile pattern rules, implicit/builtin rules, file-targets, missing prereqs, .DEFAULT_GOAL & recursive sub-make", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        useDefaultGoal: Schema.Boolean,
        includePattern: Schema.Boolean,
        includeImplicit: Schema.Boolean,
        includeSubMake: Schema.Boolean,
        includeMissing: Schema.Boolean,
        includeCycle: Schema.Boolean,
        quietFlag: Schema.Literals(["-s", "--silent", "--quiet", "--no-print-directory", ""])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const lines: Array<string> = []
            if (input.useDefaultGoal) lines.push(".DEFAULT_GOAL := custom")
            lines.push(".PHONY: all clean custom sub1 sub2")
            if (input.includePattern) {
              lines.push("%.o: %.c")
              lines.push("\tcc -c $< -o $@")
              lines.push("build/%.bin: src/%.c")
              lines.push("\tcc $< -o $@")
            }
            lines.push("filetarget: src/a.c | outdir")
            lines.push("\techo building filetarget")
            lines.push("implicit_only:")
            lines.push("custom: sub1 sub2")
            lines.push("\techo custom")
            lines.push("sub1: foo.o bar.out rcsfile sccsfile")
            lines.push("\techo sub1")
            lines.push("sub2:")
            if (input.includeSubMake) {
              lines.push(`\tmake ${input.quietFlag} custom`)
              lines.push(`\tmake ${input.quietFlag}`)
            } else {
              lines.push("\techo sub2")
            }
            if (input.includeMissing) {
              lines.push("broken: nonexistent.dep")
              lines.push("\techo broken")
            }
            if (input.includeCycle) {
              lines.push("cycA: cycB")
              lines.push("\techo a")
              lines.push("cycB: cycA")
              lines.push("\techo b")
            }
            lines.push("all: filetarget implicit_only sub1 sub2" + (input.includeMissing ? " broken" : "") + (input.includeCycle ? " cycA" : ""))
            lines.push("\techo done")

            const tracked = [
              "Makefile",
              "filetarget",
              "src/a.c",
              ...(input.includeImplicit
                ? ["foo.c", "bar", "RCS/rcsfile,v", "SCCS/s.sccsfile", "implicit_only.c"]
                : [])
            ]
            const parsed = Makefile.readMakefile("Makefile", lines.join("\n"), tracked)
            expect(parsed.jobs.length).toBeGreaterThanOrEqual(1)
            return true
          }),
        { executions: Math.min(executions, 40), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes GithubActions matrix include/exclude, container/services, defaults, reusable workflows, actions & expressions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        shell: Schema.Literals(["bash", "sh", "pwsh", "python", "zsh {0}"]),
        hasContainer: Schema.Boolean,
        hasServices: Schema.Boolean,
        hasMatrix: Schema.Boolean,
        hasReusable: Schema.Boolean,
        hasSecrets: Schema.Boolean,
        hasContinueOnError: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const yaml = [
              "name: Wave10 CI",
              "on:",
              "  push:",
              "    branches: [main]",
              "  pull_request:",
              "  workflow_dispatch:",
              "  schedule:",
              "    - cron: '0 0 * * *'",
              "defaults:",
              "  run:",
              `    shell: ${input.shell}`,
              "    working-directory: packages/app",
              "env:",
              "  CI: 'true'",
              "jobs:",
              ...(input.hasReusable
                ? [
                    "  call-reuse:",
                    "    uses: ./.github/workflows/sub.yml",
                    "    with:",
                    "      env: prod",
                    "    secrets: inherit"
                  ]
                : []),
              "  build:",
              "    runs-on: ${{ matrix.os || 'ubuntu-latest' }}",
              ...(input.hasContainer ? ["    container:", "      image: node:22", "      env:", "        NODE_ENV: test"] : []),
              ...(input.hasServices ? ["    services:", "      postgres:", "        image: postgres:16"] : []),
              ...(input.hasMatrix
                ? [
                    "    strategy:",
                    "      fail-fast: false",
                    "      matrix:",
                    "        os: [ubuntu-latest, macos-latest]",
                    "        node: [20, 22]",
                    "        include:",
                    "          - os: ubuntu-latest",
                    "            node: 22",
                    "            extra: yes",
                    "        exclude:",
                    "          - os: macos-latest",
                    "            node: 20"
                  ]
                : []),
              "    steps:",
              "      - uses: actions/checkout@v4",
              "        with:",
              "          fetch-depth: 0",
              "      - uses: actions/setup-node@v4",
              "        with:",
              "          node-version: '22'",
              "      - uses: actions/cache@v4",
              "        with:",
              "          path: ~/.cache",
              "          key: k-${{ hashFiles('**/package-lock.json') }}",
              "      - uses: actions/upload-artifact@v4",
              "        with:",
              "          name: dist",
              "          path: dist/",
              "      - uses: third-party/custom-action@v1",
              "      - name: test step",
              ...(input.hasContinueOnError ? ["        continue-on-error: true"] : []),
              "        if: success() && github.event_name == 'push'",
              "        env:",
              ...(input.hasSecrets ? ["          API_TOKEN: ${{ secrets.API_TOKEN }}"] : ["          MODE: fast"]),
              "        run: |",
              "          npm test",
              "          echo done"
            ].join("\n")

            const parsed = GithubActions.readWorkflow(".github/workflows/ci.yml", yaml, {})
            expect(parsed.jobs.length).toBeGreaterThanOrEqual(1)

            // Malformed & edge YAML shapes
            const bad = GithubActions.readWorkflow(".github/workflows/bad.yml", ":::not-yaml:::\n\t[")
            expect(bad).toBeDefined()
            const noJobs = GithubActions.readWorkflow(".github/workflows/empty.yml", "name: Empty\non: push\n")
            expect(noJobs.jobs).toEqual([])
            return true
          }),
        { executions: Math.min(executions, 35), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes Justfile attributes/shebang/settings & MachineChanges quoting/installs/questions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        host: Schema.Literals(["linux", "darwin", "win32"]),
        cmdKind: Schema.Literals([
          "apt",
          "brew",
          "apk",
          "pip",
          "cargo",
          "npm_g",
          "curl_sh",
          "docker_d",
          "systemd",
          "ansi_quote"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const jf = [
              'set shell := ["bash", "-cu"]',
              "set dotenv-load",
              'set working-directory := "sub"',
              'export FOO := "bar"',
              "ver := `echo 1`",
              "alias t := test",
              "",
              "[linux]",
              "[no-cd]",
              "build target='all' *args:",
              "  echo building {{target}} {{args}}",
              "",
              "[macos]",
              "shebang-job:",
              "  #!/usr/bin/env bash",
              "  set -euo pipefail",
              "  echo hi",
              "",
              "test: (build 'debug')",
              "  npm test"
            ].join("\n")
            const parsedJust = Justfile.readJustfile("justfile", jf, input.host)
            expect(parsedJust.jobs.length).toBeGreaterThanOrEqual(1)

            // MachineChanges quoting & command classification
            expect(MachineChanges.ansiQuoteEnd("$'hello\\'world\\\\' rest", 0)).toBeGreaterThan(0)
            expect(MachineChanges.ansiQuoteEnd("$'unterminated", 0)).toBe(14)
            expect(MachineChanges.closingOf("$(echo (a) 'b')", 1, false)).toBeGreaterThan(0)
            expect(typeof MachineChanges.closingOf("$(unterminated", 1, false)).toBe("number")

            const cmdMap: Record<string, string> = {
              apt: "sudo apt-get update && sudo apt-get install -y jq curl",
              brew: "brew install ripgrep fd",
              apk: "apk add --no-cache git bash",
              pip: "pip install --user ruff black",
              cargo: "cargo install just",
              npm_g: "npm install -g typescript",
              curl_sh: "curl -fsSL https://example.com/install.sh | sh",
              docker_d: "docker run -d --name db postgres:16",
              systemd: "sudo systemctl start redis",
              ansi_quote: "echo $'a\\nb' && $(echo ok)"
            }
            const cmd = cmdMap[input.cmdKind]!
            const ch = MachineChanges.changesIn(cmd)
            const st = MachineChanges.startedIn(cmd)
            const inst = MachineChanges.installsOf(cmd)
            expect(Array.isArray(ch)).toBe(true)
            expect(Array.isArray(st)).toBe(true)
            if (inst !== undefined) {
              for (const item of inst) {
                for (const pkg of item.packages) {
                  const q = MachineChanges.questionFor(item.manager, pkg)
                  if (q !== undefined) {
                    expect(typeof MachineChanges.answers(q, "installed ok\n")).toBe("boolean")
                  }
                }
              }
            }
            const job = MachineChanges.markChanges(makeJob("j1", [makeStep("s1", cmd)]))
            const inv: Inventory = makeInventory([job])
            const qs = MachineChanges.questionsFor(inv, () => true)
            expect(Array.isArray(qs)).toBe(true)
            const updated = MachineChanges.withInstalled(inv, () => true, () => true)
            expect(updated.jobs.length).toBe(1)
            expect(MachineChanges.listed(["a", "b", "c"])).toContain("a")
            return true
          }),
        { executions: Math.min(executions, 35), seed: seed + 3 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("packages/ci Wave 10: Split, Decompose Plan, InventoryRead & Cli", () => {
  it("exercises Split.splitWith (symlinks, binary, lockfile, chained scripts, turbo, zig) & InventoryRead.read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w10-ci-split-"))
    const outside = mkdtempSync(join(tmpdir(), "w10-ci-outside-"))
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir })
      execFileSync("git", ["config", "user.email", "w10@test.local"], { cwd: dir })
      execFileSync("git", ["config", "user.name", "W10"], { cwd: dir })
      mkdirSync(join(dir, "packages", "a", "src"), { recursive: true })
      mkdirSync(join(dir, "packages", "b", "src"), { recursive: true })
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true })
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "root",
          private: true,
          workspaces: ["packages/*"],
          scripts: {
            check: "pnpm -r test && pnpm -r build",
            single: "vitest run"
          }
        })
      )
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n")
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
      writeFileSync(join(dir, "turbo.json"), JSON.stringify({ tasks: { test: { dependsOn: ["^build"] }, build: {} } }))
      writeFileSync(
        join(dir, "packages", "a", "package.json"),
        JSON.stringify({ name: "@w10/a", scripts: { test: "vitest", build: "tsc" } })
      )
      writeFileSync(
        join(dir, "packages", "b", "package.json"),
        JSON.stringify({ name: "@w10/b", dependencies: { "@w10/a": "workspace:*" }, scripts: { test: "vitest", build: "tsc" } })
      )
      writeFileSync(join(dir, "packages", "a", "src", "index.ts"), "export const a = 1\n")
      writeFileSync(join(dir, "packages", "b", "src", "index.ts"), 'import { a } from "@w10/a"\nexport const b = a + 1\n')
      // Binary file with null byte
      writeFileSync(join(dir, "packages", "a", "src", "blob.dat"), Buffer.from([0, 1, 2, 3, 0, 4]))
      // Valid internal symlink & escaping symlink
      symlinkSync(join(dir, "packages", "a", "src", "index.ts"), join(dir, "packages", "a", "src", "link.ts"))
      writeFileSync(join(outside, "ext.ts"), "export const ext = 1\n")
      symlinkSync(join(outside, "ext.ts"), join(dir, "packages", "a", "src", "escape.ts"))
      // Workflow + Makefile + justfile for InventoryRead.read
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm run check\n      - run: zig build test\n"
      )
      writeFileSync(join(dir, "Makefile"), ".PHONY: test\ntest:\n\techo ok\n")
      writeFileSync(join(dir, "justfile"), "test:\n  echo ok\n")
      execFileSync("git", ["add", "."], { cwd: dir })
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir })

      const readInv = await runNode(InventoryRead.read(dir))
      expect(readInv.jobs.length).toBeGreaterThanOrEqual(1)

      const splitInv = await runNode(Split.splitWith()(dir, ciOf(readInv)))
      expect(splitInv.jobs.length).toBeGreaterThanOrEqual(1)

      // DecomposePlan helpers across command forms
      const cmds = [
        "pnpm -r test",
        "npm run test",
        "yarn workspace @w10/a test",
        "bun test",
        "cargo test --workspace",
        "go test ./...",
        "pytest tests/",
        "zig build test",
        "sh -c 'vitest run'"
      ]
      for (const c of cmds) {
        const u = DecomposePlan.understand(makeStep("s", c), undefined)
        if (u !== undefined) {
          expect(DecomposePlan.keepCommand(u)).toBeDefined()
        }
        DecomposePlan.zigStep(c.split(" "))
      }
      expect(DecomposePlan.followed(readInv.jobs)).toBeDefined()
      expect(DecomposePlan.preceded(readInv.jobs)).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  }, 60_000)

  it("exercises Cli.cli default/replay/inventory/apply, symlink --out refusal, uncommitted warning & exitCodeOf", async () => {
    const codes: ReadonlyArray<Failure["code"]> = [
      "not-a-repository",
      "unsupported",
      "command-failed",
      "model-unavailable",
      "invalid-document"
    ]
    for (const code of codes) {
      const f: Failure = { code, message: `msg-${code}`, part: "cli" }
      expect(typeof Cli.exitCodeOf(f)).toBe("number")
      expect(Cli.lineOf(f)).toContain(`msg-${code}`)
    }
    expect(Cli.shown("hello\nworld")).toBeDefined()
    expect(Cli.cacheUrlOf("https://cache.example.com")).toBeDefined()
    expect(Cli.cacheUrlOf("not a url")).toBeUndefined()

    const dir = mkdtempSync(join(tmpdir(), "w10-ci-cli-"))
    const outTarget = join(dir, "real-out.html")
    const outLink = join(dir, "link-out.html")
    writeFileSync(outTarget, "")
    symlinkSync(outTarget, outLink)

    const logs: Array<string> = []
    const silentConsole = Layer.succeed(Console.Console, {
      log: (...args: ReadonlyArray<unknown>) => Effect.sync(() => { logs.push(args.map(String).join(" ")) }),
      error: (...args: ReadonlyArray<unknown>) => Effect.sync(() => { logs.push(args.map(String).join(" ")) }),
      warn: () => Effect.void,
      info: () => Effect.void,
      debug: () => Effect.void,
      trace: () => Effect.void,
      assert: () => Effect.void,
      clear: Effect.void,
      count: () => Effect.void,
      countReset: () => Effect.void,
      dir: () => Effect.void,
      dirxml: () => Effect.void,
      group: () => Effect.void,
      groupEnd: Effect.void,
      table: () => Effect.void,
      time: () => Effect.void,
      timeEnd: () => Effect.void,
      timeLog: () => Effect.void,
      unsafe: console
    } as unknown as Console.Console)

    const fakeReport = {
      version: 1 as const,
      repository: dir,
      commits: [],
      jobs: { total: 1, covered: 1, left: [] },
      asked: { total: 1, ran: 1, skipped: 0 },
      flaky: 0,
      fastFlaky: 0,
      commitsLeft: [],
      reruns: 0,
      diskHeldBytes: 0,
      runnerSteps: 1,
      stepsLeftOut: 0
    }

    const baseJob = makeJob("build", [makeStep("s1", "echo ok")])
    const baseInv: Inventory = makeInventory([baseJob])
    const cliParts: Cli.Parts<never> = {
      read: () => Effect.succeed(baseInv),
      decompose: (_root, inv) => Effect.succeed(inv),
      files: () => Effect.succeed([{ path: ".smithers/WORKSPACE.smithers", content: "// gen\n" }]),
      run: () => Effect.succeed(fakeReport as never),
      text: () => "TEXT REPORT",
      html: () => "<html>REPORT</html>",
      rows: () => Effect.succeed([]),
      score: () => Effect.succeed([])
    }

    const layer = Layer.mergeAll(
      NodeServices.layer,
      silentConsole,
      Layer.succeed(Cli.RunningUser, { isRoot: () => false })
    ) as Layer.Layer<any, never, never>

    try {
      // 1. inventory text & json
      await Effect.runPromise(Cli.cli(["inventory"], dir, cliParts).pipe(Effect.provide(layer)))
      await Effect.runPromise(Cli.cli(["inventory", "--json"], dir, cliParts).pipe(Effect.provide(layer)))

      // 2. replay with valid --out & --json & uncommitted warning
      const uncommittedParts: Cli.Parts<never> = {
        ...cliParts,
        read: () =>
          Effect.succeed(makeInventory([baseJob], [{ feature: "uncommitted-changes", detail: "dirty" }]))
      }
      const htmlPath = join(dir, "report.html")
      await Effect.runPromise(
        Cli.cli(["replay", "--commits", "1", "--out", htmlPath], dir, uncommittedParts).pipe(Effect.provide(layer))
      )
      await Effect.runPromise(
        Cli.cli(["replay", "--commits", "1", "--json"], dir, cliParts).pipe(Effect.provide(layer))
      )

      // 3. replay with symlink --out -> refused cleanly!
      const linkExit = await Effect.runPromiseExit(
        Cli.cli(["replay", "--commits", "1", "--out", outLink], dir, cliParts).pipe(Effect.provide(layer))
      )
      expect(Exit.isFailure(linkExit) || (Exit.isSuccess(linkExit) && linkExit.value !== 0)).toBe(true)

      // 4. default command (normal repo)
      await Effect.runPromise(Cli.cli(["--commits", "1"], dir, cliParts).pipe(Effect.provide(layer)))

      // 5. default command when every job changes the machine (applies === false)
      const machineJob = MachineChanges.markChanges(makeJob("sys", [makeStep("s1", "sudo apt-get install -y jq")]))
      const machineParts: Cli.Parts<never> = {
        ...cliParts,
        read: () => Effect.succeed(makeInventory([machineJob]))
      }
      await Effect.runPromise(Cli.cli(["--commits", "1"], dir, machineParts).pipe(Effect.provide(layer)))

      // 6. apply command
      await Effect.runPromise(Cli.cli(["apply"], dir, cliParts).pipe(Effect.provide(layer)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
