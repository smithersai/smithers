import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CiToolchain from "../src/CiToolchain.ts"
import * as GithubCiGen from "../src/GithubCiGen.ts"
import * as GithubWorkflow from "../src/GithubWorkflow.ts"
import * as Input from "../src/Input.ts"
import * as Nix from "../src/Nix.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Secret from "../src/Secret.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as Verb from "../src/Verb.ts"
import { packageManager, runtime } from "./toolchain.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const baseToolchain = (): CiToolchain.Toolchain =>
  CiToolchain.Needs({ runtimes: [CiToolchain.Node({ release: "26.4.0" })] })

const baseJob = (overrides: Partial<GithubCiGen.Job> = {}): GithubCiGen.Job => ({
  id: "ci",
  runsOn: "ubuntu-latest",
  toolchain: baseToolchain(),
  steps: [{ name: "CI", verb: Verb.Ci, pattern: "//..." }],
  ...overrides
})

const baseAttrs = (overrides: Partial<GithubCiGen.Attrs> = {}): GithubCiGen.Attrs => ({
  output: ".github/workflows/ci.yml",
  workflowName: "CI",
  mode: "write",
  pushBranches: ["main"],
  pullRequest: true,
  workflowDispatch: false,
  packageManager,
  requiredJobs: ["ci"],
  gates: [],
  jobs: [baseJob()],
  ...overrides
} as GithubCiGen.Attrs)

