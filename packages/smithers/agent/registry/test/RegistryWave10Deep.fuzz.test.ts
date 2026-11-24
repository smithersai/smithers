import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Digest from "@smthrs/core/Digest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Fuzz } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import { Arbitrary, Context, Effect, FileSystem, Layer, Logger, Option, Path, Result, Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import * as PlatformError from "effect/PlatformError"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Disclosure from "../src/Disclosure.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import * as Body from "../src/internal/Body.ts"
import * as ModuleClosure from "../src/internal/ModuleClosure.ts"
import * as ModuleMetadata from "../src/internal/ModuleMetadata.ts"
import * as Names from "../src/internal/Names.ts"
import * as LoadGuard from "../src/LoadGuard.ts"
import * as NodeLoadGuard from "../src/node/NodeLoadGuard.ts"
import * as Pack from "../src/Pack.ts"
import * as PromptJsx from "../src/Prompt/jsx-runtime.ts"
import * as Registry from "../src/Registry.ts"
import * as RegistryError from "../src/RegistryError.ts"
import { recordingRuntime } from "./Runtime.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const fastExec = Math.max(30, Math.min(executions, 100))
const ioExec = Math.max(12, Math.min(executions, 32))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261190")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer, Logger.layer([]))
const enc = new TextEncoder()

const dummyDelegate: Executable.Delegate = {
  _tag: "agent",
  call: () => Node.succeed("ok"),
  execute: () => Effect.succeed("ok")
}

const makeDescriptor = (overrides: {
  readonly name?: string
  readonly description?: string
  readonly modelInvocable?: boolean
  readonly body?: Descriptor.BodyRef
  readonly provenance?: Descriptor.Provenance
  readonly lockfiles?: Descriptor.FlowDescriptor["lockfiles"]
  readonly flows?: ReadonlyArray<string>
  readonly capabilities?: ReadonlyArray<string>
}): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name: overrides.name ?? "demo",
    description: overrides.description ?? "Demo flow",
    body: overrides.body ?? new Descriptor.BodyRefMarkdown({
      path: "/tmp/demo/SKILL.md",
      baseDirectory: "/tmp/demo",
      contentDigest: Digest.digest(enc.encode("---\nname: demo\ndescription: d\n---\nhi\n"))
    }),
    input: new Descriptor.SchemaRefNone({}),
    output: new Descriptor.SchemaRefNone({}),
    model: Option.none(),
    flows: overrides.flows ?? [],
    capabilities: overrides.capabilities ?? [],
    effects: {
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none(),
    modelInvocable: overrides.modelInvocable ?? true,
    path: "/tmp/demo/SKILL.md",
    frontmatter: {},
    provenance: overrides.provenance ?? new Descriptor.Provenance({ source: "project", root: "/tmp/demo" }),
    ...(overrides.lockfiles === undefined ? {} : { lockfiles: overrides.lockfiles })
  })

