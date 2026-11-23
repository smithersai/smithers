import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Schema } from "effect"
import * as FsSync from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Migrate from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/migrate AST scanners, Zod/Prompt translators, Options path security, Scan & Report fuzz invariants", () => {
  it("Detect.isOldSpecifier, classifyPackage, classifyPrompt & resolvedEffectVersions classify 0.x vs 1.x reliably", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        spec: Schema.Literals([
          "smthrs",
          "smithers-orchestrator",
          "smithers-orchestrator/jsx-runtime",
          "@smithers/core",
          "@smithers-orchestrator/sdk",
          "@smthrs/flow",
          "@smthrs/agent",
          "effect",
          "react",
          "./local.ts"
        ]),
        version: Schema.Literals(["0.9.0", "^0.12.1", "1.0.0", "1.0.0-rc.18", "workspace:*", "4.1.1"]),
        promptText: Schema.Literals([
          "Simple prompt text",
          "Hello {{name}} from {{repo}}",
          "Use {props.x} and <Component />",
          "import foo from ./bar\n# Heading\nBody",
          "```ts\nconst x = 1\n```\nPlain"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ spec, version, promptText }) =>
          Effect.sync(() => {
            const isOld = Migrate.Detect.isOldSpecifier(spec)
            if (
              spec === "@smthrs/flow" || spec === "@smthrs/agent" || spec === "effect" || spec === "react" ||
              spec === "./local.ts"
            ) {
              if (isOld) return false
            }
            if (spec === "smthrs" || spec === "smithers-orchestrator" || spec.startsWith("@smithers/")) {
              if (!isOld) return false
            }
            const pkgClass = Migrate.Detect.classifyPackage(spec, version)
            if (spec === "smithers-orchestrator" && pkgClass === undefined) return false
            if (
              spec === "@smthrs/flow" && (version.startsWith("1.") || version === "workspace:*") &&
              pkgClass !== undefined
            ) return false

            const pClass = Migrate.Detect.classifyPrompt(promptText)
            const pHint = Migrate.PromptHints.classify(promptText)
            if (pClass.classification !== pHint) return false
            const printed = Migrate.PromptHints.print(promptText)
            if (typeof printed !== "string") return false

            const lock = `packages:\n  effect@${version}:\n    resolution: {}\n`
            const versions = Migrate.Detect.resolvedEffectVersions(lock)
            return Array.isArray(versions)
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ZodSchemaHints.classify, print & printField handle valid Zod chains, refinements, and malformed expressions without crashing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        chain: Schema.Literals([
          "z.string()",
          "z.string().min(1).max(64)",
          "z.number().int().nonnegative()",
          "z.boolean().optional()",
          "z.string().nullable()",
          "z.array(z.string())",
          "z.enum([a, b, c])",
          "z.literal(ok)",
          "z.object({ id: z.string(), count: z.number().optional() })",
          "z.union([z.string(), z.number()])",
          "z.record(z.string(), z.number())",
          "z.string().transform((s) => s.trim())",
          "z.string().refine((s) => s.length > 0)",
          "z.unknown()",
          "z.any()",
          "not_a_zod_chain(",
          ""
        ]),
        raw: Schema.String.check(Schema.isMaxLength(40))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ chain, raw }) =>
          Effect.sync(() => {
            const c = Migrate.ZodSchemaHints.classify(chain)
            const p = Migrate.ZodSchemaHints.print(chain)
            const pf = Migrate.ZodSchemaHints.printField(chain)
            if (chain === "z.string()" && (p === undefined || !p.includes("Schema.String"))) return false
            if (chain === "z.boolean().optional()" && pf === undefined) return false
            if (c.class === "automatic" && p === undefined) return false
            // Arbitrary text must never throw
            Migrate.ZodSchemaHints.classify(raw)
            Migrate.ZodSchemaHints.print(raw)
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Options path validators reject traversal, absolute paths & reserved dirs; Contract.fenced/inline never break fences", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pathVal: Schema.Literals([
          ".smithers/flows",
          "flows/out",
          "../escape",
          "/abs/path",
          "a/../b",
          ".git/hooks",
          ".jj/repo",
          "node_modules/pkg",
          "",
          "a\\b",
          "foo\u0000bar"
        ]),
        text: Schema.String.check(Schema.isMaxLength(60)),
        cmdLine: Schema.Literals([
          "pnpm test",
          "npm run build",
          "echo hello && rm -rf /",
          "tsc --noEmit",
          ""
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pathVal, text, cmdLine }) =>
          Effect.sync(() => {
            const relIssue = Migrate.Options.relativePathIssue("flowsDir", pathVal)
            const lexIssue = Migrate.Options.lexicalPathIssue("flowsDir", pathVal)
            if (pathVal.startsWith("/") || pathVal.includes("..") || pathVal === "" || pathVal.includes("\u0000")) {
              if (relIssue === undefined && lexIssue === undefined) return false
            }
            const layoutIss = Migrate.Options.layoutIssue({
              root: "/repo",
              reportDir: pathVal,
              layout: { flowsDir: ".smithers/flows" }
            })
            if (pathVal === ".git/hooks" || pathVal === ".jj/repo" || pathVal === "node_modules/pkg") {
              if (layoutIss === undefined) return false
            }

            const fenced = Migrate.Contract.fenced(text, "ts")
            const lines = fenced.split("\n")
            const opener = lines[0]!
            const closer = lines[lines.length - 1]!
            const tickCount = opener.match(/^`+/)?.[0]?.length ?? 0
            if (tickCount < 3 || closer !== "`".repeat(tickCount)) return false

            const inl = Migrate.Contract.inline(text.replace(/\n/g, " "))
            if (!inl.startsWith("`") || !inl.endsWith("`")) return false

            const parsedCmd = Migrate.Units.simpleCommand(cmdLine)
            if (cmdLine.includes("&&") && parsedCmd !== undefined) return false
            if (cmdLine === "pnpm test" && (parsedCmd === undefined || parsedCmd.executable !== "pnpm")) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Scan.scan, Inventory.scanFile, Report.toJson/toMarkdown, Gate.evaluate & Checks.run roundtrip on real synthetic 0.x repos", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-migrate-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          hasOldPkg: Schema.Boolean,
          hasJsxWorkflow: Schema.Boolean,
          hasPromptMdx: Schema.Boolean,
          mode: Schema.Literals(["scan", "plan", "apply"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ hasOldPkg, hasJsxWorkflow, hasPromptMdx, mode }) =>
            Effect.gen(function*() {
              const dir = FsSync.mkdtempSync(Path.join(tmpRoot, "proj-"))
              try {
                FsSync.writeFileSync(
                  Path.join(dir, "package.json"),
                  JSON.stringify({
                    name: "fuzz-proj",
                    version: "0.1.0",
                    dependencies: hasOldPkg
                      ? { "smithers-orchestrator": "^0.9.0", zod: "^3.23.0" }
                      : { "@smthrs/flow": "1.0.0" }
                  })
                )
                if (hasJsxWorkflow) {
                  FsSync.mkdirSync(Path.join(dir, "workflows"), { recursive: true })
                  const wfCode = [
                    `import { createSmithers } from "smithers-orchestrator"`,
                    `import { z } from "zod"`,
                    `const Out = z.object({ ok: z.boolean() })`,
                    `const { Workflow, Task, smithers } = createSmithers({ out: Out })`,
                    `export default smithers((ctx) => <Workflow name="demo"><Task id="t1" output={Out}>hi</Task></Workflow>)`
                  ].join("\n")
                  FsSync.writeFileSync(Path.join(dir, "workflows/demo.tsx"), wfCode)
                  const invFile = Migrate.Inventory.scanFile("workflows/demo.tsx", wfCode, {
                    factories: new Set(["createSmithers"])
                  })
                  if (invFile.length === 0) return false
                }
                if (hasPromptMdx) {
                  FsSync.mkdirSync(Path.join(dir, "prompts"), { recursive: true })
                  FsSync.writeFileSync(Path.join(dir, "prompts/hello.mdx"), "# Hello\nSummarize {{repo}}.\n")
                }

                const scanned = yield* Migrate.Scan.scan(dir)
                const rep = Migrate.Scan.toReport(scanned, mode, "2026-11-23T00:00:00.000Z")
                const finalized = Migrate.Report.finalize(rep)
                const json = Migrate.Report.toJson(finalized)
                const md = Migrate.Report.toMarkdown(finalized)
                if (JSON.parse(json).mode !== mode) return false
                if (!md.toLowerCase().includes("migration")) return false

                const gateRes = yield* Migrate.Gate.evaluate(scanned, { mode }).pipe(Effect.result)
                const repGateRes = yield* Migrate.Gate.evaluateReport(finalized, { mode }).pipe(Effect.result)
                if (gateRes._tag !== "Success" && gateRes._tag !== "Failure") return false
                if (repGateRes._tag !== "Success" && repGateRes._tag !== "Failure") return false

                if (scanned.units.length > 0) {
                  const checks = yield* Migrate.Checks.run(dir, scanned.units[0]!, [], {
                    sources: new Map(),
                    digests: new Map()
                  })
                  if (!Array.isArray(checks)) return false
                }
                return true
              } finally {
                FsSync.rmSync(dir, { recursive: true, force: true })
              }
            }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
          { seed: seed + 3, executions: Math.min(executions, 20) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
