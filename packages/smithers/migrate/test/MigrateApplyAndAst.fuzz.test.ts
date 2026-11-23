import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Fuzz } from "@smthrs/fuzz"
import { Capability, GrantStore, Workspace } from "@smthrs/kernel"
import { Arbitrary, Effect, Layer, Schema } from "effect"
import { CliConfig, Command } from "effect/cli"
import * as FsSync from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Checks from "../src/Checks.ts"
import * as Constructs from "../src/Constructs.ts"
import * as Archive from "../src/flow/Archive.ts"
import * as Checkpoint from "../src/flow/Checkpoint.ts"
import * as Cli from "../src/flow/Cli.ts"
import * as CommandModule from "../src/flow/Command.ts"
import * as Contract from "../src/flow/Contract.ts"
import * as Canonical from "../src/flow/internal/Canonical.ts"
import * as Exec from "../src/flow/internal/Exec.ts"
import * as Pending from "../src/flow/internal/Pending.ts"
import * as Vcs from "../src/flow/internal/Vcs.ts"
import * as Layers from "../src/flow/Layers.ts"
import * as Lock from "../src/flow/Lock.ts"
import * as MigrateFlow from "../src/flow/MigrateFlow.ts"
import * as Options from "../src/flow/Options.ts"
import * as Transform from "../src/flow/Transform.ts"
import * as Verify from "../src/flow/Verify.ts"
import * as CliScripts from "../src/internal/CliScripts.ts"
import * as CommandLine from "../src/internal/CommandLine.ts"
import * as FsInternal from "../src/internal/Fs.ts"
import * as Jsonc from "../src/internal/Jsonc.ts"
import * as Semver from "../src/internal/Semver.ts"
import * as Ts from "../src/internal/Ts.ts"
import * as Versions from "../src/internal/Versions.ts"
import * as Inventory from "../src/Inventory.ts"
import * as Mapping from "../src/Mapping.ts"
import * as MigrateError from "../src/MigrateError.ts"
import * as PromptHints from "../src/PromptHints.ts"
import * as Report from "../src/Report.ts"
import * as RunState from "../src/RunState.ts"
import * as Scan from "../src/Scan.ts"
import * as Units from "../src/Units.ts"
import * as ZodSchemaHints from "../src/ZodSchemaHints.ts"
import {
  copyFixture,
  fixture,
  hashTree,
  journeyHost,
  nativeHelperAvailable,
  nodeLayer,
  unconfinedNode
} from "./fixtures/helpers.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const goldenFlow = FsSync.readFileSync(
  Path.join(fixture("jsx-single.migrated"), ".smithers", "flows", "simple-workflow", "flow.ts"),
  "utf8"
)

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