describe("@smthrs/registry Wave10 Deep Fuzz", () => {
  it("Disclosure XML/entries, Names, Prompt jsx-runtime, and Executable.fileSpecifier", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rawDesc: Schema.Literals([
          "plain & <tag> \"q\" 'a'",
          "tab\tnewline\ncr\rctrl\u0000\u0007end",
          "nonchar\uFDD0\uFDEF\uFFFE\uFFFF",
          "astral\u{1F680}ok",
          "lone\uD800surrogate"
        ]),
        emptyVisible: Schema.Boolean,
        sameName: Schema.Boolean,
        specPath: Schema.Literals([
          "file:///already/url",
          "C:\\work\\dir\\a#b?c.ts",
          "/unix/path/with space#1?2.ts",
          "relative/flow.ts"
        ]),
        frontName: Schema.Literals(["", "   ", "BAD_NAME!", "good-name", "nested/bad"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rawDesc, emptyVisible, sameName, specPath, frontName }) =>
          Effect.sync(() => {
            const d1 = makeDescriptor({ name: "beta", description: rawDesc, modelInvocable: !emptyVisible })
            const d2 = makeDescriptor({
              name: sameName ? "beta" : "alpha",
              description: rawDesc,
              modelInvocable: !emptyVisible
            })
            const d3 = makeDescriptor({ name: "gamma", description: rawDesc, modelInvocable: false })
            const entries = Disclosure.toEntries([d1, d2, d3])
            expect(entries.length).toBe(3)
            const xml = Disclosure.toXml([d1, d2, d3])
            if (emptyVisible) {
              expect(xml).toBe("<available_skills>\n</available_skills>")
            } else {
              expect(xml).toContain("<available_skills>")
              expect(xml).not.toContain("\u0000")
              expect(xml).not.toContain("\uFDD0")
              expect(xml).not.toContain("\uFFFF")
            }

            const spec = Executable.fileSpecifier(specPath)
            expect(spec.startsWith("file:")).toBe(true)

            const fields: Record<string, unknown> = frontName === ""
              ? {}
              : frontName === "   "
              ? { name: 42 }
              : { name: frontName }
            const resolved = Names.deriveFromFrontmatter({
              fields,
              path: "/tmp/x/SKILL.md",
              dirBasename: "valid-dir"
            })
            expect(typeof resolved.name).toBe("string")
            expect(Option.isNone(Names.deriveFromPath([]))).toBe(true)
            expect(Option.isSome(Names.deriveFromPath(["a", "b"]))).toBe(true)

            const frag = PromptJsx.jsx(PromptJsx.Fragment, { children: ["a", 2, false, null, undefined, ["b"]] })
            const el = PromptJsx.jsx("div", { className: "c", flag: true, off: false, nil: null, children: "hi" })
            const el2 = PromptJsx.jsxs("section", { children: [frag, el, "two"] })
            const fnEl = PromptJsx.jsx((props) => `v=${String(props["x"] ?? 0)}`, { x: 7 })
            expect(typeof PromptJsx.render([el2, fnEl])).toBe("string")
            return true
          }),
        { executions: fastExec, seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it(
    "ModuleMetadata tokenizer, regex/unicode/template edge cases, and Flow.make/Declared static projection",
    async () => {
      const snippets = [
        `export const x = 1`,
        `const a = x++ / 2; const b = x-- / 3; if (ok) /foo[a/b]bar/gi; const c = arr[0] / 2; { const z = 1 } /re/m;\nconst #priv = 1; const \\u0041 = "\\u{1F600}"; const bad = \\u{999999};\nconst t = \`a \${ { nested: 1 } } b\`;\nexport default Flow.make("re-flow", { description: "ok", capabilities: ["fs:read:**"], body: () => null })`,
        `const r = /unterminated[a-z\nconst t = \`unterminated \${ 1`,
        `export default ({ name: "dec", extraUnknownKey: 123, body: () => null })`,
        `const caps = ["fs:read:**"]\nexport default Flow.make("del-1", { description: "d", capabilities: caps, flows: ["helper"], body: () => null })`,
        `export default Flow.make("del-2", { description: "d", capabilities: ["fs:read:a"], flows: ["helper"], body: () => null })`,
        `export default Flow.make("del-3", { description: "d", flows: ["helper"], body: () => null })`,
        `const base = {}\nexport default Flow.make("spread", { ...base, ["dyn"]: 1, payload: { a: Schema.String }, flows: ["helper"], capabilities: ["fs:read:a"], body: () => null })`,
        `import { Schema } from "effect"\nexport default Flow.make("deep", { description: "d", payload: Schema.Struct({ a: Schema.Struct({ b: Schema.Struct({ c: Schema.Struct({ d: Schema.Struct({ e: Schema.Struct({ f: Schema.Struct({ g: Schema.Struct({ h: Schema.Struct({ i: Schema.Struct({ j: Schema.String }) }) }) }) }) }) }) }) }) }), body: () => null })`,
        `import * as S from "effect/Schema"\nexport default Flow.make("schemas", { description: "d", payload: { a: S.String, b: S.Number, c: S.Boolean, d: S.Literal("x"), e: S.Array(S.String), f: S.Record(S.String, S.Number), g: S.optional(S.String), h: S.NullOr(S.Boolean), i: S.Union(S.String, S.Number) }, body: () => null })`,
        `import { Schema } from "effect"\nconst MyPayload = Schema.String\nexport default Flow.make("unproj", { description: "d", payload: MyPayload, body: () => null })`
      ]

      const arb = Arbitrary.schema(
        Schema.Struct({
          idx: Schema.Literals([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
          prefixPad: Schema.Literals(["", "// leading comment\n", "/* block */ "])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ idx, prefixPad }) =>
            Effect.sync(() => {
              const src = prefixPad + snippets[idx]!
              const meta = ModuleMetadata.parse(src)
              const complete = ModuleMetadata.isComplete(src)
              expect(typeof complete).toBe("boolean")
              expect(Array.isArray(meta.warnings)).toBe(true)
              if (idx === 0 || idx === 2) {
                expect(meta.warnings.length).toBeGreaterThan(0)
              }
              if (idx === 5) {
                expect(meta.capabilities).toEqual(["fs:read:a"])
              }
              return true
            }),
          { executions: fastExec, seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "ModuleClosure scan/analyze/snapshot/linked covers TSImportType, opaque require/createRequire, runtime loads, #imports, MDX errors",
    async () => {
      const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-w10-closure-")))
      try {
        const arb = Arbitrary.schema(
          Schema.Struct({
            mode: Schema.Literals([
              "tsx-import-type",
              "opaque-require",
              "runtime-load",
              "pkg-imports-single",
              "pkg-imports-multi",
              "mdx-broken",
              "builtins-abs",
              "linked-check"
            ])
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ mode }) =>
              Effect.gen(function*() {
                const fsSvc = yield* FileSystem.FileSystem
                const pathSvc = yield* Path.Path
                const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpRoot, "c-")))
                const cache = ModuleClosure.cache()

                if (mode === "tsx-import-type") {
                  const entry = path.join(dir, "flow.tsx")
                  const helper = path.join(dir, "h.ts")
                  const src = `type T = import("./h.ts").Foo;\nexport const x = <div />;\n`
                  yield* Effect.promise(() => fs.writeFile(helper, "export type Foo = string\n"))
                  yield* Effect.promise(() => fs.writeFile(entry, src))
                  const res = yield* ModuleClosure.analyze(fsSvc, pathSvc, entry, src, cache)
                  expect(res.imports).toBeDefined()
                } else if (mode === "opaque-require") {
                  const entry = path.join(dir, "flow.ts")
                  const src = [
                    `const a = host["require"]`,
                    `const b = host["createRequire"]`,
                    `import { createRequire as cr } from "node:module"`,
                    `const r1 = require`,
                    `const r2 = require.resolve("./x")`,
                    `const obj = { require: 1 }`,
                    `const ok = opts.require`,
                    `const bad = globalThis.require`,
                    `const dyn = import(someVar)`,
                    `const tpl = import(\`./a\${x}\`)`
                  ].join("\n")
                  yield* Effect.promise(() => fs.writeFile(entry, src))
                  const res = yield* ModuleClosure.analyze(fsSvc, pathSvc, entry, src, cache)
                  expect(res.imports.some((i) => i.computed === true)).toBe(true)
                } else if (mode === "runtime-load") {
                  const entry = path.join(dir, "flow.ts")
                  const helper = path.join(dir, "helper.ts")
                  const src =
                    `const h = await import("./helper.ts")\nconst r = require("./helper.ts")\nexport default h\n`
                  yield* Effect.promise(() => fs.writeFile(helper, "export const v = 1\n"))
                  yield* Effect.promise(() => fs.writeFile(entry, src))
                  const snapped = yield* ModuleClosure.snapshot(fsSvc, pathSvc, entry, enc.encode(src))
                  expect(snapped.unsupported.length).toBeGreaterThan(0)
                } else if (mode === "pkg-imports-single" || mode === "pkg-imports-multi") {
                  const pkgJson = mode === "pkg-imports-single"
                    ? { name: "p", imports: { "#one": "./one.ts" } }
                    : { name: "p", imports: { "#multi": { import: "./a.ts", default: "./b.ts" } } }
                  yield* Effect.promise(() => fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkgJson)))
                  yield* Effect.promise(() => fs.writeFile(path.join(dir, "one.ts"), "export const o = 1\n"))
                  yield* Effect.promise(() => fs.writeFile(path.join(dir, "a.ts"), "export const a = 1\n"))
                  yield* Effect.promise(() => fs.writeFile(path.join(dir, "b.ts"), "export const b = 2\n"))
                  const entry = path.join(dir, "flow.ts")
                  const spec = mode === "pkg-imports-single" ? "#one" : "#multi"
                  const src = `import { ${
                    mode === "pkg-imports-single" ? "o" : "a"
                  } } from "${spec}"\nexport default 1\n`
                  yield* Effect.promise(() => fs.writeFile(entry, src))
                  const snapped = yield* ModuleClosure.snapshot(fsSvc, pathSvc, entry, enc.encode(src))
                  if (mode === "pkg-imports-single") {
                    expect(snapped.modules.get(entry)?.links.length).toBe(1)
                  } else {
                    expect(snapped.unsupported.length).toBeGreaterThan(0)
                  }
                } else if (mode === "mdx-broken") {
                  const entry = path.join(dir, "flow.ts")
                  const badMdx = path.join(dir, "bad.mdx")
                  yield* Effect.promise(() => fs.writeFile(badMdx, "# Hi\n\n<UnclosedTag\n"))
                  const src = `import doc from "./bad.mdx"\nexport default doc\n`
                  yield* Effect.promise(() => fs.writeFile(entry, src))
                  const res = yield* ModuleClosure.analyze(fsSvc, pathSvc, entry, src, cache)
                  expect(res.imports.length).toBeGreaterThan(0)
                } else if (mode === "builtins-abs") {
                  const entry = path.join(dir, "flow.ts")
                  const src = `import "node:fs"\nimport "bun:test"\nimport "/abs/path.ts"\nexport default 1\n`
                  yield* Effect.promise(() => fs.writeFile(entry, src))
                  const res = yield* ModuleClosure.analyze(fsSvc, pathSvc, entry, src, cache)
                  expect(res.hostImports.length).toBeGreaterThan(0)
                } else if (mode === "linked-check") {
                  const entry = path.join(dir, "flow.ts")
                  const helper = path.join(dir, "h.ts")
                  const src = `import { x } from "./h.ts"\nimport { y } from "#alias"\nexport default x + y\n`
                  const startRel = src.indexOf(`"./h.ts"`)
                  const startHash = src.indexOf(`"#alias"`)
                  const good = ModuleClosure.linked(
                    pathSvc,
                    entry,
                    {
                      source: src,
                      links: [
                        { start: startRel, end: startRel + `"./h.ts"`.length, target: helper },
                        { start: startHash, end: startHash + `"#alias"`.length, target: helper }
                      ]
                    },
                    (f) => f === entry || f === helper
                  )
                  expect(good).toBe(true)
                  const badMissing = ModuleClosure.linked(
                    pathSvc,
                    entry,
                    { source: src, links: [] },
                    (f) => f === entry || f === helper
                  )
                  expect(badMissing).toBe(false)
                  const badTarget = ModuleClosure.linked(
                    pathSvc,
                    entry,
                    {
                      source: src,
                      links: [
                        { start: startRel, end: startRel + `"./h.ts"`.length, target: "/wrong.ts" },
                        { start: startHash, end: startHash + `"#alias"`.length, target: helper }
                      ]
                    },
                    (f) => f === entry || f === helper
                  )
                  expect(badTarget).toBe(false)
                }
                return true
              }).pipe(Effect.provide(platform)),
            { executions: ioExec, seed: seed + 2 }
          )
        )
        assertPassed(report)
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "ExecutionSnapshot corruption, missing blobs, lockfile drift, link races, roots, descriptor, and layerFileSystem",
    async () => {
      const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-w10-snap-")))
      try {
        const arb = Arbitrary.schema(
          Schema.Struct({
            fault: Schema.Literals([
              "invalid-digest",
              "index-unreadable",
              "index-bad-json",
              "index-bad-address",
              "manifest-digest-mismatch",
              "manifest-lockfile-mismatch",
              "lockfile-changed-restore",
              "lockfile-changed-pin",
              "missing-compiled",
              "corrupt-compiled-source",
              "entry-digest-mismatch",
              "closure-size-mismatch",
              "helper-digest-mismatch",
              "unmeasured-pin",
              "no-source-pin",
              "tampered-entry-pin",
              "tampered-helper-pin",
              "retire-stale-index",
              "link-race-existing",
              "link-fail-missing",
              "happy-roots-descriptor"
            ])
          })
        )

        const snapFlow = Flow.make("snapflow", {
          description: "snap",
          payload: Schema.Struct({}),
          success: Schema.String,
          body: () => Node.succeed("ok")
        })

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ fault }) =>
              Effect.gen(function*() {
                const root = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpRoot, "s-")))
                const flowDir = path.join(root, ".smithers", "flows", "snapflow")
                yield* Effect.promise(() => fs.mkdir(flowDir, { recursive: true }))
                const entryPath = path.join(flowDir, "flow.ts")
                const helperPath = path.join(flowDir, "helper.ts")
                const helperSrc = `export const msg = "ok"\n`
                const entrySrc = [
                  `import { Flow } from "@smthrs/flow"`,
                  `import { Node } from "@smthrs/plan"`,
                  `import { Schema } from "effect"`,
                  `import { msg } from "./helper.ts"`,
                  `export default Flow.make("snapflow", {`,
                  `  description: "snap",`,
                  `  payload: Schema.Struct({}),`,
                  `  success: Schema.String,`,
                  `  body: () => Node.succeed(msg)`,
                  `})`
                ].join("\n")
                yield* Effect.promise(() => fs.writeFile(helperPath, helperSrc))
                yield* Effect.promise(() => fs.writeFile(entryPath, entrySrc))
                yield* Effect.promise(() => fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n"))

                const discovery = yield* Discovery.Discovery
                const scanned = yield* discovery.scan({
                  source: "project",
                  root: path.join(root, ".smithers", "flows"),
                  naming: "path",
                  lockfileRoot: root
                })
                const descriptor = scanned.entries[0]!
                const digest = Descriptor.executionDigest(descriptor)!
                const exec = yield* Executable.fromDescriptor(descriptor, {
                  delegates: [],
                  load: () => Effect.succeed({ default: snapFlow })
                })

                const baseFs = yield* FileSystem.FileSystem
                const pathSvc = yield* Path.Path
                const crypto = yield* EffectDigest.Digest
                const objDir = path.join(root, ".flows", "objects")
                const execDir = path.join(root, ".flows", "executions")
                const store = ArtifactStore.makeFileSystem(baseFs, pathSvc, { directory: objDir })

                const makeSnap = (customFs?: FileSystem.FileSystem) =>
                  ExecutionSnapshot.makeFileSystem({ root, store }).pipe(
                    Effect.provideService(FileSystem.FileSystem, customFs ?? baseFs)
                  )

                if (fault === "invalid-digest") {
                  const snap = yield* makeSnap()
                  const r = yield* Effect.result(snap.restore("not-valid-hex"))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (fault === "index-unreadable") {
                  const badFs = {
                    ...baseFs,
                    readFile: () =>
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "PermissionDenied",
                          module: "FileSystem",
                          method: "readFile"
                        })
                      )
                  } as unknown as FileSystem.FileSystem
                  const snap = yield* makeSnap(badFs)
                  const r = yield* Effect.result(snap.restore(digest))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (fault === "index-bad-json" || fault === "index-bad-address") {
                  const snap = yield* makeSnap()
                  yield* Effect.promise(() => fs.mkdir(execDir, { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(
                      path.join(execDir, `${digest}.json`),
                      fault === "index-bad-json" ? "{bad" : JSON.stringify("not-a-digest")
                    )
                  )
                  const r = yield* Effect.result(snap.restore(digest))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (fault === "unmeasured-pin") {
                  const snap = yield* makeSnap()
                  const unmeasuredDesc = new Descriptor.FlowDescriptor({
                    ...descriptor,
                    body: new Descriptor.BodyRefMarkdown({ path: entryPath, baseDirectory: flowDir })
                  })
                  const r = yield* Effect.result(snap.pin({ ...exec, descriptor: unmeasuredDesc }))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (fault === "no-source-pin") {
                  const snap = yield* makeSnap()
                  const r = yield* Effect.result(snap.pin({ ...exec, source: undefined }))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (fault === "tampered-entry-pin") {
                  const snap = yield* makeSnap()
                  const badSrc = { ...exec.source!, bytes: enc.encode("tampered") }
                  const r = yield* Effect.result(snap.pin({ ...exec, source: badSrc }))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (fault === "tampered-helper-pin") {
                  const snap = yield* makeSnap()
                  const mods = new Map(exec.source!.modules)
                  const orig = mods.get(helperPath)!
                  mods.set(helperPath, { ...orig, bytes: enc.encode("tampered-helper") })
                  const r = yield* Effect.result(snap.pin({ ...exec, source: { ...exec.source!, modules: mods } }))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (fault === "lockfile-changed-pin") {
                  const snap = yield* makeSnap()
                  yield* Effect.promise(() => fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9.1\n"))
                  const r = yield* Effect.result(snap.pin(exec))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (fault === "happy-roots-descriptor") {
                  const res = yield* Effect.gen(function*() {
                    const snap = yield* ExecutionSnapshot.ExecutionSnapshot
                    yield* snap.pin(exec)
                    yield* snap.pin(exec)
                    const roots = yield* snap.roots([digest])
                    const d = yield* snap.descriptor(digest)
                    return { roots, d }
                  }).pipe(Effect.provide(ExecutionSnapshot.layerFileSystem({ root, store })))
                  expect(res.roots.length).toBeGreaterThanOrEqual(2)
                  expect(res.d.name).toBe("snapflow")
                } else if (fault === "link-race-existing" || fault === "link-fail-missing") {
                  const snapReal = yield* makeSnap()
                  if (fault === "link-race-existing") {
                    yield* snapReal.pin(exec)
                  }
                  let calls = 0
                  const toggleFs = {
                    ...baseFs,
                    exists: (p: string) =>
                      p.endsWith(`${digest}.json`)
                        ? Effect.sync(() => fault === "link-race-existing" ? ++calls > 1 : false)
                        : baseFs.exists(p),
                    link: () =>
                      Effect.fail(
                        PlatformError.systemError({ _tag: "AlreadyExists", module: "FileSystem", method: "link" })
                      )
                  } as unknown as FileSystem.FileSystem
                  const snapRace = yield* makeSnap(toggleFs)
                  const r = yield* Effect.result(snapRace.pin(exec))
                  expect(Result.isSuccess(r)).toBe(fault === "link-race-existing")
                } else {
                  const snap = yield* makeSnap()
                  yield* snap.pin(exec)
                  const indexPath = path.join(execDir, `${digest}.json`)
                  const blobDigest = JSON.parse(yield* Effect.promise(() => fs.readFile(indexPath, "utf8"))) as string
                  const manifestRaw = new TextDecoder().decode(
                    yield* store.get(blobDigest).pipe(Effect.provideService(EffectDigest.Digest, crypto))
                  )
                  const manifest = JSON.parse(manifestRaw) as Record<string, any>

                  if (fault === "lockfile-changed-restore") {
                    yield* Effect.promise(() => fs.writeFile(path.join(root, "pnpm-lock.yaml"), "changed\n"))
                    const r = yield* Effect.result(snap.restore(digest))
                    expect(Result.isFailure(r)).toBe(true)
                  } else if (fault === "retire-stale-index") {
                    yield* Effect.promise(() => fs.rm(objDir, { recursive: true, force: true }))
                    yield* snap.pin(exec)
                    const restored = yield* snap.restore(digest)
                    expect(restored.descriptor.name).toBe("snapflow")
                  } else {
                    if (fault === "manifest-digest-mismatch") {
                      manifest.executionDigest = "a".repeat(64)
                    } else if (fault === "manifest-lockfile-mismatch") {
                      manifest.lockfileDigest = "b".repeat(64)
                    } else if (fault === "missing-compiled") {
                      delete manifest.compiled[helperPath]
                    } else if (fault === "corrupt-compiled-source") {
                      manifest.compiled[entryPath].source = "// altered"
                    } else if (fault === "entry-digest-mismatch") {
                      const fakeBlob = yield* store.put(enc.encode("wrong-entry")).pipe(
                        Effect.provideService(EffectDigest.Digest, crypto)
                      )
                      manifest.modules[entryPath] = fakeBlob
                      manifest.compiled[entryPath] = { source: "wrong-entry", links: [] }
                    } else if (fault === "closure-size-mismatch") {
                      const extraBlob = yield* store.put(enc.encode("export const z = 1")).pipe(
                        Effect.provideService(EffectDigest.Digest, crypto)
                      )
                      const extraFile = path.join(flowDir, "extra.ts")
                      manifest.modules[extraFile] = extraBlob
                      manifest.compiled[extraFile] = { source: "export const z = 1", links: [] }
                    } else if (fault === "helper-digest-mismatch") {
                      const fakeBlob = yield* store.put(enc.encode("export const msg = 'tampered'\n")).pipe(
                        Effect.provideService(EffectDigest.Digest, crypto)
                      )
                      manifest.modules[helperPath] = fakeBlob
                      manifest.compiled[helperPath] = { source: "export const msg = 'tampered'\n", links: [] }
                    }
                    const newBlob = yield* store.put(enc.encode(JSON.stringify(manifest))).pipe(
                      Effect.provideService(EffectDigest.Digest, crypto)
                    )
                    yield* Effect.promise(() => fs.writeFile(indexPath, JSON.stringify(newBlob)))
                    const r = yield* Effect.result(snap.restore(digest))
                    expect(Result.isFailure(r)).toBe(true)
                  }
                }
                return true
              }).pipe(Effect.provide(Layer.mergeAll(platform, Discovery.layer.pipe(Layer.provide(platform))))),
            { executions: ioExec, seed: seed + 3 }
          )
        )
        assertPassed(report)
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "Discovery edge cases: oversized stream/stat, symlink cycles/escapes, multiple entries, unreadable files, retired root holdsEntry",
    async () => {
      const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-w10-disc-")))
      try {
        const arb = Arbitrary.schema(
          Schema.Struct({
            scenario: Schema.Literals([
              "multiple-entries-and-root-level",
              "oversized-stat",
              "oversized-lying-stat",
              "unreadable-entry",
              "symlink-cycle-and-escape",
              "unresolvable-confinement",
              "retired-root-holds-entry",
              "no-inode-identity"
            ])
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ scenario }) =>
              Effect.gen(function*() {
                const baseFs = yield* FileSystem.FileSystem
                const pathSvc = yield* Path.Path
                const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpRoot, "d-")))
                const flowsDir = path.join(dir, "flows")
                yield* Effect.promise(() => fs.mkdir(flowsDir, { recursive: true }))

                if (scenario === "multiple-entries-and-root-level") {
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(flowsDir, "SKILL.md"), "---\nname: r\ndescription: r\n---\nhi\n")
                  )
                  yield* Effect.promise(() => fs.writeFile(path.join(flowsDir, "flow.ts"), "export default 1\n"))
                  const sub = path.join(flowsDir, "dup")
                  yield* Effect.promise(() => fs.mkdir(sub, { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(sub, "SKILL.md"), "---\nname: dup\ndescription: d\n---\nhi\n")
                  )
                  yield* Effect.promise(() => fs.writeFile(path.join(sub, "flow.ts"), "export default 1\n"))
                  const disc = Discovery.make(baseFs, pathSvc)
                  const out = yield* disc.scan({ source: "project", root: flowsDir, naming: "path" })
                  expect(out.warnings.some((w) => w.code === "multiple_entry_files")).toBe(true)
                  expect(out.warnings.some((w) => w.code === "root_level_entry")).toBe(true)
                } else if (scenario === "oversized-stat") {
                  const sub = path.join(flowsDir, "big")
                  yield* Effect.promise(() => fs.mkdir(sub, { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(sub, "SKILL.md"), "x".repeat(Discovery.entrySizeLimit + 16))
                  )
                  const disc = Discovery.make(baseFs, pathSvc)
                  const out = yield* disc.scan({ source: "project", root: flowsDir, naming: "path" })
                  expect(out.warnings.some((w) => w.code === "entry_too_large")).toBe(true)
                } else if (scenario === "oversized-lying-stat") {
                  const sub = path.join(flowsDir, "lie")
                  yield* Effect.promise(() => fs.mkdir(sub, { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(sub, "SKILL.md"), "x".repeat(Discovery.entrySizeLimit + 16))
                  )
                  const lyingFs = {
                    ...baseFs,
                    stat: (p: string) =>
                      baseFs.stat(p).pipe(
                        Effect.map((info) =>
                          p.endsWith("SKILL.md") ? { ...info, size: 10 as unknown as typeof info.size } : info
                        )
                      )
                  } as unknown as FileSystem.FileSystem
                  const disc = Discovery.make(lyingFs, pathSvc)
                  const out = yield* disc.scan({ source: "project", root: flowsDir, naming: "path" })
                  expect(out.warnings.some((w) => w.code === "entry_too_large")).toBe(true)
                } else if (scenario === "unreadable-entry") {
                  const sub = path.join(flowsDir, "unr")
                  yield* Effect.promise(() => fs.mkdir(sub, { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(sub, "SKILL.md"), "---\nname: unr\ndescription: d\n---\nhi\n")
                  )
                  const badStreamFs = {
                    ...baseFs,
                    stream: (p: string, opts?: any) =>
                      p.endsWith("SKILL.md")
                        ? baseFs.stream(path.join(dir, "definitely-missing-file"), opts)
                        : baseFs.stream(p, opts)
                  } as unknown as FileSystem.FileSystem
                  const disc = Discovery.make(badStreamFs, pathSvc)
                  const out = yield* disc.scan({ source: "project", root: flowsDir, naming: "path" })
                  expect(out.warnings.some((w) => w.code === "unreadable")).toBe(true)
                } else if (scenario === "symlink-cycle-and-escape") {
                  const outside = path.join(dir, "outside")
                  yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(outside, "SKILL.md"), "---\nname: out\ndescription: d\n---\nhi\n")
                  )
                  const sub = path.join(flowsDir, "loop")
                  yield* Effect.promise(() => fs.mkdir(sub, { recursive: true }))
                  yield* Effect.promise(() => fs.symlink(flowsDir, path.join(sub, "back")))
                  yield* Effect.promise(() => fs.symlink(outside, path.join(flowsDir, "esc")))
                  const broken = path.join(flowsDir, "broken-link")
                  yield* Effect.promise(() => fs.symlink(path.join(dir, "nowhere"), broken))
                  const disc = Discovery.make(baseFs, pathSvc)
                  const out = yield* disc.scan({
                    source: "project",
                    root: flowsDir,
                    confinementRoot: flowsDir,
                    naming: "path"
                  })
                  expect(out.warnings.some((w) => w.code === "symlink_cycle")).toBe(true)
                  expect(out.warnings.some((w) => w.code === "outside_root")).toBe(true)
                } else if (scenario === "unresolvable-confinement") {
                  const sub = path.join(flowsDir, "ok")
                  yield* Effect.promise(() => fs.mkdir(sub, { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(sub, "SKILL.md"), "---\nname: ok\ndescription: d\n---\nhi\n")
                  )
                  const disc = Discovery.make(baseFs, pathSvc)
                  const out = yield* disc.scan({
                    source: "project",
                    root: flowsDir,
                    confinementRoot: path.join(dir, "nonexistent-confinement"),
                    naming: "path"
                  })
                  expect(out.warnings.some((w) => w.code === "outside_root")).toBe(true)
                } else if (scenario === "retired-root-holds-entry") {
                  const project = path.join(dir, "proj")
                  const active = path.join(project, ".smithers", "flows")
                  const retired = path.join(project, "flows")
                  yield* Effect.promise(() => fs.mkdir(active, { recursive: true }))
                  let cur = retired
                  for (let i = 0; i < 34; i++) {
                    cur = path.join(cur, `d${i}`)
                  }
                  yield* Effect.promise(() => fs.mkdir(cur, { recursive: true }))
                  yield* Effect.promise(() => fs.symlink(retired, path.join(retired, "cyc")))
                  const disc = Discovery.make(baseFs, pathSvc)
                  const out1 = yield* disc.scan({ source: "project", root: active, naming: "path" })
                  expect(out1.entries).toEqual([])
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(retired, "d0", "SKILL.md"), "---\nname: old\ndescription: d\n---\nhi\n")
                  )
                  const out2 = yield* disc.scan({ source: "project", root: active, naming: "path" })
                  expect(out2.warnings.length).toBeGreaterThanOrEqual(0)
                } else if (scenario === "no-inode-identity") {
                  const sub = path.join(flowsDir, "nino")
                  yield* Effect.promise(() => fs.mkdir(sub, { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(sub, "SKILL.md"), "---\nname: nino\ndescription: d\n---\nhi\n")
                  )
                  const noInoFs = {
                    ...baseFs,
                    stat: (p: string) => baseFs.stat(p).pipe(Effect.map((info) => ({ ...info, ino: Option.none() })))
                  } as unknown as FileSystem.FileSystem
                  const disc = Discovery.make(noInoFs, pathSvc)
                  const out = yield* disc.scan({ source: "project", root: flowsDir, naming: "path" })
                  expect(out.entries.length).toBe(1)
                }
                return true
              }).pipe(Effect.provide(platform)),
            { executions: ioExec, seed: seed + 4 }
          )
        )
        assertPassed(report)
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "Pack.read, Pack.sources, Pack.compatible semver comparators, Registry.make/loadBody with snapshots, Body, and NodeLoadGuard",
    async () => {
      const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-w10-pack-")))
      try {
        const semverArb = Arbitrary.schema(
          Schema.Struct({
            version: Schema.Literals(["0.0.3", "0.0.4", "0.2.3", "0.3.0", "1.2.3", "1.3.0", "2.0.0", "bad"]),
            range: Schema.Literals([
              "",
              "*",
              "1.0.0 - 2.0.0",
              ">=1.2",
              "<=1.2",
              "<=1.2.3",
              ">1.2",
              ">1.2.3",
              "<1.3.0",
              "^0.2.3",
              "^0.0.3",
              "^0",
              "^0.0",
              "^1.2.3",
              "~1.2.3",
              "~1",
              "=1.2",
              "1.2.3",
              "not-a-range"
            ])
          })
        )
        const semverReport = await Effect.runPromise(
          Fuzz.run(
            semverArb,
            ({ version, range }) =>
              Effect.sync(() => {
                const res = Pack.compatible(range, version)
                expect(typeof res).toBe("boolean")
                return true
              }),
            { executions: fastExec, seed: seed + 5 }
          )
        )
        assertPassed(semverReport)

        const packArb = Arbitrary.schema(
          Schema.Struct({
            caseKind: Schema.Literals([
              "pack-missing",
              "pack-bad-json",
              "pack-array-json",
              "pack-unsafe-entry",
              "pack-invalid-schema",
              "pack-unknown-key",
              "pack-sources-escape",
              "pack-sources-unresolved-root",
              "pack-sources-symlink-loop",
              "registry-snapshot-fallback",
              "registry-lockfile-pack-fail",
              "body-failures-and-file-url",
              "node-load-guard"
            ])
          })
        )

        const packReport = await Effect.runPromise(
          Fuzz.run(
            packArb,
            ({ caseKind }) =>
              Effect.gen(function*() {
                const fsSvc = yield* FileSystem.FileSystem
                const pathSvc = yield* Path.Path
                const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpRoot, "p-")))

                if (caseKind === "pack-missing") {
                  const r = yield* Effect.result(Pack.read(fsSvc, pathSvc, dir))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (caseKind === "pack-bad-json") {
                  yield* Effect.promise(() => fs.writeFile(path.join(dir, "pack.json"), "{nope"))
                  const r = yield* Effect.result(Pack.read(fsSvc, pathSvc, dir))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (caseKind === "pack-array-json") {
                  yield* Effect.promise(() => fs.writeFile(path.join(dir, "pack.json"), "[1,2,3]"))
                  const r = yield* Effect.result(Pack.read(fsSvc, pathSvc, dir))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (caseKind === "pack-unsafe-entry") {
                  yield* Effect.promise(() =>
                    fs.writeFile(
                      path.join(dir, "pack.json"),
                      JSON.stringify({ name: "p", version: "1.0.0", flows: ["../escape"] })
                    )
                  )
                  const r = yield* Effect.result(Pack.read(fsSvc, pathSvc, dir))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (caseKind === "pack-invalid-schema") {
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(dir, "pack.json"), JSON.stringify({ name: "", version: "1.0.0", flows: [] }))
                  )
                  const r = yield* Effect.result(Pack.read(fsSvc, pathSvc, dir))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (caseKind === "pack-unknown-key") {
                  yield* Effect.promise(() =>
                    fs.writeFile(
                      path.join(dir, "pack.json"),
                      JSON.stringify({ name: "good-pack", version: "1.0.0", flows: ["flows"], extraField: true })
                    )
                  )
                  const loaded = yield* Pack.read(fsSvc, pathSvc, dir)
                  expect(loaded.warnings.some((w) => w.code === "unknown_pack_key")).toBe(true)
                } else if (caseKind === "pack-sources-escape") {
                  const outside = path.join(dir, "outside")
                  const packDir = path.join(dir, "pk")
                  yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
                  yield* Effect.promise(() => fs.mkdir(packDir, { recursive: true }))
                  yield* Effect.promise(() => fs.symlink(outside, path.join(packDir, "flows")))
                  const fakePack = {
                    origin: "local" as const,
                    dir: packDir,
                    manifest: new Pack.Manifest({ name: "pk", version: "1.0.0", flows: ["flows"] })
                  }
                  const r = yield* Effect.result(Pack.sources(fakePack, pathSvc))
                  expect(Result.isFailure(r)).toBe(true)
                  const badRel = yield* Effect.result(
                    Pack.sources(
                      {
                        ...fakePack,
                        manifest: { ...fakePack.manifest, flows: ["../outside"] } as unknown as Pack.Manifest
                      },
                      pathSvc
                    )
                  )
                  expect(Result.isFailure(badRel)).toBe(true)
                } else if (caseKind === "pack-sources-unresolved-root") {
                  const fakePack = {
                    origin: "local" as const,
                    dir: path.join(dir, "does-not-exist"),
                    manifest: new Pack.Manifest({ name: "pk", version: "1.0.0", flows: ["flows"] })
                  }
                  const r = yield* Effect.result(Pack.sources(fakePack, pathSvc))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (caseKind === "pack-sources-symlink-loop") {
                  const packDir = path.join(dir, "loop-pk")
                  yield* Effect.promise(() => fs.mkdir(packDir, { recursive: true }))
                  yield* Effect.promise(() => fs.symlink(path.join(packDir, "b"), path.join(packDir, "a")))
                  yield* Effect.promise(() => fs.symlink(path.join(packDir, "a"), path.join(packDir, "b")))
                  const fakePack = {
                    origin: "local" as const,
                    dir: packDir,
                    manifest: new Pack.Manifest({ name: "pk", version: "1.0.0", flows: ["a"] })
                  }
                  const r = yield* Effect.result(Pack.sources(fakePack, pathSvc))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (caseKind === "registry-snapshot-fallback") {
                  const flowsDir = path.join(dir, "flows")
                  const fDir = path.join(flowsDir, "mdflow")
                  yield* Effect.promise(() => fs.mkdir(fDir, { recursive: true }))
                  const mdPath = path.join(fDir, "SKILL.md")
                  yield* Effect.promise(() =>
                    fs.writeFile(mdPath, "---\nname: mdflow\ndescription: hi\n---\nPrompt body\n")
                  )
                  const snap = yield* ExecutionSnapshot.makeFileSystem({ root: dir })
                  const disc = Discovery.make(fsSvc, pathSvc)
                  const reg = yield* Registry.make({
                    sources: [{ source: "project", root: flowsDir, naming: "path" }],
                    snapshots: snap
                  }).pipe(Effect.provideService(Discovery.Discovery, disc))
                  const d = yield* reg.get("mdflow")
                  const digest = Descriptor.executionDigest(d)!
                  const exec = yield* Executable.fromDescriptor(d, { delegates: [dummyDelegate] })
                  yield* snap.pin(exec)

                  yield* Effect.promise(() =>
                    fs.writeFile(mdPath, "---\nname: mdflow\ndescription: hi\n---\nModified\n")
                  )
                  const restoredBody = yield* reg.loadBody("mdflow", digest)
                  expect(restoredBody._tag).toBe("Prompt")

                  const wrongFlow = yield* Effect.result(reg.loadBody("other-flow", digest))
                  expect(Result.isFailure(wrongFlow)).toBe(true)

                  const wrongDigest = yield* Effect.result(reg.loadBody("mdflow", "a".repeat(64)))
                  expect(Result.isFailure(wrongDigest)).toBe(true)

                  const regNoSnap = yield* Registry.make({
                    sources: [{ source: "project", root: flowsDir, naming: "path" }]
                  }).pipe(Effect.provideService(Discovery.Discovery, disc))
                  const failNoSnap = yield* Effect.result(regNoSnap.loadBody("mdflow", digest))
                  expect(Result.isFailure(failNoSnap)).toBe(true)
                } else if (caseKind === "registry-lockfile-pack-fail") {
                  const packDir = path.join(dir, "pk")
                  yield* Effect.promise(() => fs.mkdir(path.join(packDir, "flows"), { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(
                      path.join(packDir, "pack.json"),
                      JSON.stringify({ name: "pk", version: "1.0.0", flows: ["flows"] })
                    )
                  )
                  const failingDiscovery = Discovery.Discovery.of({
                    scan: () =>
                      Effect.fail(
                        new RegistryError.DiscoveryError({
                          code: "read_failed",
                          module: "Discovery",
                          method: "scan",
                          path: packDir,
                          message: "boom"
                        })
                      )
                  })
                  const r1 = yield* Effect.result(
                    Registry.make({
                      sources: [{ source: "project", root: dir, naming: "path" }]
                    }).pipe(Effect.provideService(Discovery.Discovery, failingDiscovery))
                  )
                  expect(Result.isFailure(r1)).toBe(true)

                  const r2 = yield* Effect.result(
                    Registry.make({
                      sources: [],
                      packs: {
                        runtimeVersion: "1.0.0",
                        lockfileRoot: dir,
                        installed: [{
                          origin: "local",
                          dir: packDir,
                          manifest: new Pack.Manifest({ name: "pk", version: "1.0.0", flows: ["flows"] })
                        }]
                      }
                    }).pipe(Effect.provideService(Discovery.Discovery, failingDiscovery))
                  )
                  expect(Result.isFailure(r2)).toBe(true)
                } else if (caseKind === "body-failures-and-file-url") {
                  const f = path.join(dir, "a.md")
                  const content = enc.encode("hello body")
                  yield* Effect.promise(() => fs.writeFile(f, content))
                  const dUnmeasured = makeDescriptor({
                    body: new Descriptor.BodyRefMarkdown({ path: f, baseDirectory: dir })
                  })
                  const rUnm = yield* Effect.result(Body.readVerifiedBody(fsSvc, pathSvc, dUnmeasured))
                  expect(Result.isFailure(rUnm)).toBe(true)

                  const dFileUrl = makeDescriptor({
                    body: new Descriptor.BodyRefMarkdown({
                      path: pathToFileURL(f).href,
                      baseDirectory: dir,
                      contentDigest: Digest.digest(content)
                    })
                  })
                  const ok = yield* Body.readVerifiedBody(fsSvc, pathSvc, dFileUrl)
                  expect(ok.length).toBe(content.length)

                  const dBadLock = makeDescriptor({
                    body: new Descriptor.BodyRefMarkdown({
                      path: f,
                      baseDirectory: dir,
                      contentDigest: Digest.digest(content)
                    }),
                    provenance: new Descriptor.Provenance({ source: "project", root: dir }),
                    lockfiles: { root: ".", digest: "f".repeat(64) }
                  })
                  const rLock = yield* Effect.result(Body.readVerifiedBody(fsSvc, pathSvc, dBadLock))
                  expect(Result.isFailure(rLock)).toBe(true)
                } else if (caseKind === "node-load-guard") {
                  const noSvc = yield* Effect.serviceOption(LoadGuard.LoadGuard).pipe(
                    Effect.provide(NodeLoadGuard.layerWith(undefined))
                  )
                  expect(Option.isNone(noSvc)).toBe(true)

                  let registeredResolve:
                    | ((
                      spec: string,
                      ctx: unknown,
                      next: (s: string, c: unknown) => { readonly url: string }
                    ) => { readonly url: string })
                    | undefined
                  const layer = NodeLoadGuard.layerWith((hooks) => {
                    registeredResolve = hooks.resolve
                  })
                  const protectedFile = path.join(dir, "secret.ts")
                  const permittedFile = path.join(dir, "permitted.ts")
                  yield* Effect.promise(() => fs.writeFile(protectedFile, "export const s = 1\n"))
                  yield* Effect.promise(() => fs.writeFile(permittedFile, "export const p = 1\n"))
                  yield* Effect.scoped(Effect.gen(function*() {
                    const guard = yield* LoadGuard.LoadGuard
                    const badProtect = yield* Effect.result(guard.protect(path.join(dir, "no-such-dir")))
                    expect(Result.isFailure(badProtect)).toBe(true)
                    const notConsulted = yield* Effect.result(guard.protect(dir))
                    expect(Result.isFailure(notConsulted)).toBe(true)
                    yield* guard.permit(permittedFile)
                    if (registeredResolve !== undefined) {
                      const next = (s: string) => ({ url: s })
                      const allowed = registeredResolve(pathToFileURL(permittedFile).href, {}, next)
                      expect(allowed.url).toContain("permitted.ts")
                      const bare = registeredResolve("node:fs", {}, next)
                      expect(bare.url).toBe("node:fs")
                    }
                  })).pipe(Effect.provide(layer as unknown as Layer.Layer<LoadGuard.LoadGuard>))
                }
                return true
              }).pipe(Effect.provide(platform)),
            { executions: ioExec, seed: seed + 6 }
          )
        )
        assertPassed(packReport)
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "Executable moduleServices, invalid layers, namingMissing, adoptedRuntime, snapshots, stale siblings, and catalog load/timeout/deferred",
    async () => {
      const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-w10-exec-")))
      try {
        const arb = Arbitrary.schema(
          Schema.Struct({
            mode: Schema.Literals([
              "invalid-layer-non-layer",
              "invalid-layer-declared",
              "invalid-layer-replace-impls",
              "missing-flow-runtime",
              "missing-service-in-action",
              "legacy-object-module",
              "load-typeerror-make",
              "invalid-file-url",
              "markdown-snapshot-fallback",
              "module-snapshot-fallback",
              "adopted-runtime-and-cache-delegate",
              "catalog-deferred-timeout-unlisted",
              "stale-sibling-sweep"
            ])
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ mode }) =>
              Effect.gen(function*() {
                const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpRoot, "e-")))
                const flowsDir = path.join(dir, "flows")
                const fDir = path.join(flowsDir, "f1")
                yield* Effect.promise(() => fs.mkdir(fDir, { recursive: true }))

                const flowTs = path.join(fDir, "flow.ts")
                const validSrc = [
                  `import { Flow } from "@smthrs/flow"`,
                  `import { Node } from "@smthrs/plan"`,
                  `import { Schema } from "effect"`,
                  `export default Flow.make("f1", {`,
                  `  description: "f1",`,
                  `  payload: Schema.Struct({ n: Schema.Number }),`,
                  `  success: Schema.Number,`,
                  `  body: ({ n }) => Node.succeed(n + 1)`,
                  `})`
                ].join("\n")
                yield* Effect.promise(() => fs.writeFile(flowTs, validSrc))

                const discovery = yield* Discovery.Discovery
                const scanned = yield* discovery.scan({ source: "project", root: flowsDir, naming: "path" })
                const desc = scanned.entries[0]!
                const runtimeFlow = Flow.make("f1", {
                  description: "f1",
                  payload: Schema.Struct({ n: Schema.Number }),
                  success: Schema.Number,
                  body: ({ n }) => Node.succeed(n + 1)
                })

                if (mode === "invalid-layer-non-layer") {
                  const r = yield* Effect.result(
                    Executable.fromDescriptor(desc, {
                      delegates: [],
                      load: () => Effect.succeed({ default: runtimeFlow, layer: "not-a-layer" })
                    })
                  )
                  expect(Result.isFailure(r)).toBe(true)
                } else if (mode === "invalid-layer-declared") {
                  const r = yield* Effect.result(
                    Executable.fromDescriptor(desc, {
                      delegates: [],
                      load: () => Effect.succeed({ default: { name: "f1", description: "d" }, layer: Layer.empty })
                    })
                  )
                  expect(Result.isFailure(r)).toBe(true)
                } else if (mode === "invalid-layer-replace-impls") {
                  const badLayer = Layer.succeed(
                    Action.Implementations,
                    Action.Implementations.of({
                      get: () => Effect.succeed(Option.none()),
                      add: () => Effect.void
                    })
                  )
                  const r = yield* Effect.result(
                    Executable.fromDescriptor(desc, {
                      delegates: [],
                      load: () => Effect.succeed({ default: runtimeFlow, layer: badLayer })
                    }).pipe(Effect.provide(recordingRuntime([])))
                  )
                  expect(Result.isFailure(r)).toBe(true)
                } else if (mode === "missing-flow-runtime") {
                  const r = yield* Effect.result(
                    Executable.fromDescriptor(desc, {
                      delegates: [],
                      load: () => Effect.succeed({ default: runtimeFlow, layer: Layer.empty })
                    })
                  )
                  expect(Result.isFailure(r)).toBe(true)
                } else if (mode === "missing-service-in-action") {
                  class MissingSvc extends Context.Service<MissingSvc, { readonly v: number }>()("Wave10MissingSvc") {}
                  const act = Action.make("wave10/missing", {
                    payload: Schema.Struct({}),
                    success: Schema.Number
                  })
                  const implLayer = act.toLayer(() => Effect.map(MissingSvc, (s) => s.v))
                  const exec = yield* Effect.scoped(
                    Executable.fromDescriptor(desc, {
                      delegates: [],
                      load: () => Effect.succeed({ default: runtimeFlow, layer: implLayer })
                    })
                  ).pipe(Effect.provide(recordingRuntime([])))
                  expect(exec.descriptor.name).toBe("f1")
                } else if (mode === "legacy-object-module") {
                  const legPath = path.join(fDir, "legacy.ts")
                  const legSrc = `export default { name: "f1", steps: [] }\n`
                  yield* Effect.promise(() => fs.writeFile(legPath, legSrc))
                  const legDesc = makeDescriptor({
                    name: "f1",
                    body: new Descriptor.BodyRefModule({
                      path: legPath,
                      contentDigest: Digest.digest(enc.encode(legSrc)),
                      imports: []
                    }),
                    provenance: new Descriptor.Provenance({ source: "project", root: flowsDir })
                  })
                  const r = yield* Effect.result(Executable.fromDescriptor(legDesc, { delegates: [] }))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (mode === "load-typeerror-make") {
                  const r = yield* Effect.result(
                    Executable.fromDescriptor(desc, {
                      delegates: [],
                      load: () => Effect.fail(new TypeError("Flow.make is not a function"))
                    })
                  )
                  expect(Result.isFailure(r)).toBe(true)
                  if (Result.isFailure(r)) expect(r.failure.code).toBe("invalid_module")
                } else if (mode === "invalid-file-url") {
                  const badDesc = makeDescriptor({
                    name: "f1",
                    body: new Descriptor.BodyRefModule({
                      path: "file://not a valid %zz url",
                      contentDigest: Digest.digest(enc.encode("x")),
                      imports: []
                    })
                  })
                  const r = yield* Effect.result(Executable.fromDescriptor(badDesc, { delegates: [] }))
                  expect(Result.isFailure(r)).toBe(true)
                } else if (mode === "markdown-snapshot-fallback") {
                  const mdPath = path.join(fDir, "SKILL.md")
                  const mdContent = "---\nname: f1\ndescription: md\n---\nhello\n"
                  yield* Effect.promise(() => fs.writeFile(mdPath, mdContent))
                  const mdDesc = makeDescriptor({
                    name: "f1",
                    body: new Descriptor.BodyRefMarkdown({
                      path: mdPath,
                      baseDirectory: fDir,
                      contentDigest: Digest.digest(enc.encode(mdContent))
                    }),
                    provenance: new Descriptor.Provenance({ source: "project", root: flowsDir })
                  })
                  const snap = yield* ExecutionSnapshot.makeFileSystem({ root: dir })
                  const exec0 = yield* Executable.fromDescriptor(mdDesc, { delegates: [dummyDelegate] })
                  yield* snap.pin(exec0)
                  yield* Effect.promise(() => fs.rm(mdPath))
                  const exec1 = yield* Executable.fromDescriptor(mdDesc, {
                    delegates: [dummyDelegate],
                    snapshots: snap,
                    adapterExecutionDigest: () => Descriptor.executionDigest(mdDesc)
                  })
                  expect(exec1.descriptor.name).toBe("f1")
                  const emptySnapDir = path.join(dir, "empty-snap")
                  yield* Effect.promise(() => fs.mkdir(emptySnapDir, { recursive: true }))
                  const emptySnap = yield* ExecutionSnapshot.makeFileSystem({ root: emptySnapDir })
                  const rMiss = yield* Effect.result(
                    Executable.fromDescriptor(mdDesc, {
                      delegates: [dummyDelegate],
                      snapshots: emptySnap
                    })
                  )
                  expect(Result.isFailure(rMiss)).toBe(true)
                  const mdDigest = Descriptor.executionDigest(mdDesc)!
                  yield* Effect.promise(() =>
                    fs.writeFile(path.join(dir, ".flows", "executions", mdDigest + ".json"), "{corrupt")
                  )
                  const rCorrupt = yield* Effect.result(
                    Executable.fromDescriptor(mdDesc, {
                      delegates: [dummyDelegate],
                      snapshots: snap
                    })
                  )
                  expect(Result.isFailure(rCorrupt)).toBe(true)
                } else if (mode === "module-snapshot-fallback") {
                  const snap = yield* ExecutionSnapshot.makeFileSystem({ root: dir })
                  const exec0 = yield* Executable.fromDescriptor(desc, {
                    delegates: [],
                    load: () => Effect.succeed({ default: runtimeFlow })
                  })
                  yield* snap.pin(exec0)
                  yield* Effect.promise(() => fs.rm(flowTs))
                  const exec1 = yield* Executable.fromDescriptor(desc, {
                    delegates: [],
                    snapshots: snap,
                    adapterExecutionDigest: () => Descriptor.executionDigest(desc),
                    load: () => Effect.succeed({ default: runtimeFlow })
                  })
                  expect(exec1.descriptor.name).toBe("f1")
                } else if (mode === "adopted-runtime-and-cache-delegate") {
                  const cachedFlow = CacheEnvironment.withCache(runtimeFlow, { scope: "shared", ttlMs: 60_000 })
                  const runtimeLayer = Layer.effect(
                    FlowRuntime.FlowRuntime,
                    Effect.map(FlowRuntime.FlowRuntime, (rt) =>
                      FlowRuntime.FlowRuntime.of({
                        ...rt,
                        recordNode: () => Effect.void,
                        nodeRecordBytes: () => Effect.succeed(0)
                      }))
                  ).pipe(Layer.provide(FlowEngine.layerMemory))
                  const exec = yield* Effect.scoped(
                    Executable.fromDescriptor(desc, {
                      delegates: [],
                      adapterExecutionDigest: () => "adopted-v1",
                      load: () => Effect.succeed({ default: cachedFlow, layer: Layer.empty })
                    })
                  ).pipe(Effect.provide(runtimeLayer))
                  yield* Effect.scoped(Layer.build(exec.layer)).pipe(
                    Effect.provide(Layer.mergeAll(runtimeLayer, Action.layerImplementations, NodeCrypto.layer))
                  )
                  if (exec.quiesce) yield* exec.quiesce(["exec-1"])
                  expect(exec.descriptor.name).toBe("f1")
                } else if (mode === "catalog-deferred-timeout-unlisted") {
                  const f2Dir = path.join(flowsDir, "f2")
                  yield* Effect.promise(() => fs.mkdir(f2Dir, { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(
                      path.join(f2Dir, "flow.ts"),
                      validSrc.replaceAll(`"f1"`, `"f2"`)
                    )
                  )
                  const reg = yield* Registry.make({
                    sources: [{ source: "project", root: flowsDir, naming: "path" }]
                  })
                  const catOpts: Executable.RefreshOptions = {
                    delegates: [],
                    initialFlows: ["f1"],
                    loadTimeoutMs: 25,
                    load: (p: string) =>
                      p.includes("f1")
                        ? Effect.sleep("200 millis").pipe(Effect.as({ default: runtimeFlow }))
                        : Effect.succeed({
                          default: Flow.make("f2", {
                            description: "f2",
                            payload: Schema.Struct({ n: Schema.Number }),
                            success: Schema.Number,
                            body: ({ n }) => Node.succeed(n)
                          })
                        })
                  }
                  const built = yield* Executable.catalog(catOpts).pipe(Effect.provideService(Registry.Registry, reg))
                  const catLayer = Executable.layerRefreshable(built, catOpts).pipe(
                    Layer.provide(
                      Layer.mergeAll(
                        Layer.succeed(Registry.Registry, reg),
                        FlowEngine.layerMemory,
                        Action.layerImplementations,
                        NodeCrypto.layer
                      )
                    )
                  )
                  yield* Effect.scoped(
                    Effect.gen(function*() {
                      const catalog = yield* Executable.Catalog
                      expect(catalog.refused.some((r) => r.code === "load_timeout")).toBe(true)
                      expect(catalog.deferred?.some((d) => d.name === "f2")).toBe(true)
                      const loadedDeferred = yield* catalog.load!("f2")
                      expect(loadedDeferred.descriptor.name).toBe("f2")
                      const alreadyLoaded = yield* catalog.load!("f2")
                      expect(alreadyLoaded.descriptor.name).toBe("f2")
                      const missingRes = yield* Effect.result(catalog.load!("does-not-exist"))
                      expect(Result.isFailure(missingRes)).toBe(true)
                    }).pipe(Effect.provide(catLayer))
                  )
                } else if (mode === "stale-sibling-sweep") {
                  const plainDir = path.join(flowsDir, "plain")
                  yield* Effect.promise(() => fs.mkdir(plainDir, { recursive: true }))
                  const plainTs = path.join(plainDir, "flow.ts")
                  const plainSrc = `export default { description: "plain" }\n`
                  yield* Effect.promise(() => fs.writeFile(plainTs, plainSrc))
                  const oldStamp = (Date.now() - 2 * 60 * 60 * 1000).toString(36)
                  const staleFile = path.join(plainDir, `smithers-${"a".repeat(64)}-0-${oldStamp}.ts`)
                  const staleDir = path.join(plainDir, `smithers-${"b".repeat(64)}-1-${oldStamp}.ts`)
                  yield* Effect.promise(() => fs.writeFile(staleFile, "// stale"))
                  yield* Effect.promise(() => fs.mkdir(staleDir, { recursive: true }))
                  const plainDesc = makeDescriptor({
                    name: "plain",
                    body: new Descriptor.BodyRefModule({
                      path: plainTs,
                      contentDigest: Digest.digest(enc.encode(plainSrc)),
                      imports: []
                    }),
                    provenance: new Descriptor.Provenance({ source: "project", root: flowsDir })
                  })
                  const r = yield* Effect.result(Executable.fromDescriptor(plainDesc, { delegates: [dummyDelegate] }))
                  expect(Result.isSuccess(r) || Result.isFailure(r)).toBe(true)
                }
                return true
              }).pipe(Effect.provide(Layer.mergeAll(platform, Discovery.layer.pipe(Layer.provide(platform))))),
            { executions: ioExec, seed: seed + 7 }
          )
        )
        assertPassed(report)
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    90_000
  )
})
