import * as DurableFlow from "@smthrs/flow/Flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Context, Effect, Logger, Option, Result, Schema } from "effect"
import { Sha256 } from "@smthrs/crypto"
import { describe, expect, it } from "vitest"
import * as Core from "../src/index.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "150"))
const pureExecutions = Math.max(24, Math.min(baseExecutions, 200))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(
      arb,
      (value) => predicate(value).pipe(Effect.provide(silentLogger)),
      options
    )
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const CustomService = Context.Service<string>("flows/core/fuzz/Custom")
const RefService = Context.Reference<number>("flows/core/fuzz/Ref", { defaultValue: () => 42 })

const SafeNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]{0,12}(?:-[a-z0-9]{1,8}){0,3}$/)
)

const PlacementNameSchema = Schema.Literals(["sandbox", "remote", "client", "local"])
const ModeSchema = Schema.Literals(["hermetic", "expected"])
const ConflictSchema = Schema.Literals(["serialize", "fail", "lane"])
const TierSchema = Schema.Literals(["sealed", "compensable", "irreversible"])

const CoreMarkdownInput = Schema.Struct({
  name: SafeNameSchema,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  modelKind: Schema.Literals(["none", "single", "tuple"]),
  modelA: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  modelB: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  flows: Schema.Array(SafeNameSchema).check(Schema.isMaxLength(4)),
  capKind: Schema.Literals(["undefined", "empty", "list"]),
  capabilities: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))).check(
    Schema.isMaxLength(5)
  ),
  hasEffects: Schema.Boolean,
  reads: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))).check(
    Schema.isMaxLength(3)
  ),
  writes: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16))).check(
    Schema.isMaxLength(3)
  ),
  mode: Schema.optional(ModeSchema),
  onConflict: Schema.optional(ConflictSchema),
  tier: Schema.optional(TierSchema),
  placement: Schema.optional(PlacementNameSchema),
  modelInvocable: Schema.optional(Schema.Boolean),
  hasBudget: Schema.Boolean,
  budgetTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100_000))),
  budgetMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100_000))),
  budgetUsd: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100))),
  onExceeded: Schema.optional(Core.Markdown.BudgetOnExceeded),
  hasDeadline: Schema.Boolean,
  deadlineMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(60_000)),
  hasSandbox: Schema.Boolean,
  sandbox: Core.Markdown.SandboxSelection,
  body: Schema.String.check(Schema.isMaxLength(120))
})