describe("@smthrs/migrate AST, Archive, Checkpoint, Lock, Verify, Command, Cli & Flow fuzz invariants", () => {
  it("Jsonc, Semver, CliScripts, Archive rewrites, Mapping & Canonical uphold structural invariants", async () => {
    const constructNames = Constructs.constructs.map((c) => c.name)
    const arb = Arbitrary.schema(
      Schema.Struct({
        constructIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: constructNames.length - 1 })),
        v1: Schema.Literals([
          "0.9.0",
          "^0.12.3",
          "~0.0.1-alpha.1",
          "1.0.0",
          "1.0.0-rc.18",
          "4.1.1",
          "workspace:*",
          "latest",
          "not-semver",
          ">=0.8.0 <1.0.0",
          ""
        ]),
        v2: Schema.Literals(["0.9.0", "0.10.0", "1.0.0-rc.1", "1.0.0", "2.0.0"]),
        script: Schema.Literals([
          "smthrs up workflows/a.tsx",
          "smithers-orchestrator run workflows/demo.tsx --input {}",
          "bunx smthrs up ./flows/main.tsx && pnpm test",
          "NODE_ENV=production npx smithers-orchestrator up src/wf.tsx",
          "pnpm smthrs resume run-123",
          "vitest run",
          "echo http://example.com // not comment && smthrs run a.tsx || true",
          ""
        ]),
        commentBody: Schema.Literals([
          `{\n  // line comment\n  "compilerOptions": {\n    /* block comment */\n    "jsxImportSource": "smithers-orchestrator",\n    "paths": { "smthrs": ["./src"], "app/*": ["./app/*"] }\n  }\n}`,
          `{\n  "url": "https://example.com//keep/*this*/",\n  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "smthrs" }\n}`,
          `{ "unterminated": /* oops`
        ]),
        gitignore: Schema.Literals(["node_modules/\n", ".flows/\ndist/\n", ""]),
        depField: Schema.Literals(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]),
        keysOrder: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ constructIdx, v1, v2, script, commentBody, gitignore, depField, keysOrder }) =>
          Effect.sync(() => {
            // Jsonc.withoutComments
            const stripped = Jsonc.withoutComments(commentBody)
            if (commentBody.includes("https://example.com//keep/*this*/")) {
              assertInv(stripped.includes("https://example.com//keep/*this*/"), "url preserved in string")
              const parsed = JSON.parse(stripped)
              assertInv(parsed.url === "https://example.com//keep/*this*/", "parsed url matches")
            }
            if (commentBody.includes("line comment")) {
              const parsed = JSON.parse(stripped)
              assertInv(Boolean(parsed.compilerOptions), "compilerOptions parsed after comment strip")
            }

            // Semver
            const p1 = Semver.parse(v1)
            const p2 = Semver.parse(v2)
            if (p1 && p2) {
              const cmp12 = Semver.compare(p1, p2)
              const cmp21 = Semver.compare(p2, p1)
              assertInv(Math.sign(cmp12) === -Math.sign(cmp21), "Semver.compare antisymmetry")
              assertInv(Semver.compare(p1, p1) === 0, "Semver.compare reflexivity")
            }
            const beforeOne = Semver.isBeforeOneZero(v1)
            if (v1 === "0.9.0") assertInv(beforeOne, "0.9.0 is before 1.0")
            if (v1 === "1.0.0") assertInv(!beforeOne, "1.0.0 is not before 1.0")

            // CliScripts
            const rw = CliScripts.rewrite(script, (p) => Units.flowName(p))
            assertInv(
              typeof rw.after === "string" && (rw.unsupported === undefined || typeof rw.unsupported === "string"),
              "CliScripts shape"
            )
            if (script === "vitest run") assertInv(rw.after === "vitest run", "non-smithers script untouched")

            // Archive pure rewrites
            assertInv(Archive.pinFor("effect") === Versions.effectVersion, "pinFor effect")
            assertInv(Archive.pinFor("@smthrs/flow") === Versions.smithersVersion, "pinFor @smthrs/flow")
            assertInv(
              Versions.effectPinFor(depField) === Versions.effectVersion || depField === "peerDependencies",
              "effectPinFor"
            )

            const manifestInput = JSON.stringify({
              name: "fuzz-app",
              scripts: { dev: script, test: "vitest run" },
              [depField]: {
                "smithers-orchestrator": "^0.9.0",
                effect: v1,
                zod: "^3.23.0"
              }
            })
            const mf = Archive.rewriteManifest(manifestInput, {
              remove: ["smithers-orchestrator", "zod"],
              add: ["@smthrs/flow", "@smthrs/plan"]
            })
            const mfParsed = JSON.parse(mf.text)
            assertInv(mfParsed[depField]?.["smithers-orchestrator"] === undefined, "old dep removed")
            assertInv(mfParsed.dependencies?.["@smthrs/flow"] === Versions.smithersVersion, "flow pinned")

            const srw = Archive.rewriteScripts({ dev: script, test: "vitest run" })
            assertInv(Array.isArray(srw) && srw.length === 2, "rewriteScripts count")

            const rewrittenPkg = Archive.rewritten("package.json", manifestInput, {}, "dependencies")
            assertInv(rewrittenPkg !== undefined && typeof rewrittenPkg.text === "string", "Archive.rewritten pkg")
            const rewrittenProjPkg = Archive.rewritten("package.json", manifestInput, {}, "project")
            assertInv(
              rewrittenProjPkg !== undefined && typeof rewrittenProjPkg.text === "string",
              "Archive.rewritten proj"
            )

            if (!commentBody.includes("unterminated")) {
              const rewrittenTs = Archive.rewriteTsconfig(commentBody)
              assertInv(typeof rewrittenTs === "string", "rewriteTsconfig string")
              if (commentBody.includes("line comment")) {
                const tsParsed = JSON.parse(Jsonc.withoutComments(rewrittenTs))
                assertInv(tsParsed.compilerOptions?.jsxImportSource === undefined, "jsxImportSource stripped")
                assertInv(tsParsed.compilerOptions?.paths?.smthrs === undefined, "old paths stripped")
              }
            }
            assertInv(Archive.isOldPathsKey("smthrs"), "isOldPathsKey")
            assertInv(Archive.isOldJsxImportSource("smithers-orchestrator"), "isOldJsxImportSource")
            assertInv(Archive.isRewritable("package.json") && Archive.isRewritable(".gitignore"), "isRewritable true")
            assertInv(!Archive.isRewritable("src/workflow.tsx"), "isRewritable false")

            const gi = Archive.rewriteGitignore(gitignore)
            assertInv(gi.includes(".flows/"), "gitignore includes .flows/")

            // Canonical & CommandLine
            const objA = keysOrder ? { b: 2, a: { y: 1, x: [3, 4] } } : { a: { x: [3, 4], y: 1 }, b: 2 }
            const objB = { a: { x: [3, 4], y: 1 }, b: 2 }
            assertInv(Canonical.stringify(objA) === Canonical.stringify(objB), "Canonical key-order invariance")
            const quoted = CommandLine.quote(script)
            const rendered = CommandLine.renderArgv("node", ["-e", script])
            const shellRes = CommandLine.shellResource(script)
            assertInv(
              typeof quoted === "string" && typeof rendered === "string" && typeof shellRes === "string",
              "CommandLine strings"
            )

            // Mapping across all catalogued constructs
            const cName = constructNames[constructIdx]!
            const c = Constructs.byName(cName)
            assertInv(Boolean(c) && Constructs.isCatalogued(cName), `Constructs.byName(${cName})`)
            const byC = Mapping.byConstruct(cName)
            const byI = Mapping.byImport(cName)
            const syntheticHit: Inventory.InventoryEntry = {
              file: "workflows/demo.tsx",
              line: 1,
              column: 1,
              construct: cName,
              props: c!.kind === "component" ? ["id", "output"] : [],
              detail: c!.kind === "component" ? { id: `"t1"`, children: `"hi"` } : undefined
            }
            const classified = Mapping.classifyWithReason(syntheticHit)
            const cls = Mapping.classify(syntheticHit)
            assertInv(classified.class === cls, "Mapping.classify matches classifyWithReason")
            const snip = Mapping.snippet(syntheticHit)
            assertInv(snip === undefined || typeof snip === "string", "Mapping.snippet type")
            if (byC) assertInv(byC.construct === cName, "Mapping.byConstruct match")
            if (byI) assertInv(typeof byI.construct === "string", "Mapping.byImport match")

            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
    expect(Mapping.markdownTable()).toContain("|")
  })

  it("Options, Contract, Command helpers & Layers grant rules enforce path/run-state confinement", async () => {
    const noopExecutor = {
      execute: () => Effect.die("unused executor")
    } as unknown as Parameters<typeof Layers.seatResolver>[0]["executor"]
    const arb = Arbitrary.schema(
      Schema.Struct({
        scanFlag: Schema.Boolean,
        applyFlag: Schema.Boolean,
        allowUnsafe: Schema.Literals(["NONE", "", "all", "UI, Worktree", "Custom"]),
        ackRunState: Schema.Boolean,
        allowNoVcs: Schema.Boolean,
        keepOldSources: Schema.Boolean,
        unit: Schema.Literals(["NONE", "dependencies", "dependencies,workflow:demo"]),
        maxRepairRounds: Schema.Literals([-1, 0, 2]),
        reportDir: Schema.Literals(["NONE", ".smithers-migrate", ".out", "../escape", ".git"]),
        flowsDir: Schema.Literals(["NONE", ".smithers/flows", "src/flows", "/abs/path"]),
        providerEnv: Schema.Literals(["none", "anthropic", "openai", "openrouter"]),
        seat: Schema.Literals(["NONE", "anthropic:claude-sonnet-4-5", "openai:gpt-5", "bad-seat"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          scanFlag,
          applyFlag,
          allowUnsafe,
          ackRunState,
          allowNoVcs,
          keepOldSources,
          unit,
          maxRepairRounds,
          reportDir,
          flowsDir,
          providerEnv,
          seat
        }) =>
          Effect.gen(function*() {
            const optStr = (v: string): string | undefined => (v === "NONE" ? undefined : v)
            const opts = CommandModule.optionsOf(
              {
                root: "/tmp/fuzz-migrate-root",
                scan: scanFlag,
                apply: applyFlag,
                seat: optStr(seat),
                allowUnsafe: optStr(allowUnsafe),
                acknowledgeRunState: ackRunState,
                allowNoVcs,
                keepOldSources,
                unit: optStr(unit),
                maxRepairRounds: maxRepairRounds < 0 ? undefined : maxRepairRounds,
                reportDir: optStr(reportDir),
                flowsDir: optStr(flowsDir),
                verifyInstall: undefined,
                verifyFormat: undefined,
                verifyTypecheck: ["pnpm tsc --noEmit"],
                verifyTest: "pnpm test"
              },
              "/tmp/fallback"
            )
            // Mode safety: scan always beats apply
            if (scanFlag) assertInv(opts.mode === "scan", "scan beats apply")
            else if (applyFlag) assertInv(opts.mode === "apply", "apply mode")
            else assertInv(opts.mode === "plan", "plan default")

            const execId = CommandModule.executionId(opts, "2026-11-23T00:00:00.000Z")
            assertInv(execId.startsWith("migrate-"), "executionId prefix")

            const rDir = CommandModule.reportDirectory(opts)
            assertInv(rDir.startsWith(opts.root), "reportDirectory under root")

            const hostOwned = Options.hostOwnedDirectories(opts)
            assertInv(hostOwned.length > 0, "hostOwnedDirectories non-empty")
            const fDir = Options.flowsDir(opts)
            const rounds = Options.maxRepairRounds(opts)
            assertInv(typeof fDir === "string" && typeof rounds === "number", "flowsDir and maxRepairRounds")

            const state = Options.stateOf({
              SMITHERS_HOME: "/tmp/sm-home",
              HOME: "/tmp/home",
              TMPDIR: "/tmp"
            })
            const envBack = Options.scanEnvironment(state)
            assertInv(
              envBack.SMITHERS_HOME === "/tmp/sm-home" && envBack.HOME === "/tmp/home",
              "scanEnvironment roundtrip"
            )

            // Path validation invariants
            if (reportDir === "../escape" || reportDir === ".git") {
              const layoutErr = Options.layoutIssue({
                root: opts.root,
                reportDir,
                layout: { flowsDir: optStr(flowsDir) ?? ".smithers/flows" }
              })
              assertInv(layoutErr !== undefined, `layoutIssue rejects ${reportDir}`)
            }
            if (flowsDir === "/abs/path") {
              const relErr = Options.relativePathIssue("flowsDir", flowsDir)
              assertInv(relErr !== undefined, "relativePathIssue rejects absolute path")
            }

            // Contract helpers
            const cmdLine = Contract.commandLine(Units.argv("pnpm", "test", "--run"))
            const grantRes = Contract.grantResource("pnpm test")
            assertInv(cmdLine.includes("pnpm") && grantRes.includes("pnpm"), "Contract commandLine/grantResource")
            const failRep = Contract.failureReport({
              round: 1,
              verification: {
                typecheck: [{
                  command: "tsc --noEmit",
                  exitCode: 1,
                  durationMs: 12,
                  stdoutTail: "typecheck failed",
                  stderrTail: ""
                }]
              }
            })
            assertInv(failRep.includes("typecheck failed"), "failureReport includes stdoutTail")
            const prompt = Contract.unitPrompt(
              {
                id: "workflow:demo",
                kind: "workflow",
                root: opts.root,
                sources: [{ path: "workflows/demo.tsx", text: "export default 1" }],
                targets: [".smithers/flows/demo/flow.ts"],
                constructs: [{
                  file: "workflows/demo.tsx",
                  line: 1,
                  column: 1,
                  construct: "Workflow",
                  props: ["name"],
                  class: "automatic"
                }],
                mapping: [],
                hints: [],
                unsafe: [],
                operatorDecisions: [],
                runStatePaths: [".smithers/smithers.db"],
                approvedPackages: ["@smthrs/flow"],
                commands: { typecheck: [], test: "pnpm test", flowsDir: ".smithers/flows" }
              },
              {
                round: 1,
                verification: {
                  typecheck: [{
                    command: "tsc --noEmit",
                    exitCode: 1,
                    durationMs: 5,
                    stdoutTail: "fail",
                    stderrTail: ""
                  }]
                }
              }
            )
            assertInv(prompt.includes("workflow:demo"), "unitPrompt includes unit id")

            // Layers provider / seat / grant rules
            const env: Record<string, string> = providerEnv === "anthropic"
              ? { ANTHROPIC_API_KEY: "test-key" }
              : providerEnv === "openai"
              ? { OPENAI_API_KEY: "test-key" }
              : providerEnv === "openrouter"
              ? { OPENROUTER_API_KEY: "test-key" }
              : {}
            const prov = Layers.configuredProvider(env)
            if (providerEnv === "none") assertInv(prov === undefined, "no provider key -> undefined")
            else assertInv(prov === providerEnv, `configuredProvider === ${providerEnv}`)

            const resolver = Layers.seatResolver({ seat: optStr(seat), environment: env, executor: noopExecutor })
            const resolved = yield* resolver.resolve(Transform.seat).pipe(Effect.result)
            assertInv(resolved._tag === "Success" || resolved._tag === "Failure", "seatResolver settles")

            // Real kernel grant store must ALWAYS deny writes to 0.x run state!
            const mRoot = yield* Layers.migrationRoot("/tmp/fuzz-migrate-root")
            const runStatePaths = [".smithers/smithers.db", ".smithers/executions"]
            const commands: Contract.Commands = {
              install: "pnpm install",
              format: "dprint fmt",
              typecheck: ["tsc --noEmit"],
              test: "vitest run",
              flowsDir: ".smithers/flows"
            }
            const vCmds = Layers.verificationCommands(commands)
            const vRes = Layers.verificationResources(commands)
            assertInv(vCmds.length === 4 && vRes.length === 4, "verificationCommands/Resources count")

            const storeLayer = GrantStore.layer({
              attended: false,
              rules: Layers.rules({ root: mRoot, runStatePaths, commands })
            }).pipe(Layer.provide(Workspace.layer(mRoot)), Layer.orDie)

            const runStateWriteAllowed = yield* Effect.gen(function*() {
              const grants = yield* GrantStore.GrantStore
              return yield* grants.check(Capability.make("fs:write", ".smithers/smithers.db")).pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false))
              )
            }).pipe(Effect.provide(storeLayer))
            assertInv(!runStateWriteAllowed, "kernel GrantStore denies fs:write to 0.x run state")

            const verEnv = Layers.verificationEnvironment({
              PATH: "/usr/bin",
              ANTHROPIC_API_KEY: "secret-should-not-leak",
              HOME: "/tmp"
            })
            assertInv(verEnv.ANTHROPIC_API_KEY === undefined, "verificationEnvironment strips API keys")

            const err = MigrateError.make("unsafe-blocked", "blocked", "detail")
            assertInv(CommandModule.isMigrateError(err), "isMigrateError true")

            const emptyRep = Report.finalize(Report.empty(opts.root, opts.mode, "2026-11-23T00:00:00.000Z"))
            const renderedText = CommandModule.render(emptyRep, "human", rDir)
            const renderedJson = CommandModule.render(emptyRep, "json", rDir)
            assertInv(
              typeof renderedText === "string" && JSON.parse(renderedJson).mode === opts.mode,
              "Command.render human & json"
            )
            assertInv(CommandModule.exitCode(emptyRep) === emptyRep.exitCode, "Command.exitCode")

            const envEnvelope = Transform.envelope()
            const bindings = yield* Transform.bindings()
            assertInv(envEnvelope.length > 0 && bindings !== undefined, "Transform.envelope & bindings")

            return true
          }),
        { seed: seed + 1, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("RunState SQLite scanner, Checks, Inventory, Fs & Zod/Prompt hints handle rich synthetic repos", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-mig-rs-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          runStatus: Schema.Literals(["running", "finished", "failed", "cancelled", "waiting"]),
          corruptDb: Schema.Boolean,
          hasExternalEnv: Schema.Boolean,
          hasExecDir: Schema.Boolean,
          flowBroken: Schema.Literals(["clean", "oldImport", "todoMarker", "asAny", "jsxRemnant"]),
          mutateRunState: Schema.Boolean,
          hasSymlink: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ runStatus, corruptDb, hasExternalEnv, hasExecDir, flowBroken, mutateRunState, hasSymlink }) =>
            Effect.gen(function*() {
              const dir = FsSync.mkdtempSync(Path.join(tmpRoot, "repo-"))
              try {
                FsSync.mkdirSync(Path.join(dir, ".smithers", "flows", "demo"), { recursive: true })
                FsSync.mkdirSync(Path.join(dir, "workflows"), { recursive: true })
                FsSync.writeFileSync(
                  Path.join(dir, "package.json"),
                  JSON.stringify({
                    name: "rich-fuzz",
                    scripts: { test: "node -e \"process.exit(0)\"", typecheck: "tsc --noEmit" },
                    dependencies: {
                      "smithers-orchestrator": "^0.9.0",
                      zod: "^3.23.0",
                      "@ai-sdk/anthropic": "^1.0.0"
                    }
                  })
                )

                const wfSource = [
                  `import { createSmithers, Sequence, Parallel, Branch, Loop, Approval, Worktree } from "smithers-orchestrator"`,
                  `import { ClaudeCodeAgent } from "smithers-orchestrator/agents"`,
                  `import prompt from "./hello.mdx"`,
                  `import { z } from "zod"`,
                  `export const Out = z.object({ title: z.string().min(1), count: z.number().int().default(0), tags: z.array(z.string()).optional() })`,
                  `export const { Workflow, Task, smithers } = createSmithers({ out: Out })`,
                  `const agent = new ClaudeCodeAgent({ model: "claude-sonnet-4-5" })`,
                  `export default smithers((ctx) => (`,
                  `  <Workflow name="demo">`,
                  `    <Sequence>`,
                  `      <Parallel><Task id="a" output={Out} agent={agent}>{prompt}</Task></Parallel>`,
                  `      <Branch if={true} then={<Task id="b" output={Out}>ok</Task>} />`,
                  `      <Loop until={false} maxIterations={3}><Task id="c" output={Out}>loop</Task></Loop>`,
                  `    </Sequence>`,
                  `  </Workflow>`,
                  `))`
                ].join("\n")
                FsSync.writeFileSync(Path.join(dir, "workflows", "demo.tsx"), wfSource)
                FsSync.writeFileSync(
                  Path.join(dir, "workflows", "hello.mdx"),
                  "# Hello {{name}}\nCheck {props.repo}.\n"
                )

                // Real SQLite database or corrupt db
                const dbPath = Path.join(dir, ".smithers", "smithers.db")
                if (corruptDb) {
                  FsSync.writeFileSync(dbPath, "NOT A VALID SQLITE FILE")
                } else {
                  const db = new DatabaseSync(dbPath)
                  db.exec(
                    "CREATE TABLE _smithers_runs (run_id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)"
                  )
                  const now = Date.now()
                  db.prepare(
                    "INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)"
                  ).run("run-1", "demo", runStatus, now, now)
                  db.close()
                }

                if (hasExternalEnv) {
                  FsSync.writeFileSync(Path.join(dir, ".env"), "DATABASE_URL=postgres://user:pass@localhost:5432/app\n")
                }
                if (hasExecDir) {
                  FsSync.mkdirSync(Path.join(dir, ".smithers", "executions", "e1"), { recursive: true })
                  FsSync.writeFileSync(Path.join(dir, ".smithers", "executions", "e1", "journal.json"), "{}")
                }
                if (hasSymlink) {
                  FsSync.symlinkSync("workflows/demo.tsx", Path.join(dir, "demo-link.tsx"))
                }

                // FsInternal helpers
                const walked = yield* FsInternal.walkReport(dir)
                const walkedPaths = yield* FsInternal.walk(dir)
                const walkedAll = yield* FsInternal.walkAll(dir)
                assertInv(
                  walked.files.length > 0 && walkedPaths.length > 0 && walkedAll.length > 0,
                  "FsInternal walk non-empty"
                )
                if (hasSymlink) {
                  const lt = yield* FsInternal.linkTarget(Path.join(dir, "demo-link.tsx"))
                  assertInv(lt === "workflows/demo.tsx", "linkTarget exact")
                  const lop = yield* FsInternal.linkOnPath(dir, "demo-link.tsx")
                  assertInv(lop !== undefined, "linkOnPath detects symlink")
                }
                const pos = FsInternal.positionAt(wfSource, 20)
                assertInv(pos.line >= 1 && pos.column >= 1, "positionAt positive")
                assertInv(FsInternal.isStaleTemporary(".file.tmp-123-456"), "isStaleTemporary")
                const missing = yield* FsInternal.readOption(Path.join(dir, "does-not-exist.txt"))
                assertInv(missing === undefined, "readOption missing -> undefined")
                assertInv(yield* FsInternal.isDirectory(Path.join(dir, "workflows")), "isDirectory true")

                // Inventory / AST helpers
                const sf = Ts.parse("workflows/demo.tsx", wfSource)
                const specs = Ts.moduleSpecifiers(sf)
                const chains = Inventory.zodChains("workflows/demo.tsx", wfSource)
                const mdx = Inventory.mdxImports("workflows/demo.tsx", wfSource)
                const reexp = Inventory.factoryReexports(
                  new Map([["workflows/demo.tsx", wfSource]]),
                  new Set(["createSmithers"])
                )
                assertInv(specs.length > 0 && chains.length > 0 && mdx.length > 0 && reexp.size > 0, "Inventory AST")

                // Scan & RunState
                const scanned = yield* Scan.scan(dir)
                const rs = yield* RunState.scan(dir, scanned.detection)
                const roots = RunState.roots(rs)
                assertInv(roots.length > 0, "RunState.roots non-empty")
                const zHints = ZodSchemaHints.hints(scanned.detection, Ts.parse)
                const pHints = PromptHints.hints(scanned.detection)
                assertInv(zHints.length > 0 && pHints.length > 0, "Zod & Prompt hints non-empty")

                // Write target 1.0 flow with controlled defect variants and run Checks
                const targetRel = ".smithers/flows/demo/flow.ts"
                const targetAbs = Path.join(dir, targetRel)
                const targetContent = flowBroken === "clean"
                  ? goldenFlow
                  : flowBroken === "oldImport"
                  ? `import { Task } from "smithers-orchestrator"\nexport default Task\n`
                  : flowBroken === "todoMarker"
                  ? `${goldenFlow}\n// ${Checks.marker}: finish later\n`
                  : flowBroken === "asAny"
                  ? `${goldenFlow}\nconst leaked = 1 as any\nvoid leaked\n`
                  : `${goldenFlow}\nconst el = <div />\nvoid el\n`
                FsSync.writeFileSync(targetAbs, targetContent)

                const digestEntries = yield* Checkpoint.digest(dir, roots)
                const digests = new Map(digestEntries.map((d) => [d.path, d.digest] as const))
                if (mutateRunState) {
                  FsSync.writeFileSync(dbPath, "TAMPERED")
                }
                const rsCheck = yield* Checks.runState(dir, { sources: new Map(), digests })
                if (mutateRunState) assertInv(!rsCheck.ok, "Checks.runState catches tampering")
                else assertInv(rsCheck.ok, "Checks.runState passes untampered")

                const wfUnit = scanned.units.find((u) => u.kind === "workflow")
                if (wfUnit) {
                  const unitChecks = yield* Checks.run(
                    dir,
                    { ...wfUnit, targets: [targetRel] },
                    [targetRel],
                    { sources: new Map([[wfUnit.sources[0]!, wfSource]]), digests }
                  )
                  if (flowBroken !== "clean") assertInv(!Checks.ok(unitChecks), `Checks catches ${flowBroken}`)
                }

                const disc = yield* Checks.discovery(dir, ".smithers/flows")
                assertInv(typeof disc.ok === "boolean", "Checks.discovery boolean")

                return true
              } finally {
                FsSync.rmSync(dir, { recursive: true, force: true })
              }
            }).pipe(Effect.provide(nodeLayer)),
          { seed: seed + 2, executions: Math.min(executions, 10) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("Checkpoint, Rollback, Lock, Archive.run & MigrateFlow seal/finish/settle maintain atomic integrity", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        keepOldSources: Schema.Boolean,
        unitKind: Schema.Literals(["dependencies", "workflow", "project"]),
        touchRunState: Schema.Boolean,
        tamperAfterSeal: Schema.Boolean,
        mutateExtraFile: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ keepOldSources, unitKind, touchRunState, tamperAfterSeal, mutateExtraFile }) =>
          Effect.gen(function*() {
            const dir = copyFixture("jsx-single")
            try {
              // Lock acquire, contention refusal, release
              const held = yield* Lock.acquire({ root: dir, reportDir: ".smithers-migrate" })
              const second = yield* Lock.acquire({ root: dir, reportDir: ".smithers-migrate" }).pipe(Effect.result)
              assertInv(second._tag === "Failure", "double Lock.acquire fails")
              yield* Lock.release(held)

              // Vcs & Checkpoint take -> mutate -> diff -> restore -> rollback -> pending guard
              const vcs = yield* Vcs.detect(dir)
              assertInv(vcs === "none" || vcs === "git" || vcs === "jj", "Vcs.detect valid")
              const refusedNoVcs = yield* Vcs.requireCheckpoint(
                dir,
                Path.join(dir, ".smithers-migrate", "backup"),
                false
              ).pipe(Effect.result)
              if (vcs === "none") assertInv(refusedNoVcs._tag === "Failure", "requireCheckpoint refuses no vcs")

              const beforeHashes = hashTree(dir)
              const backupDir = Path.join(dir, ".smithers-migrate", "backup")
              const ref = yield* Checkpoint.take({
                root: dir,
                unit: "workflow:simple-workflow",
                files: ["simple-workflow.jsx", ".smithers/flows/simple-workflow/flow.ts"],
                backupDir,
                allowNoVcs: true,
                treeExclude: [".smithers-migrate"]
              })
              const repCkpt = Checkpoint.toReport(ref)
              assertInv(repCkpt.vcs === ref.vcs && repCkpt.ref === ref.ref, "Checkpoint.toReport")

              // Mutate existing file & add new target file
              FsSync.writeFileSync(Path.join(dir, "simple-workflow.jsx"), "// mutated\n")
              FsSync.mkdirSync(Path.join(dir, ".smithers", "flows", "simple-workflow"), { recursive: true })
              FsSync.writeFileSync(Path.join(dir, ".smithers", "flows", "simple-workflow", "flow.ts"), goldenFlow)
              if (mutateExtraFile) {
                FsSync.writeFileSync(Path.join(dir, "extra-temp.txt"), "added")
              }

              const srcs = yield* Checkpoint.sources(ref)
              assertInv(srcs.has("simple-workflow.jsx"), "Checkpoint.sources includes original")
              const diffs = yield* Checkpoint.diff(dir, ref, [
                "simple-workflow.jsx",
                ".smithers/flows/simple-workflow/flow.ts"
              ])
              assertInv(diffs.length > 0, "Checkpoint.diff detects mutations")

              const rb = yield* Checkpoint.rollback(dir, ref, {
                paths: ["simple-workflow.jsx", ".smithers/flows/simple-workflow/flow.ts"]
              })
              assertInv(rb.restored.length > 0, "Checkpoint.rollback restored files")
              assertInv(
                !FsSync.existsSync(Path.join(dir, ".smithers", "flows", "simple-workflow", "flow.ts")),
                "rollback removes newly created target"
              )
              if (mutateExtraFile) {
                assertInv(!FsSync.existsSync(Path.join(dir, "extra-temp.txt")), "rollback removes extra added file")
              }

              // Record rollback on pending marker -> blocks subsequent checkpoint until cleared
              yield* Checkpoint.recordRollback(backupDir, ref, rb)
              const blocked = yield* Pending.assertClear(Path.dirname(backupDir)).pipe(Effect.result)
              assertInv(blocked._tag === "Failure", "pending rollback blocks assertClear")
              yield* Checkpoint.clearPending(backupDir, ref)
              yield* Pending.assertClear(Path.dirname(backupDir))

              // Verify restore brought project back cleanly
              const afterRestore = new Map([...hashTree(dir)].filter(([k]) => !k.startsWith(".smithers-migrate/")))
              const beforeClean = new Map([...beforeHashes].filter(([k]) => !k.startsWith(".smithers-migrate/")))
              assertInv(afterRestore.size === beforeClean.size, "tree size matches before checkpoint")

              // Archive.run (including run-state refusal!)
              const archiveRes = yield* Archive.run({
                root: dir,
                unit: `${unitKind}:test`,
                kind: unitKind,
                sources: touchRunState
                  ? [".smithers/smithers.db"]
                  : unitKind === "workflow"
                  ? ["simple-workflow.jsx"]
                  : ["package.json", "tsconfig.json"],
                targets: [".smithers/flows/simple-workflow/flow.ts"],
                archiveDir: Path.join(dir, ".smithers-migrate", "archive"),
                keepOldSources,
                runStatePaths: [".smithers/smithers.db"]
              }).pipe(Effect.result)
              if (touchRunState) assertInv(archiveRes._tag === "Failure", "Archive refuses run-state source")
              else assertInv(archiveRes._tag === "Success", "Archive succeeds on normal source")

              // Plan seal & tamper detection
              const opts: Options.MigrateOptions = {
                root: dir,
                mode: "apply",
                allowNoVcs: true,
                commands: { typecheck: [], test: "node -e \"process.exit(0)\"" }
              }
              const scanned = yield* MigrateFlow.scan(opts)
              const planS = yield* MigrateFlow.planSeal(scanned, opts)
              const sealCheck = yield* MigrateFlow.validateSeal({ options: opts, seal: planS }).pipe(Effect.result)
              assertInv(sealCheck._tag === "Success", "validateSeal passes before tamper")
              if (tamperAfterSeal) {
                FsSync.writeFileSync(Path.join(dir, "package.json"), "{\"name\":\"tampered\"}\n")
                const tampered = yield* MigrateFlow.validateSeal({ options: opts, seal: planS }).pipe(Effect.result)
                assertInv(tampered._tag === "Failure", "validateSeal catches tamper")
              }

              // Settle & writeReport
              const unitOutlines = MigrateFlow.outlines(scanned, opts)
              if (unitOutlines.length > 0) {
                const artifactPath = yield* MigrateFlow.settle({
                  options: opts,
                  outline: unitOutlines[0]!,
                  failure: MigrateError.make("agent-failed", "synthetic fuzz failure")
                })
                assertInv(
                  artifactPath === unitOutlines[0]!.id &&
                    FsSync.existsSync(Path.join(dir, MigrateFlow.unitArtifact(opts, unitOutlines[0]!.id))),
                  "settle writes artifact"
                )
                const readBack = yield* MigrateFlow.readUnitReport(opts, unitOutlines[0]!.id)
                assertInv(readBack !== undefined && readBack.status === "failed", "readUnitReport matches")
                const rep = Scan.toReport(scanned, "apply", "2026-11-23T00:00:00.000Z")
                const written = yield* MigrateFlow.writeReport({
                  options: opts,
                  report: rep,
                  unitIds: unitOutlines.map((u) => u.id)
                })
                assertInv(FsSync.existsSync(Path.join(dir, ".smithers-migrate", "report.json")), "report.json written")
                assertInv(written.units.length > 0, "written report has units")
              }

              return true
            } finally {
              FsSync.rmSync(dir, { recursive: true, force: true })
            }
          }).pipe(Effect.provide(unconfinedNode)),
        { seed: seed + 3, executions: Math.min(executions, 8) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Verify, Exec, Command.run/runNode, Cli.command & scripted apply flow execute end-to-end across fixtures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fixtureName: Schema.Literals(["jsx-single", "mixed-api", "persisted-db", "batch-issues", "plue-pack", "lock"]),
        mode: Schema.Literals(["scan", "plan"]),
        asJson: Schema.Boolean,
        verifyPass: Schema.Boolean
      })
    )

    const cliServices = Layer.mergeAll(NodeServices.layer, CliConfig.layer())

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ fixtureName, mode, asJson, verifyPass }) =>
          Effect.gen(function*() {
            const dir = copyFixture(fixtureName)
            try {
              // Exec.tail + Exec.run
              const tailed = Exec.tail("x".repeat(20_000), 100)
              assertInv(tailed.includes("earlier bytes omitted") && tailed.length < 250, "Exec.tail truncates cleanly")
              const execRes = yield* Exec.run(
                verifyPass ? "node -e \"process.stdout.write(String(123))\"" : "node -e \"process.exit(2)\"",
                { cwd: dir }
              ).pipe(Effect.provide(unconfinedNode))
              if (verifyPass) assertInv(execRes.exitCode === 0, "Exec.run exitCode 0")
              else assertInv(execRes.exitCode !== 0, `Exec.run nonzero exitCode: ${execRes.exitCode}`)

              // Verify.run
              const vRes = yield* Verify.run({
                root: dir,
                commands: {
                  typecheck: [],
                  test: verifyPass ? "node -e \"process.exit(0)\"" : "node -e \"process.exit(1)\"",
                  flowsDir: ".smithers/flows"
                }
              }).pipe(Effect.provide(unconfinedNode))
              const verd = Verify.verdict(vRes)
              const fails = Verify.failures(vRes)
              if (!verifyPass) assertInv(verd === "fail" && fails.length > 0, "Verify catches failing test")

              // Cli.command via Command.runWith
              const before = hashTree(dir)
              const prevExit = process.exitCode
              process.exitCode = undefined
              try {
                const args = ["--root", dir, "--report-dir", ".out"]
                if (mode === "scan") args.push("--scan")
                if (asJson) args.push("--json")
                yield* Command.runWith(Cli.command, { version: Cli.version })(args).pipe(Effect.provide(cliServices))
                const status = process.exitCode ?? 0
                assertInv(status === 0 || status === 1 || status === 3, `Cli exit status valid: ${status}`)
              } finally {
                process.exitCode = prevExit
              }

              // Scan mode invariant: zero files modified!
              if (mode === "scan") {
                const after = hashTree(dir)
                assertInv(after.size === before.size, `scan left tree size unchanged (${before.size} vs ${after.size})`)
                for (const [k, v] of before) {
                  assertInv(after.get(k) === v, `scan left ${k} unchanged`)
                }
              } else {
                assertInv(FsSync.existsSync(Path.join(dir, ".out", "report.json")), "plan wrote report.json")
              }

              return true
            } finally {
              FsSync.rmSync(dir, { recursive: true, force: true })
            }
          }),
        { seed: seed + 4, executions: Math.min(executions, 4) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")

    // Full scripted end-to-end apply on jsx-single (both clean rewrite and repair/rollback path)
    if (nativeHelperAvailable) {
      const applyArb = Arbitrary.schema(
        Schema.Struct({
          succeed: Schema.Boolean,
          keepOldSources: Schema.Boolean
        })
      )
      const applyReport = await Effect.runPromise(
        Fuzz.run(
          applyArb,
          ({ succeed, keepOldSources }) =>
            Effect.gen(function*() {
              const dir = copyFixture("jsx-single")
              try {
                const chosen: CommandModule.MigrateOptions = {
                  root: dir,
                  mode: "apply",
                  allowNoVcs: true,
                  keepOldSources,
                  maxRepairRounds: succeed ? 1 : 0,
                  commands: { typecheck: [], test: "node -e \"process.exit(0)\"" }
                }
                const surveyed = yield* CommandModule.survey(chosen).pipe(
                  Effect.provide(Layers.layerNodeScanned({ root: dir, evaluator: ScriptedJudge.layer }))
                )
                const script: Layers.Script = (asked) => {
                  const unit = /# Unit `([^`]+)`/.exec(asked)?.[1] ?? "unknown"
                  const result = {
                    unit,
                    changedFiles: unit === "workflow:simple-workflow"
                      ? [".smithers/flows/simple-workflow/flow.ts"]
                      : [],
                    decisions: [],
                    unresolved: [],
                    unsupported: [],
                    notes: "fuzz-scripted"
                  }
                  if (unit !== "workflow:simple-workflow") return Layers.done(result)
                  if (!succeed) {
                    return [
                      `await ctx.call("write", { path: ".smithers/flows/simple-workflow/flow.ts", content: "import { Task } from \\"smithers-orchestrator\\"\\nexport default Task\\n" })`,
                      Layers.done(result)
                    ].join("\n")
                  }
                  return [
                    `await ctx.call("write", { path: ".smithers/flows/simple-workflow/flow.ts", content: ${
                      JSON.stringify(goldenFlow)
                    } })`,
                    Layers.done(result)
                  ].join("\n")
                }
                const composition = Layers.layerScripted({
                  ...journeyHost,
                  root: dir,
                  commands: surveyed.commands,
                  runStatePaths: Transform.runStatePaths(surveyed.scan),
                  script
                })
                const rep = yield* CommandModule.run(chosen).pipe(Effect.provide(composition))
                if (succeed) {
                  assertInv(
                    rep.exitCode === 0 &&
                      FsSync.existsSync(Path.join(dir, ".smithers", "flows", "simple-workflow", "flow.ts")),
                    "scripted apply succeeded and wrote flow.ts"
                  )
                } else {
                  assertInv(
                    rep.exitCode !== 0 &&
                      !FsSync.existsSync(Path.join(dir, ".smithers", "flows", "simple-workflow", "flow.ts")),
                    "failing scripted apply rolled back flow.ts"
                  )
                }
                return true
              } finally {
                FsSync.rmSync(dir, { recursive: true, force: true })
              }
            }),
          { seed: seed + 5, executions: Math.min(executions, 2) }
        )
      )
      const applyFailure = Fuzz.formatReport(applyReport)
      if (applyFailure !== undefined) throw new Error(applyFailure)
      expect(applyReport._tag).toBe("Passed")
    }
  })
})
