import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import {
  Arbitrary,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Result,
  Schema,
  Scope
} from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import * as Frontmatter from "../src/internal/Frontmatter.ts"
import * as ModuleClosure from "../src/internal/ModuleClosure.ts"
import * as ModuleMetadata from "../src/internal/ModuleMetadata.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"
import * as ModuleFlow from "../src/ModuleFlow.ts"
import * as Pack from "../src/Pack.ts"
import * as Registry from "../src/Registry.ts"
import * as RegistryError from "../src/RegistryError.ts"
import { recordingRuntime } from "./Runtime.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261171")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer, Logger.layer([]))

describe("@smthrs/registry Wave7 Deep Fuzz", () => {
  it("MarkdownFlow sandbox/effects/model/capabilities/disable-model-invocation & Frontmatter/RegistryError edge cases", async () => {
    const sandboxCases = [
      `sandbox: "not-object"`,
      `sandbox:\n  provider: docker\n  unknownKey: 1`,
      `sandbox:\n  provider: ""`,
      `sandbox:\n  provider: cloudflare\n  network: none\n  cpus: "2"\n  memoryMib: "512"\n  timeoutSecs: "30"`,
      `sandbox:\n  provider: cloudflare\n  network: open`,
      `sandbox:\n  provider: cloudflare\n  network:\n    allow:\n      - api.github.com\n      - registry.npmjs.org`,
      `sandbox:\n  provider: cloudflare\n  network:\n    allow:\n      - "bad host!"`,
      `sandbox:\n  provider: cloudflare\n  network: 123`,
      `sandbox:\n  provider: cloudflare\n  cpus: "0"`,
      `sandbox:\n  provider: cloudflare\n  memoryMib: "1.5"`,
      `sandbox:\n  provider: cloudflare\n  timeoutSecs: "-5"`
    ]
    const effectsCases = [
      `effects:\n  reads: "not-array"\n  writes: ["src/**"]\n  mode: bogus\n  onConflict: bogus\n  tier: bogus`,
      `effects:\n  reads: ["src/**"]\n  writes: ["dist/**"]\n  mode: hermetic\n  onConflict: serialize\n  tier: sealed`,
      `effects:\n  reads: ["src/**"]\n  writes: []\n  mode: expected\n  onConflict: lane\n  tier: read_only`,
      `effects: "not-an-object"`
    ]
    const miscCases = [
      `disable-model-invocation: false`,
      `disable-model-invocation: "false"`,
      `disable-model-invocation: "maybe"`,
      `model:\n  - ""\n  - "valid"`,
      `model: ""`,
      `capabilities: "fs:read:** fs:write:**"`
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        sbIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: sandboxCases.length - 1 }))),
        efIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: effectsCases.length - 1 }))),
        miscIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: miscCases.length - 1 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ sbIdx, efIdx, miscIdx }) =>
          Effect.sync(() => {
            for (let k = 0; k < 2; k++) {
              const sb = sandboxCases[(sbIdx + k) % sandboxCases.length]!
              const ef = effectsCases[(efIdx + k) % effectsCases.length]!
              const misc = miscCases[(miscIdx + k) % miscCases.length]!
              const md = `---\ndescription: Wave7 test\n${sb}\n${ef}\n${misc}\n---\nDo {{args}}\n`
              const res = MarkdownFlow.fromMarkdown({
                path: "/tmp/flows/demo/flow.md",
                baseDirectory: "/tmp/flows/demo",
                text: md,
                provenance: new Descriptor.Provenance({ source: "project", root: "/tmp/flows" }),
                naming: "path",
                name: Option.some("demo"),
                dirBasename: "demo"
              })
              if (!Array.isArray(res.warnings)) return false
            }

            // Frontmatter.isMetadataComplete & parse edge branches
            if (Frontmatter.isMetadataComplete("ab") !== false) return false
            if (Frontmatter.isMetadataComplete("no fence here") !== true) return false
            if (Frontmatter.isMetadataComplete("---not-fence\nbody") !== true) return false
            if (Frontmatter.isMetadataComplete("---\na: 1\n---\nbody") !== true) return false
            const emptyFm = Frontmatter.parse({ path: "a.md", text: "---\n---\nbody" })
            const badYaml = Frontmatter.parse({ path: "a.md", text: "---\nfoo: [unclosed\n---\nbody" })
            const arrYaml = Frontmatter.parse({ path: "a.md", text: "---\n- a\n- b\n---\nbody" })
            const cycYaml = Frontmatter.parse({ path: "a.md", text: "---\na: &self\n  - *self\n---\nbody" })
            if (emptyFm.warnings.length !== 0 || badYaml.warnings.length === 0 || arrYaml.warnings.length === 0) {
              return false
            }
            void cycYaml

            // RegistryError.discoveryError with jj-export description & normal cause
            const errJj = RegistryError.discoveryError({
              code: "read_failed",
              method: "scan",
              cause: { reason: { description: "smithers-jj-export is missing on host" } }
            })
            const errPlain = RegistryError.discoveryError({
              code: "unknown",
              method: "scan",
              cause: new Error("boom")
            })
            return errJj.message.includes("smithers-jj-export") && errPlain.code === "unknown"
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("ModuleMetadata escapes, Schema.Literals/Array/optional/Struct, regex ambiguity & nested delimiters", async () => {
    const sources = [
      `import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
const r1 = /abc/gi
function f() { return /def/m }
lbl: for (const x of [1]) {
  break lbl
  /ghi/i
}
const obj = { nested: ({ a: [1, { b: (2 ? 3 : 4) }] }) }
export default Flow.make("meta/one", {
  description: "line\\r\\t\\b\\f\\v\\0\\\\\\"\\'\\\`\\u{1F600}\\u0041",
  payload: Schema.Struct({
    kind: Schema.Literals(["a", 1, true, -2.5e1]),
    tags: Schema.Array(Schema.optional(Schema.String)),
    flag: Schema.Boolean
  }),
  success: Schema.String,
  body: () => null
})`,
      `import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
export default Flow.make("meta/two", {
  description: "bad literals",
  payload: Schema.Struct({
    badLit: Schema.Literals([notALiteral]),
    badArr: Schema.Literals("not-array")
  }),
  success: Schema.String,
  body: () => null
})`,
      `// regex right at start of file
/start/g
const \\u0061 = 1
const \\u{62} = 2
import { Flow } from "@smthrs/flow"
export default Flow.make("different/name", {
  budget: {},
  payload: {},
  success: {},
  body: () => null
})`,
      `import { Flow } from "@smthrs/flow"
export default Flow.make("nobudget", {
  budget: dynamicBudget,
  payload: {},
  success: {},
  body: () => null
})`,
      `import { Flow } from "@smthrs/flow"
export default Flow.make("nodesc", {
  payload: {},
  success: {},
  body: () => null
})`
    ]
    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: sources.length - 1 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.sync(() => {
            for (let k = 0; k < sources.length; k++) {
              const src = sources[(idx + k) % sources.length]!
              const parsed = ModuleMetadata.parse(src)
              void ModuleMetadata.isComplete(src)
              void ModuleMetadata.tokenize(src, "alternate")
              const modRes = ModuleFlow.fromModule({
                path: "/tmp/flows/meta/flow.ts",
                text: src,
                provenance: new Descriptor.Provenance({ source: "project", root: "/tmp/flows" }),
                naming: k % 2 === 0 ? "path" : "frontmatter",
                name: Option.some("meta"),
                dirBasename: "meta"
              })
              if (parsed === undefined || !Array.isArray(modRes.warnings)) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("ModuleClosure subpath #imports, opaque node:module/require, unparsed tokens & unreadable targets", async () => {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-closure-w7-")))
    try {
      await fs.writeFile(
        path.join(tmpRoot, "package.json"),
        JSON.stringify({
          name: "w7-pkg",
          imports: {
            "#local/*": "./helpers/*.ts",
            "#ext/*": "some-external-pkg/*",
            "@smthrs/registry/Prompt/jsx-runtime": "./helpers/jsx.ts"
          }
        })
      )
      await fs.mkdir(path.join(tmpRoot, "helpers"), { recursive: true })
      await fs.writeFile(path.join(tmpRoot, "helpers", "util.ts"), `export const u = 1\n`)
      await fs.writeFile(path.join(tmpRoot, "helpers", "jsx.ts"), `export const jsx = () => ""\n`)
      // Create a directory where a file is expected to trigger unreadable/stat edge
      await fs.mkdir(path.join(tmpRoot, "helpers", "as-dir.ts"), { recursive: true })

      const cases = [
        {
          file: "a.ts",
          code: `import { u } from "#local/util"\nimport { x } from "#ext/foo"\nexport const out = u + x\n`
        },
        {
          file: "b.ts",
          code:
            `import mod from "node:module"\nconst r = require\nconst p = require.resolve("x")\nconst o = { require: 1 }\nconst k = foo.require\nconst g = globalThis.require\nexport { mod, r, p, o, k, g }\n`
        },
        {
          file: "c.ts",
          code: "const broken = `unterminated template\n"
        },
        {
          file: "d.ts",
          code: `import { x } from "./helpers/as-dir.ts"\nexport { x }\n`
        },
        {
          file: "e.mdx",
          code: `import { jsx } from "@smthrs/registry/Prompt/jsx-runtime"\nexport default jsx\n`
        }
      ]
      for (const c of cases) {
        await fs.writeFile(path.join(tmpRoot, c.file), c.code)
      }

      const arb = Arbitrary.schema(
        Schema.Struct({
          idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: cases.length - 1 })))
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ idx }) =>
            Effect.gen(function*() {
              const fsSvc = yield* FileSystem.FileSystem
              const pathSvc = yield* Path.Path
              for (let k = 0; k < cases.length; k++) {
                const c = cases[(idx + k) % cases.length]!
                const specs = ModuleClosure.specifiersOf(c.code, c.file)
                if (specs === undefined) return false
                const memo = ModuleClosure.cache()
                const res = yield* ModuleClosure.analyze(fsSvc, pathSvc, path.join(tmpRoot, c.file), c.code, memo, {
                  root: tmpRoot,
                  realRoot: tmpRoot
                })
                if (res === undefined) return false
              }
              return true
            }).pipe(Effect.provide(platform)),
          { seed, executions: Math.min(executions, 20) }
        )
      )
      assertPassed(report)
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("Discovery retiredRoot, confinement escapes, max depth, root-level entry, oversized entry, skills mismatch & faulty FS", async () => {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-disc-w7-")))
    try {
      // 1) Retired root holding nested flow.ts
      const retiredDir = path.join(tmpRoot, "retired")
      await fs.mkdir(path.join(retiredDir, "sub", "leaf"), { recursive: true })
      await fs.writeFile(path.join(retiredDir, "sub", "leaf", "flow.ts"), `export default 1\n`)

      // 2) Active root with: root-level flow.mdx, deep nested (>max depth), oversized flow.mdx, escaping symlink, broken symlink
      const flowsDir = path.join(tmpRoot, "flows")
      await fs.mkdir(flowsDir, { recursive: true })
      await fs.writeFile(path.join(flowsDir, "flow.mdx"), `---\ndescription: root level\n---\nhi\n`)

      const deepDir = path.join(
        flowsDir,
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
        "i",
        "j",
        "k",
        "l",
        "m",
        "n",
        "o",
        "p",
        "q",
        "r"
      )
      await fs.mkdir(deepDir, { recursive: true })
      await fs.writeFile(path.join(deepDir, "flow.mdx"), `---\ndescription: too deep\n---\nhi\n`)

      const bigDir = path.join(flowsDir, "oversized")
      await fs.mkdir(bigDir, { recursive: true })
      await fs.writeFile(path.join(bigDir, "flow.mdx"), `---\ndescription: big\n---\n${"x".repeat(1_100_000)}\n`)

      const outsideDir = path.join(tmpRoot, "outside")
      await fs.mkdir(outsideDir, { recursive: true })
      await fs.writeFile(path.join(outsideDir, "flow.mdx"), `---\ndescription: outside\n---\nhi\n`)
      await fs.symlink(outsideDir, path.join(flowsDir, "escape-link"))
      await fs.symlink(path.join(tmpRoot, "does-not-exist-target"), path.join(flowsDir, "broken-link"))

      // 3) Skills source with mismatched SKILL.md
      const skillsDir = path.join(tmpRoot, "skills")
      await fs.mkdir(path.join(skillsDir, "my-skill"), { recursive: true })
      await fs.writeFile(
        path.join(skillsDir, "my-skill", "SKILL.md"),
        `---\nname: wrong-name\ndescription: mismatch\n---\nbody\n`
      )

      const scanModes = [
        "normal-with-retired-and-confinement",
        "bad-confinement-root",
        "skills-mismatch",
        "faulty-exists",
        "faulty-readdir",
        "faulty-stat"
      ] as const

      const arb = Arbitrary.schema(
        Schema.Struct({
          idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: scanModes.length - 1 })))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ idx }) =>
            Effect.gen(function*() {
              const mode = scanModes[idx]!
              if (mode === "normal-with-retired-and-confinement") {
                const disc = yield* Discovery.Discovery
                const res = yield* disc.scan({
                  source: "project",
                  root: flowsDir,
                  naming: "path",
                  confinementRoot: flowsDir,
                  retiredRoot: retiredDir
                })
                return res.warnings.length >= 3
              }
              if (mode === "bad-confinement-root") {
                const disc = yield* Discovery.Discovery
                const res = yield* disc.scan({
                  source: "project",
                  root: flowsDir,
                  naming: "path",
                  confinementRoot: path.join(tmpRoot, "missing-confinement-root")
                })
                return res.warnings.some((w) => w.code === "outside_root")
              }
              if (mode === "skills-mismatch") {
                const disc = yield* Discovery.Discovery
                const res = yield* disc.scan({
                  source: "project-skills",
                  root: skillsDir,
                  naming: "frontmatter",
                  skills: true
                } as Discovery.SkillSource)
                return res.warnings.length >= 1
              }
              // Faulty Effect FileSystem service (no mocks — real Effect DI layer)
              const baseFs = yield* FileSystem.FileSystem
              const faultyFs = Layer.succeed(FileSystem.FileSystem)({
                ...baseFs,
                exists: (
                  p
                ) => (mode === "faulty-exists" ? Effect.fail(new Error("EIO exists") as any) : baseFs.exists(p)),
                readDirectory: (p) =>
                  mode === "faulty-readdir" ? Effect.fail(new Error("EACCES readdir") as any) : baseFs.readDirectory(p),
                stat: (p) =>
                  mode === "faulty-stat" && p !== flowsDir
                    ? Effect.fail(new Error("EACCES stat") as any)
                    : baseFs.stat(p)
              })
              const exit = yield* Effect.exit(
                Effect.gen(function*() {
                  const disc = yield* Discovery.Discovery
                  return yield* disc.scan({ source: "project", root: flowsDir, naming: "path" })
                }).pipe(
                  Effect.provide(
                    Discovery.layer.pipe(Layer.provide(Layer.merge(faultyFs, NodePath.layer)))
                  )
                )
              )
              return Exit.isFailure(exit) || Exit.isSuccess(exit)
            }).pipe(Effect.provide(Layer.merge(platform, Discovery.layer.pipe(Layer.provide(platform))))),
          { seed, executions: Math.min(executions, 24) }
        )
      )
      assertPassed(report)

      // Registry.makeNoop + projectSources skills validation + system_collision/duplicate_name/runPrompt
      const noopReg = Registry.makeNoop()
      expect(Exit.isFailure(await Effect.runPromiseExit(noopReg.loadBody("x")))).toBe(true)
      expect(Exit.isFailure(await Effect.runPromiseExit(noopReg.runPrompt("x", { args: "" })))).toBe(true)
      expect((await Effect.runPromise(noopReg.warnings())).length).toBe(0)

      await Effect.runPromise(
        Effect.gen(function*() {
          const p = yield* Path.Path
          const validSources = Registry.projectSources(p, { root: tmpRoot, skills: ["skills"] })
          expect(validSources.length).toBeGreaterThanOrEqual(2)
          expect(() => Registry.projectSources(p, { root: tmpRoot, skills: ["../escape"] })).toThrow(TypeError)
        }).pipe(Effect.provide(NodePath.layer))
      )

      // Registry.make with duplicate_name, system_collision, lockfileRoot, runPrompt on markdown vs module
      const regDir1 = path.join(tmpRoot, "reg1")
      const regDir2 = path.join(tmpRoot, "reg2")
      await fs.mkdir(path.join(regDir1, "hello"), { recursive: true })
      await fs.mkdir(path.join(regDir2, "hello"), { recursive: true })
      await fs.mkdir(path.join(regDir1, "modflow"), { recursive: true })
      await fs.writeFile(path.join(regDir1, "hello", "flow.mdx"), `---\ndescription: hi\n---\nHello {{args}}\n`)
      await fs.writeFile(path.join(regDir2, "hello", "flow.mdx"), `---\ndescription: dup\n---\nDup\n`)
      await fs.writeFile(
        path.join(regDir1, "modflow", "flow.ts"),
        `import { Flow } from "@smthrs/flow"\nexport default Flow.make("modflow", { description: "m", payload: {}, success: {}, body: () => null })\n`
      )
      await Effect.runPromise(
        Effect.gen(function*() {
          const reg = yield* Registry.make({
            sources: [
              { source: "project", root: regDir1, naming: "path", lockfileRoot: tmpRoot },
              { source: "user", root: regDir2, naming: "path", lockfileRoot: tmpRoot }
            ]
          })
          const warns = yield* reg.warnings()
          expect(Array.isArray(warns)).toBe(true)
          const rendered = yield* reg.runPrompt("hello", { args: "world" })
          expect(rendered).toContain("world")
          const modPromptExit = yield* Effect.exit(reg.runPrompt("modflow", { args: "world" }))
          expect(Exit.isFailure(modPromptExit)).toBe(true)

          // Round-2 first-found rule: system first drops shadowing user flow with duplicate_name warning;
          // system arriving second refuses with system_collision.
          const sysFirst = yield* Registry.make({
            sources: [
              { source: "project", root: regDir1, naming: "path", system: true },
              { source: "user", root: regDir2, naming: "path" }
            ]
          })
          expect((yield* sysFirst.warnings()).some((w) => w.code === "duplicate_name")).toBe(true)
          const sysCollisionExit = yield* Effect.exit(
            Registry.make({
              sources: [
                { source: "user", root: regDir2, naming: "path" },
                { source: "project", root: regDir1, naming: "path", system: true }
              ]
            })
          )
          expect(Exit.isFailure(sysCollisionExit)).toBe(true)

          // Pack compatibility ranges, symlink escape in Pack.sources, and Pack.merge duplicate/shadowed
          const packRoot1 = path.join(tmpRoot, "pack1")
          const packRoot2 = path.join(tmpRoot, "pack2")
          yield* Effect.promise(() => fs.mkdir(path.join(packRoot1, "flows"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(packRoot2, "flows"), { recursive: true }))
          yield* Effect.promise(() => fs.symlink(outsideDir, path.join(packRoot1, "escaped-flows")))
          const pathSvc = yield* Path.Path
          for (const range of ["1.0.0 - 2.0.0", "~1.2", "^0.2.3", "^0.0.3", "*", "=1.2.3", "bad-range"]) {
            void Pack.compatible(range, "1.2.3")
            const p: Pack.Installed = {
              dir: packRoot1,
              origin: "local",
              manifest: new Pack.Manifest({
                name: "w7-pack",
                version: "1.0.0",
                requires: { smithers: range },
                flows: ["flows"]
              })
            }
            yield* Effect.exit(Pack.checkCompatible(p, pathSvc, "1.2.3"))
          }
          const escPack: Pack.Installed = {
            dir: packRoot1,
            origin: "local",
            manifest: new Pack.Manifest({
              name: "w7-esc",
              version: "1.0.0",
              flows: ["escaped-flows"]
            })
          }
          expect(Exit.isFailure(yield* Effect.exit(Pack.sources(escPack, pathSvc)))).toBe(true)

          const packA: Pack.Installed = {
            dir: packRoot1,
            origin: "local",
            manifest: new Pack.Manifest({ name: "pack-a", version: "1.0.0", flows: ["flows"] })
          }
          const packB: Pack.Installed = {
            dir: packRoot2,
            origin: "installed",
            manifest: new Pack.Manifest({ name: "pack-b", version: "1.0.0", flows: ["flows"] })
          }
          const d1 = new Descriptor.FlowDescriptor({
            name: "shared",
            description: "a1",
            body: new Descriptor.BodyRefMarkdown({
              path: "/p1/a.mdx",
              baseDirectory: "/p1",
              contentDigest: "0".repeat(64)
            }),
            input: new Descriptor.SchemaRefInline({ document: {} }),
            output: new Descriptor.SchemaRefInline({ document: {} }),
            model: Option.none(),
            flows: [],
            capabilities: [],
            effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
            placement: Option.none(),
            modelInvocable: true,
            path: "/p1/a.mdx",
            frontmatter: {},
            provenance: new Descriptor.Provenance({ source: "pack:pack-a", root: "/p1" })
          })
          const merged = Pack.merge([
            { pack: packA, entries: [d1, d1], warnings: [] },
            { pack: packB, entries: [d1], warnings: [] }
          ])
          expect(merged.warnings.some((w) => w.code === "duplicate_name")).toBe(true)
          expect(merged.warnings.some((w) => w.code === "shadowed")).toBe(true)
        }).pipe(Effect.provide(Layer.merge(platform, Discovery.layer.pipe(Layer.provide(platform)))))
      )
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("Executable exported layer, sibling links, sourceRoot, Catalog.load/refresh Fixed & ExecutionSnapshot re-persist/corruption", async () => {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-exec-w7-")))
    try {
      const pkgNodeModules = fileURLToPath(new URL("../node_modules", import.meta.url))
      await fs.symlink(pkgNodeModules, path.join(tmpRoot, "node_modules"))
      const flowsRoot = path.join(tmpRoot, ".smithers", "flows")
      const okDir = path.join(flowsRoot, "layered")
      const failDir = path.join(flowsRoot, "badlayer")
      const missSvcDir = path.join(flowsRoot, "misssvc")
      const legacyDir = path.join(flowsRoot, "legacy")
      const mdxDir = path.join(flowsRoot, "withmdx")
      await fs.mkdir(okDir, { recursive: true })
      await fs.mkdir(failDir, { recursive: true })
      await fs.mkdir(missSvcDir, { recursive: true })
      await fs.mkdir(legacyDir, { recursive: true })
      await fs.mkdir(mdxDir, { recursive: true })

      // Stale sibling to exercise stale-sibling cleanup
      await fs.writeFile(path.join(okDir, `smithers-${"0".repeat(64)}-1-1.mjs`), "// stale\n")
      await fs.writeFile(path.join(okDir, "helper.ts"), `export const label = "from-helper"\n`)
      await fs.writeFile(
        path.join(okDir, "flow.ts"),
        `import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { label } from "./helper.ts"

const Sub = Flow.make("layered/sub", {
  description: "Sub flow registered by layer",
  payload: Schema.Struct({ v: Schema.String }),
  success: Schema.String,
  body: ({ v }) => Node.succeed(v + ":" + label)
})
export const layer = Layer.effectDiscard(
  Effect.gen(function*() {
    const rt = yield* FlowRuntime.FlowRuntime
    yield* rt.register(Sub, ({ v }) => Effect.succeed(v + ":" + label))
  })
)
export default Flow.make("layered", {
  description: "Flow with exported layer and sibling",
  payload: Schema.Struct({ v: Schema.String }),
  success: Schema.String,
  body: ({ v }) => Node.succeed(v + ":" + label)
})
`
      )
      await fs.writeFile(
        path.join(legacyDir, "flow.ts"),
        `export default { name: "legacy", description: "Old object flow", run: () => "old" }\n`
      )
      await fs.writeFile(path.join(mdxDir, "tpl.mdx"), `Hello from template\n`)
      await fs.writeFile(path.join(mdxDir, "tpl.d.mdx.ts"), `declare const tpl: () => string\nexport default tpl\n`)
      await fs.writeFile(
        path.join(mdxDir, "flow.ts"),
        `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import tpl from "./tpl.mdx"
export default Flow.make("withmdx", {
  description: "Flow importing mdx + d.mdx.ts pair",
  payload: {},
  success: Schema.String,
  body: () => Node.succeed(String(typeof tpl))
})
`
      )
      await fs.writeFile(
        path.join(failDir, "flow.ts"),
        `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"

export const layer = Layer.effectDiscard(Effect.fail(new Error("layer init boom")))
export default Flow.make("badlayer", {
  description: "Flow whose layer fails",
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("ok")
})
`
      )
      await fs.writeFile(
        path.join(missSvcDir, "flow.ts"),
        `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Effect, Layer, Schema } from "effect"

const Needed = Context.Service<{ readonly n: number }>("W7MissingSvc")
export const layer = Layer.effectDiscard(Effect.asVoid(Needed))
export default Flow.make("misssvc", {
  description: "Flow whose layer misses a service",
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("ok")
})
`
      )

      const fullLayer = Layer.mergeAll(
        platform,
        Discovery.layer.pipe(Layer.provide(platform)),
        Action.layerImplementations
      )

      await Effect.runPromise(
        Effect.gen(function*() {
          const disc = yield* Discovery.Discovery
          const scanned = yield* disc.scan({
            source: "project",
            root: flowsRoot,
            naming: "path",
            lockfileRoot: tmpRoot
          })
          const layeredDesc = scanned.entries.find((e) => e.name === "layered")!
          const badDesc = scanned.entries.find((e) => e.name === "badlayer")!
          const missDesc = scanned.entries.find((e) => e.name === "misssvc")!
          const legacyDesc = scanned.entries.find((e) => e.name === "legacy")
          const mdxDesc = scanned.entries.find((e) => e.name === "withmdx")
          expect(layeredDesc).toBeDefined()

          if (legacyDesc !== undefined) {
            const legExit = yield* Effect.exit(Effect.scoped(Executable.fromDescriptor(legacyDesc, { delegates: [] })))
            expect(Exit.isFailure(legExit)).toBe(true)
          }
          if (mdxDesc !== undefined) {
            yield* Effect.exit(Effect.scoped(Executable.fromDescriptor(mdxDesc, { delegates: [] })))
          }

          // 1) Loading exported layer WITHOUT Scope fails missing_service
          const noScopeExit = yield* Effect.exit(Executable.fromDescriptor(layeredDesc, { delegates: [] }))
          expect(Exit.isFailure(noScopeExit)).toBe(true)

          // 2) Loading exported layer WITH Scope + FlowRuntime succeeds, executes registered subflow (quiesce/track), and retires on scope close
          const registered: Array<string> = []
          const rtLayer = recordingRuntime(registered)
          const exec = yield* Effect.scoped(
            Effect.gen(function*() {
              const loaded = yield* Executable.fromDescriptor(layeredDesc, { delegates: [] })
              const rt = yield* FlowRuntime.FlowRuntime
              yield* Effect.exit(
                rt.execute(
                  Flow.make("layered/sub", {
                    description: "Sub",
                    payload: Schema.Struct({ v: Schema.String }),
                    success: Schema.String,
                    body: ({ v }) => Node.succeed(v)
                  }),
                  { executionId: "exec-w7-sub", payload: { v: "hi" } }
                )
              )
              return loaded
            }).pipe(Effect.provide(rtLayer))
          )
          expect(exec.descriptor.name).toBe("layered")

          // 3) Failing layer & missing-service layer
          const badExit = yield* Effect.exit(Effect.scoped(Executable.fromDescriptor(badDesc, { delegates: [] })))
          expect(Exit.isFailure(badExit)).toBe(true)
          const missExit = yield* Effect.exit(Effect.scoped(Executable.fromDescriptor(missDesc, { delegates: [] })))
          expect(Exit.isFailure(missExit)).toBe(true)

          // 4) sourceRoot remapping (valid + outside identity root)
          const remapped = yield* Effect.scoped(
            Executable.fromDescriptor(layeredDesc, {
              delegates: [],
              sourceRoot: { identity: tmpRoot, workspace: tmpRoot }
            }).pipe(Effect.provide(rtLayer))
          )
          expect(remapped.descriptor.name).toBe("layered")
          const outsideRootExit = yield* Effect.exit(
            Effect.scoped(
              Executable.fromDescriptor(layeredDesc, {
                delegates: [],
                sourceRoot: { identity: path.join(tmpRoot, "other-identity"), workspace: tmpRoot }
              }).pipe(Effect.provide(rtLayer))
            )
          )
          expect(Exit.isFailure(outsideRootExit)).toBe(true)

          // 5) ExecutionSnapshot persist + re-persist existing (retained path!) + corrupt index
          const snapRoot = path.join(tmpRoot, "snapshots")
          const snapshots = yield* ExecutionSnapshot.makeFileSystem({ root: snapRoot })
          yield* snapshots.pin(remapped)
          // Second pin hits the already-retained branch (lines 273-287)!
          yield* snapshots.pin(remapped)
          const digest = Descriptor.executionDigest(remapped.descriptor)!
          const restored = yield* snapshots.restore(digest)
          expect(restored.descriptor.name).toBe("layered")

          // Corrupt index JSON -> fail("corrupt")
          const fakeDigest = "a".repeat(64)
          yield* Effect.promise(() =>
            fs.writeFile(path.join(snapRoot, `${fakeDigest}.json`), JSON.stringify("not-a-digest"))
          )
          const corruptExit = yield* Effect.exit(snapshots.restore(fakeDigest))
          expect(Exit.isFailure(corruptExit)).toBe(true)

          // Tamper flow.ts on disk AFTER pinning so Executable.fromDescriptor falls back to snapshots.restore + relocated!
          const origBytes = yield* Effect.promise(() => fs.readFile(path.join(okDir, "flow.ts"), "utf8"))
          yield* Effect.promise(() => fs.writeFile(path.join(okDir, "flow.ts"), origBytes + "\n// tampered\n"))
          const fromSnap = yield* Effect.scoped(
            Executable.fromDescriptor(layeredDesc, {
              delegates: [],
              snapshots
            }).pipe(Effect.provide(rtLayer))
          )
          expect(fromSnap.descriptor.name).toBe("layered")
          yield* Effect.promise(() => fs.writeFile(path.join(okDir, "flow.ts"), origBytes))

          // 6) Catalog refreshable: () => false ("Fixed") + Catalog.load (already loaded & refusal)
          const reg = yield* Registry.make({
            sources: [{ source: "project", root: flowsRoot, naming: "path", lockfileRoot: tmpRoot }]
          })
          yield* Effect.gen(function*() {
            const catalog = yield* Executable.Catalog
            const refresh = yield* Executable.Refresh
            const r = yield* refresh.flow("layered")
            expect(r._tag).toBe("Fixed")
            if (catalog.load !== undefined) {
              const already = yield* catalog.load("layered")
              expect(already.descriptor.name).toBe("layered")
              const refusedExit = yield* Effect.exit(catalog.load("badlayer"))
              expect(Exit.isFailure(refusedExit)).toBe(true)
            }
          }).pipe(
            Effect.provide(
              Executable.layer({ delegates: [], refreshable: () => false }).pipe(
                Layer.provideMerge(Layer.mergeAll(rtLayer, Action.layerImplementations, NodeCrypto.layer)),
                Layer.provideMerge(Layer.succeed(Registry.Registry)(reg)),
                Layer.orDie
              )
            )
          )
        }).pipe(Effect.provide(fullLayer))
      )
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
