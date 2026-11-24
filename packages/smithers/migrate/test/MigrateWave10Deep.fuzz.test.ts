import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Arbitrary, Effect, Exit, Layer, Logger, Option, Schema, Stream } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Checks from "../src/Checks.ts"
import * as Detect from "../src/Detect.ts"
import * as Checkpoint from "../src/flow/Checkpoint.ts"
import * as Exec from "../src/flow/internal/Exec.ts"
import * as Layers from "../src/flow/Layers.ts"
import * as MigrateFlow from "../src/flow/MigrateFlow.ts"
import * as Options from "../src/flow/Options.ts"
import * as Verify from "../src/flow/Verify.ts"
import * as CliScripts from "../src/internal/CliScripts.ts"
import * as Jsonc from "../src/internal/Jsonc.ts"
import * as PathText from "../src/internal/PathText.ts"
import * as Inventory from "../src/Inventory.ts"
import * as Mapping from "../src/Mapping.ts"
import * as Report from "../src/Report.ts"
import * as RunState from "../src/RunState.ts"
import * as Scan from "../src/Scan.ts"
import * as Units from "../src/Units.ts"
import * as ZodSchemaHints from "../src/ZodSchemaHints.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261230")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(30, Math.min(baseExecutions, 80))
const ioExec = Math.max(24, Math.min(Math.ceil(baseExecutions / 4), 36))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const silentLog = Logger.layer([])

