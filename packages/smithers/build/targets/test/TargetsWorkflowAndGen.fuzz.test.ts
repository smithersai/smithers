import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Yaml from "yaml"
import * as CiToolchain from "../src/CiToolchain.ts"
import * as DocsCheck from "../src/DocsCheck.ts"
import * as DocsParity from "../src/DocsParity.ts"
import * as Factory from "../src/Factory.ts"
import * as Flow from "../src/Flow.ts"
import * as FlowCatalog from "../src/FlowCatalog.ts"
import * as GeneratedFile from "../src/GeneratedFile.ts"
import * as GithubCiGen from "../src/GithubCiGen.ts"
import * as GithubTarget from "../src/GithubTarget.ts"
import * as GithubWorkflow from "../src/GithubWorkflow.ts"
import * as Home from "../src/Home.ts"
import * as Input from "../src/Input.ts"
import * as YamlLocation from "../src/internal/YamlLocation.ts"
import * as NewPackage from "../src/NewPackage.ts"
import * as Nix from "../src/Nix.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as PackageJsonTemplate from "../src/PackageJsonTemplate.ts"
import * as PnpmWorkspaceFile from "../src/PnpmWorkspaceFile.ts"
import * as Runtime from "../src/Runtime.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import * as Target from "../src/Target.ts"
import * as TargetIndex from "../src/TargetIndex.ts"
import * as TsBuild from "../src/TsBuild.ts"
import * as Tsconfig from "../src/Tsconfig.ts"
import * as Verb from "../src/Verb.ts"
import * as Vitest from "../src/Vitest.ts"
import { plannedCalls } from "./plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const fsExecutions = Math.min(executions, 25)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/targets workflow, CI generation, docs, factory, home & manifest fuzz invariants", () => {
  it("GithubWorkflow parser, shell span analyzer, install detectors & gate checkers preserve invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cmd: Schema.Literals([
          "pnpm install --frozen-lockfile",
          "bun install --frozen-lockfile",
          "npm ci",
          "pnpm exec smthrs test //...",
          "echo '# not a comment' && pnpm exec smthrs ci //a # trailing comment",
          "if true; then\n  pnpm exec smthrs lint //...\nfi",
          "foo=$(pnpm exec smthrs build //a) && echo ok",
          "\"quoted $(sub)\" ; 'single # hash' | cat",
          "cat <<EOF\npnpm install\nEOF\npnpm exec smthrs test //a",
          "FOO=bar BAZ=\"1 2\" pnpm exec smthrs docs //..."
        ]),
        shell: Schema.Literals(["", "bash", "sh", "bash -e {0}", "pwsh", "python", "cmd"]),
        condition: Schema.Literals([
          "",
          "always()",
          "success()",
          "!cancelled()",
          GithubWorkflow.independentGateCondition,
          "github.event_name == 'push'"
        ]),
        uses: Schema.Literals([
          "actions/checkout@v4",
          "pnpm/action-setup@v4",
          "actions/setup-node@v4",
          "owner/repo/sub@sha"
        ]),
        installCmd: Schema.Literals([
          "pnpm install --frozen-lockfile",
          "bun install --frozen-lockfile",
          "npm ci",
          "yarn install",
          "echo hi"
        ]),
        malformed: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cmd, shell, condition, uses, installCmd, malformed }) =>
          Effect.sync(() => {
            const stripped1 = GithubWorkflow.stripShellComments(cmd)
            const stripped2 = GithubWorkflow.stripShellComments(stripped1)
            if (stripped1 !== stripped2) return false

            const spans = GithubWorkflow.commandSpans(cmd)
            const starts = GithubWorkflow.commandStarts(cmd)
            if (spans.length !== starts.length) return false
            for (let i = 0; i < spans.length; i++) {
              if (spans[i]!.start !== starts[i]) return false
              if (i > 0 && starts[i]! < starts[i - 1]!) return false
            }

            GithubWorkflow.runsCommand(cmd, "pnpm exec smthrs test //...")
            GithubWorkflow.usesAction(uses, "actions/checkout")
            GithubWorkflow.alwaysRuns(condition || undefined)
            GithubWorkflow.executesRunScript(shell || undefined)
            const sup = GithubWorkflow.supportedInstallOf(installCmd)
            if (GithubWorkflow.isSupportedInstall(installCmd) !== (sup !== undefined)) return false
            GithubWorkflow.workspaceExec(installCmd)
            GithubWorkflow.performsInstall(cmd, installCmd)

            if (malformed) {
              const badSources = [
                ":::bad: [yaml",
                "name: only-name\n",
                "on: push\njobs: not-a-map\n",
                "on: push\njobs:\n  j1:\n    steps: bad\n"
              ]
              for (const bad of badSources) {
                try {
                  GithubWorkflow.parseWorkflow(bad)
                } catch (e) {
                  if (!(e instanceof GithubWorkflow.WorkflowParseError)) return false
                }
              }
              const lineCounter = new Yaml.LineCounter()
              const badDoc = Yaml.parseDocument(":::bad: [yaml", { lineCounter })
              if (badDoc.errors.length > 0) {
                const errLine = YamlLocation.parseErrorLine(lineCounter, badDoc.errors[0]!)
                if (errLine < 1) return false
              }
            } else {
              const yamlSource = [
                "name: FuzzCI",
                "on: workflow_dispatch",
                "jobs:",
                "  build:",
                "    runs-on: ubuntu-latest",
                "    steps:",
                `      - uses: ${uses}`,
                "      - name: Run",
                ...(shell ? [`        shell: ${shell}`] : []),
                ...(condition ? [`        if: ${condition}`] : []),
                "        run: |",
                ...cmd.split("\n").map((line) => `          ${line}`)
              ].join("\n") + "\n"

              const wf = GithubWorkflow.parseWorkflow(yamlSource)
              if (wf.jobs.length !== 1 || wf.jobs[0]!.id !== "build") return false
              const missing = GithubWorkflow.missingRequiredJobs(wf, ["build", "absent"])
              if (missing.length !== 1 || missing[0] !== "absent") return false
              const missingG = GithubWorkflow.missingGates(wf, [
                { name: "test-gate", command: "pnpm exec smthrs test //..." },
                { name: "pinned-gate", command: "pnpm exec smthrs lint //...", job: "build" }
              ])
              if (!Array.isArray(missingG)) return false

              const lineCounter = new Yaml.LineCounter()
              const doc = Yaml.parseDocument(yamlSource, { lineCounter })
              const line = YamlLocation.nodeLine(lineCounter, doc.contents)
              if (line < 1) return false
              if (YamlLocation.nodeLine(lineCounter, null) !== 1) return false
            }
            return true
          }),
        { executions, seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("GithubCiGen balanceShards, toolchainSteps, artifactSteps, render & GithubTarget round-trip through strict parser", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        shardCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        targetCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
        concurrency: Schema.Literals(["ref", "commit"]),
        cancelInProgress: Schema.Boolean,
        results: Schema.Boolean,
        knownRed: Schema.Boolean,
        useMatrix: Schema.Boolean,
        withArtifacts: Schema.Boolean,
        toolchainKind: Schema.Literals(["node", "bun", "rust", "go", "zig", "foundry", "nix", "docker", "all"]),
        verb: Schema.Literals(["build", "test", "lint", "docs"]),
        mode: Schema.Literals(["write", "check"])
      })
    )

    const nodeSetup = CiToolchain.Node({ runtime, release: "26.4.0" })
    const bunSetup = CiToolchain.Bun({ runtime: Runtime.Bun({ version: ">=1.4.0" }), release: "1.4.1" })
    const rustSetup = CiToolchain.Rust({ toolchain: RustToolchain.Pinned({}) })
    const goSetup = CiToolchain.Go({ release: "1.26.0" })
    const zigSetup = CiToolchain.Zig({ release: "0.17.1" })
    const foundrySetup = CiToolchain.Foundry({ release: "v1.8.1" })
    const nixEnv = Nix.Environment({ flake: Input.file("flake.nix"), lock: Input.file("flake.lock") })
    const nixSetup = CiToolchain.Nix({ environment: nixEnv, installer: "determinate" })
    const dockerSetup = CiToolchain.Docker({ imageStore: "containerd" })
    const jjSetup = CiToolchain.Jj({ release: "0.39.0" })
    const rgSetup = CiToolchain.Ripgrep({ release: "14.1.1" })
    const aptSetup = CiToolchain.Apt({ packages: ["libssl-dev", "pkg-config"] })
    const pgSetup = CiToolchain.Postgres({ release: "18" })
    const pwSetup = CiToolchain.Playwright({ cwd: "apps/web", browsers: ["chromium"] })
    const browserSetup = CiToolchain.Browser({ executable: "chromium", reason: "browser e2e" })
    const actionlint = CiToolchain.Actionlint({ release: "1.7.11", workflows: [".github/workflows/ci.yml"] })

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          shardCount,
          targetCount,
          concurrency,
          cancelInProgress,
          results,
          knownRed,
          useMatrix,
          withArtifacts,
          toolchainKind,
          verb,
          mode
        }) =>
          Effect.sync(() => {
            const items = Array.from({ length: targetCount }, (_, i) => ({
              pattern: `//pkg-${i}:test`,
              durationMs: ((i * 37 + 13) % 100) + 1
            }))
            const k = Math.min(shardCount, targetCount)
            const shardsA = GithubCiGen.balanceShards(items, k)
            const shardsB = GithubCiGen.balanceShards([...items].reverse(), k)
            if (shardsA.length !== k) return false
            if (JSON.stringify(shardsA) !== JSON.stringify(shardsB)) return false
            const flat = shardsA.flatMap((s) => s.patterns).sort()
            const expected = items.map((t) => t.pattern).sort()
            if (JSON.stringify(flat) !== JSON.stringify(expected)) return false
            const totalA = shardsA.reduce((acc, s) => acc + s.durationMs, 0)
            const totalExp = items.reduce((acc, t) => acc + t.durationMs, 0)
            if (totalA !== totalExp) return false

            try {
              GithubCiGen.balanceShards(items, 0)
              return false
            } catch (e) {
              if (!(e instanceof GithubCiGen.InvalidSelection)) return false
            }

            const upload = withArtifacts
              ? CiToolchain.Artifacts({
                artifact: "build-artifacts",
                sources: [{ from: "dist/out.txt", as: "out.txt" }]
              })
              : undefined
            if (upload) {
              const aSteps = GithubCiGen.artifactSteps(upload)
              if (aSteps.length === 0) return false
            }

            const toolchain: CiToolchain.Toolchain = toolchainKind === "node"
              ? CiToolchain.Needs({ runtimes: [nodeSetup], ...(upload ? { artifacts: upload as never } : {}) })
              : toolchainKind === "bun"
              ? CiToolchain.Needs({ runtimes: [bunSetup] })
              : toolchainKind === "rust"
              ? CiToolchain.Needs({ runtimes: [nodeSetup], rust: rustSetup })
              : toolchainKind === "go"
              ? CiToolchain.Needs({ runtimes: [nodeSetup], go: goSetup })
              : toolchainKind === "zig"
              ? CiToolchain.Needs({ runtimes: [nodeSetup], zig: zigSetup })
              : toolchainKind === "foundry"
              ? CiToolchain.Needs({ runtimes: [nodeSetup], foundry: foundrySetup })
              : toolchainKind === "nix"
              ? CiToolchain.Needs({ nix: nixSetup })
              : toolchainKind === "docker"
              ? CiToolchain.Needs({ runtimes: [nodeSetup], docker: dockerSetup, workflowLint: actionlint })
              : CiToolchain.Needs({
                runtimes: [nodeSetup],
                rust: rustSetup,
                go: goSetup,
                jj: jjSetup,
                ripgrep: rgSetup,
                apt: aptSetup,
                postgres: pgSetup,
                playwright: pwSetup,
                browser: browserSetup
              })

            const verbVal = verb === "build"
              ? Verb.Build
              : verb === "test"
              ? Verb.Test
              : verb === "lint"
              ? Verb.Lint
              : Verb.Docs

            const mainStep: GithubCiGen.TargetStep = {
              name: "Primary",
              verb: verbVal,
              pattern: "//packages/...",
              additionalPatterns: ["//apps/..."],
              parallelism: 2
            }

            const baseJob: GithubCiGen.Job = {
              id: "main",
              name: "Main",
              ...(useMatrix
                ? {
                  matrix: [
                    { os: "ubuntu-latest", advisory: false },
                    { os: "macos-latest", advisory: true }
                  ]
                }
                : { runsOn: "ubuntu-latest" }),
              timeoutMinutes: 30,
              toolchain,
              steps: [mainStep]
            }

            const rawAttrs = {
              workflowName: "Fuzz CI",
              pushBranches: ["main"],
              pullRequest: true,
              workflowDispatch: true,
              requiredJobs: ["main"],
              output: ".github/workflows/ci.yml",
              mode,
              packageManager,
              concurrency,
              cancelInProgress,
              results,
              ...(knownRed ? { knownRed: ".github/known-red.json" } : {}),
              gates: [{ name: "primary", verb: verbVal, pattern: "//packages/..." }],
              jobs: [baseJob]
            }
            const attrs = Schema.decodeUnknownSync(GithubCiGen.Attrs)(rawAttrs)

            if (!GithubCiGen.targetPattern("//packages/...")) return false
            if (GithubCiGen.targetPattern("//bad; rm -rf /")) return false
            if (!GithubCiGen.relativeFilePath(".github/workflows/ci.yml")) return false
            if (GithubCiGen.relativeFilePath("../escape.yml")) return false

            const cmdStr = GithubCiGen.stepCommand(attrs, mainStep)
            if (!cmdStr.includes("smthrs")) return false
            if (!GithubCiGen.satisfiesGate(mainStep, { name: "g", verb: verbVal, pattern: "//packages/..." })) {
              return false
            }
            if (GithubCiGen.missingGates(attrs).length !== 0) return false

            const rendered = GithubCiGen.render(attrs)
            const parsed = GithubWorkflow.parseWorkflow(rendered)
            if (parsed.jobs.length < 1) return false

            const target = GithubCiGen.GithubCiGen(rawAttrs as never)
            if (!Target.isTarget(target)) return false
            const calls = plannedCalls(target)
            if (calls.length === 0) return false

            const setupT = GithubTarget.Setup({})
            const wfT = GithubTarget.Workflow({
              name: "check",
              on: { push: { branches: ["main"] } },
              runsOn: "ubuntu-latest",
              steps: [{ name: "Hi", run: "echo hi" }]
            })
            const ciT = GithubTarget.Ci({
              workflows: { verify: { on: { pullRequest: true, push: ["main"] }, run: [setupT] } },
              changes: [".github/workflows/*.yml"]
            })
            const prT = GithubTarget.Pr({ gates: [setupT] })
            const pagesT = GithubTarget.Pages({ site: setupT })
            const relT = GithubTarget.Release({
              manifest: Input.file("package.json"),
              notes: "Release notes",
              gates: [setupT]
            })
            if (
              !Target.isTarget(setupT) || !Target.isTarget(wfT) || !Target.isTarget(ciT) ||
              !Target.isTarget(prT) || !Target.isTarget(pagesT) || !Target.isTarget(relT)
            ) {
              return false
            }
            if (!GithubTarget.setupAttrsOf(setupT) || !GithubTarget.workflowAttrsOf(wfT)) return false
            if (!GithubTarget.ciGenAttrsOf(ciT) || !GithubTarget.prAttrsOf(prT)) return false
            return true
          }),
        { executions: Math.min(executions, 80), seed: seed + 2 }
      )
    )
    assertPassed(report)
  })

  it("DocsCheck normalization, evidenceDigest, closureDigest, stamp roundtrip & judge invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pagePath: Schema.Literals(["docs/guide.md", "README.md", "docs/api/index.md"]),
        contentA: Schema.String.check(Schema.isMaxLength(200)),
        contentB: Schema.String.check(Schema.isMaxLength(200)),
        ignoreMode: Schema.Literals(["none", "frontmatter", "sections"]),
        mutateOutput: Schema.Boolean,
        mutateInput: Schema.Boolean,
        dropStamp: Schema.Boolean,
        absentInput: Schema.Boolean,
        evAgeMs: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 5000 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pagePath, contentA, contentB, ignoreMode, mutateOutput, mutateInput, dropStamp, absentInput, evAgeMs }) =>
          Effect.sync(() => {
            const safeA = contentA.replace(/[\uD800-\uDFFF]/g, "").replace(/\r/g, "")
            const safeB = contentB.replace(/[\uD800-\uDFFF]/g, "").replace(/\r/g, "")
            const ignore: DocsCheck.Ignore | undefined = ignoreMode === "none"
              ? undefined
              : ignoreMode === "frontmatter"
              ? { frontmatterKeys: ["updated"] }
              : { sections: ["Changelog"] }

            const textToNorm =
              `---\ntitle: Demo\nupdated: 2026-11-23\n---\n\n# Guide\n\n${safeA}\n\n## Changelog\n\n- entry\n`
            const norm1 = DocsCheck.normalize(textToNorm, ignore)
            const norm2 = DocsCheck.normalize(norm1, ignore)
            if (norm1 !== norm2) return false

            const now = 10_000
            const ttlMs = 1_000
            const evInput: DocsCheck.EvidenceInput = {
              file: Input.file(".smithers/evidence.json"),
              dependency: "api-docs",
              ttlMs
            }
            const evJson = JSON.stringify({
              format: 1,
              dependency: "api-docs",
              observedAt: now - evAgeMs,
              digest: Input.digestText(safeA)
            })
            const ev1 = DocsCheck.evidenceDigest(evJson, evInput, now)
            const ev2 = DocsCheck.evidenceDigest(evJson, evInput, now)
            if (ev1 !== ev2) return false
            const validAge = evAgeMs >= 0 && evAgeMs < ttlMs
            if (validAge && ev1 === undefined) return false
            if (!validAge && ev1 !== undefined) return false
            if (DocsCheck.evidenceDigest(undefined, evInput, now) !== undefined) return false
            if (DocsCheck.evidenceDigest("{bad", evInput, now) !== undefined) return false

            const inp1 = { path: "src/a.ts", digest: absentInput ? undefined : Input.digestText(safeA) }
            const inp2 = { path: "src/b.ts", digest: Input.digestText(safeB) }
            const outFile = { path: pagePath, digest: Input.digestText(safeA + safeB) }

            if (DocsCheck.closureDigest([inp1, inp2]) !== DocsCheck.closureDigest([inp2, inp1])) return false
            if (DocsCheck.closureDigest([inp1, inp2, inp1]) !== DocsCheck.closureDigest([inp1, inp2])) return false

            const stamp = DocsCheck.makeStamp({ producer: "//docs:gen", output: outFile, inputs: [inp2, inp1] })
            const rendered = DocsCheck.renderStamp(stamp)
            const parsed = DocsCheck.parseStamp(rendered)
            if (!parsed || JSON.stringify(parsed) !== JSON.stringify(stamp)) return false
            if (DocsCheck.parseStamp("{invalid json") !== undefined) return false

            if (DocsCheck.firstDifference(stamp.inputs, stamp.inputs) !== undefined) return false

            const actualOut = mutateOutput ? { path: pagePath, digest: Input.digestText(safeA + "MUTATED") } : outFile
            const actualInputs = mutateInput
              ? [{ path: "src/a.ts", digest: Input.digestText(safeA + "CHANGED") }, inp2]
              : [inp1, inp2]
            const verdict = DocsCheck.judge({
              page: pagePath,
              stampPath: `${pagePath}.stamp.json`,
              stamp: dropStamp ? undefined : stamp,
              output: actualOut,
              inputs: actualInputs
            })
            const expectStale = dropStamp ||
              (mutateOutput && actualOut.digest !== outFile.digest) ||
              (mutateInput && actualInputs[0]!.digest !== inp1.digest)
            if (expectStale && verdict === undefined) return false
            if (!expectStale && verdict !== undefined) return false

            const checkTarget = DocsCheck.Check({
              stamp: Input.file(`${pagePath}.stamp.json`),
              output: Input.file(pagePath),
              inputs: [Input.file("src/a.ts")]
            })
            if (!Target.isTarget(checkTarget)) return false
            return true
          }),
        { executions, seed: seed + 3 }
      )
    )
    assertPassed(report)
  })

  it("DocsParity fences/summarize/exampleProblem/checkDocs & GeneratedFile write/check/symlink invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-docsgen-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          proseWords: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 40 })),
          lang: Schema.Literals(["ts", "typescript", "bash", "json", ""]),
          codeLine: Schema.Literals(["export const x = 1", "console.log('ok')", "pnpm test"]),
          fileSlug: Schema.Literals(["a", "sub/b", "deep/dir/c"]),
          drift: Schema.Boolean,
          symlink: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ proseWords, lang, codeLine, fileSlug, drift, symlink }) =>
            Effect.gen(function*() {
              const prose = Array.from({ length: proseWords }, (_, i) => `word${i}`).join(" ")
              const md = `# Title\n\n${prose}\n\n\`\`\`${lang}\n${codeLine}\n\`\`\`\n`
              const fences = DocsParity.fences(md)
              if (fences.length !== 1) return false
              const sum = DocsParity.summarize(md)
              if (sum.proseCharacters <= 0) return false

              DocsParity.exampleProblem(
                { page: "README.md", example: "examples/demo.ts", test: "test/examples.test.ts" },
                { page: md, example: codeLine + "\n", test: "import '../examples/demo.ts'\n" }
              )
              const exProblemMissing = DocsParity.exampleProblem(
                { page: "README.md", example: "examples/demo.ts", test: "test/examples.test.ts" },
                { page: "# Empty\n", example: "different()\n", test: "" }
              )
              if (exProblemMissing === undefined) return false

              const readmeRel = `doc-${fileSlug.replace(/\//g, "-")}.md`
              const readmeAbs = NodePath.join(tmpRoot, readmeRel)
              yield* Effect.promise(() => Fs.writeFile(readmeAbs, md, "utf8"))
              const checkExit = yield* Effect.exit(
                DocsParity.checkDocs(
                  { workspaceRoot: tmpRoot },
                  { path: readmeRel, minimumProseCharacters: 20, examples: [] }
                )
              )
              if (sum.proseCharacters >= 20 && checkExit._tag !== "Success") return false
              if (sum.proseCharacters < 20 && checkExit._tag !== "Failure") return false

              const genPath = `gen/${fileSlug}.txt`
              if (GeneratedFile.resolveOutputPath(genPath) !== genPath) return false
              if (GeneratedFile.failureMessage(new Error("boom")).length === 0) return false
              const dErr = GeneratedFile.driftError(genPath, "drifted", "drifted")
              if (dErr._tag !== "smithers-build/DriftError") return false

              const content = `generated:${prose}\n`
              yield* GeneratedFile.writeGeneratedFile(tmpRoot, { path: genPath, contents: content })
              yield* GeneratedFile.checkGeneratedFile(tmpRoot, { path: genPath, contents: content })

              if (drift) {
                const driftExit = yield* Effect.exit(
                  GeneratedFile.checkGeneratedFile(tmpRoot, { path: genPath, contents: content + "DRIFT" })
                )
                if (driftExit._tag !== "Failure") return false
              }

              if (symlink) {
                const linkPath = `links/${fileSlug}.link`
                yield* GeneratedFile.writeGeneratedSymlink(tmpRoot, { path: linkPath, target: `../${genPath}` })
                yield* GeneratedFile.checkGeneratedSymlink(tmpRoot, { path: linkPath, target: `../${genPath}` })
                const badLinkExit = yield* Effect.exit(
                  GeneratedFile.checkGeneratedSymlink(tmpRoot, { path: linkPath, target: "../other.txt" })
                )
                if (badLinkExit._tag !== "Failure") return false
              }

              const escExit = yield* Effect.exit(
                GeneratedFile.writeGeneratedFile(tmpRoot, { path: "../escape.txt", contents: "no" })
              )
              if (escExit._tag !== "Failure") return false
              return true
            }),
          { executions: fsExecutions, seed: seed + 4 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("Factory, Home, FlowCatalog, PackageJson, NewPackage, Tsconfig, PnpmWorkspaceFile & TargetIndex fuzz invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-pkg-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          pkgShort: Schema.Literals(["alpha", "beta-lib", "gamma-tools"]),
          scoped: Schema.Boolean,
          license: Schema.Literals(["MIT", "Apache-2.0", "ISC"]),
          format: Schema.Literals(["esm", "cjs", "dual"]),
          mirror: Schema.Literals(["push", "pull", "none"]),
          issues: Schema.Literals(["read", "two-way", "none"]),
          changes: Schema.Literals(["land", "send-upstream", "none"]),
          includeHtml: Schema.Boolean,
          extraField: Schema.Literals(["sideEffects", "funding", "homepage"])
        })
      )

      let scaffoldCounter = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ pkgShort, scoped, license, format, mirror, issues, changes, includeHtml, extraField }) =>
            Effect.gen(function*() {
              const pkgName = scoped ? `@fuzz/${pkgShort}` : pkgShort
              if (PackageJson.assertPackageName(pkgName) !== pkgName) return false

              if (includeHtml) {
                try {
                  Home.Text({ text: "<b>unsafe</b>" })
                  return false
                } catch {
                  // expected HTML rejection
                }
              }
              const homeDecl = Home.Home({
                blocks: [
                  Home.Text({ title: "Welcome", text: `Package ${pkgName} overview.` }),
                  Home.Links({ links: [{ label: "Repo", url: "https://github.com/smithersai/smithers" }] }),
                  Home.Flows({ title: "Flows" }),
                  Home.Prompt({ title: "Ask", placeholder: "Type a task...", flow: "review" }),
                  Home.App({ flow: "review", title: "Review", picture: "review" }),
                  Home.Markdown({ path: "README.md" }),
                  Home.Stack({ title: "Stack" }),
                  Home.View({ flow: "review" })
                ]
              })
              if (!Home.isHomeDeclaration(homeDecl)) return false
              const homeJson = Home.render(homeDecl)
              const parsedHome = Home.parse(homeJson)
              if (
                typeof parsedHome === "string" || !("blocks" in parsedHome) ||
                parsedHome.blocks.length !== homeDecl.blocks.length
              ) return false

              const flowDecl = Flow.Flow({ flow: "review", summary: "Review changes.", featured: true })
              const flowDecl2 = Flow.Flow({ flow: "lint", summary: "Lint workspace." })
              const catalogRows = FlowCatalog.rows(
                [
                  {
                    id: "review",
                    description: "Review flow",
                    kind: "ts",
                    path: ".smithers/flows/review/flow.ts",
                    capabilities: [],
                    model: null,
                    modelInvocable: true
                  },
                  {
                    id: "lint",
                    description: "Lint flow",
                    kind: "mdx",
                    path: ".smithers/flows/lint/flow.mdx",
                    capabilities: [],
                    model: null,
                    modelInvocable: false
                  }
                ],
                [flowDecl, flowDecl2]
              )
              if (catalogRows.length !== 2) return false

              const incompatibleMirror = (changes === "land" && mirror !== "push") ||
                (changes === "send-upstream" && mirror === "push")
              let policy: Factory.GithubPolicy
              if (incompatibleMirror) {
                try {
                  Factory.Policy({ mirror, issues, changes })
                  throw new Error("expected incompatibleMirror throw")
                } catch {
                  policy = Factory.Policy({
                    mirror: changes === "land" ? "push" : "pull",
                    issues,
                    changes
                  })
                }
              } else {
                policy = Factory.Policy({ mirror, issues, changes })
              }
              const factoryDecl = Factory.Factory({
                summary: `Factory for ${pkgName}`,
                github: policy,
                flows: [flowDecl, flowDecl2],
                on: {
                  "pull_request.opened": "review",
                  "push.main": ["review", "lint"]
                }
              })
              if (!Factory.isFactoryDeclaration(factoryDecl)) throw new Error("not factoryDecl")
              if (Factory.rules(factoryDecl).length !== 2) throw new Error("rules length")
              const projJson = Factory.renderProjection(factoryDecl, catalogRows)
              const parsedProj = Factory.parseProjection(projJson)
              if (typeof parsedProj === "string") throw new Error("parsedProj err: " + parsedProj)
              if (parsedProj.summary !== factoryDecl.summary) throw new Error("summary mismatch")

              const merged = PackageJson.merge(
                { name: pkgName, version: "1.0.0", scripts: { test: "vitest" } },
                {
                  license,
                  [extraField]: extraField === "sideEffects" ? false : "https://example.com",
                  scripts: { build: "tsc" }
                }
              )
              const renderedPkg = PackageJson.render(merged)
              if (!renderedPkg.endsWith("\n")) throw new Error("no trailing newline")
              const parsedPkg = JSON.parse(renderedPkg) as Record<string, unknown>
              if (PackageJson.render(parsedPkg) !== renderedPkg) throw new Error("render not idempotent")
              const diffsSame = PackageJson.diffFields(parsedPkg, parsedPkg)
              if (diffsSame.length !== 0) throw new Error("diffsSame non-empty")
              const diffsChanged = PackageJson.diffFields(parsedPkg, { ...parsedPkg, version: "2.0.0" })
              if (diffsChanged.length === 0) throw new Error("diffsChanged empty")

              const parsedGen = PackageJson.parseGenerated(
                JSON.stringify({ description: "Fuzz desc", keywords: ["fuzz", "build", "smithers"] }),
                ["description", "keywords"]
              )
              if (parsedGen.description !== "Fuzz desc") return false

              const cwd = `packages/${pkgShort}`
              const buildT = TsBuild.TsBuild({
                packageManager,
                srcs: [Input.glob("src/**/*.ts")],
                entries: [Input.file("src/index.ts")],
                deps: [],
                tsconfig: Input.file("tsconfig.json"),
                tool: { name: "program", entry: Input.file("scripts/build.mjs") },
                format,
                outDir: "dist",
                cwd
              })
              const testT = Vitest.Vitest({
                packageManager,
                tests: [Input.glob("test/**/*.test.ts")],
                sources: [Input.glob("src/**/*.ts")],
                deps: [],
                config: Input.file("vitest.config.ts"),
                environment: "node",
                passWithNoTests: false,
                cwd
              })
              const decl = PackageJson.PackageJson({
                name: pkgName,
                version: "0.1.0",
                license,
                description: "Generated package",
                keywords: ["smithers"],
                publish: { entry: buildT },
                scripts: { build: buildT, test: testT }
              })
              if (!PackageJson.isDeclaration(decl)) return false
              const pkgTargets = PackageJson.targets(
                decl,
                cwd,
                (t) => (t === buildT ? `//${cwd}:build` : `//${cwd}:test`)
              )
              if (!Target.isTarget(pkgTargets.check) || !Target.isTarget(pkgTargets.write)) return false
              const tpl = PackageJsonTemplate.make({ license, author: "Smithers" })
              if (!PackageJsonTemplate.isTemplate(tpl)) return false

              const pkgDirAbs = NodePath.join(tmpRoot, cwd)
              yield* Effect.promise(() => Fs.mkdir(pkgDirAbs, { recursive: true }))
              const syncPayload: PackageJson.SyncPayload = {
                path: `${cwd}/package.json`,
                packageDirectory: cwd,
                mode: "write",
                fields: merged,
                generated: [],
                readme: Input.file(`${cwd}/README.md`),
                sources: Input.glob(`${cwd}/src/**/*.ts`),
                engine: "claude",
                model: "claude-sonnet-4-6",
                promptVersion: PackageJson.promptVersion
              }
              yield* PackageJson.sync({ workspaceRoot: tmpRoot, cacheDirectory: ".cache" }, syncPayload)
              yield* PackageJson.sync({ workspaceRoot: tmpRoot, cacheDirectory: ".cache" }, {
                ...syncPayload,
                mode: "check"
              })

              scaffoldCounter += 1
              const scaffoldDir = `scaffolds/run-${scaffoldCounter}`
              const scaffoldPayload: NewPackage.ScaffoldPayload = {
                directory: scaffoldDir,
                version: "0.1.0",
                license,
                fields: tpl.fields,
                tsconfigExtends: "../../tsconfig.json"
              }
              const bp = NewPackage.boilerplate(pkgName, scaffoldPayload)
              if (bp.length === 0) return false
              const wt = NewPackage.withTemplate(pkgName, scaffoldPayload, [["README.md", "# {{name}}\n"]])
              if (wt.length === 0) return false
              const scafReport = yield* NewPackage.scaffold(
                { workspaceRoot: tmpRoot, packageName: pkgName },
                scaffoldPayload
              )
              if (scafReport.files.length === 0) return false

              const tsAttrs = Tsconfig.Attrs.make({
                path: "tsconfig.json",
                cwd,
                extends: Input.file("//tsconfig.base.json"),
                include: [Input.glob("src/**/*.ts"), "test/**/*.ts"],
                exclude: ["dist"],
                compilerOptions: { strict: true, noEmit: true }
              })
              const tsRendered = Tsconfig.render(tsAttrs)
              if (!JSON.parse(tsRendered).compilerOptions.strict) return false
              const tsTarget = Tsconfig.Tsconfig({
                path: "tsconfig.json",
                cwd,
                extends: Input.file("//tsconfig.base.json"),
                include: [Input.glob("src/**/*.ts")],
                compilerOptions: { strict: true }
              })
              if (plannedCalls(tsTarget).length === 0) return false

              const pnpmWsAttrs = PnpmWorkspaceFile.Attrs.make({
                packages: ["packages/*", "apps/*"],
                allowBuilds: { esbuild: true },
                settings: { verifyDepsBeforeRun: "install" },
                packageManager
              })
              const pnpmWsRendered = PnpmWorkspaceFile.render(pnpmWsAttrs)
              if (!pnpmWsRendered.includes("packages/*")) return false
              const pnpmWsTarget = PnpmWorkspaceFile.PnpmWorkspace({
                packages: ["packages/*", "apps/*"],
                allowBuilds: { esbuild: true },
                packageManager
              })
              if (plannedCalls(pnpmWsTarget).length === 0) return false

              const idxRendered = TargetIndex.render([
                {
                  label: `//${cwd}:build`,
                  package: cwd,
                  name: "build",
                  rule: "TsBuild",
                  kinds: ["build"],
                  cacheable: true,
                  inputs: [{ kind: "file", path: `${cwd}/src/index.ts` }],
                  outputs: [`${cwd}/dist`],
                  dependencies: []
                }
              ])
              if (!JSON.parse(idxRendered)[0].label.includes(":build")) return false
              return true
            }),
          { executions: fsExecutions, seed: seed + 5 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