describe("@smthrs/core fuzz", () => {
  it("fuzzes Annotations add/merge/getOption and built-in keys", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        p1: Schema.Int.check(Schema.isBetween({ minimum: -1000, maximum: 1000 })),
        p2: Schema.Int.check(Schema.isBetween({ minimum: -1000, maximum: 1000 })),
        c1: Schema.String.check(Schema.isMaxLength(30)),
        c2: Schema.String.check(Schema.isMaxLength(30)),
        refVal: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
        placement: PlacementNameSchema
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          expect(Option.isNone(Core.Annotations.getOption(Core.Annotations.empty, Core.Annotations.Priority))).toBe(true)
          expect(Option.getOrUndefined(Core.Annotations.getOption(Core.Annotations.empty, RefService))).toBe(42)

          const placementVal = v.placement === "sandbox"
            ? Core.Placement.sandbox()
            : v.placement === "remote"
            ? Core.Placement.remote()
            : v.placement === "client"
            ? Core.Placement.client()
            : Core.Placement.local()

          const parent = Core.Annotations.add(
            Core.Annotations.add(
              Core.Annotations.add(Core.Annotations.empty, Core.Annotations.Priority, v.p1) as Context.Context<never>,
              CustomService,
              v.c1
            ) as Context.Context<never>,
            Core.Annotations.Placement,
            placementVal
          ) as Context.Context<never>
          const child = Core.Annotations.add(
            Core.Annotations.add(
              Core.Annotations.add(Core.Annotations.empty, Core.Annotations.Priority, v.p2) as Context.Context<never>,
              RefService,
              v.refVal
            ) as Context.Context<never>,
            Core.Annotations.Effects,
            Core.Effects.make({ reads: [], writes: [], mode: "hermetic", onConflict: "serialize" })
          ) as Context.Context<never>
          const merged = Core.Annotations.merge(parent, child)

          expect(Option.getOrUndefined(Core.Annotations.getOption(parent, Core.Annotations.Priority))).toBe(v.p1)
          expect(Option.getOrUndefined(Core.Annotations.getOption(merged, Core.Annotations.Priority))).toBe(v.p2)
          expect(Option.getOrUndefined(Core.Annotations.getOption(merged, CustomService))).toBe(v.c1)
          expect(Option.getOrUndefined(Core.Annotations.getOption(merged, RefService))).toBe(v.refVal)
          expect(Option.isSome(Core.Annotations.getOption(merged, Core.Annotations.Placement))).toBe(true)
          expect(Option.isSome(Core.Annotations.getOption(merged, Core.Annotations.Effects))).toBe(true)
          return true
        }),
      { seed: seed + 1, executions: pureExecutions }
    )
  })

  it("fuzzes Digest.digest, Digest.provideSync, and Digest.canonical", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        text: Schema.String.check(Schema.isPattern(/^[\x09\x0a\x0d\x20-\x7e]{0,200}$/)),
        a: Schema.Int.check(Schema.isBetween({ minimum: -10000, maximum: 10000 })),
        b: Schema.String.check(Schema.isPattern(/^[\x20-\x7e]{0,40}$/)),
        c: Schema.Boolean,
        badKind: Schema.Literals(["undefined", "nan", "inf", "bigint", "symbol", "fn", "cycle"])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const hexStr = Core.Digest.digest(v.text)
          const bytes = new TextEncoder().encode(v.text)
          const hexBytes = Core.Digest.digest(bytes)
          expect(hexStr).toBe(hexBytes)
          expect(hexStr).toMatch(/^[0-9a-f]{64}$/)

          const svcHex = yield* Core.Digest.provideSync(Schema.decodeUnknownEffect(Sha256)(v.text))
          expect(svcHex).toBe(hexStr)

          const canon1 = Core.Digest.canonical({ z: v.a, a: v.b, m: v.c })
          const canon2 = Core.Digest.canonical({ a: v.b, m: v.c, z: v.a })
          expect(canon1).toBe(canon2)

          let badVal: unknown
          if (v.badKind === "undefined") badVal = undefined
          else if (v.badKind === "nan") badVal = Number.NaN
          else if (v.badKind === "inf") badVal = Number.POSITIVE_INFINITY
          else if (v.badKind === "bigint") badVal = BigInt(v.a)
          else if (v.badKind === "symbol") badVal = Symbol("x")
          else if (v.badKind === "fn") badVal = () => 1
          else {
            const cyc: Record<string, unknown> = {}
            cyc.self = cyc
            badVal = cyc
          }
          expect(() => Core.Digest.canonical(badVal)).toThrow()
          expect(() => Core.Digest.canonical("\ud800")).toThrow()
          expect(() => Core.Digest.digest("\ud800")).toThrow()
          return true
        }),
      { seed: seed + 2, executions: pureExecutions }
    )
  })

  it("fuzzes Effects and Placement re-exports", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        readsA: Schema.Array(SafeNameSchema).check(Schema.isMaxLength(4)),
        writesA: Schema.Array(SafeNameSchema).check(Schema.isMaxLength(4)),
        readsB: Schema.Array(SafeNameSchema).check(Schema.isMaxLength(4)),
        writesB: Schema.Array(SafeNameSchema).check(Schema.isMaxLength(4)),
        mode: ModeSchema,
        onConflict: ConflictSchema,
        tier: TierSchema,
        label: SafeNameSchema
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          const a = Core.Effects.make({
            reads: v.readsA,
            writes: v.writesA,
            mode: v.mode,
            onConflict: v.onConflict,
            tier: v.tier
          })
          const b = Core.Effects.make({
            reads: v.readsB,
            writes: v.writesB,
            mode: v.mode,
            onConflict: v.onConflict,
            tier: v.tier
          })
          const sealedA = Core.Effects.sealed(a)
          expect(sealedA.tier).toBe("sealed")
          expect(sealedA.mode).toBe("hermetic")
          expect(Core.Effects.covers(`${v.label}/*`, `${v.label}/child`)).toBe(true)
          expect(Core.Effects.covers(v.label, v.label)).toBe(true)
          expect(Core.Effects.covers(`${v.label}/*`, `${v.label}/../escape`)).toBe(false)
          expect(Array.isArray(Core.Effects.overlaps(a, b))).toBe(true)
          expect(Array.isArray(Core.Effects.overlaps(sealedA, a))).toBe(true)
          const narrowed = Core.Effects.narrow(a, b)
          expect(narrowed).toBeDefined()

          const placements = [
            Core.Placement.local(),
            Core.Placement.client(),
            Core.Placement.remote(),
            Core.Placement.sandbox(),
            Core.Placement.sandbox({ image: v.label })
          ]
          for (const p of placements) {
            expect(p).toBeDefined()
          }
          return true
        }),
      { seed: seed + 3, executions: pureExecutions }
    )
  })

  it("fuzzes lowerMarkdown valid options, Flow combinators, Graph.build, and KeyMaterial", async () => {
    const arb = Arbitrary.schema(CoreMarkdownInput)

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const budget = v.hasBudget
            ? {
              ...(v.budgetTokens !== undefined ? { tokens: v.budgetTokens } : { tokens: 100 }),
              ...(v.budgetMs !== undefined ? { milliseconds: v.budgetMs } : {}),
              ...(v.budgetUsd !== undefined ? { usd: v.budgetUsd } : {}),
              ...(v.onExceeded !== undefined ? { onExceeded: v.onExceeded } : {})
            }
            : undefined
          const placement = v.hasSandbox
            ? (v.placement === "sandbox" ? "sandbox" : undefined)
            : v.placement
          const model = v.modelKind === "none"
            ? undefined
            : v.modelKind === "single"
            ? v.modelA
            : ([v.modelA, v.modelB] as readonly [string, ...Array<string>])
          const capsInput = v.capKind === "undefined"
            ? undefined
            : v.capKind === "empty"
            ? []
            : [...v.capabilities]
          const flowsInput = [...v.flows]

          const lowered = Core.Markdown.lowerMarkdown(
            {
              name: v.name,
              description: v.description,
              model,
              flows: flowsInput,
              capabilities: capsInput,
              effects: v.hasEffects
                ? {
                  reads: v.reads,
                  writes: v.writes,
                  mode: v.mode,
                  onConflict: v.onConflict,
                  tier: v.tier
                }
                : undefined,
              placement,
              modelInvocable: v.modelInvocable,
              budget,
              deadline: v.hasDeadline ? v.deadlineMs : undefined,
              sandbox: v.hasSandbox ? v.sandbox : undefined
            },
            v.body
          )

          expect(Core.Flow.isFlow(lowered)).toBe(true)
          expect(Core.Flow.isFlow(null)).toBe(false)
          expect(Core.Flow.isFlow({ name: v.name })).toBe(false)
          expect(lowered.name).toBe(v.name)
          expect(lowered.prompt).toBe(v.body)
          expect(lowered.model).toEqual(
            v.modelKind === "none" ? "smart" : v.modelKind === "single" ? v.modelA : [v.modelA, v.modelB]
          )

          // Defensive copy check
          flowsInput.push("mutated-after-lower")
          expect(lowered.flows).not.toContain("mutated-after-lower")
          if (v.capKind === "list" && capsInput !== undefined) {
            expect(lowered.capabilities).toEqual([...new Set(capsInput)].sort())
          } else {
            expect(lowered.capabilities).toEqual([])
          }

          // Combinators: data-first and pipe/data-last
          const placed = lowered.pipe(Core.Flow.within(Core.Placement.remote()))
          expect(Option.isSome(Core.Annotations.getOption(placed.annotations, Core.Annotations.Placement))).toBe(true)
          const placedFirst = Core.Flow.within(lowered, Core.Placement.local())
          expect(Option.isSome(Core.Annotations.getOption(placedFirst.annotations, Core.Annotations.Placement))).toBe(true)

          const annotated = placed.pipe(
            Core.Flow.annotate(Core.Annotations.Priority, 7),
            Core.Flow.annotate(DurableFlow.Capabilities, ["fs:read"]),
            Core.Flow.annotate(Core.Annotations.Effects, Core.Effects.make({ reads: ["r"], writes: ["w"], mode: "hermetic", onConflict: "serialize", tier: "compensable" }))
          )
          expect(annotated.capabilities).toEqual(["fs:read"])
          expect(annotated.effects?.tier).toBe("compensable")
          expect(Option.getOrUndefined(Core.Annotations.getOption(annotated.annotations, Core.Annotations.Priority))).toBe(7)

          const annotatedFirst = Core.Flow.annotate(lowered, CustomService, "tag")
          expect(Option.getOrUndefined(Core.Annotations.getOption(annotatedFirst.annotations, CustomService))).toBe("tag")

          const withCollabs = annotated.pipe(Core.Flow.withFlows(["collab-a", lowered]))
          expect(withCollabs.flows?.length).toBe(2)
          const withCollabsFirst = Core.Flow.withFlows(lowered, ["collab-b"])
          expect(withCollabsFirst.flows).toEqual(["collab-b"])

          // Node + Graph.build + KeyMaterial shape
          const node = lowered.call({ args: v.body })
          expect(node).toBeDefined()
          const graph = Core.Graph.build(annotated.flow, { args: "hello" })
          const nodes = Core.Graph.nodes(graph)
          expect(nodes.length).toBeGreaterThan(0)
          const drafts = Core.Graph.drafts(graph)
          expect(drafts.length).toBeGreaterThan(0)
          const km: Core.KeyMaterial.Entry = {
            nodeId: drafts[0]!.id,
            material: drafts[0]!.material as unknown as Core.KeyMaterial.KeyMaterial
          }
          expect(km.nodeId).toBe(drafts[0]!.id)
          return true
        }),
      { seed: seed + 4, executions: Math.min(pureExecutions, 80) }
    )
  })

  it("fuzzes lowerMarkdown error paths (invalid placement, effects, budget, sandbox conflicts)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        name: SafeNameSchema,
        kind: Schema.Literals([
          "bad-placement",
          "bad-effects",
          "bad-budget",
          "empty-budget",
          "bad-sandbox",
          "sandbox-conflict"
        ]),
        nonSandboxPlacement: Schema.Literals(["remote", "client", "local"]),
        badString: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          if (v.kind === "bad-placement") {
            expect(() =>
              Core.Markdown.lowerMarkdown(
                { name: v.name, placement: (`invalid-${v.badString}`) as never },
                "body"
              )
            ).toThrow(RangeError)
          } else if (v.kind === "bad-effects") {
            expect(() =>
              Core.Markdown.lowerMarkdown(
                { name: v.name, effects: { tier: (`bad-${v.badString}`) as never } },
                "body"
              )
            ).toThrow(RangeError)
          } else if (v.kind === "bad-budget") {
            expect(() =>
              Core.Markdown.lowerMarkdown(
                { name: v.name, budget: { tokens: -1 } },
                "body"
              )
            ).toThrow(RangeError)
          } else if (v.kind === "empty-budget") {
            expect(() =>
              Core.Markdown.lowerMarkdown(
                { name: v.name, budget: { onExceeded: "warn" } },
                "body"
              )
            ).toThrow(RangeError)
          } else if (v.kind === "bad-sandbox") {
            expect(() =>
              Core.Markdown.lowerMarkdown(
                { name: v.name, sandbox: { provider: (`nope-${v.badString}`) as never } },
                "body"
              )
            ).toThrow(RangeError)
          } else {
            expect(() =>
              Core.Markdown.lowerMarkdown(
                {
                  name: v.name,
                  placement: v.nonSandboxPlacement,
                  sandbox: { provider: "cloudflare" }
                },
                "body"
              )
            ).toThrow(RangeError)
          }
          return true
        }),
      { seed: seed + 5, executions: pureExecutions }
    )
  })

  it("fuzzes splitFrontmatter, parseSkill, validateSkillFrontmatter, lowerSkill, and isSkillName", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        bom: Schema.Boolean,
        crlf: Schema.Boolean,
        name: SafeNameSchema,
        desc: Schema.String.check(
          Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9 .,_-]{0,40}$/)
        ),
        tools: Schema.Array(SafeNameSchema).check(Schema.isMaxLength(4)),
        license: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]{1,16}$/))),
        compat: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 ._-]{1,24}$/))),
        metaKey: SafeNameSchema,
        metaVal: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,16}$/)),
        useSiblingAlias: Schema.Boolean,
        body: Schema.String.check(Schema.isMaxLength(80))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          expect(Core.Markdown.isSkillName(v.name)).toBe(true)
          expect(Core.Markdown.isSkillName(`-${v.name}`)).toBe(false)
          expect(Core.Markdown.isSkillName(`${v.name}-`)).toBe(false)
          expect(Core.Markdown.isSkillName(`${v.name}--x`)).toBe(false)
          expect(Core.Markdown.isSkillName("A".repeat(5))).toBe(false)
          expect(Core.Markdown.isSkillName("a".repeat(65))).toBe(false)

          const nl = v.crlf ? "\r\n" : "\n"
          const lines = [
            `name: ${v.name}`,
            `description: "${v.desc}"`
          ]
          if (v.tools.length > 0) {
            lines.push(`allowed-tools: "${v.tools.join("   ")}"`)
          }
          if (v.license !== undefined) {
            lines.push(`license: ${v.license}`)
          }
          if (v.compat !== undefined) {
            lines.push(`compatibility: "${v.compat}"`)
          }
          lines.push(`metadata:${nl}  ${v.metaKey}: "${v.metaVal}"`)
          if (v.useSiblingAlias) {
            lines.push(`shared: &s${nl}  k: v${nl}copy: *s`)
          }
          const doc = `${v.bom ? "\uFEFF" : ""}---${nl}${lines.join(nl)}${nl}---  ${nl}${v.body}`

          const split = Core.Markdown.splitFrontmatter(doc)
          expect(split.frontmatter).toBeDefined()
          expect(split.body).toBe(v.body)

          const parsed = Core.Markdown.parseSkill(doc)
          expect(Result.isSuccess(parsed)).toBe(true)
          if (Result.isSuccess(parsed)) {
            expect(parsed.success.name).toBe(v.name)
            expect(parsed.success.description).toBe(v.desc)
            expect(parsed.success.allowedTools).toEqual(v.tools)
            expect(Object.getPrototypeOf(parsed.success.extra)).toBeNull()
            expect(Object.isFrozen(parsed.success.extra)).toBe(true)
          }

          const lowered = Core.Markdown.lowerSkill(doc)
          expect(Result.isSuccess(lowered)).toBe(true)
          if (Result.isSuccess(lowered)) {
            expect(lowered.success.name).toBe(v.name)
            expect(lowered.success.flows).toEqual(v.tools)
          }
          return true
        }),
      { seed: seed + 6, executions: pureExecutions }
    )
  })

  it("fuzzes all skillFrontmatter and validateSkillFrontmatter refusal branches", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals([
          "missing-open",
          "missing-close",
          "yaml-syntax",
          "non-mapping",
          "non-scalar-key",
          "recursive-alias",
          "alias-bomb",
          "reserved-proto",
          "reserved-constructor-nested",
          "reserved-prototype",
          "missing-name",
          "blank-name",
          "invalid-name-type",
          "invalid-name-chars",
          "missing-desc",
          "blank-desc",
          "invalid-desc-type",
          "invalid-desc-long",
          "emoji-desc-valid",
          "invalid-allowed-tools",
          "invalid-license",
          "invalid-compat-empty",
          "invalid-compat-long",
          "invalid-compat-type",
          "invalid-meta-null",
          "invalid-meta-array",
          "invalid-meta-date",
          "invalid-meta-value"
        ]),
        noise: Schema.String.check(Schema.isPattern(/^[a-z0-9 ]{0,20}$/))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          const expectCode = (res: Result.Result<unknown, Core.Markdown.MarkdownError>, code: Core.Markdown.MarkdownErrorCode) => {
            expect(Result.isFailure(res)).toBe(true)
            if (Result.isFailure(res)) {
              expect(res.failure.code).toBe(code)
            }
          }

          switch (v.caseKind) {
            case "missing-open":
              expectCode(Core.Markdown.parseSkill(`no frontmatter ${v.noise}`), "skill_missing_frontmatter")
              break
            case "missing-close":
              expectCode(Core.Markdown.parseSkill(`---\nname: abc\n${v.noise}`), "skill_missing_frontmatter")
              break
            case "yaml-syntax":
              expectCode(Core.Markdown.parseSkill(`---\nname: [unclosed\n---\n${v.noise}`), "skill_invalid_frontmatter")
              break
            case "non-mapping":
              expectCode(Core.Markdown.parseSkill(`---\n- item1\n- item2\n---\n${v.noise}`), "skill_invalid_frontmatter")
              break
            case "non-scalar-key":
              expectCode(Core.Markdown.parseSkill(`---\n? [a, b]\n: val\n---\n${v.noise}`), "skill_invalid_frontmatter")
              break
            case "recursive-alias":
              expectCode(
                Core.Markdown.parseSkill(`---\nname: abc\ndescription: hi\nb: &a\n  c: *a\n---\n`),
                "skill_invalid_frontmatter"
              )
              break
            case "alias-bomb":
              expectCode(
                Core.Markdown.parseSkill(
                  `---\na: &a ["1","2","3","4"]\nb: &b [*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c]\ne: [*d,*d,*d,*d]\n---\n`
                ),
                "skill_invalid_frontmatter"
              )
              break
            case "reserved-proto":
              expectCode(
                Core.Markdown.parseSkill(`---\nname: abc\ndescription: ok\n__proto__: bad\n---\n`),
                "skill_invalid_frontmatter"
              )
              break
            case "reserved-constructor-nested":
              expectCode(
                Core.Markdown.parseSkill(`---\nname: abc\ndescription: ok\nnested:\n  constructor: bad\n---\n`),
                "skill_invalid_frontmatter"
              )
              break
            case "reserved-prototype":
              expectCode(
                Core.Markdown.parseSkill(`---\nname: abc\ndescription: ok\nprototype: bad\n---\n`),
                "skill_invalid_frontmatter"
              )
              break
            case "missing-name":
              expectCode(Core.Markdown.validateSkillFrontmatter({ description: "ok" }), "skill_missing_name")
              break
            case "blank-name":
              expectCode(Core.Markdown.validateSkillFrontmatter({ name: "   ", description: "ok" }), "skill_missing_name")
              break
            case "invalid-name-type":
              expectCode(Core.Markdown.validateSkillFrontmatter({ name: 123, description: "ok" }), "skill_invalid_name")
              break
            case "invalid-name-chars":
              expectCode(Core.Markdown.validateSkillFrontmatter({ name: "Bad_Name", description: "ok" }), "skill_invalid_name")
              break
            case "missing-desc":
              expectCode(Core.Markdown.validateSkillFrontmatter({ name: "abc" }), "skill_missing_description")
              break
            case "blank-desc":
              expectCode(Core.Markdown.validateSkillFrontmatter({ name: "abc", description: " \t " }), "skill_missing_description")
              break
            case "invalid-desc-type":
              expectCode(Core.Markdown.validateSkillFrontmatter({ name: "abc", description: ["x"] }), "skill_invalid_description")
              break
            case "invalid-desc-long":
              expectCode(
                Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "x".repeat(1025) }),
                "skill_invalid_description"
              )
              break
            case "emoji-desc-valid": {
              const res = Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "😀".repeat(600) })
              expect(Result.isSuccess(res)).toBe(true)
              break
            }
            case "invalid-allowed-tools":
              expectCode(
                Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "ok", "allowed-tools": ["a"] }),
                "skill_invalid_allowed_tools"
              )
              break
            case "invalid-license":
              expectCode(
                Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "ok", license: { spdx: "MIT" } }),
                "skill_invalid_license"
              )
              break
            case "invalid-compat-empty":
              expectCode(
                Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "ok", compatibility: "" }),
                "skill_invalid_compatibility"
              )
              break
            case "invalid-compat-long":
              expectCode(
                Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "ok", compatibility: "a".repeat(501) }),
                "skill_invalid_compatibility"
              )
              break
            case "invalid-compat-type":
              expectCode(
                Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "ok", compatibility: 42 }),
                "skill_invalid_compatibility"
              )
              break
            case "invalid-meta-null":
              expectCode(
                Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "ok", metadata: null }),
                "skill_invalid_metadata"
              )
              break
            case "invalid-meta-array":
              expectCode(
                Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "ok", metadata: ["x"] }),
                "skill_invalid_metadata"
              )
              break
            case "invalid-meta-date":
              expectCode(
                Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "ok", metadata: new Date() }),
                "skill_invalid_metadata"
              )
              break
            case "invalid-meta-value":
              expectCode(
                Core.Markdown.validateSkillFrontmatter({ name: "abc", description: "ok", metadata: { k: 123 } }),
                "skill_invalid_metadata"
              )
              break
          }
          return true
        }),
      { seed: seed + 7, executions: pureExecutions }
    )
  })
})