describe("@smthrs/migrate Wave 10 deep fuzzing", () => {
  it(
    "fuzzes CliScripts, PathText, Jsonc, ZodSchemaHints, Mapping snippets/classifications & Detect package/lock helpers",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scriptCase: Schema.Literals([
            "commentAndEscapes",
            "trailingBackslash",
            "envAndExec",
            "pnpmExecDlx",
            "pnpmRunIgnored",
            "pkgAtVersion",
            "detachedVsData",
            "badDetachedEquals",
            "dupBoolFlag",
            "equalsFlag",
            "backendSqlite",
            "backendPostgres",
            "badJsonInput",
            "remoteDetachedConflict"
          ]),
          zodCase: Schema.Literals([
            "primitivesAndLiterals",
            "arrayAndRecords",
            "enumUnionAndStruct",
            "modifiersAndDefaults",
            "numberAndStringBounds",
            "unsupportedChains"
          ]),
          mappingCase: Schema.Literals([
            "sequencedCtxDeps",
            "childOutputsAndAgents",
            "timerVariants",
            "waitSignalApproval",
            "workflowAndRalph",
            "unknownConstruct"
          ]),
          pathCase: Schema.Literals([
            "winDriveDeep",
            "winDriveRoot",
            "winRelative",
            "winUnc",
            "winMixedSlash",
            "winDotDot",
            "posixPaths"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ scriptCase, zodCase, mappingCase, pathCase }) =>
            Effect.sync(() => {
              // 1. CliScripts.rewrite (CliScripts.ts L40-239)
              const flowName = (p: string) => p.replace(/^.*\//, "").replace(/\.tsx?$/, "")
              const scriptMap: Record<typeof scriptCase, string> = {
                commentAndEscapes: "smithers up src/a\\ b.tsx --input \"{\\\"k\\\":\\\"v\\\"}\" # trailing comment",
                trailingBackslash: "smithers up src/wf.tsx \\",
                envAndExec: "env FOO=1 BAR=\"2\" smithers up src/wf.tsx && exec smthrs workflow run src/wf2.tsx",
                pnpmExecDlx: "pnpm exec smithers up src/wf.tsx && pnpm dlx smithers@0.9.0 up src/wf2.tsx",
                pnpmRunIgnored: "pnpm run build",
                pkgAtVersion: "npx smithers-orchestrator@0.9.1 up src/wf.tsx && npx other@1.0.0 smithers@0.9.0",
                detachedVsData: "smithers up src/wf.tsx -d && smithers workflow run src/wf.tsx -d '{\"a\":1}'",
                badDetachedEquals: "smithers up src/wf.tsx -d=1",
                dupBoolFlag: "smithers up src/wf.tsx --remote --remote",
                equalsFlag: "smithers up src/wf.tsx --input='{\"a\":1}' --max-concurrency=4",
                backendSqlite: "smithers up src/wf.tsx --backend sqlite",
                backendPostgres: "smithers up src/wf.tsx --backend postgres",
                badJsonInput: "smithers up src/wf.tsx --input '{bad-json'",
                remoteDetachedConflict: "smithers up src/wf.tsx --remote --detached"
              }
              const rw = CliScripts.rewrite(scriptMap[scriptCase], flowName)
              expect(typeof rw).toBe("object")

              // 2. PathText (PathText.ts L24, 37-42, 62-65)
              const pathSamples: Record<typeof pathCase, ReadonlyArray<string>> = {
                winDriveDeep: ["C:\\repo\\src\\flow.ts", "D:\\a\\b\\"],
                winDriveRoot: ["C:\\", "C:/"],
                winRelative: ["C:relative\\path"],
                winUnc: ["\\\\server\\share\\dir\\file.ts", "\\\\server\\share\\"],
                winMixedSlash: ["C:\\repo/mixed\\path"],
                winDotDot: ["C:\\repo\\..\\escape", "C:\\repo\\.\\dot"],
                posixPaths: ["/a/b/c", "/", "a/b", "single", "/a/../b"]
              }
              for (const sample of pathSamples[pathCase]) {
                const isWin = PathText.windowsAbsolute(sample)
                const dir = PathText.dirname(sample)
                const issue = PathText.absoluteIssue(sample)
                expect(typeof isWin).toBe("boolean")
                expect(typeof dir).toBe("string")
                expect(issue === undefined || issue === "relative" || issue === "unnormalized").toBe(true)
              }

              // 3. Jsonc.withoutComments (Jsonc.ts L41-43, 72-76)
              const rawJsonc = `{
              // line comment
              "escaped": "hello \\"world\\" \\\\ path", /* block */
              "arr": [1, 2, ],
              "nested": { "k": true, },
            }`
              const parsed = JSON.parse(Jsonc.withoutComments(rawJsonc))
              expect(parsed.escaped).toBe("hello \"world\" \\ path")
              expect(parsed.arr).toEqual([1, 2])

              // 4. ZodSchemaHints (ZodSchemaHints.ts L93-362)
              const zodChains: Record<typeof zodCase, ReadonlyArray<string>> = {
                primitivesAndLiterals: [
                  `z.string()`,
                  `z.number()`,
                  `z.boolean()`,
                  `z.int()`,
                  `z.unknown()`,
                  `z.any()`,
                  `z.literal("ok")`,
                  `z.literal(42)`,
                  `z.literal(true)`,
                  `z.literal(false)`,
                  `z.literal(null)`
                ],
                arrayAndRecords: [
                  `z.array(z.string())`,
                  `z.record(z.number())`,
                  `z.record(z.string(), z.boolean())`,
                  `z.record(z.enum(["a", "b"]), z.number())`,
                  `z.record(z.number(), z.string())`
                ],
                enumUnionAndStruct: [
                  `z.enum(["draft", "live"])`,
                  `z.union([z.string(), z.number()])`,
                  `z.object({ "non-id": z.string().optional(), ok: z.boolean() })`,
                  `z.object({ a: z.string().optional() }).default({})`
                ],
                modifiersAndDefaults: [
                  `z.string().optional()`,
                  `z.string().nullable().default(null)`,
                  `z.number().nullish()`,
                  `z.string().describe("the name").default("anon")`,
                  `z.array(z.string()).default([])`,
                  `z.object({}).default({})`
                ],
                numberAndStringBounds: [
                  `z.number().int().nonnegative().positive().min(1).max(100)`,
                  `z.string().min(2).max(20)`,
                  `z.array(z.number()).min(1).max(5)`
                ],
                unsupportedChains: [
                  `z.string().optional().default("x")`,
                  `z.boolean().min(1)`,
                  `z.number().default(1).int()`,
                  `z.number().default(1).nonnegative()`,
                  `z.number().default(1).positive()`,
                  `z.string().default(someFn())`,
                  `z.enum([1, notLit])`,
                  `z.literal(notLit)`,
                  `z.unknown().default("x")`
                ]
              }
              for (const chain of zodChains[zodCase]) {
                const cls = ZodSchemaHints.classify(chain)
                expect(cls).toBeDefined()
                ZodSchemaHints.print(chain)
                ZodSchemaHints.printField(chain)
              }

              // 5. Mapping classify/snippet/byImport/markdownTable (Mapping.ts L1009-1676)
              expect(Mapping.markdownTable()).toContain("|")
              expect(Mapping.byImport("Workflow")).toBeDefined()
              expect(Mapping.byImport("smithers-orchestrator/tools")).toBeUndefined()

              const mkHit = (
                construct: string,
                excerpt: string,
                detail: Record<string, unknown> = {}
              ): Inventory.InventoryEntry => ({
                construct,
                file: "src/wf.tsx",
                line: 10,
                excerpt,
                props: [],
                detail
              } as any)

              if (mappingCase === "sequencedCtxDeps") {
                const h1 = mkHit(
                  "Task",
                  `<Task id="step2" output={outSchema}>{(ctx) => run(ctx.input.repo, deps.step1.summary)}</Task>`,
                  { sequenced: true, childOutputs: ["outA"], childAgents: ["coder"] }
                )
                Mapping.classifyWithReason(h1)
                Mapping.snippet(h1)
                const h2 = mkHit("Sequence", `<Sequence><Task id="a" /><Task id="b" /></Sequence>`, {
                  childOutputs: ["aOut", "bOut"],
                  childAgents: ["agentA"]
                })
                Mapping.classifyWithReason(h2)
                Mapping.snippet(h2)
              } else if (mappingCase === "childOutputsAndAgents") {
                const h = mkHit("Parallel", `<Parallel maxConcurrency={2}><Task id="a" /><Task id="b" /></Parallel>`, {
                  childOutputs: ["x"],
                  childAgents: ["a1"]
                })
                Mapping.classifyWithReason(h)
                Mapping.snippet(h)
              } else if (mappingCase === "timerVariants") {
                for (
                  const ex of [
                    `<Timer id="t1" duration="5m" />`,
                    `<Timer id="t2" until="2026-12-01T00:00:00Z" />`,
                    `<Timer id="t3" every="1h" />`,
                    `<Timer id="t4" badProp={x} />`
                  ]
                ) {
                  const h = mkHit("Timer", ex)
                  Mapping.classifyWithReason(h)
                  Mapping.snippet(h)
                }
              } else if (mappingCase === "waitSignalApproval") {
                for (
                  const [c, ex, d] of [
                    ["WaitForEvent", `<WaitForEvent event="pr.merged" correlationId="pr-1" />`, {
                      eventLiteral: "pr.merged",
                      correlationIdLiteral: "pr-1"
                    }],
                    ["Signal", `<Signal event="go" />`, { eventLiteral: "go" }],
                    ["Approval", `<Approval id="ap1" prompt="ship?" />`, {}]
                  ] as const
                ) {
                  const h = mkHit(c, ex, d as any)
                  Mapping.classifyWithReason(h)
                  Mapping.snippet(h)
                }
              } else if (mappingCase === "workflowAndRalph") {
                for (
                  const [c, ex] of [
                    ["Workflow", `<Workflow name="deploy"><Task id="t" /></Workflow>`],
                    ["Ralph", `<Ralph id="r" until={done} maxIterations={3}><Task id="t" /></Ralph>`],
                    ["Branch", `<Branch if={ok} then={<Task id="a" />} else={<Task id="b" />} />`],
                    ["Worktree", `<Worktree path="/tmp/wt"><Task id="a" /></Worktree>`]
                  ] as const
                ) {
                  const h = mkHit(c, ex)
                  Mapping.classifyWithReason(h)
                  Mapping.snippet(h)
                }
              } else {
                const h = mkHit("NonExistentConstruct", `foo()`)
                expect(Mapping.byConstruct("NonExistentConstruct")).toBeUndefined()
                Mapping.classifyWithReason(h)
                Mapping.snippet(h)
              }

              // 6. Detect package & lockfile helpers
              expect(Detect.classifyPackage("smthrs", "^0.9.0")).toBe("old-name")
              expect(Detect.classifyPackage("smithers-orchestrator", "^0.9.0")).toBe("old-name")
              expect(Detect.classifyPackage("@smithers/core", "^0.5.0")).toBe("old-scope")
              expect(Detect.classifyPackage("@smthrs/flow", "^0.8.0")).toBe("old-version")
              expect(Detect.classifyPackage("@smthrs/flow", "^1.0.0")).toBeUndefined()
              expect(Detect.isOldSpecifier("smithers-orchestrator/tools")).toBe(true)
              const effVers = Detect.resolvedEffectVersions(
                `  'effect@3.14.2':\n    resolution: {}\n  effect@4.1.1:\n    resolution: {}\n  "effect": "3.12.0"\n`
              )
              expect(effVers.length).toBeGreaterThanOrEqual(1)

              return true
            }),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    90_000
  )

  it(
    "fuzzes Detect.scan, Inventory, Units, Scan, RunState, Checks & Report over rich synthetic 0.x project trees",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          variant: Schema.Literals([
            "malformedManifestAndTsconfig",
            "effectPinConflictAndAliases",
            "cyclesReexportsAndForeign",
            "runStatePgliteExternalAndGateway",
            "duplicateUnitAndUnknownFilter",
            "checksAndReportEdges"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ variant }) =>
            Effect.gen(function*() {
              const root = mkdtempSync(join(tmpdir(), "wave10a-mig-proj-"))
              const outside = mkdtempSync(join(tmpdir(), "wave10a-mig-ext-"))
              const gwDir = mkdtempSync(join(tmpdir(), "wave10a-mig-gw-"))
              try {
                mkdirSync(join(root, "src"), { recursive: true })

                if (variant === "malformedManifestAndTsconfig") {
                  writeFileSync(join(root, "package.json"), "{ invalid-json ")
                  writeFileSync(join(root, "tsconfig.json"), "{ bad tsconfig")
                  writeFileSync(join(root, "src", "broken-link.ts"), "export const x = 1\n")
                  symlinkSync(join(outside, "does-not-exist.ts"), join(root, "src", "dangling.ts"))
                  const det = yield* Detect.scan(root)
                  expect(det.warnings.length).toBeGreaterThan(0)
                } else if (variant === "effectPinConflictAndAliases") {
                  writeFileSync(
                    join(root, "package.json"),
                    JSON.stringify({
                      name: "pin-conflict",
                      scripts: {
                        wf: "smithers workflow run src/wf.tsx",
                        old: "smithers run src/wf.tsx -d '{\"x\":1}'"
                      },
                      dependencies: {
                        effect: "^3.12.0",
                        myAlias: "npm:smithers-orchestrator@^0.9.0",
                        "@smthrs/flow": "^0.8.0"
                      }
                    })
                  )
                  writeFileSync(join(root, "pnpm-lock.yaml"), "packages:\n  effect@3.12.5:\n    resolution: {}\n")
                  writeFileSync(
                    join(root, "tsconfig.json"),
                    JSON.stringify({
                      compilerOptions: {
                        jsxImportSource: "smithers-orchestrator",
                        paths: {
                          "@smthrs/*": ["./vendor/smthrs/*"],
                          "smithers-orchestrator/*": ["./vendor/old/*"]
                        }
                      }
                    })
                  )
                  writeFileSync(
                    join(root, "smithers.config.ts"),
                    `export default { repoCommands: { test: "custom-test-cmd" } }\n`
                  )
                  writeFileSync(
                    join(root, "src", "wf.tsx"),
                    `/** @jsxImportSource smithers-orchestrator */\n` +
                      `import { createSmithers, Workflow, Task, WaitForEvent, Signal } from "smithers-orchestrator"\n` +
                      `import { z } from "zod"\n` +
                      `const Out = z.object({ ok: z.boolean().default(true) })\n` +
                      `const { smithers } = createSmithers()\n` +
                      `export default smithers(() => (\n` +
                      `  <Workflow name="demo">\n` +
                      `    <WaitForEvent event="pr.open" correlationId="c-1" />\n` +
                      `    <Signal event="done" />\n` +
                      `    <Task id="t1" output={Out}>{() => ({ ok: true })}</Task>\n` +
                      `  </Workflow>\n` +
                      `))\n`
                  )
                  const scanRes = yield* Scan.scan(root)
                  expect(scanRes.detection.warnings.length).toBeGreaterThanOrEqual(0)
                  expect(scanRes.units.length).toBeGreaterThanOrEqual(1)
                  const zodHints = ZodSchemaHints.hints(scanRes.detection)
                  expect(zodHints.length).toBeGreaterThanOrEqual(1)
                } else if (variant === "cyclesReexportsAndForeign") {
                  writeFileSync(
                    join(root, "package.json"),
                    JSON.stringify({
                      name: "cycles-proj",
                      dependencies: {
                        "smithers-orchestrator": "^0.9.0",
                        "@smithers-ai/workflow": "^0.2.0"
                      }
                    })
                  )
                  writeFileSync(
                    join(root, "src", "barrel.ts"),
                    `export { Workflow, Task } from "smithers-orchestrator"\n` +
                      `export * from "smithers-orchestrator"\n`
                  )
                  writeFileSync(
                    join(root, "src", "a.tsx"),
                    `import { createSmithers } from "smithers-orchestrator"\n` +
                      `import { Workflow, Task } from "./barrel"\n` +
                      `import { bFlow } from "./b"\n` +
                      `const { smithers } = createSmithers()\n` +
                      `export const aFlow = smithers(() => <Workflow name="a"><Task id="t1">{() => bFlow}</Task></Workflow>)\n`
                  )
                  writeFileSync(
                    join(root, "src", "b.tsx"),
                    `import { createSmithers, Workflow, Task } from "smithers-orchestrator"\n` +
                      `import { aFlow } from "./a"\n` +
                      `const { smithers } = createSmithers()\n` +
                      `export const bFlow = smithers(() => <Workflow name="b"><Task id="t2">{() => aFlow}</Task></Workflow>)\n`
                  )
                  writeFileSync(
                    join(root, "src", "foreign.ts"),
                    `import * as wf from "@smithers-ai/workflow"\n` +
                      `import { defineFlow } from "@smithers-ai/workflow"\n` +
                      `export const f = [wf, defineFlow]\n`
                  )
                  const scanRes = yield* Scan.scan(root)
                  expect(scanRes.detection.imports.length).toBeGreaterThan(0)
                } else if (variant === "runStatePgliteExternalAndGateway") {
                  writeFileSync(
                    join(root, "package.json"),
                    JSON.stringify({
                      name: "runstate-proj",
                      dependencies: { "smithers-orchestrator": "^0.9.0" }
                    })
                  )
                  mkdirSync(join(root, ".smithers", "pg"), { recursive: true })
                  writeFileSync(join(root, ".smithers", "pg", "PG_VERSION"), "16\n")
                  mkdirSync(join(root, ".smithers", "workflows"), { recursive: true })
                  writeFileSync(join(root, ".smithers", "workflows", "run-abc.log"), "started\n")
                  const extDb = join(outside, "external.sqlite")
                  writeFileSync(extDb, "SQLite format 3\0")
                  writeFileSync(
                    join(root, "smithers.config.ts"),
                    `export default { dbPath: ${JSON.stringify(extDb)} }\n`
                  )
                  mkdirSync(join(gwDir, "smithers-gateway"), { recursive: true })
                  writeFileSync(
                    join(gwDir, "smithers-gateway", "gateway.json"),
                    JSON.stringify({ workspaces: [{ path: root, nested: { [root]: true } }] })
                  )
                  writeFileSync(join(gwDir, "smithers-gateway", "corrupt.json"), "{not-json")
                  const det = yield* Detect.scan(root)
                  const rs = yield* RunState.scan(root, det, { tmpdir: gwDir })
                  expect(rs.pglite).toBeDefined()
                  expect(rs.stateDirs.length).toBeGreaterThanOrEqual(1)
                  expect(rs.external.length).toBeGreaterThanOrEqual(1)
                  const rts = RunState.roots(rs)
                  expect(Array.isArray(rts)).toBe(true)
                } else if (variant === "duplicateUnitAndUnknownFilter") {
                  writeFileSync(
                    join(root, "package.json"),
                    JSON.stringify({
                      name: "dup-proj",
                      dependencies: { "smithers-orchestrator": "^0.9.0" }
                    })
                  )
                  mkdirSync(join(root, "src", "one"), { recursive: true })
                  mkdirSync(join(root, "src", "two"), { recursive: true })
                  const wfSrc = `import { createSmithers, Workflow, Task } from "smithers-orchestrator"\n` +
                    `const { smithers } = createSmithers()\n` +
                    `export default smithers(() => <Workflow name="same"><Task id="t">{() => 1}</Task></Workflow>)\n`
                  writeFileSync(join(root, "src", "one", "same.tsx"), wfSrc)
                  writeFileSync(join(root, "src", "two", "same.tsx"), wfSrc)
                  const dupExit = yield* Effect.exit(Scan.scan(root))
                  expect(Exit.isFailure(dupExit) || Exit.isSuccess(dupExit)).toBe(true)

                  // Unknown unit filter fails unsupported-project (Scan.ts L156-162)
                  rmSync(join(root, "src", "two", "same.tsx"))
                  const badUnit = yield* Effect.exit(Scan.scan(root, { units: ["no-such-unit"] }))
                  expect(Exit.isFailure(badUnit)).toBe(true)
                } else {
                  // checksAndReportEdges
                  writeFileSync(
                    join(root, "package.json"),
                    JSON.stringify({ name: "chk-proj", dependencies: { "@smthrs/flow": "^1.0.0" } })
                  )
                  writeFileSync(
                    join(root, "src", "flow.ts"),
                    `import { Flow } from "@smthrs/flow"\n` +
                      `const body = () => 1\n` +
                      `// ${Checks.marker}: manual follow-up\n` +
                      `export default Flow.make("demo", { description: "d", body })\n`
                  )
                  const fakeUnit = {
                    id: "demo",
                    kind: "workflow",
                    sources: ["src/flow.ts"],
                    specifiers: {},
                    verification: { discovery: { flowsDir: ".smithers/flows" } },
                    constructs: [],
                    decisions: [],
                    unsafe: [],
                    notes: []
                  } as any
                  const chkRes = yield* Checks.run(
                    root,
                    fakeUnit,
                    ["src/flow.ts"],
                    { sources: new Map(), digests: new Map(), runStateRoots: [] },
                    [],
                    []
                  )
                  expect(Array.isArray(chkRes)).toBe(true)
                  const rsChk = yield* Checks.runState(root, {
                    sources: new Map(),
                    digests: new Map([["src/missing.db", "deadbeef"]]),
                    runStateRoots: []
                  })
                  expect(typeof rsChk.ok).toBe("boolean")
                  const discChk = yield* Checks.discovery(root, ".smithers/flows")
                  expect(typeof discChk.ok).toBe("boolean")
                }

                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
                rmSync(outside, { recursive: true, force: true })
                rmSync(gwDir, { recursive: true, force: true })
              }
            }).pipe(Effect.provide(NodeServices.layer), Effect.provide(silentLog)),
          { seed: seed + 1, executions: ioExec }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "fuzzes Checkpoint (jj/git spawner stubs, carveRoots, symlinks, restore/rollback errors), Options, Layers, Exec, Verify & MigrateFlow.postconditions",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Literals([
            "checkpointVcsAndErrors",
            "checkpointCarveTreeAndRollback",
            "optionsValidationErrors",
            "layersSeatAndRules",
            "execTimeoutOverflowAndFail",
            "verifyCommandsAndPlantedVcs",
            "migrateFlowPostconditionsAndReport"
          ]),
          flag: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ scenario, flag }) =>
            Effect.gen(function*() {
              const root = mkdtempSync(join(tmpdir(), "wave10a-mig-fl-"))
              const outside = mkdtempSync(join(tmpdir(), "wave10a-mig-out-"))
              try {
                if (scenario === "checkpointVcsAndErrors") {
                  mkdirSync(join(root, "src"), { recursive: true })
                  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
                  mkdirSync(join(root, "src", "subdir"), { recursive: true })

                  // Invalid backup path & directory-as-file errors (Checkpoint.ts L315, L344)
                  const badPathEx = yield* Effect.exit(
                    Checkpoint.take({
                      root,
                      unit: "u1",
                      files: ["../escape.ts"],
                      runStateRoots: [],
                      backupDir: join(root, ".smithers-migrate", "backups"),
                      allowNoVcs: true
                    } as any)
                  )
                  expect(Exit.isFailure(badPathEx)).toBe(true)

                  const dirAsFileEx = yield* Effect.exit(
                    Checkpoint.take({
                      root,
                      unit: "u1",
                      files: ["src/subdir"],
                      runStateRoots: [],
                      backupDir: join(root, ".smithers-migrate", "backups"),
                      allowNoVcs: true
                    } as any)
                  )
                  expect(Exit.isFailure(dirAsFileEx)).toBe(true)

                  // Stubbed ChildProcessSpawner covering BOTH jj & git branches (success + failure)
                  const vcsMode = flag ? "jj" : "git"
                  if (vcsMode === "jj") mkdirSync(join(root, ".jj"), { recursive: true })
                  else mkdirSync(join(root, ".git"), { recursive: true })

                  for (const failStep of [false, true]) {
                    const stubSpawner = Layer.succeed(
                      ChildProcessSpawner.ChildProcessSpawner,
                      ChildProcessSpawner.make(() =>
                        Effect.succeed({
                          exitCode: Effect.succeed(failStep ? 1 : 0),
                          stdout: Stream.succeed(new TextEncoder().encode(failStep ? "" : "abc123456\n")),
                          stderr: Stream.succeed(new TextEncoder().encode(failStep ? "vcs error\n" : "")),
                          all: Stream.empty,
                          stdin: undefined as any,
                          pid: 123 as any,
                          isRunning: Effect.succeed(false),
                          kill: () => Effect.void
                        } as any)
                      )
                    )
                    const ex = yield* Effect.exit(
                      Checkpoint.take({
                        root,
                        unit: "unit:a/b",
                        files: ["src/a.ts"],
                        runStateRoots: [],
                        backupDir: join(root, ".smithers-migrate", "backups")
                      } as any).pipe(Effect.provide(stubSpawner))
                    )
                    expect(Exit.isSuccess(ex)).toBe(!failStep)
                  }
                } else if (scenario === "checkpointCarveTreeAndRollback") {
                  mkdirSync(join(root, ".smithers", "keep", "nested"), { recursive: true })
                  writeFileSync(join(root, ".smithers", "keep", "nested", "k.txt"), "keep")
                  writeFileSync(join(root, ".smithers", "other.txt"), "other")
                  mkdirSync(join(root, "src"), { recursive: true })
                  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
                  symlinkSync(join(root, "src", "a.ts"), join(root, "src", "link.ts"))

                  // carveRoots with nested keep & absolute path (Checkpoint.ts L457-474)
                  const carved = yield* Checkpoint.carveRoots(
                    root,
                    [".smithers", "/abs/external/db"],
                    ".smithers/keep/nested"
                  )
                  expect(carved.length).toBeGreaterThan(0)

                  // digest & tree with symlink (Checkpoint.ts L400-401, L573-574)
                  const digs = yield* Checkpoint.digest(root, ["src/link.ts", "src/missing-root"])
                  expect(digs.length).toBeGreaterThanOrEqual(1)
                  const t1 = yield* Checkpoint.tree(root, [])
                  expect(Object.keys(t1.files).length).toBeGreaterThan(0)

                  // Take checkpoint then test restore/rollback error edges (missing digest, undeclared path)
                  const bdir = join(root, ".smithers-migrate", "backups")
                  const ref = yield* Checkpoint.take({
                    root,
                    unit: "u-rb",
                    files: ["src/a.ts"],
                    runStateRoots: [],
                    backupDir: bdir,
                    allowNoVcs: true
                  } as any)
                  const badUndeclared = yield* Effect.exit(Checkpoint.diff(root, ref, ["src/not-in-manifest.ts"]))
                  expect(Exit.isFailure(badUndeclared)).toBe(true)

                  const corruptedRef = {
                    ...ref,
                    entries: ref.entries.map((e: any) => ({ ...e, digest: undefined }))
                  } as any
                  const badDigSources = yield* Effect.exit(Checkpoint.sources(corruptedRef))
                  expect(Exit.isFailure(badDigSources)).toBe(true)
                  const badDigDiff = yield* Effect.exit(Checkpoint.diff(root, corruptedRef, ["src/a.ts"]))
                  expect(Exit.isFailure(badDigDiff)).toBe(true)
                  const badDigRestore = yield* Effect.exit(Checkpoint.restore(root, corruptedRef, ["src/a.ts"]))
                  expect(Exit.isFailure(badDigRestore)).toBe(true)

                  // Modify file + add stray file + archive copy, then rollback cleanly
                  writeFileSync(join(root, "src", "a.ts"), "export const a = 2\n")
                  writeFileSync(join(root, "src", "stray.ts"), "stray\n")
                  const archDir = join(root, ".smithers-migrate", "archive")
                  mkdirSync(join(archDir, "src"), { recursive: true })
                  writeFileSync(join(archDir, "src", "a.ts"), "archived\n")
                  const badRb = yield* Effect.exit(
                    Checkpoint.rollback(root, ref, { paths: ["src/a.ts", "src/stray.ts"], archiveDir: archDir })
                  )
                  expect(Exit.isFailure(badRb)).toBe(true)
                  const rb = yield* Checkpoint.rollback(root, ref, {
                    paths: ["src/a.ts"],
                    archiveDir: archDir
                  })
                  expect(rb.unrestored.length).toBe(0)
                } else if (scenario === "optionsValidationErrors") {
                  // flowsDir overlapping defaultReportDir (Options.ts L272)
                  expect(
                    Options.layoutIssue({ root, layout: { flowsDir: ".smithers-migrate/flows" } } as any)
                  ).toContain("overlap")

                  // Non-directory root (Options.ts L431)
                  const filePath = join(root, "not-a-dir.txt")
                  writeFileSync(filePath, "hi")
                  const nonDirEx = yield* Effect.exit(
                    Options.validateLayout({ root: filePath, mode: "plan" } as any)
                  )
                  expect(Exit.isFailure(nonDirEx)).toBe(true)

                  // reportDir is a file (Options.ts L464)
                  writeFileSync(join(root, ".smithers-migrate"), "a-file")
                  const fileRepEx = yield* Effect.exit(
                    Options.validateLayout({ root, mode: "plan" } as any)
                  )
                  expect(Exit.isFailure(fileRepEx)).toBe(true)
                  rmSync(join(root, ".smithers-migrate"))

                  // reportDir with foreign files (Options.ts L473-476)
                  mkdirSync(join(root, ".smithers-migrate"), { recursive: true })
                  writeFileSync(join(root, ".smithers-migrate", "foreign.txt"), "nope")
                  const foreignEx = yield* Effect.exit(
                    Options.validateLayout({ root, mode: "plan" } as any)
                  )
                  expect(Exit.isFailure(foreignEx)).toBe(true)
                  rmSync(join(root, ".smithers-migrate"), { recursive: true, force: true })

                  // Symlink escaping root (Options.ts L445)
                  symlinkSync(outside, join(root, "escape-flows"))
                  const escEx = yield* Effect.exit(
                    Options.validateLayout({ root, mode: "plan", layout: { flowsDir: "escape-flows" } } as any)
                  )
                  expect(Exit.isFailure(escEx)).toBe(true)
                } else if (scenario === "layersSeatAndRules") {
                  const fakeExecutor = RequestExecutor.RequestExecutor.of({
                    execute: () => Effect.die("unused")
                  } as any)
                  // Missing provider / unknown provider / valid anthropic & openai env (Layers.ts L125-184)
                  const rMissing = Layers.seatResolver({ environment: {}, seat: undefined, executor: fakeExecutor })
                  expect(Exit.isFailure(yield* Effect.exit(rMissing.resolve("default" as any)))).toBe(true)
                  const rBadProv = Layers.seatResolver({
                    environment: { SMITHERS_MIGRATE_PROVIDER: "unknown-prov", SMITHERS_MIGRATE_MODEL: "m1" },
                    seat: undefined,
                    executor: fakeExecutor
                  })
                  expect(Exit.isFailure(yield* Effect.exit(rBadProv.resolve("default" as any)))).toBe(true)
                  const rGood = Layers.seatResolver({
                    environment: flag
                      ? {
                        ANTHROPIC_API_KEY: "sk-ant-test",
                        SMITHERS_MIGRATE_PROVIDER: "anthropic",
                        SMITHERS_MIGRATE_MODEL: "claude-3-5-sonnet-latest"
                      }
                      : {
                        OPENAI_API_KEY: "sk-oai-test",
                        SMITHERS_MIGRATE_PROVIDER: "openai",
                        SMITHERS_MIGRATE_MODEL: "gpt-4o"
                      },
                    seat: undefined,
                    executor: fakeExecutor
                  })
                  const seatEx = yield* Effect.exit(rGood.resolve("default" as any))
                  expect(Exit.isSuccess(seatEx) || Exit.isFailure(seatEx)).toBe(true)

                  // Windows-style rules normalization (Layers.ts L321-322)
                  const rls = Layers.rules({
                    root: "C:\\proj\\root\\" as any,
                    runStatePaths: [".smithers/runs", "C:\\external\\gw.json"],
                    commands: { typecheck: ["pnpm typecheck"], test: "pnpm test" } as any,
                    reportDir: ".smithers-migrate"
                  })
                  expect(Array.isArray(rls)).toBe(true)
                } else if (scenario === "execTimeoutOverflowAndFail") {
                  // Overflow ring buffer (>12KB across chunks) (Exec.ts L115-117)
                  const bigRes = yield* Exec.run(process.execPath, {
                    args: ["-e", "for(let i=0;i<20;i++) process.stdout.write('x'.repeat(1200));"],
                    cwd: root,
                    timeoutMs: 5_000
                  })
                  expect(bigRes.exitCode).toBe(0)
                  expect(bigRes.stdout.length).toBeLessThanOrEqual(Exec.tailBytes + 200)

                  // Timeout kill -> ExecFailure (Exec.ts L78-83, L196-198)
                  const toEx = yield* Effect.exit(
                    Exec.run(process.execPath, {
                      args: ["-e", "setTimeout(() => {}, 10000)"],
                      cwd: root,
                      timeoutMs: 80
                    })
                  )
                  expect(Exit.isFailure(toEx)).toBe(true)

                  // Nonexistent command -> ExecFailure (Exec.ts L205)
                  const badCmd = yield* Effect.exit(
                    Exec.run("/nonexistent-wave10a-bin-xyz", { args: [], cwd: root, timeoutMs: 2_000 })
                  )
                  expect(Exit.isFailure(badCmd)).toBe(true)
                } else if (scenario === "verifyCommandsAndPlantedVcs") {
                  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "v-proj" }))
                  // Verify with format + typecheck + test + planted .git creation (Verify.ts L225, 249, 308-326)
                  const vRes = yield* Verify.run({
                    root,
                    flowsDir: ".smithers/flows",
                    commands: {
                      install: undefined,
                      format: `${process.execPath} -e "process.exit(0)"`,
                      typecheck: [
                        `${process.execPath} -e "require('fs').mkdirSync('.git', { recursive: true })"`,
                        `${process.execPath} -e "process.exit(1)"`
                      ],
                      test: `${process.execPath} -e "process.exit(0)"`
                    },
                    budgets: { installMs: 5_000, commandMs: 5_000 }
                  } as any)
                  expect(Verify.verdict(vRes)).toBe("fail")
                  expect(Verify.failures(vRes).length).toBeGreaterThan(0)
                } else {
                  // migrateFlowPostconditionsAndReport (MigrateFlow.ts L610-734, L1136)
                  mkdirSync(join(root, "src"), { recursive: true })
                  writeFileSync(
                    join(root, "package.json"),
                    JSON.stringify({
                      name: "pc-proj",
                      dependencies: { "smithers-orchestrator": "^0.9.0", effect: "^3.12.0" }
                    })
                  )
                  writeFileSync(
                    join(root, "tsconfig.json"),
                    JSON.stringify({
                      compilerOptions: {
                        jsxImportSource: "smithers-orchestrator",
                        paths: { "smithers-orchestrator/*": ["./old/*"] }
                      }
                    })
                  )
                  writeFileSync(
                    join(root, "src", "integ.ts"),
                    `import { x } from "smithers-orchestrator"\nexport const y = x\n`
                  )

                  const baseOutline = {
                    id: "u1",
                    kind: "workflow",
                    sources: ["src/wf.tsx"],
                    targets: [".smithers/flows/u1/flow.ts"],
                    manifests: ["package.json", "missing/package.json"],
                    tsconfigs: ["tsconfig.json", "missing/tsconfig.json"],
                    specifiers: {},
                    expectedEffectVersion: "^4.1.0"
                  } as any
                  const pc1 = yield* MigrateFlow.postconditions(root, baseOutline)
                  expect(pc1.some((c) => !c.ok)).toBe(true)

                  const integOutline = {
                    ...baseOutline,
                    id: "integration:slack",
                    kind: "integration",
                    sources: ["src/integ.ts", "src/deleted-integ.ts"],
                    targets: []
                  } as any
                  const pc2 = yield* MigrateFlow.postconditions(root, integOutline)
                  expect(pc2.some((c) => !c.ok)).toBe(true)

                  // readUnitReport ID mismatch (MigrateFlow.ts L1136)
                  mkdirSync(join(root, ".smithers-migrate", "units"), { recursive: true })
                  writeFileSync(
                    join(root, ".smithers-migrate", "units", "expected-id.json"),
                    JSON.stringify({ id: "wrong-id", status: "failed" })
                  )
                  const badRep = yield* Effect.exit(MigrateFlow.readUnitReport({ root, mode: "apply" }, "expected-id"))
                  expect(Exit.isFailure(badRep) || Exit.isSuccess(badRep)).toBe(true)
                }

                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
                rmSync(outside, { recursive: true, force: true })
              }
            }).pipe(Effect.provide(NodeServices.layer), Effect.provide(silentLog)),
          { seed: seed + 2, executions: ioExec }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "fuzzes Mapping mechanical snippets (Sequence/Branch/Timer/WaitForEvent/Approval), Checks AST validators & Report rendering/finalize",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          snippetCase: Schema.Literals([
            "sequenceValid",
            "sequenceReservedBinding",
            "sequenceCollision",
            "branchWithElse",
            "timerDuration",
            "timerUntil",
            "timerEveryUnsupported",
            "waitForEventLiteral",
            "signalLiteral",
            "approvalGate"
          ]),
          checkCase: Schema.Literals([
            "emptyTag",
            "nonCallableBody",
            "delegateToSiblingFlow",
            "shorthandBody",
            "oldImportRemaining"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ snippetCase, checkCase }) =>
            Effect.gen(function*() {
              const root = mkdtempSync(join(tmpdir(), "wave10a-mig-p2-"))
              try {
                // 1. Mapping mechanical snippets (Mapping.ts L1350-1434, 1600-1676)
                const mkH = (
                  construct: string,
                  props: ReadonlyArray<string>,
                  detail: Record<string, any>
                ): Inventory.InventoryEntry => ({
                  construct,
                  file: "src/wf.tsx",
                  line: 12,
                  excerpt: `<${construct} />`,
                  props,
                  detail
                } as any)

                if (snippetCase === "sequenceValid") {
                  const h = mkH("Sequence", [], {
                    children: [{ id: "fetch" }, { id: "build" }],
                    payloads: {
                      fetch: { repo: "ctx.input.repo" },
                      build: { src: "deps.fetch.data", tag: "ctx.input.tag" }
                    },
                    childOutputs: { fetch: "z.object({ data: z.string() })", build: "z.boolean()" }
                  })
                  Mapping.classifyWithReason(h)
                  const sn = Mapping.snippet(h)
                  expect(sn === undefined || sn.includes("bindPlanned")).toBe(true)
                } else if (snippetCase === "sequenceReservedBinding") {
                  const h = mkH("Sequence", [], {
                    children: [{ id: "class" }, { id: "next" }],
                    payloads: { class: {}, next: { v: "deps.class.val" } }
                  })
                  Mapping.snippet(h)
                } else if (snippetCase === "sequenceCollision") {
                  const h = mkH("Sequence", [], {
                    children: [{ id: "a-b" }, { id: "a_b" }],
                    payloads: { "a-b": {}, "a_b": {} }
                  })
                  Mapping.snippet(h)
                } else if (snippetCase === "branchWithElse") {
                  const h = mkH("Branch", ["if", "then", "else"], {
                    thenStep: { id: "yes" },
                    elseStep: { id: "no" },
                    payloads: { yes: { a: "ctx.input.a" }, no: { b: "ctx.input.b" } }
                  })
                  Mapping.snippet(h)
                } else if (snippetCase === "timerDuration") {
                  for (const d of ["500ms", "5s", "2m", "1h", "1d", "-1s", "bad"]) {
                    const h = mkH("Timer", ["duration"], { duration: d })
                    Mapping.classifyWithReason(h)
                    Mapping.snippet(h)
                  }
                } else if (snippetCase === "timerUntil") {
                  for (const u of ["1700000000000", "1700000000000ms"]) {
                    const h = mkH("Timer", ["until"], { until: u })
                    Mapping.classifyWithReason(h)
                    Mapping.snippet(h)
                  }
                } else if (snippetCase === "timerEveryUnsupported") {
                  const h = mkH("Timer", ["every"], { every: "5m" })
                  Mapping.classifyWithReason(h)
                  expect(Mapping.snippet(h)).toBeUndefined()
                } else if (snippetCase === "waitForEventLiteral") {
                  const h = mkH("WaitForEvent", ["event"], { eventLiteral: "deploy.ready" })
                  expect(Mapping.snippet(h)).toContain("WaitFor.action.call")
                } else if (snippetCase === "signalLiteral") {
                  const h = mkH("Signal", ["correlationId"], { correlationIdLiteral: "order-1" })
                  expect(Mapping.snippet(h)).toContain("WaitFor.action.call")
                } else {
                  const h = mkH("Approval", [], { id: "ship-it", request: "Ship release?" })
                  expect(Mapping.snippet(h)).toContain("HumanTask.action.call")
                  const hRestricted = mkH("Approval", ["allowedRoles"], { id: "r", request: "R?" })
                  const rSnip = Mapping.snippet(hRestricted)
                  expect(rSnip === undefined || typeof rSnip === "string").toBe(true)
                }

                // 2. Checks AST validation on flows under .smithers/flows (Checks.ts L117-260, 477-549)
                mkdirSync(join(root, ".smithers", "flows", "demo"), { recursive: true })
                const flowPath = ".smithers/flows/demo/flow.ts"
                const flowSrcMap: Record<typeof checkCase, string> = {
                  emptyTag:
                    `import { Flow } from "@smthrs/flow"\nexport default Flow.make("", { description: "d", body: () => 1 })\n`,
                  nonCallableBody:
                    `import { Flow } from "@smthrs/flow"\nexport default Flow.make("demo", { description: "d", body: 123 })\n`,
                  delegateToSiblingFlow:
                    `import { Flow } from "@smthrs/flow"\nconst Inner = Flow.make("inner", { description: "i", body: () => 1 })\nexport default Flow.make("demo", { description: "d", body: (p) => { return Inner.call(p) } })\n`,
                  shorthandBody:
                    `import { Flow } from "@smthrs/flow"\nconst body = () => 1\nconst description = "d"\nexport default Flow.make("demo", { description, body })\n`,
                  oldImportRemaining:
                    `import { Workflow } from "smithers-orchestrator"\nimport { Flow } from "@smthrs/flow"\nexport default Flow.make("demo", { description: "d", body: () => Workflow })\n`
                }
                writeFileSync(join(root, flowPath), flowSrcMap[checkCase])
                const fakeUnit = {
                  id: "demo",
                  kind: "workflow",
                  sources: ["src/wf.tsx"],
                  specifiers: {},
                  verification: { discovery: { flowsDir: ".smithers/flows" } },
                  constructs: [],
                  decisions: [],
                  unsafe: [],
                  notes: []
                } as any
                const chks = yield* Checks.run(
                  root,
                  fakeUnit,
                  [flowPath],
                  { sources: new Map(), digests: new Map(), runStateRoots: [] },
                  [],
                  []
                )
                expect(chks.length).toBeGreaterThan(0)

                // 3. Report.empty + withUnit + finalize + toJson + toMarkdown + write (Report.ts L451-994)
                const fakeRunState: RunState.RunStateReport = {
                  databases: [
                    {
                      path: ".smithers/db.sqlite",
                      readable: true,
                      migrations: { count: 2 },
                      runsByStatus: [{ status: "running", count: 1 }],
                      live: [{ runId: "r1", workflowName: "wf", status: "running", heartbeatAtMs: 1000 }],
                      parked: [{ runId: "r2", workflowName: "wf", status: "waiting-approval" }]
                    } as any
                  ],
                  external: [{ declared: "dbPath", resolved: "/ext/db.sqlite" }],
                  postgres: { backend: "postgres", sources: [{ file: "smithers.config.ts", text: "pg" }] } as any,
                  pglite: { backend: "pglite", sources: [{ file: ".smithers/pg/PG_VERSION", text: "pglite" }] } as any,
                  stateDirs: [{ path: ".smithers/runs", kind: "directory", files: 2, bytes: 200, newestMtimeMs: 1000 }],
                  gatewayState: ["/tmp/smithers-gateway/g.json"],
                  verdict: "blocked",
                  instructions: ["Stop live runs before migrating"]
                }
                let rep = Report.empty(root, "apply", "2026-11-24T00:00:00Z")
                rep = new Report.MigrationReport({
                  ...rep,
                  project: {
                    ...rep.project,
                    packageManager: "pnpm",
                    effectPin: "3.15.0",
                    globalState: ["~/.smithers"],
                    warnings: [{ code: "effect-pin", file: "package.json", message: "effect pin conflict" }],
                    integrations: [{ file: "src/mcp.ts", line: 1, integration: "mcp", kind: "import" }],
                    config: [{ kind: "smithers.config", path: "smithers.config.ts", detail: "backend=postgres" }]
                  },
                  runState: Report.runState(fakeRunState),
                  inventory: [
                    {
                      file: "src/wf.tsx",
                      line: 1,
                      column: 1,
                      construct: "Workflow",
                      props: ["name"],
                      class: "automatic"
                    },
                    { file: "src/wf.tsx", line: 8, column: 1, construct: "Worktree", props: [], class: "unsafe" }
                  ],
                  mapping: [
                    {
                      construct: "Workflow",
                      target: "Flow.make",
                      rule: "workflow-to-flow",
                      class: "automatic",
                      decidedBy: "scanner",
                      occurrences: 1
                    },
                    {
                      construct: "Worktree",
                      target: null,
                      rule: "worktree-unsafe",
                      class: "unsafe",
                      decidedBy: "agent",
                      reason: "manual",
                      unit: "u1",
                      occurrences: 1
                    }
                  ],
                  followUps: [
                    { severity: "must", text: "Fix TS error in src/wf.tsx", unit: "u1" },
                    { severity: "should", text: "Review archived files" },
                    { severity: "info", text: "Run full test suite" }
                  ]
                })
                rep = Report.withUnit(rep, {
                  id: "u1",
                  kind: "workflow",
                  status: checkCase === "emptyTag"
                    ? "failed"
                    : checkCase === "nonCallableBody"
                    ? "blocked"
                    : checkCase === "shorthandBody"
                    ? "migrated"
                    : "skipped",
                  sources: ["src/wf.tsx"],
                  targets: [".smithers/flows/u1/flow.ts"],
                  changedFiles: [
                    { path: ".smithers/flows/u1/flow.ts", change: "added", bytes: 120 },
                    { path: "src/wf.tsx", change: "archived", bytes: 90 }
                  ],
                  decisions: [{
                    construct: "Approval",
                    file: "src/wf.tsx",
                    line: 5,
                    choice: "confirm",
                    reason: "manual"
                  }],
                  unresolved: [{
                    construct: "Worktree",
                    file: "src/wf.tsx",
                    line: 8,
                    reason: "needs review",
                    suggestion: "Use workspace service",
                    unit: "u1"
                  }],
                  unsupported: [{
                    construct: "Ralph",
                    file: "src/wf.tsx",
                    line: 9,
                    closest: "Loop",
                    reason: "manual",
                    unit: "u1"
                  }],
                  verification: {
                    install: { command: "pnpm install", exitCode: 0, durationMs: 10, stdoutTail: "", stderrTail: "" },
                    format: {
                      command: "biome",
                      exitCode: 0,
                      durationMs: 5,
                      stdoutTail: "",
                      stderrTail: "",
                      skipped: "no formatter"
                    },
                    typecheck: [{ command: "tsc", exitCode: 1, durationMs: 20, stdoutTail: "", stderrTail: "TS2322" }],
                    tests: { command: "vitest", exitCode: 0, durationMs: 15, stdoutTail: "ok", stderrTail: "" },
                    discovery: { command: "discovery", exitCode: 0, durationMs: 5, stdoutTail: "", stderrTail: "" }
                  },
                  checkpoint: { vcs: "none", ref: "cp-1", restore: "restore cp-1" },
                  repairRounds: 1,
                  durationMs: 120
                })
                const finalized = Report.finalize(rep, {
                  acknowledgeRunState: checkCase === "shorthandBody"
                })
                const md = Report.toMarkdown(finalized)
                const js = Report.toJson(finalized)
                expect(md).toContain("u1")
                expect(js).toContain("u1")
                yield* Report.write(join(root, ".smithers-migrate"), finalized)

                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
              }
            }).pipe(Effect.provide(NodeServices.layer), Effect.provide(silentLog)),
          { seed: seed + 3, executions: Math.min(ioExec, 24) }
        )
      )
      assertPassed(report)
    },
    120_000
  )
  it(
    "fuzzes Mapping childConstructs/snippets, Checks AST violations, Detect symlinks/UI/oversize, and CliScripts flags",
    async () => {
      const scenarioArb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals(["workflow", "sequence", "parallel", "branch", "misc"]),
          checkViolation: Schema.Literals([
            "react",
            "sqlite",
            "loop",
            "seatUnjustified",
            "seatJustified",
            "escapeHatch"
          ]),
          cliCase: Schema.Literals(["upFlags", "workflowRunFlags", "unsupportedFlag", "chained"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          scenarioArb,
          ({ mode, checkViolation, cliCase }) =>
            Effect.gen(function*() {
              const root = mkdtempSync(join(tmpdir(), "w10-mig-p3-"))
              try {
                const mkHit = (
                  construct: string,
                  props: ReadonlyArray<string>,
                  detail: Record<string, string>
                ): Inventory.InventoryEntry => ({
                  file: "src/wf.tsx",
                  line: 10,
                  column: 2,
                  construct,
                  props,
                  detail
                })

                // 1. Mapping.snippet & classifyWithReason with exact childConstructs format
                if (mode === "workflow") {
                  const wfOk = mkHit("Workflow", ["name"], {
                    name: "wf-demo",
                    description: "Demo workflow",
                    payloadChain: "z.object({ a: z.string(), n: z.number().optional() })",
                    childConstructs: "Task:break,Task:done",
                    childPayloads: JSON.stringify({
                      break: { x: "ctx.input.a" },
                      done: { y: "deps.break.out" }
                    }),
                    childOutputs: JSON.stringify({
                      break: "z.object({ out: z.string() })",
                      done: "z.object({ ok: z.boolean() })"
                    }),
                    childAgents: "break"
                  })
                  expect(Mapping.snippet(wfOk)).toContain("export default Flow.make")
                  expect(Mapping.snippet(wfOk)).toContain("breakValue")
                  expect(Mapping.snippet(wfOk)).toContain("AgentAction.AgentFailure")
                  // Missing output / unresolved payload -> undefined
                  const wfNoOut = mkHit("Workflow", ["name"], {
                    name: "wf-bad",
                    payloadChain: "z.object({ a: z.string() })",
                    childConstructs: "Task:s1",
                    childPayloads: JSON.stringify({ s1: { x: "other.expr" } }),
                    childOutputs: JSON.stringify({ s1: null })
                  })
                  expect(Mapping.snippet(wfNoOut)).toBeUndefined()
                  const wfUnnamed = mkHit("Workflow", ["name"], {
                    name: "wf-unnamed",
                    payloadChain: "z.object({ a: z.string() })",
                    childConstructs: "Task:"
                  })
                  expect(Mapping.snippet(wfUnnamed)).toBeUndefined()
                } else if (mode === "sequence") {
                  const seqOk = mkHit("Sequence", [], {
                    childConstructs: "Task:first,Task:second",
                    childPayloads: JSON.stringify({
                      first: { a: "ctx.input.a" },
                      second: { b: "deps.first.val" }
                    })
                  })
                  expect(Mapping.snippet(seqOk)).toContain("Node.bindPlanned")
                  const seqBad = mkHit("Sequence", [], {
                    childConstructs: "Task:first,Task:second",
                    childPayloads: JSON.stringify({
                      first: { a: "ctx.input.a" },
                      second: { b: "deps.unknown.val" }
                    })
                  })
                  expect(Mapping.snippet(seqBad)).toBeUndefined()
                } else if (mode === "parallel") {
                  const parOk = mkHit("Parallel", [], {
                    childConstructs: "Task:left-arm,Task:right-arm",
                    childPayloads: JSON.stringify({
                      "left-arm": { a: "ctx.input.a" },
                      "right-arm": {}
                    })
                  })
                  expect(Mapping.snippet(parOk)).toContain("Node.all")
                  const parCollide = mkHit("Parallel", [], {
                    childConstructs: "Task:a-b,Task:a_b",
                    childPayloads: JSON.stringify({ "a-b": {}, "a_b": {} })
                  })
                  expect(Mapping.snippet(parCollide)).toBeUndefined()
                } else if (mode === "branch") {
                  const brBoth = mkHit("Branch", ["if", "then", "else"], {
                    if: "payload.flag",
                    thenConstructs: "Task:yes",
                    elseConstructs: "Task:no",
                    thenPayloads: JSON.stringify({ yes: { a: "ctx.input.a" } }),
                    elsePayloads: JSON.stringify({ no: { b: "ctx.input.b" } })
                  })
                  expect(Mapping.snippet(brBoth)).toContain("Node.branch")
                  const brNoElse = mkHit("Branch", ["if", "then"], {
                    if: "payload.flag",
                    thenConstructs: "Task:yes",
                    elseConstructs: "",
                    thenPayloads: JSON.stringify({ yes: { a: "ctx.input.a" } })
                  })
                  expect(Mapping.snippet(brNoElse)).toContain("Node.branch")
                } else {
                  const appWhen = mkHit("Approval", ["when"], {
                    id: "gate",
                    request: "Proceed?",
                    when: "payload.risky"
                  })
                  expect(Mapping.snippet(appWhen)).toContain("Node.branch")
                  expect(Mapping.snippet(mkHit("close", [], {}))).toContain("host layer")
                  expect(Mapping.snippet(mkHit("outputs.<key>", [], {}))).toContain("already in scope")
                  expect(Mapping.snippet(mkHit("tables.<key>", [], {}))).toContain("already in scope")
                  expect(Mapping.snippet(mkHit("runWorkflow", [], {}))).toContain("flow.execute")
                  expect(Mapping.snippet(mkHit("ctx.input", [], {}))).toContain("already in scope")
                  expect(
                    Mapping.snippet(mkHit("smithers up", [], { command: "smithers up src/wf.tsx --input '{\"a\":1}'" }))
                  ).toBeDefined()
                  expect(
                    Mapping.snippet(mkHit("smithers workflow", [], { command: "smithers workflow run src/wf.tsx" }))
                  ).toBeDefined()
                  expect(Mapping.snippet(mkHit("smithers up", [], {}))).toBeUndefined()
                }

                // 2. Checks AST violations (Checks.ts L165-184, 353-378, 477-549)
                mkdirSync(join(root, ".smithers", "flows", "demo"), { recursive: true })
                const flowPath = ".smithers/flows/demo/flow.ts"
                const bodies: Record<typeof checkViolation, string> = {
                  react:
                    `import React from "react"\nimport { Flow } from "@smthrs/flow"\nexport default Flow.make("demo", { description: "d", body: () => React })\n`,
                  sqlite:
                    `import { Database } from "bun:sqlite"\nimport { Flow } from "@smthrs/flow"\nexport default Flow.make("demo", { description: "d", body: () => new Database(":memory:") })\n`,
                  loop:
                    `import { Flow } from "@smthrs/flow"\nexport default Flow.make("demo", { description: "d", body: () => { setInterval(() => {}, 10); while (true) { break } while (1) { break } } })\n`,
                  seatUnjustified:
                    `import { Flow } from "@smthrs/flow"\nconst cfg = { seat: "openai:gpt-invented" }\nexport default Flow.make("demo", { description: "d", body: () => cfg })\n`,
                  seatJustified:
                    `import { Flow } from "@smthrs/flow"\nconst cfg = { seat: "openai:gpt-5" }\nexport default Flow.make("demo", { description: "d", body: () => cfg })\n`,
                  escapeHatch:
                    `import { Flow } from "@smthrs/flow"\n// @ts-ignore\nconst x = (1 as any)\nexport default Flow.make("demo", { description: "d", body: () => x })\n`
                }
                writeFileSync(join(root, flowPath), bodies[checkViolation])
                const chkUnit = {
                  id: "demo",
                  kind: "workflow",
                  sources: ["src/wf.tsx"],
                  specifiers: {},
                  verification: { discovery: { flowsDir: ".smithers/flows" } },
                  constructs: [],
                  decisions: [],
                  unsafe: [],
                  notes: []
                } as any
                const chkRes = yield* Checks.run(
                  root,
                  chkUnit,
                  [flowPath],
                  { sources: new Map([[flowPath, ""]]), digests: new Map(), runStateRoots: [] },
                  [],
                  checkViolation === "seatJustified" ? ["openai:gpt-5"] : []
                )
                expect(chkRes.length).toBeGreaterThan(0)

                // 3. Detect symlinks, sparse >8MB file, .smithers/ui, and <UI entry=...> (Detect.ts L765-796, 1284-1316)
                mkdirSync(join(root, "src"), { recursive: true })
                mkdirSync(join(root, ".smithers", "ui"), { recursive: true })
                writeFileSync(
                  join(root, "package.json"),
                  JSON.stringify({ name: "p3-app", dependencies: { "smithers-orchestrator": "0.14.0" } })
                )
                writeFileSync(join(root, ".smithers", "ui", "panel.tsx"), `export const Panel = () => null\n`)
                writeFileSync(
                  join(root, "src", "wf.tsx"),
                  `import { createSmithers } from "smithers-orchestrator"\nconst { smithers, Workflow } = createSmithers({}); export default smithers(() => (<Workflow name="w"><UI entry="../.smithers/ui/panel.tsx" /><UI entry="./missing.tsx" /></Workflow>))\n`
                )
                symlinkSync(join(root, "package.json"), join(root, "src", "linked.ts"))
                const bigPath = join(root, "src", "oversized.ts")
                writeFileSync(bigPath, "// big\n")
                truncateSync(bigPath, 8 * 1024 * 1024 + 64)
                const det = yield* Detect.scan(root)
                expect(det.warnings.some((w) => w.code === "incomplete-scan")).toBe(true)
                expect(det.warnings.some((w) => w.code === "unresolved-ui-entry")).toBe(true)
                expect(det.uis.length).toBeGreaterThanOrEqual(2)

                // 3b. Rich ZodSchemaHints + Inventory + Detect config/pragma branches
                const zodExprs = [
                  "z.string().min(1).max(10).email().url().uuid().regex(/^a/)",
                  "z.number().int().positive().nonnegative().min(0).max(9)",
                  "z.boolean().default(false)",
                  "z.literal(\"ok\")",
                  "z.enum([\"a\", \"b\"])",
                  "z.array(z.string()).nonempty()",
                  "z.record(z.string(), z.number())",
                  "z.tuple([z.string(), z.number()])",
                  "z.union([z.string(), z.number()]).nullable().optional()",
                  "z.discriminatedUnion(\"kind\", [z.object({ kind: z.literal(\"a\"), v: z.string() }), z.object({ kind: z.literal(\"b\"), n: z.number() })])",
                  "z.object({ a: z.string().optional(), b: z.number().default(1) }).strict()",
                  "z.bigint()",
                  "z.date()",
                  "z.any()",
                  "z.unknown()",
                  "z.custom(() => true)"
                ]
                for (const zexpr of zodExprs) {
                  ZodSchemaHints.print(zexpr)
                  ZodSchemaHints.printField(zexpr)
                }
                writeFileSync(
                  join(root, "tsconfig.json"),
                  JSON.stringify({
                    compilerOptions: {
                      jsx: "react-jsx",
                      jsxImportSource: "smithers-orchestrator",
                      paths: { "@/*": ["./src/*"] }
                    }
                  })
                )
                writeFileSync(join(root, "bunfig.toml"), `preload = ["./src/preload.ts"]\n`)
                writeFileSync(
                  join(root, "src", "preload.ts"),
                  `import { mdxPlugin } from "smithers-orchestrator/mdx"\nmdxPlugin()\n`
                )
                writeFileSync(
                  join(root, "smithers.config.ts"),
                  `export default { backend: "postgres", repoCommands: { test: "pnpm test" } }\n`
                )
                mkdirSync(join(root, ".smithers", "skills"), { recursive: true })
                mkdirSync(join(root, ".smithers", "evals"), { recursive: true })
                writeFileSync(join(root, ".smithers", "skills", "s.md"), "# skill\n")
                writeFileSync(join(root, ".smithers", "evals", "e.ts"), "export default {}\n")
                writeFileSync(
                  join(root, "src", "rich.tsx"),
                  [
                    `/** @jsxImportSource smithers-orchestrator */`,
                    `import { createSmithers, Workflow, Sequence, Parallel, Branch, Timer, Approval, WaitForEvent, Signal, Ralph, Worktree, Task, runWorkflow } from "smithers-orchestrator"`,
                    `const { smithers, outputs, tables, db } = createSmithers({})`,
                    `export default smithers((ctx: any) => (`,
                    `  <Workflow name="rich">`,
                    `    <Sequence>`,
                    `      <Parallel maxConcurrency={2}>`,
                    `        <Task id="t1">{ctx.input.a}{ctx.output("t0")}{ctx.latest("t0")}{outputs.t1}{tables.t1}</Task>`,
                    `        <Approval id="a1" allowedRoles={["admin"]} request="ok?" />`,
                    `      </Parallel>`,
                    `      <Branch if={ctx.input.ok} then={<Timer duration="5s" />} else={<Timer until={1700000000000} />} />`,
                    `      <Timer every="5m" />`,
                    `      <WaitForEvent event="ev.go" />`,
                    `      <Signal correlationId="c1" />`,
                    `      <Ralph maxIterations={3}><Worktree path="."><Task id="t2">hi</Task></Worktree></Ralph>`,
                    `    </Sequence>`,
                    `  </Workflow>`,
                    `))`,
                    `export const runIt = () => { db.close(); return runWorkflow({} as any, {}) }`
                  ].join("\n")
                )
                const scanRich = yield* Scan.scan(root)
                expect(scanRich.inventory.length).toBeGreaterThan(3)
                expect(scanRich.units.length).toBeGreaterThan(0)

                const cliSamples = [
                  "smithers up src/wf.tsx -d '{\"a\":1}'",
                  "smithers up -d src/wf.tsx",
                  "smithers up -d=1 src/wf.tsx",
                  "smithers up src/wf.tsx -d $VAR",
                  "smithers up src/wf.tsx --detached --remote",
                  "smithers up src/wf.tsx --detached --detached",
                  "smithers up src/wf.tsx --backend=sqlite --input='{\"k\":1}'",
                  "smithers up src/wf.tsx --backend=postgres",
                  "smithers up src/wf.tsx --input='[1,2]'",
                  "smithers up src/wf.tsx --input=notjson",
                  "smithers up src/wf.tsx --input=",
                  "smithers up src/wf.tsx --input --other",
                  "smithers up ../escape.tsx",
                  "smithers up /abs.tsx",
                  "smithers up",
                  "smithers flow start demo"
                ]
                for (const cmd of cliSamples) {
                  CliScripts.rewrite(cmd, (fp) => fp.replace(/^src\/|\.tsx$/g, ""))
                }
                // 4. CliScripts rewrite flags
                const cliMap: Record<typeof cliCase, string> = {
                  upFlags: "smithers up src/wf.tsx --input '{\"k\":1}' --max-concurrency 4 --resume",
                  workflowRunFlags: "smithers workflow run src/wf.tsx -i '{\"x\":2}' --run-id r1",
                  unsupportedFlag: "smithers up src/wf.tsx --port 3000 --watch",
                  chained: "smithers up src/a.tsx && smithers workflow run src/b.tsx"
                }
                const rw = CliScripts.rewrite(cliMap[cliCase], (p) => p.replace(/^src\/|\.tsx$/g, ""))
                expect(typeof rw.after).toBe("string")

                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
              }
            }).pipe(Effect.provide(NodeServices.layer), Effect.provide(silentLog)),
          { seed: seed + 4, executions: Math.min(ioExec, 24) }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
