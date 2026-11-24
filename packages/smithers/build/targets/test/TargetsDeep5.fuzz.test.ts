import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as GithubWorkflow from "../src/GithubWorkflow.ts"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as NewPackage from "../src/NewPackage.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as PackageJsonTemplate from "../src/PackageJsonTemplate.ts"
import * as Reference from "../src/Reference.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as ToolBuild from "../src/ToolBuild.ts"
import { plannedCalls } from "./plan.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261135")
const fsExecutions = Math.min(executions, 18)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/targets deep fuzz suite 5: GithubWorkflow shell parser, PackageJson.sync, NewPackage.scaffold, Shell, ToolBuild & LlmLint/Exec extras", () => {
  it(
    "GithubWorkflow complex bash constructs (heredocs, case, functions, subshells, arrays) & multi-job missingGates",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scriptKind: Schema.Literals([
            "heredoc",
            "heredoc-quoted",
            "case-stmt",
            "func-def",
            "array-assign",
            "subshell-arith",
            "for-while-if",
            "escaped-quotes"
          ]),
          gateMode: Schema.Literals([
            "direct",
            "needs-chain",
            "conditional-job",
            "conditional-step",
            "action-gate",
            "python-shell"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ scriptKind, gateMode }) =>
            Effect.sync(() => {
              const script = scriptKind === "heredoc"
                ? "cat <<EOF\npnpm run fake\nEOF\npnpm run real\n"
                : scriptKind === "heredoc-quoted"
                ? "cat <<-'END'\n\tinside heredoc\n\tEND\nbun test\n"
                : scriptKind === "case-stmt"
                ? "case \"$OS\" in\n  linux|darwin) pnpm run test ;;\n  *) echo other ;;\nesac\n"
                : scriptKind === "func-def"
                ? "helper() {\n  echo hi\n  pnpm run lint\n}\nhelper\n"
                : scriptKind === "array-assign"
                ? "ARGS=(--foo 'bar baz' \"qux\")\nFOO+=('x')\npnpm run build \"${ARGS[@]}\"\n"
                : scriptKind === "subshell-arith"
                ? "X=$((1 + 2 * (3 + 4)))\nY=$(echo $(uname))\n(cd pkg && pnpm run check)\n"
                : scriptKind === "for-while-if"
                ? "if [ -f a ]; then\n  for x in 1 2; do echo $x; done\nelif true; then\n  while false; do true; done\nelse\n  pnpm run fallback\nfi\n"
                : "echo \"hello \\\"world\\\" $VAR\" 'single\\' && pnpm run ci\n"

              const spans = GithubWorkflow.commandSpans(script)
              if (spans.length === 0) throw new Error("expected spans")
              void GithubWorkflow.commandStarts(script)
              void GithubWorkflow.stripShellComments(script)
              if (scriptKind === "heredoc") {
                if (GithubWorkflow.runsCommand(script, "pnpm run fake")) throw new Error("heredoc fake matched!")
                if (!GithubWorkflow.runsCommand(script, "pnpm run real")) throw new Error("heredoc real missed!")
              }
              if (scriptKind === "case-stmt") {
                if (!GithubWorkflow.runsCommand(script, "pnpm run test")) throw new Error("case command missed")
              }

              const wfYaml = gateMode === "direct"
                ? "name: CI\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - id: setup\n        run: pnpm install --frozen-lockfile\n      - run: pnpm run ci\n"
                : gateMode === "needs-chain"
                ? "name: CI\non: push\njobs:\n  setup:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm install --frozen-lockfile\n  test:\n    runs-on: ubuntu-latest\n    needs: [setup]\n    steps:\n      - run: pnpm run test\n"
                : gateMode === "conditional-job"
                ? "name: CI\non: push\njobs:\n  ci:\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm run ci\n"
                : gateMode === "conditional-step"
                ? "name: CI\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - if: ${{ github.event_name == 'push' }}\n        run: pnpm run ci\n"
                : gateMode === "action-gate"
                ? "name: CI\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n"
                : "name: CI\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - shell: python\n        run: print('pnpm run ci')\n"

              const wf = GithubWorkflow.parseWorkflow(wfYaml)
              const gates: ReadonlyArray<GithubWorkflow.Gate> = gateMode === "action-gate"
                ? [{ name: "checkout", command: "actions/checkout" }]
                : [{ name: "ci", command: gateMode === "needs-chain" ? "pnpm run test" : "pnpm run ci" }]
              const missing = GithubWorkflow.missingGates(wf, gates)
              if (gateMode === "conditional-job" || gateMode === "conditional-step" || gateMode === "python-shell") {
                if (missing.length === 0) throw new Error(`expected missing gate for ${gateMode}`)
              }
              if (gateMode === "direct" || gateMode === "needs-chain" || gateMode === "action-gate") {
                if (missing.length !== 0) {
                  throw new Error(`unexpected missing gate for ${gateMode}: ${JSON.stringify(missing)}`)
                }
              }
              void GithubWorkflow.alwaysRuns("${{ always() }}")
              void GithubWorkflow.alwaysRuns("${{ !cancelled() }}")
              void GithubWorkflow.alwaysRuns("${{ success() }}")
              return true
            }),
          { executions, seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "PackageJson.sync (write/check/refresh/drift/generated), NewPackage.scaffold & ToolBuild capture/verify fuzz invariants",
    async () => {
      const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-deep5-")))
      try {
        const arb = Arbitrary.schema(
          Schema.Struct({
            pkgSlug: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{1,8}$/)),
            syncMode: Schema.Literals(["write", "check-clean", "check-drift", "refresh"]),
            scaffoldCase: Schema.Literals(["ok", "exists", "bad-name", "io-fail"]),
            toolOutCase: Schema.Literals(["ok", "missing", "mutated", "extra", "limit"])
          })
        )

        let runIdx = 0
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ pkgSlug, syncMode, scaffoldCase, toolOutCase }) =>
              Effect.gen(function*() {
                const idx = runIdx++
                const ws = NodePath.join(tmpRoot, `ws-${idx}`)
                const pkgRel = `packages/${pkgSlug}`
                const pkgAbs = NodePath.join(ws, pkgRel)
                yield* Effect.promise(async () => {
                  await Fs.mkdir(NodePath.join(pkgAbs, "src"), { recursive: true })
                  await Fs.writeFile(NodePath.join(pkgAbs, "README.md"), `# ${pkgSlug}\n\nA package.\n`, "utf8")
                  await Fs.writeFile(NodePath.join(pkgAbs, "src/index.ts"), `export const ${pkgSlug} = 1\n`, "utf8")
                })

                // 1. PackageJson helpers + PackageJson.sync
                const tpl = PackageJsonTemplate.make({ license: "MIT", sideEffects: false })
                const merged = PackageJson.merge(
                  { name: `@demo/${pkgSlug}`, version: "0.1.0", dependencies: { effect: "^4.0.0" } },
                  {
                    description: "Demo desc",
                    keywords: ["demo"],
                    license: "MIT",
                    scripts: { test: "smthrs test :test" }
                  }
                )
                const rendered = PackageJson.render(merged)
                if (!rendered.endsWith("\n")) throw new Error("render newline")
                const diff = PackageJson.diffFields({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })
                if (diff.length === 0) throw new Error("diffFields")
                void PackageJson.assertPackageName(`@demo/${pkgSlug}`)
                const cmd = Shell.Test({ shell: "true" })
                const sc = PackageJson.scriptCommand("test", cmd, `//${pkgRel}:test`)
                if (!sc.includes("test")) throw new Error("scriptCommand")

                const parsedGen = PackageJson.parseGenerated(
                  JSON.stringify({ description: "Generated desc", keywords: ["alpha", "beta", "gamma"] }),
                  ["description", "keywords"]
                )
                if (parsedGen.description !== "Generated desc") throw new Error("parseGenerated")

                const manifestPath = NodePath.join(pkgAbs, "package.json")
                if (syncMode === "check-clean") {
                  yield* Effect.promise(() => Fs.writeFile(manifestPath, rendered, "utf8"))
                } else if (syncMode === "check-drift") {
                  yield* Effect.promise(() => Fs.writeFile(manifestPath, "{\"name\":\"wrong\"}\n", "utf8"))
                }

                const syncPayload: PackageJson.SyncPayload = {
                  path: `${pkgRel}/package.json`,
                  packageDirectory: pkgRel,
                  mode: syncMode === "write" ? "write" : syncMode === "refresh" ? "refresh" : "check",
                  fields: {
                    name: `@demo/${pkgSlug}`,
                    version: "0.1.0",
                    license: "MIT",
                    description: "Demo desc",
                    keywords: ["demo"],
                    scripts: { test: "smthrs test :test" }
                  },
                  generated: [],
                  readme: null,
                  sources: null,
                  promptVersion: PackageJson.promptVersion,
                  engine: "claude",
                  model: "claude-opus-5-5"
                }
                const genCtx = yield* Effect.promise(() =>
                  PackageJson.generationContext(ws, {
                    ...syncPayload,
                    readme: Input.file(`${pkgRel}/README.md`),
                    sources: Input.glob(`${pkgRel}/src/**/*.ts`)
                  })
                )
                if (genCtx.digest.length === 0) throw new Error("generationContext")
                const syncExit = yield* PackageJson.sync({ workspaceRoot: ws, cacheDirectory: ".flows" }, syncPayload)
                  .pipe(Effect.exit)
                if (syncMode === "check-drift") {
                  if (!Exit.isFailure(syncExit)) throw new Error("expected drift failure")
                } else {
                  if (Exit.isFailure(syncExit)) {
                    throw new Error(`sync ${syncMode} failed: ${JSON.stringify(syncExit.cause)}`)
                  }
                }
                void PackageJson.SyncPackageJsonLive({ workspaceRoot: ws, cacheDirectory: ".flows" })

                const pjDecl = PackageJson.PackageJson({
                  name: `@demo/${pkgSlug}`,
                  version: "0.1.0",
                  description: "Demo desc",
                  license: "MIT",
                  template: tpl,
                  scripts: { test: cmd }
                })
                const pjTargets = PackageJson.targets(pjDecl, pkgRel, () => `//${pkgRel}:test`)
                if (plannedCalls(pjTargets.check).length === 0) throw new Error("packageJsonCheck")
                if (plannedCalls(pjTargets.write).length === 0) throw new Error("packageJsonWrite")

                // 2. NewPackage.scaffold & template rendering
                const newPkgName = scaffoldCase === "bad-name" ? "INVALID NAME!!" : `@demo/new-${pkgSlug}`
                const scaffoldPayload: NewPackage.ScaffoldPayload = {
                  directory: "packages",
                  version: "0.1.0",
                  license: "MIT",
                  fields: { sideEffects: false }
                }
                if (scaffoldCase === "exists") {
                  yield* Effect.promise(async () => {
                    await Fs.mkdir(NodePath.join(ws, `packages/new-${pkgSlug}`), { recursive: true })
                    await Fs.writeFile(NodePath.join(ws, `packages/new-${pkgSlug}/package.json`), "{}\n", "utf8")
                  })
                }
                const boilerplateFiles = NewPackage.boilerplate(`@demo/new-${pkgSlug}`, scaffoldPayload)
                if (boilerplateFiles.length === 0) throw new Error("boilerplate")
                const withTpl = NewPackage.withTemplate(`@demo/new-${pkgSlug}`, scaffoldPayload, [
                  ["EXTRA.md.tmpl", "# {{name}} ({{identifier}})\n"],
                  ["package.json", "{\"type\":\"module\"}"]
                ])
                if (withTpl.length < boilerplateFiles.length) throw new Error("withTemplate")

                const scaffoldExit = yield* NewPackage.scaffold(
                  {
                    workspaceRoot: ws,
                    packageName: newPkgName,
                    ...(scaffoldCase === "io-fail"
                      ? {
                        io: {
                          rename: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
                        }
                      }
                      : {})
                  },
                  scaffoldPayload
                ).pipe(Effect.exit)
                if (scaffoldCase === "ok") {
                  if (Exit.isFailure(scaffoldExit)) {
                    throw new Error(`scaffold ok failed: ${JSON.stringify(scaffoldExit.cause)}`)
                  }
                } else {
                  if (!Exit.isFailure(scaffoldExit)) throw new Error(`expected scaffold failure for ${scaffoldCase}`)
                }
                void NewPackage.ScaffoldPackageLive({ workspaceRoot: ws })

                // 3. ToolBuild measureOutput / measureOutputs / verifyOutputs / readOutputManifest
                const outDir = NodePath.join(ws, "dist")
                yield* Effect.promise(async () => {
                  await Fs.mkdir(outDir, { recursive: true })
                  await Fs.writeFile(NodePath.join(outDir, "index.js"), `export const v = "${pkgSlug}"\n`, "utf8")
                })
                const declaredOut = { cwd: ".", paths: ["dist"] }
                const measured = yield* Effect.tryPromise(() =>
                  ToolBuild.measureOutputs(
                    ws,
                    ".",
                    ["dist"],
                    toolOutCase === "limit"
                      ? { limits: { ...ToolBuild.defaultCaptureLimits, files: 0, treeBytes: 1 } }
                      : {}
                  )
                ).pipe(Effect.exit)
                if (toolOutCase === "limit") {
                  if (!Exit.isFailure(measured)) throw new Error("expected measureOutputs limit failure")
                } else if (Exit.isSuccess(measured)) {
                  const manifest = measured.value
                  const parsedM = ToolBuild.readOutputManifest(declaredOut, manifest)
                  if (typeof parsedM === "string") throw new Error(`readOutputManifest: ${parsedM}`)
                  if (toolOutCase === "missing") {
                    yield* Effect.promise(() => Fs.unlink(NodePath.join(outDir, "index.js")))
                  } else if (toolOutCase === "mutated") {
                    yield* Effect.promise(() => Fs.writeFile(NodePath.join(outDir, "index.js"), "MUTATED\n", "utf8"))
                  } else if (toolOutCase === "extra") {
                    yield* Effect.promise(() => Fs.writeFile(NodePath.join(outDir, "extra.js"), "EXTRA\n", "utf8"))
                  }
                  const mismatch = yield* Effect.promise(() => ToolBuild.verifyOutputs(ws, declaredOut, manifest))
                  if (toolOutCase === "ok") {
                    if (mismatch !== undefined) throw new Error(`expected verifyOutputs ok, got: ${mismatch}`)
                  } else {
                    if (mismatch === undefined) throw new Error(`expected verifyOutputs mismatch for ${toolOutCase}`)
                  }
                }
                void ToolBuild.CaptureOutputsLive({ workspaceRoot: ws, cacheDirectory: ".flows" })

                return true
              }),
            { executions: fsExecutions, seed: seed + 1 }
          )
        )
        assertPassed(report)
      } finally {
        await Fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Shell rules/durations/tokens, LlmLint.promptEngine/budget/onCredentials/required & Exec script/heldOutput fuzz invariants",
    async () => {
      const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-deep5b-")))
      try {
        const fakeClaude = NodePath.join(tmpRoot, "fake-claude.mjs")
        await Fs.writeFile(
          fakeClaude,
          `#!${process.execPath}\nfor await (const _ of process.stdin) {}\nprocess.stdout.write(JSON.stringify({ type: "result", result: "[]" }));\n`,
          "utf8"
        )
        await Fs.chmod(fakeClaude, 0o755)
        await Fs.writeFile(NodePath.join(tmpRoot, "run.mjs"), "process.stdout.write('script-ran');\n", "utf8")

        const arb = Arbitrary.schema(
          Schema.Struct({
            dur: Schema.Literals(["500ms", "10s", "2m", "1h", "invalid"]),
            shellForm: Schema.Literals(["shell", "script", "bin", "bun", "serve", "diff", "build"]),
            llmCase: Schema.Literals([
              "prompt-ok",
              "prompt-bad-model",
              "empty-required",
              "budget-exhausted",
              "on-creds-fail"
            ])
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ dur, shellForm, llmCase }) =>
              Effect.gen(function*() {
                // 1. Shell durations, env helpers, tokens & all rule variants
                const ms = Shell.durationMs(dur)
                if (typeof ms !== "number" || ms <= 0) throw new Error("durationMs")
                void Shell.observedEnv(["CI", "NODE_ENV"])
                void Shell.givenEnv({ A: "1" })
                void Shell.flagToken("release")
                void Shell.scriptToken("scripts/build.ts")
                void Shell.scriptInterpreterToken("scripts/build.ts")
                void Shell.scriptInterpreterToken("scripts/build.sh")

                const toolRef = Reference.NodeModule.Bin("vitest", "vitest")
                if (shellForm === "shell") {
                  plannedCalls(
                    Shell.Test({
                      shell: "echo hi",
                      env: { FOO: "1" },
                      inheritEnv: ["PATH"],
                      timeout: "30s",
                      exclusive: true
                    })
                  )
                } else if (shellForm === "script") {
                  plannedCalls(Shell.Run({ script: Input.file("run.mjs"), args: ["--flag"] }))
                } else if (shellForm === "bin") {
                  plannedCalls(Shell.Test({ bin: toolRef, args: ["run"] }))
                } else if (shellForm === "bun") {
                  plannedCalls(Shell.Run({ bun: "run.mjs" }))
                } else if (shellForm === "serve") {
                  plannedCalls(Shell.Serve({ shell: "echo serving" }))
                } else if (shellForm === "diff") {
                  plannedCalls(Shell.Diff({ shell: "echo diff", changes: ["src/a.ts"] }))
                } else {
                  plannedCalls(Shell.Build({ shell: "echo build", outDirs: ["dist"] }))
                }

                // 2. LlmLint.promptEngine & review edge cases
                if (llmCase === "prompt-ok") {
                  const ans = yield* LlmLint.promptEngine(
                    { workspaceRoot: tmpRoot, executable: fakeClaude, timeoutMs: 15_000 },
                    { engine: "claude", model: "claude-opus-5-5", prompt: "hello" }
                  )
                  if (ans !== "[]") throw new Error(`unexpected promptEngine answer: ${ans}`)
                } else if (llmCase === "prompt-bad-model") {
                  const exit = yield* LlmLint.promptEngine(
                    { workspaceRoot: tmpRoot, executable: fakeClaude },
                    { engine: "claude", model: "", prompt: "hello" }
                  ).pipe(Effect.exit)
                  if (!Exit.isFailure(exit)) throw new Error("expected empty model failure")
                } else if (llmCase === "empty-required") {
                  const exit = yield* LlmLint.review(
                    { workspaceRoot: tmpRoot, snapshot: [], executable: fakeClaude },
                    {
                      base: "HEAD",
                      include: [Input.glob("src/**/*.ts")],
                      context: [],
                      prompt: "Review",
                      rubric: "Rubric",
                      engine: "claude",
                      model: "claude-opus-5-5",
                      batchSize: 4,
                      failOn: "error",
                      required: true
                    }
                  ).pipe(Effect.exit)
                  if (!Exit.isFailure(exit)) throw new Error("expected required empty failure")
                } else if (llmCase === "budget-exhausted") {
                  const exit = yield* LlmLint.review(
                    {
                      workspaceRoot: tmpRoot,
                      snapshot: [{ path: "src/a.ts", contents: "export const x = 1\n", changed: true, deleted: false }],
                      executable: fakeClaude
                    },
                    {
                      base: "HEAD",
                      include: [Input.glob("src/**/*.ts")],
                      context: [],
                      prompt: "Review",
                      rubric: "Rubric",
                      engine: "claude",
                      model: "claude-opus-5-5",
                      batchSize: 4,
                      failOn: "error",
                      budget: { maxTokens: 1, wallMs: 1 } as never
                    }
                  ).pipe(Effect.exit)
                  void exit
                } else {
                  const exit = yield* LlmLint.review(
                    {
                      workspaceRoot: tmpRoot,
                      snapshot: [{
                        path: "src/a.ts",
                        contents: "export const GITHUB_TOKEN = \"ghp_abcdefghijklmnopqrstuvwxyz1234567890\"\n",
                        changed: true,
                        deleted: false
                      }],
                      executable: fakeClaude,
                      onCredentials: () => Effect.fail(new Error("delivery boom"))
                    },
                    {
                      base: "HEAD",
                      include: [Input.glob("src/**/*.ts")],
                      context: [],
                      prompt: "Review",
                      rubric: "Rubric",
                      engine: "claude",
                      model: "claude-opus-5-5",
                      batchSize: 4,
                      failOn: "error"
                    }
                  ).pipe(Effect.exit)
                  if (!Exit.isFailure(exit)) throw new Error("expected onCredentials failure")
                }

                // 3. Exec script token resolution
                const scriptRes = yield* Exec.run(
                  { workspaceRoot: tmpRoot },
                  {
                    cwd: ".",
                    argv: [process.execPath, `${Exec.scriptTokenPrefix}run.mjs}`],
                    env: {},
                    secrets: [],
                    expectedExitCodes: [0],
                    timeoutMs: 15_000
                  }
                )
                if (scriptRes.stdout !== "script-ran") throw new Error(`unexpected scriptRes: ${scriptRes.stdout}`)

                return true
              }),
            { executions: fsExecutions, seed: seed + 2 }
          )
        )
        assertPassed(report)
      } finally {
        await Fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    120_000
  )
})
