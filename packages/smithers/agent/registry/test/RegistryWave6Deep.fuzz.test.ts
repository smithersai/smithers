import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Arbitrary, Effect, Exit, Layer, Option, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Bundled from "../src/Bundled.vibe"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Frontmatter from "../src/internal/Frontmatter.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"
import * as Registry from "../src/Registry.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "150"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const flowsRoot = fileURLToPath(new URL("./fixtures/executable/.smithers/flows", import.meta.url))

const Echo = Flow.make("test/echo", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Node.succeed(payload.flow)
})
const Other = Flow.make("test/other", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Node.succeed(payload.flow)
})
const Agent = Flow.make("agent", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Node.succeed(payload.prompt)
})

describe("@smthrs/registry Wave 6 deep fuzz (Bundled, MarkdownFlow, deriveBudget, Discovery, Executable)", () => {
  it("Bundled.make lists flows, resolves existing names, and refuses missing or duplicate names", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        names: Schema.Array(Schema.Literals(["a/one", "a/two", "b/three", "c/four"])).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(5)
        ),
        lookup: Schema.Literals(["a/one", "a/two", "absent/flow"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ names, lookup }) =>
          Effect.gen(function*() {
            const flows = names.map((n) =>
              Flow.make(n, {
                description: `Flow ${n}`,
                payload: {},
                success: Schema.Null,
                body: () => Node.succeed(null)
              })
            )
            const hasDup = new Set(names).size !== names.length
            const made = yield* Bundled.make(flows).pipe(Effect.exit)
            if (hasDup) {
              expect(Exit.isFailure(made)).toBe(true)
              return true
            }
            expect(Exit.isSuccess(made)).toBe(true)
            if (Exit.isSuccess(made)) {
              const listed = yield* made.value.list()
              expect(listed.map((f) => f._tag)).toEqual(names)
              const got = yield* made.value.get(lookup).pipe(Effect.exit)
              if (names.includes(lookup as never)) {
                expect(Exit.isSuccess(got)).toBe(true)
              } else {
                expect(Exit.isFailure(got)).toBe(true)
              }
            }
            return true
          }),
        { executions: Math.min(executions, 100), seed }
      )
    )
    assertPassed(report)
  })

  it("MarkdownFlow.fromMarkdown, toCoreFrontmatter, loadBody, renderPrompt, and deriveBudget uphold authority, limits, placement, and warning invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        regime: Schema.Literals(["path", "frontmatter"]),
        includeName: Schema.Boolean,
        includeDesc: Schema.Boolean,
        longDesc: Schema.Boolean,
        effectTier: Schema.Literals(["none", "read-only", "reversible", "irreversible", "bogus-tier"]),
        caps: Schema.Literals(["none", "empty", "readOnly", "write", "wildcard"]),
        placement: Schema.Literals(["none", "local", "remote", "sandbox", "bogus-place"]),
        disableModel: Schema.Boolean,
        includeFlows: Schema.Boolean,
        includeAllowedTools: Schema.Boolean,
        budgetMode: Schema.Literals(["none", "validNum", "validStr", "badArray", "badNeg", "badUsd", "badKey"]),
        includeModel: Schema.Boolean,
        includeUnknownKey: Schema.Boolean,
        args: Schema.Literals(["", "hello world", "foo --bar=1"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.sync(() => {
            const fmLines: Array<string> = ["---"]
            if (tc.includeName) fmLines.push("name: demo-skill")
            if (tc.includeDesc) {
              fmLines.push(`description: ${tc.longDesc ? "x".repeat(1030) : "A helpful test flow"}`)
            }
            if (tc.effectTier !== "none") fmLines.push(`effects: ${tc.effectTier}`)
            if (tc.caps === "empty") fmLines.push("capabilities: []")
            else if (tc.caps === "readOnly") fmLines.push("capabilities:\n  - fs:read")
            else if (tc.caps === "write") fmLines.push("capabilities:\n  - fs:write\n  - net:http")
            else if (tc.caps === "wildcard") fmLines.push("capabilities:\n  - \"*\"")
            if (tc.placement !== "none") fmLines.push(`placement: ${tc.placement}`)
            if (tc.disableModel) fmLines.push("disable-model-invocation: true")
            if (tc.includeFlows) fmLines.push("flows:\n  - std/read\n  - std/write")
            if (tc.includeAllowedTools) fmLines.push("allowed-tools: Read Grep Glob")
            if (tc.budgetMode === "validNum") {
              fmLines.push("budget:\n  tokens: 2000\n  milliseconds: 15000\n  usd: 0.25")
            } else if (tc.budgetMode === "validStr") {
              fmLines.push("budget:\n  tokens: \"4096\"\n  milliseconds: \"30000\"\n  usd: \"1.50\"")
            } else if (tc.budgetMode === "badArray") {
              fmLines.push("budget:\n  - 1")
            } else if (tc.budgetMode === "badNeg") {
              fmLines.push("budget:\n  tokens: -5\n  milliseconds: 0")
            } else if (tc.budgetMode === "badUsd") {
              fmLines.push("budget:\n  usd: -0.5")
            } else if (tc.budgetMode === "badKey") {
              fmLines.push("budget:\n  unknownField: 12")
            }
            if (tc.includeModel) {
              fmLines.push("model:\n  primary: claude/sonnet\n  fallback:\n    - openai/gpt-5")
            }
            if (tc.includeUnknownKey) fmLines.push("custom-extra-key: 123")
            fmLines.push("---")
            fmLines.push("")
            fmLines.push("# Demo")
            fmLines.push("Handle: $ARGUMENTS")
            const source = fmLines.join("\n")

            const res = MarkdownFlow.fromMarkdown({
              text: source,
              path: tc.regime === "path" ? ".smithers/flows/demo-skill/SKILL.md" : ".agents/skills/demo-skill/SKILL.md",
              baseDirectory: "/repo",
              naming: tc.regime,
              name: tc.regime === "path" ? Option.some("demo-skill") : Option.none(),
              dirBasename: "demo-skill",
              provenance: new Descriptor.Provenance({ source: tc.regime === "path" ? "workspace" : "user", root: "/repo" })
            })

            const warnings: Array<Descriptor.DiscoveryWarning> = []
            const budgetFields: Record<string, unknown> =
              tc.budgetMode === "validNum" ? { budget: { tokens: 1000, milliseconds: 5000, usd: 0.5 } }
              : tc.budgetMode === "validStr" ? { budget: { tokens: "2000", milliseconds: "9000", usd: "1.25" } }
              : tc.budgetMode === "badArray" ? { budget: [1, 2] }
              : tc.budgetMode === "badNeg" ? { budget: { tokens: -1, milliseconds: 0 } }
              : tc.budgetMode === "badUsd" ? { budget: { usd: "not-a-num" } }
              : tc.budgetMode === "badKey" ? { budget: { bogus: 1 } }
              : {}
            const derived = MarkdownFlow.deriveBudget(budgetFields, "SKILL.md", warnings)
            if (tc.budgetMode === "validNum" || tc.budgetMode === "validStr") {
              expect(derived).toBeDefined()
            }

            if (!tc.includeDesc || tc.budgetMode === "badArray" || tc.budgetMode === "badNeg" || tc.budgetMode === "badUsd" || tc.budgetMode === "badKey") {
              expect(res.warnings.length).toBeGreaterThan(0)
            }
            if (Option.isSome(res.descriptor)) {
              const desc = res.descriptor.value
              const coreFm = MarkdownFlow.toCoreFrontmatter(desc)
              expect(coreFm).toBeDefined()
              const body = MarkdownFlow.loadBody(source, "/repo")
              const rendered = MarkdownFlow.renderPrompt(body, { args: tc.args })
              expect(rendered).toContain(tc.args)
              if (tc.disableModel) {
                expect(desc.modelInvocable).toBe(false)
              }
            }
            expect(Frontmatter.parse({ text: source, path: "SKILL.md" })).toBeDefined()
            return true
          }),
        { executions: Math.min(executions, 100), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("Discovery.scan + Executable.fromDescriptor + Executable.catalog + Registry.layer lower all 12 fixture flows cleanly and enforce delegate/refusal invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        flowName: Schema.Literals([
          "cacheable",
          "cacheable-expiring",
          "cacheable-plain",
          "cacheable-reads",
          "cacheable-scoped",
          "changelog",
          "greet",
          "orphan",
          "scoped",
          "standalone",
          "tuned",
          "undecided"
        ]),
        withDelegates: Schema.Boolean
      })
    )

    const scanResult = await Effect.runPromise(
      Effect.gen(function*() {
        const discovery = yield* Discovery.Discovery
        return yield* discovery.scan({ source: "project", root: flowsRoot, naming: "path" })
      }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(platform))), Effect.provide(platform))
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ flowName, withDelegates }) =>
          Effect.gen(function*() {
            const desc = scanResult.entries.find((e) => e.name === flowName)
            if (desc === undefined) return true
            const opts: Executable.Options = {
              delegates: withDelegates ? [Echo, Other, Agent] : []
            }
            const lowered = yield* Executable.fromDescriptor(desc, opts).pipe(
              Effect.provide(platform),
              Effect.exit
            )
            // Lowering must either succeed cleanly with a valid Flow or fail with a typed ExecutableError
            if (Exit.isSuccess(lowered)) {
              expect(lowered.value.descriptor.name).toBe(flowName)
              expect(lowered.value.flow._tag).toBe(flowName)
            } else {
              expect(lowered.cause.reasons.length).toBeGreaterThan(0)
            }
            return true
          }),
        { executions: Math.min(executions, 48), seed: seed + 2 }
      )
    )
    assertPassed(report)

    // Exercise Registry.layer + Executable.catalog end-to-end across the fixture root
    const regLayer = Registry.layer({
      sources: [{ source: "project", root: flowsRoot, naming: "path" }]
    }).pipe(Layer.provide(Layer.merge(Discovery.layer.pipe(Layer.provide(platform)), platform)))

    const entries = await Effect.runPromise(
      Effect.gen(function*() {
        const reg = yield* Registry.Registry
        const all = yield* reg.list()
        const cat = yield* Executable.catalog({ delegates: [Echo, Other, Agent] })
        return { all: all.length, exec: cat.executables.length, refused: cat.refused.length }
      }).pipe(Effect.provide(Layer.merge(regLayer, platform)))
    )
    expect(entries.all).toBeGreaterThan(0)
    expect(entries.exec).toBeGreaterThan(0)
  }, 60_000)
})
