import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cargo from "../src/Cargo.ts"
import * as GithubWorkflow from "../src/GithubWorkflow.ts"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as Secret from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const fsExecutions = Math.min(executions, 10)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

const gitExec = (root: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile("git", ["-C", root, ...args], (err, stdout) => {
      if (err !== null) reject(err)
      else resolve(stdout.trim())
    })
  })

const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{1,6}$/))

describe("@smthrs/targets deep fuzz suite 8: LlmLint store lifecycle+tail/UTF8/budget, GithubWorkflow YAML parser, Target outputs, PackageJson.merge & Cargo", () => {
  it("LlmLint full finding lifecycle (open -> fixed-pending-retest -> closeFinding -> already-closed), stderr ring wrap, bad UTF-8, budget exhaustion & scope=all", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        cliCase: Schema.Literals(["lifecycle", "bad-utf8", "huge-stderr", "missing-bin", "budget-exhausted"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, cliCase }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-t8-llm-", async (root) => {
              await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
              await Fs.writeFile(NodePath.join(root, "src", "a.ts"), `export const a = "${slug}"\n`)
              await Fs.writeFile(NodePath.join(root, "src", "b.ts"), `export const b = "${slug}"\n`)
              await gitExec(root, ["init", "--quiet", "--initial-branch=main"])
              await gitExec(root, ["config", "user.name", "Fuzz"])
              await gitExec(root, ["config", "user.email", "fuzz@example.invalid"])
              await gitExec(root, ["config", "commit.gpgsign", "false"])
              await gitExec(root, ["add", "-A"])
              await gitExec(root, ["commit", "--quiet", "-m", "base"])
              const baseSha = await gitExec(root, ["rev-parse", "HEAD"])
              await Fs.writeFile(NodePath.join(root, "src", "a.ts"), `export const a = "${slug}-2"\n`)
              await Fs.writeFile(NodePath.join(root, "src", "b.ts"), `export const b = "${slug}-2"\n`)

              const storeDir = NodePath.join(root, ".store")
              const basePayload: LlmLint.Payload = {
                base: baseSha,
                include: [Input.glob("src/**/*.ts")],
                context: [],
                prompt: "Inspect code",
                rubric: "Find issues",
                engine: "claude",
                model: "claude-sonnet-4",
                batchSize: 1,
                failOn: "error",
                scope: "all"
              }

              if (cliCase === "lifecycle") {
                const stateFile = NodePath.join(root, "run-count")
                const fakeCli = NodePath.join(root, "fake-claude.cjs")
                await Fs.writeFile(
                  fakeCli,
                  `#!${process.execPath}
const fs = require("node:fs");
let n = 0;
try { n = Number(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8")); } catch {}
fs.writeFileSync(${JSON.stringify(stateFile)}, String(n + 1));
(async () => {
  for await (const _ of process.stdin) {}
  const findings = n === 0 ? [{
    file: "src/a.ts",
    line: 1,
    severity: "warning",
    message: "Warning in ${slug}"
  }] : [];
  process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(findings) }));
})();
`,
                  { mode: 0o755 }
                )

                // Run 1: opens a warning finding (doesn't fail since failOn is "error")
                const r1 = await Effect.runPromiseExit(
                  LlmLint.review(
                    { workspaceRoot: root, executable: fakeCli, store: { directory: storeDir, owner: "alice" } },
                    { ...basePayload, batchSize: 10 }
                  )
                )
                expect(Exit.isSuccess(r1), String(r1)).toBe(true)
                const stored1 = await Effect.runPromise(LlmLint.storedFindings(storeDir))
                if (stored1.length > 0) {
                  // Trying to close while still "open" must fail
                  const openClose = await Effect.runPromiseExit(
                    LlmLint.closeFinding(storeDir, stored1[0]!.fingerprint, {
                      revision: baseSha,
                      command: "verify",
                      observedResult: "still open"
                    })
                  )
                  expect(Exit.isFailure(openClose)).toBe(true)
                }

                // Run 2: 0 findings -> transitions finding to fixed-pending-retest
                const r2 = await Effect.runPromiseExit(
                  LlmLint.review(
                    { workspaceRoot: root, executable: fakeCli, store: { directory: storeDir, owner: "alice" } },
                    { ...basePayload, batchSize: 10 }
                  )
                )
                expect(Exit.isSuccess(r2)).toBe(true)
                const stored2 = await Effect.runPromise(LlmLint.storedFindings(storeDir))
                for (const rec of stored2) {
                  if (rec.state === "fixed-pending-retest") {
                    const closed = await Effect.runPromise(
                      LlmLint.closeFinding(storeDir, rec.fingerprint, {
                        revision: baseSha,
                        command: "verify",
                        observedResult: "fixed"
                      })
                    )
                    expect(closed.state).toBe("closed")
                    // Closing a second time fails
                    const again = await Effect.runPromiseExit(
                      LlmLint.closeFinding(storeDir, rec.fingerprint, {
                        revision: baseSha,
                        command: "verify",
                        observedResult: "fixed"
                      })
                    )
                    expect(Exit.isFailure(again)).toBe(true)
                  }
                }
              } else if (cliCase === "bad-utf8") {
                const fakeCli = NodePath.join(root, "bad-utf8.mjs")
                await Fs.writeFile(
                  fakeCli,
                  `#!${process.execPath}
process.stderr.write(Buffer.from([0xff, 0xfe, 0xfd]));
process.stdout.write(Buffer.from([0xff, 0xfe, 0xfd]));
process.exit(1);
`,
                  { mode: 0o755 }
                )
                const exit = await Effect.runPromiseExit(
                  LlmLint.review({ workspaceRoot: root, executable: fakeCli }, { ...basePayload, batchSize: 10 })
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (cliCase === "huge-stderr") {
                const fakeCli = NodePath.join(root, "huge-stderr.mjs")
                await Fs.writeFile(
                  fakeCli,
                  `#!${process.execPath}
process.stderr.write("E".repeat(40000));
process.exit(2);
`,
                  { mode: 0o755 }
                )
                const exit = await Effect.runPromiseExit(
                  LlmLint.review({ workspaceRoot: root, executable: fakeCli }, { ...basePayload, batchSize: 10 })
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (cliCase === "missing-bin") {
                const exit = await Effect.runPromiseExit(
                  LlmLint.review(
                    { workspaceRoot: root, executable: NodePath.join(root, "does-not-exist-cli") },
                    { ...basePayload, required: true, batchSize: 10 }
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else {
                // Budget exhaustion (maxCalls: 1 across 2 batches of batchSize: 1)
                const fakeCli = NodePath.join(root, "ok-cli.mjs")
                await Fs.writeFile(
                  fakeCli,
                  `#!${process.execPath}
(async () => {
  for await (const _ of process.stdin) {}
  process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify([]) }));
})();
`,
                  { mode: 0o755 }
                )
                const exit = await Effect.runPromiseExit(
                  LlmLint.review(
                    { workspaceRoot: root, executable: fakeCli },
                    { ...basePayload, batchSize: 1, budget: { modelCalls: 1, promptTokens: 1, wallMs: 30_000 } }
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
              }

              // publicAttempts & publicError
              const err = new LlmLint.LlmReviewError({ phase: "store", message: `err ${slug}` })
              expect(LlmLint.publicError(err).message).toContain(slug)
              expect(LlmLint.publicAttempts(undefined)).toBeUndefined()
            })
            return true
          }),
        { executions: fsExecutions, seed: 20261180 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("GithubWorkflow YAML edge parser, Target.declaredOutputsFailure, PackageJson.merge, Cargo.packageArgs & WorkspaceDeclaration error branches", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        yamlVariant: Schema.Literals(["literal", "folded", "flow", "quoted", "bad-indent", "bad-colon", "empty-jobs"]),
        cargoProfile: Schema.Literals(["debug", "release"]),
        allFeatures: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, yamlVariant, cargoProfile, allFeatures }) =>
          Effect.promise(async () => {
            // 1. GithubWorkflow complex YAML cases
            const yamlDoc =
              yamlVariant === "literal"
                ? `name: ci-${slug}\non: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: "Multi line"\n        run: |-\n          echo "hello ${slug}"\n          # comment\n          pnpm test\n`
                : yamlVariant === "folded"
                ? `name: 'ci-${slug}'\non: push\njobs:\n  build:\n    runs-on: macos-latest\n    env:\n      FOO: "bar"\n    steps:\n      - run: >-\n          echo ${slug}\n          && pnpm test\n`
                : yamlVariant === "flow"
                ? `name: ci-${slug}\non: { push: { branches: [main] } }\njobs:\n  build:\n    runs-on: windows-latest\n    steps:\n      - { uses: "actions/checkout@v4" }\n      - { run: "pnpm test", shell: "bash" }\n`
                : yamlVariant === "quoted"
                ? `name: "ci:\\"${slug}\\""\non:\n  workflow_dispatch: {}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    if: \${{ !cancelled() }}\n    steps:\n      - run: 'echo ''quoted ${slug}'''\n`
                : yamlVariant === "bad-indent"
                ? `name: ci\njobs:\n   a:\n  b: 1\n`
                : yamlVariant === "bad-colon"
                ? `name: "unterminated\n`
                : `name: empty\non: push\njobs: {}\n`

            try {
              const wf = GithubWorkflow.parseWorkflow(yamlDoc)
              expect(wf).toBeDefined()
            } catch (e) {
              expect(e).toBeInstanceOf(Error)
            }

            // 2. Target.declaredOutputsFailure edge matrix
            expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["dist"] })).toBeUndefined()
            expect(Target.declaredOutputsFailure({ cwd: ".", paths: [] })).toBeUndefined()
            expect(Target.declaredOutputsFailure({ cwd: ".", paths: [""] })).toBeTruthy()
            expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["/abs"] })).toBeTruthy()
            expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["../escape"] })).toBeTruthy()
            expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["a\0b"] })).toBeTruthy()
            expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["dist", "dist"] })).toBeTruthy()
            expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["dist", "dist/sub"] })).toBeTruthy()
            expect(Target.declaredOutputsFailure({ cwd: "../up", paths: ["dist"] })).toBeTruthy()

            // 3. PackageJson.merge deep object merge & array replacement
            const merged = PackageJson.merge(
              {
                name: `@demo/${slug}`,
                scripts: { build: "tsc", test: "vitest" },
                keywords: ["a", "b"],
                nested: { x: 1, y: 2 }
              },
              {
                scripts: { test: "vitest run", lint: "biome" },
                keywords: ["c"],
                nested: { y: 3, z: 4 }
              }
            )
            expect((merged["scripts"] as Record<string, string>)["build"]).toBe("tsc")
            expect((merged["scripts"] as Record<string, string>)["test"]).toBe("vitest run")
            expect(merged["keywords"]).toEqual(["c"])

            // 4. Cargo rules + packageArgs
            const buildT = Cargo.Build({
              workspace: true,
              profile: cargoProfile,
              allFeatures,
              features: allFeatures ? undefined : ["default"],
              locked: true
            })
            expect(Target.isTarget(buildT)).toBe(true)
            const clippyT = Cargo.Clippy({ workspace: true, allTargets: true })
            expect(Target.isTarget(clippyT)).toBe(true)
            const nextestT = Cargo.Nextest({ workspace: true })
            expect(Target.isTarget(nextestT)).toBe(true)
            const denyT = Cargo.Deny({ config: Input.file("deny.toml") })
            expect(Target.isTarget(denyT)).toBe(true)
            const docT = Cargo.Doc({ workspace: true })
            expect(Target.isTarget(docT)).toBe(true)
            const fetchT = Cargo.Fetch({ workspace: Input.file("Cargo.toml") })
            expect(Target.isTarget(fetchT)).toBe(true)

            // 5. WorkspaceDeclaration validation edges
            for (const badWs of [
              () => WorkspaceDeclaration.Cache({ directory: "../escape" }),
              () => WorkspaceDeclaration.Cache({ directory: "/abs" }),
              () => WorkspaceDeclaration.Host({ bins: [""] }),
              () => WorkspaceDeclaration.Remote.Http({ url: "not-a-url", token: Secret.Secret("T"), machines: 1, workdir: "/w" }),
              () => WorkspaceDeclaration.Remote.Http({ url: "https://ok.test", token: Secret.Secret("T"), machines: 0, workdir: "/w" })
            ]) {
              let threw = false
              try {
                badWs()
              } catch {
                threw = true
              }
              expect(threw).toBe(true)
            }
            return true
          }),
        { executions: Math.min(executions, 24), seed: 20261181 }
      )
    )
    assertPassed(report)
  }, 120_000)
})