describe("@smthrs/targets Wave-7A: GithubWorkflow parser/shell scanner, GithubCiGen render/validation & Shell schema filters", () => {
  it("GithubWorkflow.parseWorkflow refuses every malformed YAML/trigger/job/step/needs shape with WorkflowParseError", async () => {
    const cases: ReadonlyArray<{ readonly yaml: string; readonly reason: GithubWorkflow.WorkflowParseReason }> = [
      // Too large (> 1 MiB)
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: " + "x".repeat(GithubWorkflow.maximumWorkflowBytes + 32), reason: "too_large" },
      // Non-scalar mapping key
      { yaml: "on: push\njobs:\n  [a, b]:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "unsupported" },
      // Top-level scalar
      { yaml: "just-a-scalar\n", reason: "invalid_shape" },
      // Top-level sequence
      { yaml: "- item\n", reason: "invalid_shape" },
      // Missing on
      { yaml: "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "missing" },
      // Missing jobs
      { yaml: "on: push\n", reason: "missing" },
      // Jobs is a sequence
      { yaml: "on: push\njobs:\n  - a\n", reason: "invalid_shape" },
      // Duplicate job id
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo 1\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo 2\n", reason: "duplicate" },
      // Invalid event name shape
      { yaml: "on: 123-bad!\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "invalid_shape" },
      // Duplicate event in trigger map
      { yaml: "on:\n  push:\n  push:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "duplicate" },
      // Duplicate event in trigger sequence
      { yaml: "on: [push, push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "duplicate" },
      // Empty trigger sequence
      { yaml: "on: []\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "missing" },
      // Empty trigger scalar
      { yaml: "on: \"\"\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "missing" },
      // Job value is sequence
      { yaml: "on: push\njobs:\n  a:\n    - bad\n", reason: "invalid_shape" },
      // Job value is scalar
      { yaml: "on: push\njobs:\n  a: scalar\n", reason: "invalid_shape" },
      // Invalid job id
      { yaml: "on: push\njobs:\n  \"99bad!\":\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "invalid_shape" },
      // Duplicate key in job
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "duplicate" },
      // Inherited << merge in job
      { yaml: "on: push\njobs:\n  a:\n    \"<<\": foo\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "unsupported" },
      // Non-sequence steps
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: echo ok\n", reason: "invalid_shape" },
      // Reusable job with empty uses
      { yaml: "on: push\njobs:\n  a:\n    uses: \"   \"\n", reason: "invalid_shape" },
      // Reusable job with runs-on
      { yaml: "on: push\njobs:\n  a:\n    uses: org/repo/.github/workflows/x.yml@main\n    runs-on: ubuntu-latest\n", reason: "invalid_shape" },
      // Reusable job with steps
      { yaml: "on: push\njobs:\n  a:\n    uses: org/repo/.github/workflows/x.yml@main\n    steps:\n      - run: echo ok\n", reason: "invalid_shape" },
      // Missing runs-on
      { yaml: "on: push\njobs:\n  a:\n    steps:\n      - run: echo ok\n", reason: "missing" },
      // Missing steps
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n", reason: "missing" },
      // Step is not a mapping
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - not-a-map\n", reason: "invalid_shape" },
      // Duplicate key in step
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo 1\n        run: echo 2\n", reason: "duplicate" },
      // YAML merge << in step
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - \"<<\": x\n        run: echo 1\n", reason: "unsupported" },
      // Step declares both uses and run
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        run: echo 1\n", reason: "invalid_shape" },
      // Step declares neither uses nor run
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: empty\n", reason: "invalid_shape" },
      // Step declares empty run
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: \"   \"\n", reason: "invalid_shape" },
      // Step declares empty uses
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: \"   \"\n", reason: "invalid_shape" },
      // Step declares empty shell
      { yaml: "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n        shell: \"  \"\n", reason: "invalid_shape" },
      // Invalid needs scalar
      { yaml: "on: push\njobs:\n  a:\n    needs: 123\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "invalid_shape" },
      // Empty needs sequence
      { yaml: "on: push\njobs:\n  a:\n    needs: []\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n", reason: "invalid_shape" }
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: cases.length - 1 }))
      })
    )
    for (const c of cases) { expect(() => GithubWorkflow.parseWorkflow(c.yaml)).toThrow() }
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.sync(() => {
            const c = cases[idx]!
            let caught: unknown
            try {
              GithubWorkflow.parseWorkflow(c.yaml)
            } catch (err) {
              caught = err
            }
            expect(caught).toBeInstanceOf(GithubWorkflow.WorkflowParseError)
            const parseErr = caught as GithubWorkflow.WorkflowParseError
            expect(parseErr.reason).toBe(c.reason)
            expect(parseErr.message).toContain(`line ${parseErr.line}:`); return true
          }),
        { executions: Math.max(executions, cases.length * 3), seed }
      )
    )
    assertPassed(report)
  })

  it("GithubWorkflow shell scanner handles case/esac, POSIX bracket classes, nested $(), heredocs, backslash continuations & install flags", async () => {
    const scripts = [
      // Case with bracket expressions ([!a], []a], [:alpha:], [=a=], [.ch.], escaped ], quotes, $(), nested (), ;;, ;&, ;;&, esac)
      "case \"$x\" in\n  [!0-9]|[]a]|[[:alpha:]]|[=a=]|[.ch.]|[a\\]b]|lit|\"dq\"|$(echo hi)|@(a|b))\n    pnpm exec smthrs test //...\n    ;;\n  (foo)\n    echo hi\n    ;&\n  bar)\n    echo next\n    ;;&\n  esac\n  echo after",
      // Case inside $() inside parens (balancedEnd with body=true)
      "arr=( $(case \"$y\" in\n  a) echo 1 ;;\n  b) echo 2 ;&\n  esac\n  cat <<EOF\ninside heredoc\nEOF\n  echo \\; still-arg\n  echo line\\\ncontinued\n  (nested)\n) )\npnpm exec smthrs build //...",
      // Unterminated case pattern and unclosed bracket expression
      "case $z in\n  [[:digit:",
      "case $z in\n  unterminated pattern without paren",
      // Backslash continuation & escaped separator at top level
      "pnpm install --frozen-lockfile \\\n  --ignore-scripts && \\\necho \\; not-a-command\n",
      // Case with unclosed $() inside balancedEnd
      "foo=( $(echo unclosed",
      // Function with heredoc and subshell
      "helper() (\n  cat <<EOF\n  pnpm install --frozen-lockfile\nEOF\n  echo \\x\n)\npnpm exec smthrs lint //...",
      // Case with empty esac
      "case $v in esac\npnpm exec smthrs ci //..."
    ]

    const installCases = [
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm install --frozen-lockfile \\\n  --prefer-offline",
      "pnpm install --frozen-lockfile --reporter=append-only",
      "pnpm install --frozen-lockfile --bad-flag",
      "pnpm install --frozen-lockfile --reporter=bad$val",
      "bun install --frozen-lockfile --ignore-scripts",
      "npm ci --ignore-scripts",
      "echo not-an-install"
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        sIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: scripts.length - 1 })),
        iIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: installCases.length - 1 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ sIdx, iIdx }) =>
          Effect.sync(() => {
            const script = scripts[sIdx]!
            const spans = GithubWorkflow.commandSpans(script)
            const starts = GithubWorkflow.commandStarts(script)
            expect(starts.length).toBe(spans.length)
            for (const span of spans) {
              expect(span.start).toBeGreaterThanOrEqual(0)
              expect(span.end).toBeGreaterThanOrEqual(span.start)
              expect(span.end).toBeLessThanOrEqual(script.length)
            }
            const inst = installCases[iIdx]!
            const detected = GithubWorkflow.supportedInstallOf(inst)
            expect(GithubWorkflow.isSupportedInstall(inst)).toBe(detected !== undefined); return true
          }),
        { executions: Math.max(executions, 80), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("GithubCiGen.render, stepCommand, artifactSteps, toolchainSteps & attrsForKind cover all validation refusals and publishing/matrix/nix/cargo branches", async () => {
    const readSecret = Secret.Secret("SMTHRS_CACHE_TOKEN")
    const urlSecret = Secret.Secret("SMTHRS_CACHE_URL")
    const writeSecret = Secret.Secret("SMTHRS_CACHE_WRITE_TOKEN")
    const nixSub = Secret.Secret("NIX_SUBSTITUTER")
    const nixKey = Secret.Secret("NIX_PUBLIC_KEY")

    const errorCases: ReadonlyArray<() => unknown> = [
      // render top-level errors
      () => GithubCiGen.render(baseAttrs({ jobs: [] })),
      () => GithubCiGen.render(baseAttrs({ pushBranches: [], pullRequest: false, workflowDispatch: false })),
      () => GithubCiGen.render(baseAttrs({ concurrency: "bogus" as unknown as "ref" })),
      () => GithubCiGen.render(baseAttrs({ gates: [{ name: "missing-gate", verb: Verb.Lint, pattern: "//other:lint" }] })),
      () => GithubCiGen.render(baseAttrs({ requiredJobs: ["ci", "ghost"] })),
      // scalar control char / GitHub expression / bad runner
      () => GithubCiGen.render(baseAttrs({ workflowName: "bad\u0007name" })),
      () => GithubCiGen.render(baseAttrs({ pushBranches: ["${{ github.ref }}"] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ runsOn: "[self-hosted, bad label]" })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ runsOn: "{group: g}" })] })),
      // stepCommand errors
      () => GithubCiGen.stepCommand(baseAttrs(), { name: "Review", verb: Verb.Review, pattern: "//..." }),
      () => GithubCiGen.stepCommand(baseAttrs(), { name: "CI", verb: Verb.Ci, pattern: "//..." }, { installer: "determinate", environment: { flake: "/bad/abs", attr: "default" } as unknown as Nix.Environment }),
      // validateJobRunners errors
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ matrixNameSuffix: "os" })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ runsOn: undefined, shards: 2, matrix: [{ os: "ubuntu-latest", advisory: false }] })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ runsOn: undefined, matrix: undefined })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ runsOn: "ubuntu-latest", matrix: [{ os: "ubuntu-latest", advisory: false }] })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ runsOn: undefined, continueOnError: true, matrix: [{ os: "ubuntu-latest", advisory: false }] })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ runsOn: undefined, matrix: [] })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ runsOn: undefined, matrix: [{ os: "bad runner!", advisory: false }] })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ runsOn: undefined, matrix: [{ os: "ubuntu-latest", advisory: false }, { os: "ubuntu-latest", advisory: true }] })] })),
      // validatePublishing errors
      () => GithubCiGen.render(baseAttrs({ cacheWriteRepository: "org/repo" })),
      () => GithubCiGen.render(baseAttrs({ cacheWriteEnvironment: "cache-writer" })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ publishesToCache: true })] })),
      () => GithubCiGen.render(baseAttrs({ cacheWriteTokenSecret: writeSecret, cacheWriteRepository: "org/repo", cacheWriteEnvironment: "cache-writer" })),
      () => GithubCiGen.render(baseAttrs({ cacheWriteTokenSecret: writeSecret, cacheWriteRepository: "not-a-repo", cacheWriteEnvironment: "cache-writer", jobs: [baseJob({ publishesToCache: true })] })),
      () => GithubCiGen.render(baseAttrs({ cacheWriteTokenSecret: writeSecret, cacheWriteRepository: "org/repo", cacheWriteEnvironment: "bad env!", jobs: [baseJob({ publishesToCache: true })] })),
      () => GithubCiGen.render(baseAttrs({ cacheTokenSecret: writeSecret, cacheWriteTokenSecret: writeSecret, cacheWriteRepository: "org/repo", cacheWriteEnvironment: "cache-writer", jobs: [baseJob({ publishesToCache: true })] })),
      () => GithubCiGen.render(baseAttrs({ cacheUrlSecret: writeSecret, cacheWriteTokenSecret: writeSecret, cacheWriteRepository: "org/repo", cacheWriteEnvironment: "cache-writer", jobs: [baseJob({ publishesToCache: true })] })),
      () => GithubCiGen.render(baseAttrs({ pushBranches: [], pullRequest: true, cacheWriteTokenSecret: writeSecret, cacheWriteRepository: "org/repo", cacheWriteEnvironment: "cache-writer", jobs: [baseJob({ publishesToCache: true })] })),
      () => GithubCiGen.render(baseAttrs({ pushBranches: ["main*"], cacheWriteTokenSecret: writeSecret, cacheWriteRepository: "org/repo", cacheWriteEnvironment: "cache-writer", jobs: [baseJob({ publishesToCache: true })] })),
      // validateJobs errors
      () => GithubCiGen.render(baseAttrs({ requiredJobs: ["ci"], jobs: [baseJob({ continueOnError: true })] })),
      () => GithubCiGen.render(baseAttrs({ requiredJobs: [], jobs: [baseJob({ id: "99bad!" })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ id: "ci" }), baseJob({ id: "ci" })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ steps: [] })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ toolchain: { ...baseToolchain(), install: false } })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ timeoutMinutes: 0 })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ timeoutMinutes: 999 })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ steps: [{ name: "Dup", verb: Verb.Ci, pattern: "//...", additionalPatterns: ["//..."] }] })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ steps: [{ name: "BadPat", verb: Verb.Ci, pattern: "not-a-pattern" }] })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ steps: [{ name: "BadVerb", verb: "run" as unknown as typeof Verb.Ci, pattern: "//..." }] })] })),
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ steps: [{ name: "BadPar", verb: Verb.Ci, pattern: "//...", parallelism: 0 }] })] })),
      () => GithubCiGen.render(baseAttrs({ knownRed: "../escape.json" })),
      // Bad diagnostic text in preflight
      () => GithubCiGen.render(baseAttrs({ jobs: [baseJob({ toolchain: { ...baseToolchain(), rust: { toolchain: "1.82.0" as never, cache: true } }, steps: [{ name: "CI", verb: Verb.Ci, pattern: "//..." }] })] }))
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        errIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: errorCases.length - 1 })),
        installer: Schema.Literals(["determinate", "cachix"]),
        pkgMgr: Schema.Literals(["pnpm", "bun"]),
        requiredArt: Schema.Boolean,
        globArt: Schema.Boolean
      })
    )

    for (let i = 0; i < errorCases.length - 1; i++) {
      expect(() => errorCases[i]!()).toThrow()
    }
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ errIdx, installer, pkgMgr, requiredArt, globArt }) =>
          Effect.sync(() => {
            if (errIdx < errorCases.length - 1) {
              expect(() => errorCases[errIdx]!()).toThrow()
            } else {
              // Happy paths: publishing + shards + cache secrets + nix (determinate & cachix) + cargoBinaries + uv + continueOnError + artifactSteps
              const yaml = GithubCiGen.render(
                baseAttrs({
                  packageManager: pkgMgr === "pnpm" ? packageManager : PackageManager.BunPackages({ runtime: Runtime.Bun({ version: "1.2.0" }) }),
                  cacheUrlSecret: urlSecret,
                  cacheTokenSecret: readSecret,
                  cacheWriteTokenSecret: writeSecret,
                  cacheWriteRepository: "smithersai/smithers",
                  cacheWriteEnvironment: "cache-writer",
                  requiredJobs: ["ci"],
                  results: true,
                  knownRed: "ci/known-red.json",
                  jobs: [
                    baseJob({
                      id: "ci",
                      runsOn: "[self-hosted, linux]",
                      shards: 2,
                      publishesToCache: true,
                      timeoutMinutes: 30,
                      toolchain: CiToolchain.Needs({
                        runtimes: [pkgMgr === "pnpm" ? CiToolchain.Node({ release: "26.4.0" }) : CiToolchain.Bun({ release: "1.4.1" })],
                        rust: CiToolchain.Rust({ cache: true }),
                        cargoBinaries: [
                          { package: "smthrs-obs", binary: "smthrs-obs", toolchain: "1.98.0", environment: "SMTHRS_OBS", platforms: ["linux", "darwin", "win32"] }
                        ],
                        uv: { release: "0.8.22" }
                      }),
                      steps: [{ name: "CI", verb: Verb.Ci, pattern: "//...", parallelism: 4 }]
                    }),
                    baseJob({
                      id: "adv",
                      runsOn: "ubuntu-latest",
                      continueOnError: true,
                      toolchain: CiToolchain.Needs({
                        nix: {
                          installer,
                          environment: Nix.Environment({ flake: Input.file("flake.nix"), lock: Input.file("flake.lock"), attr: "default" }),
                          substituter: nixSub,
                          publicKey: nixKey
                        }
                      }),
                      steps: [{ name: "Lint", verb: Verb.Lint, pattern: "//..." }]
                    })
                  ]
                })
              )
              expect(yaml).toContain("SMTHRS_CACHE_WRITE_TOKEN")
              expect(yaml).toContain("SMTHRS_CACHE_URL")
              expect(yaml).toContain("cache-writer")
              expect(yaml).toContain("Install uv")
              expect(yaml).toContain("Install native smthrs-obs")
              expect(yaml).toContain("continue-on-error: true")

              const art = GithubCiGen.artifactSteps(CiToolchain.Artifacts({
                artifact: "reports",
                sources: [{ from: globArt ? "out/*.log" : "out/report.json", as: "dest", required: requiredArt }]
              }))
              expect(art.length).toBe(2)

              // Exercise attrsForKind("lint", writeAttrs) -> mode becomes "check"
              const targetInst = GithubCiGen.GithubCiGen(baseAttrs({ mode: "write" }))
              const meta = Target.metadata(targetInst)
              const forLint = meta.forKind("lint").attrs as GithubCiGen.Attrs
              expect(forLint.mode).toBe("check")
              const forBuild = meta.forKind("build").attrs as GithubCiGen.Attrs
              expect(forBuild.mode).toBe("write")
            }
            return true
          }),
        { executions: Math.max(executions, errorCases.length * 3), seed: seed + 2 }
      )
    )
    assertPassed(report)
  })

  it("Shell.BuildAttrs & Shell.TestAttrs schema filters reject every invalid selector/machine/observe/shards/given combination", async () => {
    const buildBadCases: ReadonlyArray<Record<string, unknown>> = [
      // 0 executable selectors
      { cache: false },
      // 2 executable selectors
      { shell: "echo ok", bin: "echo", cache: false },
      // shell with args
      { shell: "echo ok", args: ["a"], cache: false },
      // shell with runtimeArgs
      { shell: "echo ok", runtimeArgs: ["--x"], cache: false },
      // shell with using
      { shell: "echo ok", using: "bun", cache: false },
      // bun with args
      { bun: "index.ts", args: ["a"], cache: false },
      // bun with runtimeArgs
      { bun: "index.ts", runtimeArgs: ["--x"], cache: false },
      // using without bun
      { bin: "node", using: "bun", cache: false },
      // script with runtimeArgs
      { script: "run.sh", runtimeArgs: ["--x"], cache: false },
      // env overlapping inheritEnv
      { shell: "echo ok", env: { FOO: "1" }, inheritEnv: ["FOO"], cache: false },
      // cache true with no outDirs/outFiles
      { shell: "echo ok", cache: true },
      // machine with sandbox != none
      { shell: "echo ok", machine: "builder", sandbox: "strict", cache: false },
      // machine with cache != false
      { shell: "echo ok", machine: "builder", sandbox: "none", outFiles: ["a.txt"], cache: true }
    ]

    const testBadCases: ReadonlyArray<Record<string, unknown>> = [
      // machine with sandbox != none
      { shell: "echo ok", machine: "runner", sandbox: "strict" },
      // machine with shards > 1
      { shell: "echo ok", machine: "runner", sandbox: "none", shards: 2 },
      // machine with services
      { shell: "echo ok", machine: "runner", sandbox: "none", services: [{ name: "db", label: "//:db" }] },
      // observe with sandbox != none
      { shell: "echo ok", observe: true, sandbox: "strict" },
      // observe with shards > 1
      { shell: "echo ok", observe: true, sandbox: "none", shards: 2 },
      // observe with services
      { shell: "echo ok", observe: true, sandbox: "none", services: [{ name: "db", label: "//:db" }] },
      // observe.env overlapping env
      { shell: "echo ok", observe: { env: ["FOO"] }, sandbox: "none", env: { FOO: "1" } },
      // observe.env overlapping inheritEnv
      { shell: "echo ok", observe: { env: ["BAR"] }, sandbox: "none", inheritEnv: ["BAR"] },
      // shards > 1 with outFiles
      { shell: "echo ok", shards: 2, outFiles: ["out.txt"] },
      // given with observe
      { shell: "echo ok", observe: true, sandbox: "none", given: { env: ["A"] } },
      // given.env overlapping env
      { shell: "echo ok", given: { env: ["A"] }, env: { A: "1" } },
      // given.env overlapping inheritEnv
      { shell: "echo ok", given: { env: ["B"] }, inheritEnv: ["B"] }
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        bIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: buildBadCases.length - 1 })),
        tIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: testBadCases.length - 1 }))
      })
    )
    for (const bc of buildBadCases) expect(() => Schema.decodeUnknownSync(Shell.BuildAttrs)(bc)).toThrow()
    for (const tc of testBadCases) expect(() => Schema.decodeUnknownSync(Shell.TestAttrs)(tc)).toThrow()
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ bIdx, tIdx }) =>
          Effect.sync(() => {
            expect(() => Schema.decodeUnknownSync(Shell.BuildAttrs)(buildBadCases[bIdx])).toThrow()
            expect(() => Schema.decodeUnknownSync(Shell.TestAttrs)(testBadCases[tIdx])).toThrow(); return true
          }),
        { executions: Math.max(executions, 60), seed: seed + 3 }
      )
    )
    assertPassed(report)

    // Also confirm valid machine/observe/given forms decode cleanly
    const validBuild = Schema.decodeUnknownSync(Shell.BuildAttrs)({
      shell: "echo ok",
      machine: "builder",
      sandbox: "none",
      cache: false
    })
    expect(validBuild.machine).toBe("builder")
    const validObserve = Schema.decodeUnknownSync(Shell.TestAttrs)({
      shell: "echo ok",
      observe: { env: ["OBS_ONLY"] },
      sandbox: "none"
    })
    expect(Shell.observedEnv(validObserve.observe)).toEqual(["OBS_ONLY"])
  })
})
