import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as LoadGuard from "../src/LoadGuard.ts"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, FileSystem, Layer, Logger, Option, Path, Result, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import * as NodeLoadGuard from "../src/node/NodeLoadGuard.ts"
import * as PromptJsx from "../src/Prompt/jsx-runtime.ts"
import {
  Descriptor,
  Disclosure,
  Discovery,
  Executable,
  ExecutionSnapshot,
  MarkdownFlow,
  Pack,
  Prompt,
  Registry
} from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/registry comprehensive markdown, disclosure, pack & filesystem discovery fuzz invariants", () => {
  it("MarkdownFlow.fromMarkdown, loadBody, renderPrompt, Disclosure.toXml & Descriptor digests obey escaping & determinism invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        name: Schema.Literals(["deploy", "review-pr", "a/b", "lint_code", "bad name!"]),
        desc: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(48))),
        body: Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
        args: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        naming: Schema.Literals(["path", "frontmatter"]),
        placement: Schema.Literals(["local", "client", "sandbox", "remote"]),
        modelInvocable: Schema.Boolean,
        deadline: Schema.Literals(["", "30s", "5m", "1h", "invalid", "0s"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ name, desc, body, args, naming, placement, modelInvocable, deadline }) =>
          Effect.sync(() => {
            const safeDesc = desc.replace(/[\r\n"\\]/g, " ").trim() || "desc"
            const safeBody = body.replace(/\r/g, "")
            const fmLines = [
              "---",
              `name: ${name}`,
              `description: "${safeDesc}"`,
              `placement: ${placement}`,
              `model-invocable: ${modelInvocable}`,
              ...(deadline ? [`budget:\n  deadline: ${deadline}`] : []),
              "---",
              `${safeBody}\nUse $ARGUMENTS here.`
            ]
            const text = fmLines.join("\n").replace(/[\uD800-\uDFFF]/g, "")
            const prov = new Descriptor.Provenance({
              source: "project",
              root: "/repo"
            })
            const res = MarkdownFlow.fromMarkdown({
              text,
              path: `/repo/.smithers/flows/${name.replace(/[^a-z0-9-]/g, "x")}/SKILL.md`,
              baseDirectory: "/repo/.smithers/flows",
              naming,
              name: naming === "path" ? Option.some(name) : Option.none(),
              dirBasename: name.replace(/[^a-z0-9-]/g, "x") || "flow",
              provenance: prov
            })

            if (Option.isSome(res.descriptor)) {
              const d = res.descriptor.value
              const dec1 = Descriptor.declarationDigest(d)
              const dec2 = Descriptor.declarationDigest(d)
              if (dec1 !== dec2 || dec1.length === 0) return false
              const ex1 = Descriptor.executionDigest(d)
              const ex2 = Descriptor.executionDigest(d)
              if (ex1 !== ex2) return false
              const entries = Disclosure.toEntries([d])
              const xml = Disclosure.toXml([d])
              if (entries.length > 0 && xml.length === 0) return false
              MarkdownFlow.toCoreFrontmatter(d)
            }

            const budgetWarnings: Array<Descriptor.DiscoveryWarning> = []
            MarkdownFlow.deriveBudget({ budget: deadline ? { deadline } : undefined }, "/repo/SKILL.md", budgetWarnings)

            const loaded = MarkdownFlow.loadBody(text, "/repo/.smithers/flows")
            const rendered = MarkdownFlow.renderPrompt(loaded, { args })
            if (!rendered.includes(args)) return false

            const ms = Descriptor.deadlineMillis(deadline)
            if (ms !== undefined && (!Number.isFinite(ms) || ms < 0)) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Pack.compatible, Pack.digest, Pack.Manifest & Prompt.compile obey semver, path-safety & order-independence invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        major: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
        minor: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 9 }))),
        patch: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 9 }))),
        op: Schema.Literals(["^", "~", ">=", "", "*", "invalid"]),
        relPath: Schema.Literals(["flows/a/SKILL.md", "../escape.md", "/abs.md", "a\\b.md", "a\0b.md", "flows/b/flow.ts"]),
        mdxText: Schema.Literals(["# Hello\n\nWorld", "Simple paragraph", "List:\n- one\n- two"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ major, minor, patch, op, relPath, mdxText }) =>
          Effect.gen(function*() {
            const ver = `${major}.${minor}.${patch}`
            const range = op === "*" ? "*" : op === "invalid" ? "not-a-semver" : `${op}${ver}`
            const compat = Pack.compatible(range, ver)
            if ((op === "^" || op === "~" || op === ">=" || op === "" || op === "*") && !compat) return false
            if (op === "invalid" && compat) return false

            const manifestRes = Schema.decodeUnknownResult(Pack.Manifest)({
              name: "fuzz-pack",
              version: ver,
              requires: { smithers: ">=0.1.0" },
              flows: [relPath]
            })
            const isBadPath = relPath.includes("..") || relPath.startsWith("/") || relPath.includes("\\") || relPath.includes("\0")
            if (isBadPath && Result.isSuccess(manifestRes)) return false
            if (Result.isSuccess(manifestRes)) {
              const filesA = [
                { path: "a.md", contents: "content-a" },
                { path: "b.md", contents: "content-b" }
              ]
              const filesB = [...filesA].reverse()
              if (Pack.digest(manifestRes.success, filesA) !== Pack.digest(manifestRes.success, filesB)) {
                return false
              }
            }

            const compiled = yield* Effect.result(Prompt.compile(mdxText))
            if (Result.isFailure(compiled) || compiled.success.length === 0) return false
            return true
          }),
        { seed: seed + 1, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Discovery + Registry discover flows on real filesystem, detect tampering via digest check, and support layerFromDescriptors/layerNoop", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        flowCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
        tamperAfterDiscover: Schema.Boolean,
        bodySeed: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ flowCount, tamperAfterDiscover, bodySeed }) =>
          Effect.gen(function*() {
            const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-fuzz-")))
            return yield* Effect.ensuring(
              Effect.gen(function*() {
                const flowsDir = path.join(root, ".smithers", "flows")
                // Also author a module flow (.ts) + helper module to exercise ModuleFlow, ModuleMetadata & ModuleClosure
                const modDir = path.join(flowsDir, "mod-flow")
                yield* Effect.promise(() => fs.mkdir(modDir, { recursive: true }))
                yield* Effect.promise(() =>
                  fs.writeFile(
                    path.join(modDir, "helper.ts"),
                    `export const label = "helper-${bodySeed}"\n`
                  )
                )
                yield* Effect.promise(() =>
                  fs.writeFile(
                    path.join(modDir, "flow.ts"),
                    `import { Flow } from "@smthrs/flow"\nimport { Schema } from "effect"\nimport { label } from "./helper.ts"\nexport default Flow.make("mod-flow", { description: "Module flow", capabilities: ["fs:read:**"], payload: { x: Schema.String }, success: Schema.String, body: () => ({} as never) })\n`
                  )
                )
                // Also author a local pack to exercise Pack.read / sources / merge / attribute
                const packDir = path.join(root, "pack-a")
                yield* Effect.promise(() => fs.mkdir(path.join(packDir, "flows", "pflow"), { recursive: true }))
                yield* Effect.promise(() =>
                  fs.writeFile(
                    path.join(packDir, "pack.json"),
                    JSON.stringify({ name: "fuzz-pack", version: "1.0.0", requires: { smithers: ">=0.1.0" }, flows: ["flows/pflow/SKILL.md"] })
                  )
                )
                yield* Effect.promise(() =>
                  fs.writeFile(
                    path.join(packDir, "flows", "pflow", "SKILL.md"),
                    `---\nname: pflow\ndescription: "Pack flow"\n---\nPack body ${bodySeed}\n`
                  )
                )
                for (let i = 0; i < flowCount; i++) {
                  const fname = `flow-${i}`
                  const fdir = path.join(flowsDir, fname)
                  yield* Effect.promise(() => fs.mkdir(fdir, { recursive: true }))
                  yield* Effect.promise(() =>
                    fs.writeFile(
                      path.join(fdir, "SKILL.md"),
                      `---\nname: ${fname}\ndescription: "Fuzz flow ${i}"\n---\nBody ${bodySeed}-${i}\n`
                    )
                  )
                }

                const regLayer = Registry.layerProject({ root }).pipe(
                  Layer.provide(Discovery.layer),
                  Layer.provide(NodeFileSystem.layer),
                  Layer.provide(NodePath.layer),
                  Layer.provide(Logger.layer([]))
                )

                return yield* Effect.gen(function*() {
                  const reg = yield* Registry.Registry
                  const all = yield* reg.list()
                  if (all.length !== flowCount + 1) return false
                  const packCheck = yield* Effect.gen(function*() {
                    const fsSvc = yield* FileSystem.FileSystem
                    const pathSvc = yield* Path.Path
                    const pr = yield* Pack.read(fsSvc, pathSvc, packDir)
                    const installed: Pack.Installed = { manifest: pr.manifest, dir: pr.dir, origin: "local" }
                    yield* Pack.checkCompatible(installed, pathSvc, "1.0.0")
                    const srcs = yield* Pack.sources(installed, pathSvc)
                    return srcs.length > 0
                  }).pipe(
                    Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
                  )
                  if (!packCheck) return false
                  const first = all.find((d) => d.name === "flow-0") ?? all[0]!
                  const got = yield* reg.get(first.name)
                  if (got.name !== first.name) return false

                  if (tamperAfterDiscover) {
                    const targetFile = path.join(flowsDir, first.name, "SKILL.md")
                    yield* Effect.promise(() => fs.writeFile(targetFile, "---\nname: tampered\ndescription: x\n---\nTAMPERED"))
                    const loadRes = yield* Effect.result(reg.loadBody(first.name))
                    if (Result.isSuccess(loadRes)) return false
                  } else {
                    const loaded = yield* reg.loadBody(first.name)
                    if (loaded._tag !== "Prompt" || !loaded.text.includes(`Body ${bodySeed}`)) return false
                  }

                  const memReg = yield* Effect.provide(
                    Registry.Registry,
                    Registry.layerFromDescriptors(all).pipe(
                      Layer.provide(NodeFileSystem.layer),
                      Layer.provide(NodePath.layer)
                    )
                  )
                  if ((yield* memReg.list()).length !== flowCount + 1) return false
                  const noopReg = yield* Effect.provide(Registry.Registry, Registry.layerNoop())
                  if ((yield* noopReg.list()).length !== 0) return false
                  return true
                }).pipe(Effect.provide(regLayer))
              }),
              Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
            )
          }),
        { seed: seed + 2, executions: Math.min(executions, 25) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Prompt JSX runtime, Executable lowering/catalog, ExecutionSnapshot & NodeLoadGuard uphold invariants", async () => {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-exec-fuzz-")))
    const Echo = Flow.make("test/echo", {
      payload: Executable.Invocation,
      success: Schema.String,
      body: (payload) => Node.succeed(payload.flow)
    })
    const Agent = Flow.make("agent", {
      payload: Executable.Invocation,
      success: Schema.String,
      body: (payload) => Node.succeed(payload.prompt)
    })
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          heading: Schema.Literals(["h1", "h2", "h3", "h6"]),
          text: Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
          href: Schema.Literals(["https://example.com/a b(c)<d>", "https://smithers.sh", ""]),
          codeLang: Schema.Literals(["ts", "sh", ""]),
          codeTick: Schema.Literals(["plain", "`backtick`", "```triple```", " padded "]),
          listTag: Schema.Literals(["ul", "ol"]),
          flowName: Schema.Literals(["hello", "review-pr", "triage"]),
          useExplicitDelegate: Schema.Boolean,
          withArgs: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ heading, text, href, codeLang, codeTick, listTag, flowName, useExplicitDelegate, withArgs }) =>
            Effect.gen(function*() {
              const clean = text.replace(/[\uD800-\uDFFF]/g, "x")
              const doc = PromptJsx.jsx(PromptJsx.Fragment, {
                children: [
                  PromptJsx.jsx(heading, { children: clean }),
                  "\n",
                  PromptJsx.jsxs("p", {
                    children: [
                      PromptJsx.jsx("strong", { children: clean }),
                      " ",
                      PromptJsx.jsx("em", { children: clean }),
                      " ",
                      PromptJsx.jsx("del", { children: clean }),
                      PromptJsx.jsx("br", {}),
                      PromptJsx.jsx("a", { href, title: "tip", children: "link" }),
                      PromptJsx.jsx("img", { src: href, alt: "[alt]\\x", title: "pic" }),
                      PromptJsx.jsx("code", { children: codeTick })
                    ]
                  }),
                  PromptJsx.jsx("hr", {}),
                  PromptJsx.jsx("blockquote", { children: clean + "\nline2" }),
                  PromptJsx.jsx("pre", {
                    children: PromptJsx.jsx("code", {
                      className: codeLang ? "language-" + codeLang : undefined,
                      children: codeTick
                    })
                  }),
                  PromptJsx.jsx(listTag, {
                    start: 3,
                    children: [
                      PromptJsx.jsx("li", {
                        children: [
                          "item1",
                          PromptJsx.jsx("ul", { children: [PromptJsx.jsx("li", { children: "nested" })] })
                        ]
                      }),
                      PromptJsx.jsx("li", { children: ["item2", null, false, 42] })
                    ]
                  })
                ]
              })
              const rendered = PromptJsx.render(doc)
              if (rendered.length === 0 || !rendered.includes("---")) return false
              if (rendered !== PromptJsx.render(doc)) return false
              if (!rendered.includes("[link](") || rendered.includes("](" + href + " ") && /[\s<>()]/.test(href)) return false

              const fnComp = (p: PromptJsx.Props): PromptJsx.Content =>
                PromptJsx.jsx("blockquote", { children: p.children })
              const compOut = PromptJsx.render(PromptJsx.jsx(fnComp, { children: clean }))
              if (!compOut.startsWith(">")) return false

              const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpRoot, "r-")))
              try {
                const flowDir = path.join(dir, ".smithers", "flows", flowName)
                yield* Effect.promise(() => fs.mkdir(flowDir, { recursive: true }))
                const mdPath = path.join(flowDir, "SKILL.md")
                const mdText = [
                  "---",
                  `name: ${flowName}`,
                  `description: "Run ${flowName}"`,
                  ...(useExplicitDelegate ? ["flows: [test/echo]"] : []),
                  "---",
                  withArgs ? "Do $ARGUMENTS now." : "Run cleanly."
                ].join("\n")
                yield* Effect.promise(() => fs.writeFile(mdPath, mdText))

                const spec = Executable.fileSpecifier(mdPath)
                if (!spec.startsWith("file://")) return false

                const regLayer = Registry.layerProject({ root: dir }).pipe(
                  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer))
                )
                const execOpts: Executable.Options = { delegates: [Echo, Agent] }
                const cat = yield* Executable.catalog(execOpts).pipe(Effect.provide(regLayer))
                if (cat.executables.length !== 1 || cat.refused.length !== 0) return false

                const fromReg = yield* Executable.fromRegistry(flowName, execOpts).pipe(Effect.provide(regLayer))
                const expectedDelegate = useExplicitDelegate ? "test/echo" : "agent"
                if (fromReg.descriptor.name !== flowName || fromReg.delegate !== expectedDelegate) return false

                const fromDesc = yield* Executable.fromDescriptor(fromReg.descriptor, execOpts)
                if (fromDesc.descriptor.name !== flowName) return false

                // Unknown delegate must be refused cleanly
                const badRes = yield* Executable.fromDescriptor(fromReg.descriptor, { delegates: [] }).pipe(Effect.result)
                if (Result.isSuccess(badRes)) return false

                // ExecutionSnapshot filesystem store
                const snapSvc = yield* ExecutionSnapshot.makeFileSystem({ root: path.join(dir, ".snaps") })
                if (snapSvc === undefined) return false

                // NodeLoadGuard rejects unconsulted registerHooks cleanly
                let registered = 0
                const guardRes = yield* Effect.scoped(
                  Effect.gen(function*() {
                    const guardOpt = yield* Effect.serviceOption(LoadGuard.LoadGuard)
                    if (Option.isNone(guardOpt)) return undefined
                    return yield* guardOpt.value.protect(dir).pipe(Effect.result)
                  }).pipe(
                    Effect.provide(
                      NodeLoadGuard.layerWith(() => {
                        registered++
                      })
                    )
                  )
                )
                if (registered !== 1 || guardRes === undefined || Result.isSuccess(guardRes)) return false
                return true
              } finally {
                yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
              }
            }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer, Logger.layer([])))),
          { seed: seed + 10, executions: Math.min(executions, 25) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
