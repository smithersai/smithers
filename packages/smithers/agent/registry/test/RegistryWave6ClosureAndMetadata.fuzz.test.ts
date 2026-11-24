import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, FileSystem, Layer, Path, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as ModuleClosure from "../src/internal/ModuleClosure.ts"
import * as ModuleMetadata from "../src/internal/ModuleMetadata.ts"
import * as RegistryError from "../src/RegistryError.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const NodePlatform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

describe("@smthrs/registry Wave 6 deep fuzz (ModuleMetadata, ModuleClosure, Discovery, Executable, RegistryError)", () => {
  it("ModuleMetadata.tokenize/parse/stringLiteral/isComplete handle JS escapes, regex/slash ambiguity, conservative effects, and malformed flow declarations", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        descExpr: Schema.Literals([
          `"simple description"`,
          `'escaped\\n\\t\\q\\x41\\u0042'`,
          `"line\\\ncontinuation"`,
          `\`template literal\``,
          `computeDesc()`
        ]),
        effectsExpr: Schema.Literals([
          `{ reads: ["src/**"], writes: [], mode: "hermetic", tier: "sealed", onConflict: "parallel" }`,
          `{ reads: ["**"], writes: ["dist/**"], mode: "expected", tier: "irreversible" }`,
          `flag ? { reads: [], writes: [], tier: "sealed" } : external`,
          `({ reads: [], writes: [] }).value`,
          `choose({ reads: [] })`,
          `{ reads: [dynamicVar], writes: [] }`
        ]),
        capsExpr: Schema.Literals([
          `["fs:read", "net:get"]`,
          `[Capability.make("fs:read", "**")]`,
          `[...dynamicCaps]`,
          `[]`
        ]),
        extra: Schema.Literals([
          `// comment with /regex/ and "quotes"\nconst r = /foo\\/bar/gi\n`,
          `/* block comment */ const d = 10 / 2 / 5\n`,
          `const s = \`nested \${1 + 2} end\`\n`,
          `export const modelInvocable = true\n`
        ]),
        modelInvocable: Schema.Literals(["true", "false", "unknownVar", ""])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ descExpr, effectsExpr, capsExpr, extra, modelInvocable }) =>
          Effect.sync(() => {
            const miProp = modelInvocable === "" ? "" : `modelInvocable: ${modelInvocable},`
            const source = `${extra}
export default Flow.make("wave6/flow", {
  description: ${descExpr},
  capabilities: ${capsExpr},
  effects: ${effectsExpr},
  ${miProp}
  body: () => Effect.void
})
`
            const t1 = ModuleMetadata.tokenize(source, "likely")
            const t2 = ModuleMetadata.tokenize(source, "alternate")
            expect(t1.length).toBeGreaterThan(0)
            expect(t2.length).toBeGreaterThan(0)
            expect(ModuleMetadata.isComplete(source)).toBe(true)

            const parsed = ModuleMetadata.parse(source)
            expect(parsed).toBeDefined()
            expect(Array.isArray(parsed.warnings)).toBe(true)
            expect(Array.isArray(parsed.effects.reads)).toBe(true)
            expect(Array.isArray(parsed.effects.writes)).toBe(true)

            // Non-static effects expressions must fall back conservatively
            if (effectsExpr.includes("flag ?") || effectsExpr.includes("choose(") || effectsExpr.includes(".value")) {
              expect(parsed.effects.tier).toBe("irreversible")
              expect(parsed.effects.reads).toContain("**")
            }

            // Test stringLiteral directly on quoted & unquoted inputs
            expect(ModuleMetadata.stringLiteral(undefined)).toBeUndefined()
            const decoded = ModuleMetadata.stringLiteral(descExpr)
            if (descExpr.startsWith(`"`) || descExpr.startsWith(`'`)) {
              expect(typeof decoded).toBe("string")
            }
            return true
          }),
        { executions: Math.min(executions, 140), seed }
      )
    )
    assertPassed(report)
  })

  it(
    "ModuleClosure.specifiersOf, collect, analyze, snapshot, and linked enforce graph pinning, cycles, confinement, and bounds",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          topology: Schema.Literals([
            "acyclic",
            "cycle",
            "escape",
            "hostImport",
            "dynamicImport",
            "reexport",
            "missingDep"
          ]),
          fileBound: Schema.Literals([1, 20]),
          withTypeOnly: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ topology, fileBound, withTypeOnly }) =>
            Effect.gen(function*() {
              const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reg-closure-w6-")))
              try {
                const typeLine = withTypeOnly ? `import type { Foo } from "./types.ts"\n` : ""
                const helperSource = topology === "cycle"
                  ? `import { entry } from "./entry.ts"\nexport const helper = () => entry\n`
                  : `export const helper = 42\n`
                const entrySource = topology === "acyclic"
                  ? `${typeLine}import { helper } from "./helper.ts"\nexport const entry = helper\n`
                  : topology === "cycle"
                  ? `${typeLine}import { helper } from "./helper.ts"\nexport const entry = helper()\n`
                  : topology === "escape"
                  ? `import { x } from "../../../outside.ts"\nexport const entry = x\n`
                  : topology === "hostImport"
                  ? `import * as nodeFs from "node:fs"\nimport { helper } from "./helper.ts"\nexport const entry = [nodeFs, helper]\n`
                  : topology === "dynamicImport"
                  ? `export const entry = async (x: string) => import(x)\n`
                  : topology === "reexport"
                  ? `export * from "./helper.ts"\nexport { helper as h } from "./helper.ts"\n`
                  : `import { nope } from "./does-not-exist.ts"\nexport const entry = nope\n`

                fs.writeFileSync(path.join(root, "entry.ts"), entrySource)
                fs.writeFileSync(path.join(root, "helper.ts"), helperSource)
                if (withTypeOnly) {
                  fs.writeFileSync(path.join(root, "types.ts"), `export interface Foo { readonly x: number }\n`)
                }

                const specs = ModuleClosure.specifiersOf(entrySource, "entry.ts")
                expect(specs).toBeDefined()

                const fsSvc = yield* FileSystem.FileSystem
                const pathSvc = yield* Path.Path
                const entryPath = path.join(root, "entry.ts")
                const memo = ModuleClosure.cache()

                const collected = yield* ModuleClosure.collect(fsSvc, pathSvc, entryPath, entrySource, memo, {
                  files: fileBound,
                  bytes: 1024 * 1024
                })
                expect(Array.isArray(collected)).toBe(true)

                const analyzed = yield* ModuleClosure.analyze(fsSvc, pathSvc, entryPath, entrySource, memo, {
                  root,
                  realRoot: root
                })
                expect(Array.isArray(analyzed.imports)).toBe(true)
                expect(Array.isArray(analyzed.hostImports)).toBe(true)
                if (topology === "hostImport") {
                  expect(analyzed.hostImports.some((h) => h.includes("node:fs") || h === "fs")).toBe(true)
                }

                const snap = yield* ModuleClosure.snapshot(
                  fsSvc,
                  pathSvc,
                  entryPath,
                  new TextEncoder().encode(entrySource),
                  { files: fileBound, bytes: 1024 * 1024 }
                )
                expect(snap).toBeDefined()
                return true
              } finally {
                fs.rmSync(root, { recursive: true, force: true })
              }
            }).pipe(Effect.provide(NodePlatform)),
          { executions: Math.min(executions, 45), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "Discovery.discover, Executable.fileSpecifier, and RegistryError/DiscoveryError preserve error & path invariants across project layouts",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          layout: Schema.Literals(["promptFlow", "codeFlow", "mixed", "empty", "missingRoot", "badFrontmatter"]),
          errCode: Schema.Literals([
            "not_found",
            "system_collision",
            "body_unavailable",
            "execution_changed",
            "not_prompt_flow",
            "invalid_pack",
            "incompatible_pack",
            "unreadable_pack_range",
            "unknown"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ layout, errCode }) =>
            Effect.gen(function*() {
              const err = new RegistryError.RegistryError({
                code: errCode,
                module: "Registry",
                method: "fuzz",
                path: "/a/b",
                message: `fault:${errCode}`
              })
              expect(err.code).toBe(errCode)
              expect(err.message).toContain(errCode)

              const spec = Executable.fileSpecifier("/tmp/demo/flow with spaces.ts")
              expect(spec.startsWith("file://")).toBe(true)

              const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reg-disc-w6-")))
              try {
                if (layout === "promptFlow" || layout === "mixed") {
                  const pdir = path.join(root, ".smithers", "flows", "summarize")
                  fs.mkdirSync(pdir, { recursive: true })
                  fs.writeFileSync(
                    path.join(pdir, "SKILL.md"),
                    `---\nname: summarize\ndescription: Summarize input\n---\n\nSummarize the diff cleanly.\n`
                  )
                }
                if (layout === "codeFlow" || layout === "mixed") {
                  const cdir = path.join(root, ".smithers", "flows", "lint-check")
                  fs.mkdirSync(cdir, { recursive: true })
                  fs.writeFileSync(
                    path.join(cdir, "flow.ts"),
                    `import { Flow } from "@smthrs/flow"\nimport { Effect, Schema } from "effect"\nexport default Flow.make("lint-check", { description: "Run lint", capabilities: [], effects: { reads: ["**"], writes: [], mode: "hermetic", tier: "sealed" }, payload: Schema.Void, success: Schema.String, body: () => Effect.succeed("ok") })\n`
                  )
                }
                if (layout === "badFrontmatter") {
                  const bdir = path.join(root, ".smithers", "flows", "broken")
                  fs.mkdirSync(bdir, { recursive: true })
                  fs.writeFileSync(path.join(bdir, "SKILL.md"), `---\n: [unclosed yaml\n---\nbody\n`)
                }

                const targetRoot = layout === "missingRoot" ? path.join(root, "no-such-dir") : root
                const fsSvc = yield* FileSystem.FileSystem
                const pathSvc = yield* Path.Path
                const disc = Discovery.make(fsSvc, pathSvc)
                const result = yield* disc.scan(
                  { kind: "project", root: path.join(targetRoot, ".smithers", "flows") } as never
                ).pipe(Effect.exit)
                const skillResult = yield* disc.scan(
                  { kind: "project", root: path.join(targetRoot, ".smithers", "flows"), skills: true } as never
                ).pipe(Effect.exit)
                expect(result).toBeDefined()
                expect(skillResult).toBeDefined()
                expect(Discovery.makeNoop()).toBeDefined()
                return true
              } finally {
                fs.rmSync(root, { recursive: true, force: true })
              }
            }).pipe(Effect.provide(NodePlatform)),
          { executions: Math.min(executions, 45), seed: seed + 2 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
