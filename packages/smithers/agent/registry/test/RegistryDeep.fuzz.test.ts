import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ArtifactStore } from "@smthrs/artifacts"
import { Flow } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import { Arbitrary, Context, Effect, Layer, Option, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import * as Authority from "../src/internal/Authority.ts"
import * as LoadGuard from "../src/LoadGuard.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"
import * as NodeLoadGuard from "../src/node/NodeLoadGuard.ts"
import * as Registry from "../src/Registry.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const Platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)

describe("@smthrs/registry Authority, MarkdownFlow, NodeLoadGuard, ExecutionSnapshot & Executable deep fuzz invariants", () => {
  it("Authority.inferEffectTier, projectEffects & narrowDelegation fail closed on escape paths, env vars, wildcards & under-classification", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        capKind: Schema.Literals([
          "read",
          "grep",
          "fs:write:out/report.txt",
          "fs:write:a/b/../c.txt",
          "fs:write:../escape.txt",
          "fs:write:/etc/passwd",
          "fs:write:~/secret",
          "fs:write:out/$HOME/x",
          "fs:write:out/%USERPROFILE%/x",
          "fs:write:file:///tmp/x",
          "fs:write:C:/Windows/System32",
          "bash",
          "*"
        ]),
        grantMode: Schema.Literals(["wildcard", "subset", "empty"]),
        declMode: Schema.Literals(["none", "unreadable", "valid_exclusive", "invalid_mode", "invalid_conflict", "invalid_tier", "under_classified", "unreadable_members"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ capKind, grantMode, declMode }) =>
          Effect.sync(() => {
            const tier = Authority.inferEffectTier([capKind])
            if (capKind === "read" || capKind === "grep") {
              if (tier !== "sealed") return false
            } else if (capKind === "fs:write:out/report.txt" || capKind === "fs:write:a/b/../c.txt") {
              if (tier !== "compensable") return false
            } else {
              if (tier !== "irreversible") return false
            }

            if (Authority.maxTier("sealed", tier) !== tier) return false
            if (Authority.maxTier("irreversible", tier) !== "irreversible") return false

            const declared = [capKind, "read"]
            const grant = grantMode === "wildcard" ? ["*"] : grantMode === "subset" ? ["read"] : []
            const narrowed = Authority.narrowDelegation(grant, declared)
            for (const c of narrowed) {
              if (!declared.includes(c)) return false
              if (grantMode !== "wildcard" && !grant.includes(c)) return false
            }

            const declaration: Authority.DeclaredEffects | "unreadable" | undefined =
              declMode === "none"
                ? undefined
                : declMode === "unreadable"
                  ? "unreadable"
                  : declMode === "valid_exclusive"
                    ? { reads: ["src"], writes: ["out"], mode: "exclusive", onConflict: "queue", tier: "irreversible" }
                    : declMode === "invalid_mode"
                      ? { reads: ["src"], writes: ["out"], mode: "bogus", onConflict: "queue", tier: undefined }
                      : declMode === "invalid_conflict"
                        ? { reads: ["src"], writes: ["out"], mode: "exclusive", onConflict: "bogus", tier: undefined }
                        : declMode === "invalid_tier"
                          ? { reads: ["src"], writes: ["out"], mode: "exclusive", onConflict: "queue", tier: "bogus" }
                          : declMode === "under_classified"
                            ? { reads: ["src"], writes: ["out"], mode: "exclusive", onConflict: "queue", tier: "sealed" }
                            : { reads: "unreadable", writes: "unreadable", mode: undefined, onConflict: undefined, tier: undefined }

            const projected = Authority.projectEffects({ capabilities: [capKind], declaration })
            const order = { sealed: 0, compensable: 1, irreversible: 2 } as const
            if (order[projected.effects.tier] < order[tier]) return false
            if (declMode === "unreadable" && !projected.problems.some((p) => p._tag === "unreadableDeclaration")) {
              return false
            }
            if (declMode === "invalid_mode" && !projected.problems.some((p) => p._tag === "invalidMode")) {
              return false
            }
            if (declMode === "invalid_conflict" && !projected.problems.some((p) => p._tag === "invalidOnConflict")) {
              return false
            }
            if (declMode === "invalid_tier" && !projected.problems.some((p) => p._tag === "invalidTier")) {
              return false
            }
            if (declMode === "under_classified" && tier !== "sealed" && !projected.problems.some((p) => p._tag === "underClassifiedTier")) {
              return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("MarkdownFlow.fromMarkdown, deriveBudget, loadBody, renderPrompt & toCoreFrontmatter validate budgets and render prompts safely", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        name: Schema.Literals(["review", "triage", "summarize", "deploy-check"]),
        tokens: Schema.Literals(["1000", "0", "-5", "abc", "50000"]),
        ms: Schema.Literals(["5000", "-1", "notnum"]),
        usd: Schema.Literals(["0.5", "0", "-2", "1.25"]),
        args: Schema.String.check(Schema.isMaxLength(40)),
        hasCapabilities: Schema.Boolean,
        badBudgetType: Schema.Boolean,
        naming: Schema.Literals(["path", "frontmatter"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ name, tokens, ms, usd, args, hasCapabilities, badBudgetType, naming }) =>
          Effect.sync(() => {
            const warnings: Parameters<typeof MarkdownFlow.deriveBudget>[2] = []
            const budgetFields: Record<string, unknown> = badBudgetType
              ? { budget: "not-an-object" }
              : { budget: { tokens, milliseconds: ms, usd } }
            const derived = MarkdownFlow.deriveBudget(budgetFields, `/repo/.smithers/flows/${name}/SKILL.md`, warnings)
            if (badBudgetType && (derived !== undefined || warnings.length === 0)) return false

            const md = [
              "---",
              `name: ${name}`,
              `description: Fuzz flow ${name}`,
              ...(hasCapabilities ? ["capabilities:", "  - read", "  - fs:write:out/summary.md"] : []),
              "budget:",
              "  tokens: 2048",
              "  milliseconds: 10000",
              "  usd: 0.25",
              "---",
              "Analyze: $ARGUMENTS"
            ].join("\n")
            const parsed = MarkdownFlow.fromMarkdown({
              text: md,
              path: `/repo/.smithers/flows/${name}/SKILL.md`,
              baseDirectory: `/repo/.smithers/flows/${name}`,
              naming,
              name: Option.some(name),
              dirBasename: name,
              provenance: { source: "project", root: "/repo/.smithers/flows" }
            })
            if (Option.isNone(parsed.descriptor)) return false
            if (parsed.descriptor.value.name !== name) return false
            const coreFm = MarkdownFlow.toCoreFrontmatter(parsed.descriptor.value)
            if (typeof coreFm !== "object" || coreFm === null) return false

            const body = MarkdownFlow.loadBody("Hello $ARGUMENTS!", "/repo")
            const rendered = MarkdownFlow.renderPrompt(body, { args })
            if (!rendered.includes(args)) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("NodeLoadGuard.layerWith refuses unmeasured loads inside protected root, allows permitted/node_modules/external loads, and fails when hooks are ignored", async () => {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smthrs-nlg-fuzz-")))
    const rootDir = path.join(tmpBase, "flows")
    const measuredFile = path.join(rootDir, "measured.mjs")
    const unmeasuredFile = path.join(rootDir, "unmeasured.mjs")
    const nmFile = path.join(rootDir, "node_modules", "pkg", "index.mjs")
    const outsideFile = path.join(tmpBase, "outside.mjs")
    fs.mkdirSync(path.dirname(nmFile), { recursive: true })
    fs.writeFileSync(measuredFile, "export const x = 1\n")
    fs.writeFileSync(unmeasuredFile, "export const x = 2\n")
    fs.writeFileSync(nmFile, "export const x = 3\n")
    fs.writeFileSync(outsideFile, "export const x = 4\n")

    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          target: Schema.Literals(["measured", "unmeasured", "node_modules", "outside", "builtin"]),
          hookIgnored: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ target, hookIgnored }) =>
            Effect.gen(function*() {
              let capturedResolve: Parameters<NodeLoadGuard.RegisterHooks>[0]["resolve"] | undefined
              const fakeRegister: NodeLoadGuard.RegisterHooks = (hooks) => {
                capturedResolve = hooks.resolve
                if (!hookIgnored) {
                  hooks.resolve("node:module", {}, (s) => ({ url: s }))
                }
              }
              const layer = NodeLoadGuard.layerWith(fakeRegister)
              const exit = yield* Effect.exit(
                Effect.scoped(
                  Effect.gen(function*() {
                    const guard = yield* LoadGuard.LoadGuard
                    yield* guard.protect(rootDir)
                    yield* guard.permit(measuredFile)
                    const fileToLoad =
                      target === "measured"
                        ? measuredFile
                        : target === "unmeasured"
                          ? unmeasuredFile
                          : target === "node_modules"
                            ? nmFile
                            : target === "outside"
                              ? outsideFile
                              : "node:fs"
                    const url = target === "builtin" ? "node:fs" : pathToFileURL(fileToLoad).href
                    let threwUnmeasured = false
                    try {
                      capturedResolve!(fileToLoad, {}, () => ({ url }))
                    } catch (err) {
                      if (err instanceof LoadGuard.UnmeasuredLoadError) threwUnmeasured = true
                      else throw err
                    }
                    return threwUnmeasured
                  })
                ).pipe(Effect.provide(layer as Layer.Layer<LoadGuard.LoadGuard>))
              )
              if (hookIgnored) {
                return exit._tag === "Failure"
              }
              if (exit._tag !== "Success") return false
              return exit.value === (target === "unmeasured")
            }),
          { seed: seed + 2, executions: Math.min(executions, 40) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("ExecutionSnapshot.makeFileSystem & Executable (fromDescriptor, lower, delegateOf, catalog, fromRegistry) pin/restore snapshots and uphold fail-closed refusals", async () => {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "smthrs-reg-deep-")))
    const codeFlowImpl = Flow.make("alpha", {
      description: "Alpha code flow",
      payload: { x: Schema.Number },
      success: Schema.Number,
      body: ({ x }) => Node.succeed(x + 1)
    })
    const delegateFlow = Flow.make("agent", {
      description: "Test delegate agent",
      payload: Executable.Invocation,
      success: Schema.String,
      body: () => Node.succeed("ok")
    })

    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          flowKind: Schema.Literals(["markdown", "code"]),
          withArtifactStore: Schema.Boolean,
          hasDelegate: Schema.Boolean,
          badModule: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ flowKind, withArtifactStore, hasDelegate, badModule }) =>
            Effect.scoped(
              Effect.gen(function*() {
                const repoDir = fs.mkdtempSync(path.join(tmpBase, "repo-"))
                try {
                  const flowsRoot = path.join(repoDir, ".smithers", "flows")
                  const flowDir = path.join(flowsRoot, "alpha")
                  fs.mkdirSync(flowDir, { recursive: true })
                  if (flowKind === "markdown") {
                    fs.writeFileSync(
                      path.join(flowDir, "SKILL.md"),
                      "---\nname: alpha\ndescription: Alpha md flow\ncapabilities:\n  - read\n---\nRun $ARGUMENTS\n"
                    )
                  } else {
                    fs.writeFileSync(path.join(flowDir, "helper.ts"), `export const delta = 1\n`)
                    fs.writeFileSync(
                      path.join(flowDir, "flow.ts"),
                      `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nimport { delta } from "./helper.ts"\nexport default Flow.make("alpha", { description: "Alpha code flow", capabilities: ["read"], effects: { reads: [], writes: [], mode: "concurrent", onConflict: "allow", tier: "sealed" }, payload: Schema.Struct({ x: Schema.Number }), success: Schema.Number, body: Node.capture({}, ({ x }) => Node.succeed(x + delta)) })\n`
                    )
                  }

                  const discovery = yield* Discovery.Discovery
                  const scanned = yield* discovery.scan({ source: "project", root: flowsRoot, naming: "path" })
                  const desc = scanned.entries.find((e) => e.name === "alpha")
                  if (desc === undefined) return false

                  const lowered = Executable.lower(desc, Context.empty())
                  if (typeof lowered !== "object" || lowered === null) return false

                  const spec = Executable.fileSpecifier(path.join(flowDir, flowKind === "markdown" ? "SKILL.md" : "flow.ts"))
                  if (!spec.startsWith("file://")) return false

                  const options: Executable.Options = {
                    delegates: hasDelegate ? [delegateFlow] : [],
                    load: () =>
                      badModule
                        ? Effect.succeed({ default: "not-a-flow" })
                        : Effect.succeed({ default: codeFlowImpl })
                  }

                  const execExit = yield* Effect.exit(Executable.fromDescriptor(desc, options))
                  if (flowKind === "markdown" && !hasDelegate) {
                    if (execExit._tag !== "Failure") return false
                    return true
                  }
                  if (flowKind === "code" && badModule) {
                    if (execExit._tag !== "Failure") return false
                    return true
                  }
                  if (execExit._tag !== "Success") return false
                  const exec = execExit.value

                  const digest = Descriptor.executionDigest(exec.descriptor)
                  if (digest === undefined) return false

                  // Pin & restore with both plain filesystem and ArtifactStore CAS backing
                  const store = withArtifactStore ? ArtifactStore.makeMemory() : undefined
                  const snapSvc = yield* ExecutionSnapshot.makeFileSystem({
                    root: path.join(repoDir, ".snap"),
                    ...(store === undefined ? {} : { store })
                  })
                  yield* snapSvc.pin(exec)
                  const roots = yield* snapSvc.roots([digest])
                  if (!Array.isArray(roots)) return false
                  const restored = yield* snapSvc.restore(digest)
                  if (restored.descriptor.name !== "alpha") return false
                  const fetchedDesc = yield* snapSvc.descriptor(digest)
                  if (fetchedDesc.name !== "alpha") return false

                  // Unknown digest must fail closed
                  const missingExit = yield* Effect.exit(snapSvc.restore("0".repeat(64)))
                  if (missingExit._tag !== "Failure") return false

                  // Executable.catalog (eager + deferred) & Executable.fromRegistry parity
                  const regLayer = Registry.layerProject({ root: repoDir }).pipe(
                    Layer.provide(Discovery.layer.pipe(Layer.provideMerge(Platform)))
                  )
                  const cat = yield* Executable.catalog(options).pipe(Effect.provide(regLayer))
                  if (cat.executables.length !== 1 || cat.refused.length !== 0) return false
                  const deferredCat = yield* Executable.catalog({ ...options, initialFlows: [] }).pipe(Effect.provide(regLayer))
                  if ((deferredCat.deferred ?? []).length !== 1) return false
                  const fromReg = yield* Executable.fromRegistry("alpha", options).pipe(Effect.provide(regLayer))
                  if (fromReg.descriptor.name !== "alpha") return false
                  return true
                } finally {
                  fs.rmSync(repoDir, { recursive: true, force: true })
                }
              }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provideMerge(Platform))))
            ),
          { seed: seed + 3, executions: Math.min(executions, 20) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  }, 60_000)
})
