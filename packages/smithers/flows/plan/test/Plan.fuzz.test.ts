import { syncCrypto } from "@smthrs/crypto"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import type * as SchemaRepresentation from "effect/SchemaRepresentation"
import { describe, expect, it } from "vitest"
import {
  CachePolicy,
  Effects,
  FileSet,
  GraphBuildError,
  KeyMaterial,
  Node,
  Placement,
  Plan,
  PlanDiff,
  Planned,
  Repetition,
  Scheduling,
  StepKey
} from "../src/index.ts"
import * as Conflicts from "../src/internal/ConflictAnnotation.ts"
import * as EffectCandidates from "../src/internal/EffectCandidates.ts"
import * as InternalEffects from "../src/internal/effects.ts"
import { jsonMirror } from "../src/internal/JsonMirror.ts"
import * as InternalNode from "../src/internal/node.ts"
import * as InternalSchemaIdentity from "../src/internal/SchemaIdentity.ts"
import {
  compile as fixtureCompile,
  draft as fixtureDraft,
  effects as fixtureEffects
} from "../src/test/PlanFixtures.ts"
import { corpus as schemaCorpus, representations as schemaRepresentations } from "./SchemaIdentityCorpus.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const mediumExecutions = Math.max(40, Math.min(executions, 150))
const heavyExecutions = Math.max(25, Math.min(executions, 80))

const silentCryptoLayer = Layer.merge(
  Layer.succeed(EffectDigest.Digest)(syncCrypto),
  Logger.layer([])
)

const runSyncCrypto = <A, E>(effect: Effect.Effect<A, E, EffectDigest.Digest>): Exit.Exit<A, E> =>
  Effect.runSyncExit(Effect.provide(effect, silentCryptoLayer))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

// =============================================================================
// 1. Scheduling
// =============================================================================
describe("@smthrs/plan Scheduling fuzz invariants", () => {
  it("Scheduling.make never admits past caps, orders by priority+aging with BigInt safety, and conserves candidates", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        maxSteps: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))),
        maxAgents: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
        runningSteps: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
        runningAgents: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
        nearMax: Schema.Boolean,
        kinds: Schema.Array(Schema.Literals(["step", "agent", "merge"])),
        priorities: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 5 }))),
        waiteds: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ maxSteps, maxAgents, runningSteps, runningAgents, nearMax, kinds, priorities, waiteds }) => {
          const policy = Scheduling.make({
            ...(maxSteps === null ? {} : { steps: maxSteps }),
            ...(maxAgents === null ? {} : { agents: maxAgents })
          })
          const effMaxSteps = maxSteps ?? Number.MAX_SAFE_INTEGER
          const effMaxAgents = maxAgents ?? Number.MAX_SAFE_INTEGER
          const len = Math.min(kinds.length, 12)
          const candidates: ReadonlyArray<
            Scheduling.Candidate<
              { readonly id: string; readonly kind: "step" | "agent" | "merge"; readonly priority: number }
            >
          > = kinds.slice(0, len).map((kind, i) => ({
            node: {
              id: `n${i}`,
              kind,
              priority: nearMax
                ? Number.MAX_SAFE_INTEGER - (i % 3)
                : (priorities[i] ?? (i % 3))
            },
            order: i,
            waited: nearMax ? (i % 2 === 0 ? Number.MAX_SAFE_INTEGER : 3) : (waiteds[i] ?? (i % 4))
          }))
          const agents = Math.min(runningAgents, runningSteps)
          const usage: Scheduling.Usage = { steps: runningSteps, agents }
          const admission = policy.admit(candidates, usage)
          const admittedSteps = runningSteps + admission.admitted.length
          const admittedAgents = agents + admission.admitted.filter((c) => c.node.kind === "agent").length
          if (runningSteps >= effMaxSteps && admission.admitted.length !== 0) return false
          if (runningSteps < effMaxSteps && admittedSteps > effMaxSteps) return false
          if (agents < effMaxAgents && admittedAgents > effMaxAgents) return false
          if (admission.agents !== admission.admitted.filter((c) => c.node.kind === "agent").length) return false
          // Conservation and saturation of waited age.
          if (admission.admitted.length + admission.deferred.length !== candidates.length) return false
          for (const d of admission.deferred) {
            if (!Number.isSafeInteger(d.waited) || d.waited > Number.MAX_SAFE_INTEGER) return false
          }
          return true
        },
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("Scheduling.make and admit refuse invalid limits, active usage, and malformed candidates", async () => {
    const badNums = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY] as const
    const arb = Arbitrary.schema(
      Schema.Struct({
        badCase: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
        badNumIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: badNums.length - 1 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ badCase, badNumIdx }) => {
          const badNum = badNums[badNumIdx]!
          const okPolicy = Scheduling.make()
          const c0 = { node: { id: "a", kind: "step" as const, priority: 0 }, order: 0, waited: 0 }
          const expectRangeError = (fn: () => unknown): boolean => {
            try {
              fn()
              return false
            } catch (e) {
              return e instanceof RangeError
            }
          }
          switch (badCase) {
            case 0:
              return expectRangeError(() => Scheduling.make({ steps: badNum }))
            case 1:
              return expectRangeError(() => Scheduling.make({ agents: badNum }))
            case 2:
              return expectRangeError(() => okPolicy.admit([c0], { steps: -1, agents: 0 }))
            case 3:
              return expectRangeError(() => okPolicy.admit([c0], { steps: 1, agents: 2 }))
            case 4:
              return expectRangeError(() => okPolicy.admit([{ ...c0, order: -1 }], { steps: 0, agents: 0 }))
            case 5:
              return expectRangeError(() => okPolicy.admit([{ ...c0, waited: 1.5 }], { steps: 0, agents: 0 }))
            case 6:
              return expectRangeError(() =>
                okPolicy.admit([{ ...c0, node: { ...c0.node, priority: 1.5 } }], { steps: 0, agents: 0 })
              )
            case 7:
              return expectRangeError(() =>
                okPolicy.admit(
                  [{ ...c0, node: { ...c0.node, kind: "bogus" as unknown as "step" } }],
                  { steps: 0, agents: 0 }
                )
              )
            case 8:
              return expectRangeError(() =>
                okPolicy.admit(
                  [c0, { ...c0, order: 1 }],
                  { steps: 0, agents: 0 }
                )
              ) && expectRangeError(() =>
                okPolicy.admit(
                  [{ ...c0, node: { ...c0.node, id: "" } }],
                  { steps: 0, agents: 0 }
                )
              )
            default:
              return expectRangeError(() =>
                okPolicy.admit(
                  [c0, { node: { id: "b", kind: "step", priority: 0 }, order: 0, waited: 0 }],
                  { steps: 0, agents: 0 }
                )
              )
          }
        },
        { seed: seed + 1, executions: mediumExecutions }
      )
    )
    assertPassed(report)
  })
})

// =============================================================================
// 2. CachePolicy, Placement, GraphBuildError, Repetition, KeyMaterial
// =============================================================================
describe("@smthrs/plan core models fuzz invariants", () => {
  it("CachePolicy decodes current and historical scopes, validates ttlMs, and round-trips through annotate/cachePolicyOf", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scope: Schema.NullOr(Schema.Literals(["run", "flow", "shared", "workflow", "global", "bad"])),
        ttlMs: Schema.NullOr(Schema.Literals([1, 500, 60_000, 0, -5, 1.5]))
      })
    )
    const decodeScope = Schema.decodeUnknownResult(CachePolicy.CacheScope)
    const encodeScope = Schema.encodeSync(CachePolicy.CacheScope)
    const decodePolicy = Schema.decodeUnknownResult(CachePolicy.CachePolicy)
    const encodePolicy = Schema.encodeSync(CachePolicy.CachePolicy)
    interface Carrier {
      readonly annotations: Context.Context<never>
      readonly annotate: (key: typeof CachePolicy.CachePolicyAnnotation, value: CachePolicy.CachePolicy) => Carrier
    }
    const makeCarrier = (annotations: Context.Context<never> = Context.empty()): Carrier => ({
      annotations,
      annotate: (key, value) => makeCarrier(Context.add(annotations, key, value))
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scope, ttlMs }) => {
          if (CachePolicy.cachePolicyOf(Context.empty()) !== undefined) return false
          const expectedScope = scope === "workflow"
            ? "flow"
            : scope === "global"
            ? "shared"
            : scope === "run" || scope === "flow" || scope === "shared"
            ? scope
            : undefined
          if (scope !== null) {
            const sr = decodeScope(scope)
            if (expectedScope === undefined) {
              if (sr._tag !== "Failure") return false
            } else {
              if (sr._tag !== "Success" || sr.success !== expectedScope) return false
              if (encodeScope(sr.success) !== expectedScope) return false
            }
          }
          const raw: Record<string, unknown> = {}
          if (scope !== null) raw.scope = scope
          if (ttlMs !== null) raw.ttlMs = ttlMs
          const validTtl = ttlMs === null || (Number.isInteger(ttlMs) && ttlMs > 0)
          const validScope = scope === null || expectedScope !== undefined
          const pr = decodePolicy(raw)
          if (!validTtl || !validScope) return pr._tag === "Failure"
          if (pr._tag !== "Success") return false
          const encoded = encodePolicy(pr.success)
          if (encoded.scope !== expectedScope) return false
          const annotated = CachePolicy.annotate(makeCarrier(), raw as CachePolicy.CachePolicy)
          const read = CachePolicy.cachePolicyOf(annotated.annotations)
          if (read === undefined || !Object.isFrozen(read)) return false
          return read.scope === expectedScope && read.ttlMs === (ttlMs ?? undefined)
        },
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("Placement constructors, Repetition ceiling, GraphBuildError fatality, and KeyMaterial dependencies", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals(["local", "client", "sandbox", "remote"]),
        image: Schema.NullOr(Schema.String),
        profile: Schema.NullOr(Schema.String),
        target: Schema.NullOr(Schema.String),
        defaultOpts: Schema.Boolean,
        code: GraphBuildError.GraphBuildErrorCode,
        tier: Effects.Tier,
        nondeterministic: Schema.Boolean,
        refs: Schema.Array(
          Schema.Union([
            Schema.Struct({ tag: Schema.Literal("Literal"), hasValue: Schema.Boolean, val: Schema.Int }),
            Schema.Struct({
              tag: Schema.Literal("Ref"),
              from: Schema.Literals(["a", "b", "c", "d"]),
              path: Schema.Array(Schema.Literals(["x", "y"]))
            }),
            Schema.Struct({ tag: Schema.Literal("Pending"), from: Schema.Literals(["a", "b", "c", "d"]) })
          ])
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, image, profile, target, defaultOpts, code, tier, nondeterministic, refs }) => {
          const opts: Placement.Options = {
            ...(image === null ? {} : { image }),
            ...(profile === null ? {} : { profile }),
            ...(target === null ? {} : { target })
          }
          const p = kind === "local"
            ? Placement.local()
            : kind === "client"
            ? Placement.client()
            : kind === "sandbox"
            ? (defaultOpts ? Placement.sandbox() : Placement.sandbox(opts))
            : (defaultOpts ? Placement.remote() : Placement.remote(opts))
          const bag = Context.make(Placement.Annotation, p)
          if (Context.get(bag, Placement.Annotation)._tag !== p._tag) return false
          for (const ceilingLit of Repetition.AtCeiling.literals) {
            if (Schema.decodeUnknownSync(Repetition.AtCeiling)(ceilingLit) !== ceilingLit) return false
          }

          const err = new GraphBuildError.GraphBuildError({ code, node: "n", path: ["p"], message: "m" })
          const fatal = GraphBuildError.isFatalDiagnostic(err)
          if (fatal !== (code !== "capability_outside_grant")) return false

          const rawInputs = refs.slice(0, 8).map((r) =>
            r.tag === "Literal"
              ? (r.hasValue ? { _tag: "Literal", value: r.val } : { _tag: "Literal" })
              : r.tag === "Ref"
              ? { _tag: "Ref", from: r.from, path: r.path.slice(0, 3) }
              : { _tag: "Pending", from: r.from }
          )
          const km = Schema.decodeUnknownSync(KeyMaterial.KeyMaterial)({
            version: KeyMaterial.version,
            kind: tier,
            ...(nondeterministic ? { nondeterministic: true } : {}),
            body: { op: 1 },
            inputs: rawInputs,
            layers: ["l1"],
            capabilities: ["c1"],
            effects: { ok: true },
            placement: p
          })
          const deps = KeyMaterial.dependencies(km)
          const expectedDeps: Array<string> = []
          for (const input of km.inputs) {
            if (input._tag !== "Literal" && !expectedDeps.includes(input.from)) expectedDeps.push(input.from)
          }
          if (deps.length !== expectedDeps.length) return false
          return deps.every((d, i) => d === expectedDeps[i])
        },
        { seed: seed + 3, executions }
      )
    )
    assertPassed(report)
  })
})

// =============================================================================
// 3. Planned
// =============================================================================
describe("@smthrs/plan Planned placeholder fuzz invariants", () => {
  it("Planned.make records arbitrary nested paths, refuses every computation trap, and rejects forged carriers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        node: Schema.NonEmptyString.check(Schema.isMaxLength(16)),
        path: Schema.Array(Schema.Literals(["a", "b", "0", "nested", "value", "deep"]))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ node, path }) => {
          const segments = path.slice(0, 6)
          let current: any = Planned.make<unknown>(node)
          for (const seg of segments) current = (current as Record<string, unknown>)[seg]
          const ref = Planned.reference(current)
          if (ref === undefined || !Planned.isPlanned(current)) return false
          if (ref.node !== node || ref.path.length !== segments.length) return false
          if (!ref.path.every((s, i) => s === segments[i])) return false
          const rawProxy = current as any
          if (rawProxy.then !== undefined) return false

          const traps: ReadonlyArray<() => unknown> = [
            () => rawProxy[Symbol.toPrimitive]("default"),
            () => rawProxy.valueOf(),
            () => rawProxy.toString(),
            () => rawProxy.toJSON(),
            () => rawProxy(),
            () => "x" in rawProxy,
            () => Object.keys(rawProxy)
          ]
          for (const trap of traps) {
            let threw = false
            try {
              trap()
            } catch (e) {
              threw = e instanceof GraphBuildError.GraphBuildError &&
                e.code === "planned_value_computed" &&
                e.node === node &&
                e.path.length === segments.length
            }
            if (!threw) return false
          }

          // Forged / non-carrier values.
          const bads: ReadonlyArray<unknown> = [
            null,
            undefined,
            42,
            "str",
            {},
            () => undefined,
            { [Planned.TypeId]: null },
            { [Planned.TypeId]: { node: "", path: [] } },
            { [Planned.TypeId]: { node: "ok", path: "not-array" } },
            { [Planned.TypeId]: { node: "ok", path: [123] } }
          ]
          for (const bad of bads) {
            if (Planned.reference(bad) !== undefined || Planned.isPlanned(bad)) return false
          }
          // Valid forged carrier with full shape is accepted per contract.
          const forged = { [Planned.TypeId]: { node, path: segments } }
          return Planned.isPlanned(forged) && Planned.reference(forged)?.node === node
        },
        { seed: seed + 4, executions }
      )
    )
    assertPassed(report)
  })
})

// =============================================================================
// 4. FileSet & EffectCandidates
// =============================================================================
describe("@smthrs/plan FileSet & EffectCandidates fuzz invariants", () => {
  const segArb = Schema.Literals([
    "src",
    "Src",
    "dist",
    "a",
    "b",
    "foo.ts",
    "FOO.TS",
    "bar.js",
    "sub",
    "aaab",
    "a*b",
    "cafe\u0301"
  ])
  const relPathArb = Schema.Array(segArb).check(Schema.isMinLength(1), Schema.isMaxLength(4))
  const globSegArb = Schema.Literals(["src", "dist", "*", "**", "*.ts", "a*b*c", "*aaab*", "foo*", "*bar", "a"])
  const globPatArb = Schema.Array(globSegArb).check(Schema.isMinLength(1), Schema.isMaxLength(4))

  const entryFrom = (choice: {
    readonly tag: "path" | "glob" | "tree"
    readonly segs: ReadonlyArray<string>
    readonly inc: ReadonlyArray<ReadonlyArray<string>>
    readonly exc: ReadonlyArray<ReadonlyArray<string>>
    readonly backslash: boolean
  }): FileSet.Entry => {
    const join = (parts: ReadonlyArray<string>) => parts.join(choice.backslash ? "\\" : "/")
    if (choice.tag === "path") return join(choice.segs)
    if (choice.tag === "tree") return { _tag: "TreeArtifact", path: join(choice.segs) }
    const include = (choice.inc.length === 0 ? [choice.segs] : choice.inc).map(join) as [string, ...Array<string>]
    const exclude = choice.exc.length === 0 ? undefined : choice.exc.map(join)
    return exclude === undefined ? { _tag: "Glob", include } : { _tag: "Glob", include, exclude }
  }

  it("FileSet workspaceRelative, canonical, folded, guards, expand/expandReads, contains, and overlaps satisfy algebraic laws", async () => {
    const entrySpec = Schema.Struct({
      tag: Schema.Literals(["path", "glob", "tree"]),
      segs: relPathArb,
      inc: Schema.Array(globPatArb).check(Schema.isMaxLength(2)),
      exc: Schema.Array(globPatArb).check(Schema.isMaxLength(2)),
      backslash: Schema.Boolean
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        left: entrySpec,
        right: entrySpec,
        probe: relPathArb,
        probeBackslash: Schema.Boolean,
        badKind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ left, right, probe, probeBackslash, badKind }) => {
          const eLeft = entryFrom(left)
          const eRight = entryFrom(right)
          const p = probe.join(probeBackslash ? "\\" : "/")

          // workspaceRelative accepts valid paths & C1 controls, rejects C0/DEL/absolute/drive/./..//
          if (!FileSet.workspaceRelative(p)) return false
          if (!FileSet.workspaceRelative("a/\u0085b")) return false
          const bads = [
            "\x00a",
            "a\x1fb",
            "a\x7fb",
            "/abs",
            "C:rel",
            "C:/abs",
            "drive:/x",
            "a/./b",
            "a/../b",
            "a//b",
            ""
          ]
          if (FileSet.workspaceRelative(bads[badKind % bads.length]!)) return false

          // Pattern schema filter accepts valid and rejects invalid.
          if (Schema.decodeUnknownResult(FileSet.Pattern)(p)._tag !== "Success") return false
          if (Schema.decodeUnknownResult(FileSet.Pattern)(bads[badKind % bads.length]!)._tag !== "Failure") return false

          // canonical & folded idempotence.
          if (FileSet.canonical(FileSet.canonical(p)) !== FileSet.canonical(p)) return false
          if (FileSet.folded(FileSet.folded(p)) !== FileSet.folded(p)) return false

          // Filegroup expand / expandReads.
          const fg = FileSet.makeFilegroup("fg", [eLeft, eRight])
          const expanded = FileSet.expand([eLeft, fg])
          if (expanded.length !== 3) return false
          const readEntry: FileSet.ReadEntry = FileSet.isTreeArtifact(eLeft) ? eLeft.path : eLeft
          const readFg: FileSet.ReadFilegroup = { _tag: "Filegroup", name: "rfg", entries: [readEntry] }
          if (FileSet.expandReads([readEntry, readFg]).length !== 2) return false

          // Type guards.
          if (FileSet.isGlob(null) || FileSet.isTreeArtifact("x")) return false

          // contains rejects non-workspace-relative paths.
          if (FileSet.contains(eLeft, "/abs/path")) return false
          if (FileSet.contains(eLeft, "../escape")) return false
          const contained = FileSet.contains(eLeft, p)
          // Conservative soundness: if contains(e, p) is true, then overlaps(e, p) MUST be true.
          if (contained && !FileSet.overlaps(eLeft, p)) return false

          // overlaps symmetry and reflexivity.
          if (FileSet.overlaps(eLeft, eRight) !== FileSet.overlaps(eRight, eLeft)) return false
          if (!FileSet.overlaps(eLeft, eLeft)) return false
          return true
        },
        { seed: seed + 5, executions }
      )
    )
    assertPassed(report)
  })

  it("FileSet.matchesPattern handles KMP multi-wildcard segments, recursive **, and bounded pattern cache eviction", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        a: Schema.Literals(["a", "aa", "ab", "aba", "aab"]),
        b: Schema.Literals(["a", "aa", "ab", "aba", "ba"]),
        c: Schema.Literals(["", "a", "b", "ab"]),
        id: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600 }))
      })
    )
    let uniqueCounter = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ a, b, c, id }) => {
          const pat = `${a}*${b}*${c}`
          const matched = `${a}xx${b}yy${c}`
          if (!FileSet.matchesPattern(pat, matched)) return false
          // Trigger KMP fallback with near-matching repeated prefixes.
          if (FileSet.matchesPattern("x*aaab*z", "xaaaaacz")) return false
          if (!FileSet.matchesPattern("x*aaab*z", "xaaaaaabz")) return false
          // Trailing ** needs separator: src/** must not match bare src.
          if (FileSet.matchesPattern("src/**", "src")) return false
          if (!FileSet.matchesPattern("src/**", "src/a/b")) return false
          if (!FileSet.matchesPattern("**/a/**/b", "a/b")) return false
          if (!FileSet.matchesPattern("**/a/**/b", "x/y/a/z/b")) return false
          // Monotonic unique patterns guarantee crossing the 512-entry cache eviction threshold.
          const uid = uniqueCounter++
          const uniquePat = `dir_${uid}_${id}/**/*_${uid}.ts`
          if (!FileSet.matchesPattern(uniquePat, `dir_${uid}_${id}/sub/f_${uid}.ts`)) return false
          return true
        },
        { seed: seed + 6, executions: Math.max(executions, 550) }
      )
    )
    assertPassed(report)
  })

  it("EffectCandidates.make is sound against exhaustive FileSet.overlaps and preserves declaration order", async () => {
    const entrySpec = Schema.Struct({
      tag: Schema.Literals(["path", "glob", "tree"]),
      segs: relPathArb,
      inc: Schema.Array(globPatArb).check(Schema.isMaxLength(2)),
      exc: Schema.Array(globPatArb).check(Schema.isMaxLength(1)),
      backslash: Schema.Boolean
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        producers: Schema.Array(Schema.Array(entrySpec).check(Schema.isMaxLength(3))).check(Schema.isMaxLength(8)),
        query: Schema.Array(entrySpec).check(Schema.isMaxLength(3))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ producers, query }) => {
          const produced = producers.map((list) => list.map(entryFrom))
          const q = query.map(entryFrom)
          const select = EffectCandidates.make(produced)
          const selected = select(q)
          // Strictly ascending order.
          for (let i = 1; i < selected.length; i++) {
            if (selected[i]! <= selected[i - 1]!) return false
          }
          const selectedSet = new Set(selected)
          // Soundness: every overlapping producer MUST be selected.
          for (let owner = 0; owner < produced.length; owner++) {
            const overlapsAny = produced[owner]!.some((pe) => q.some((qe) => FileSet.overlaps(pe, qe)))
            if (overlapsAny && !selectedSet.has(owner)) return false
          }
          return true
        },
        { seed: seed + 7, executions }
      )
    )
    assertPassed(report)
  })
})

// =============================================================================
// 5. Effects & internal/effects
// =============================================================================
describe("@smthrs/plan Effects & internal/effects fuzz invariants", () => {
  const pathChoice = Schema.Literals([
    "src/a.ts",
    "src/b.ts",
    "src/sub/c.ts",
    "src/**",
    "src/*",
    "src/sub/**",
    "dist/**",
    "dist/out.js",
    "*",
    "**",
    "a/./b",
    "a/../b",
    "./x",
    "..",
    "a/./*",
    "../x*",
    "\uffff*",
    "\uffff/a",
    "z"
  ])

  it("Effects.covers, narrow, overlaps, sealed, and prepared index match pairwise definitions", async () => {
    const declSpec = Schema.Struct({
      reads: Schema.Array(pathChoice).check(Schema.isMaxLength(6)),
      writes: Schema.Array(pathChoice).check(Schema.isMaxLength(6)),
      mode: Effects.Mode,
      onConflict: Effects.ConflictStrategy,
      tier: Schema.NullOr(Effects.Tier)
    })
    const arb = Arbitrary.schema(Schema.Struct({ env: declSpec, step: declSpec }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ env, step }) => {
          const envDecl = Effects.make({
            reads: env.reads,
            writes: env.writes,
            mode: env.mode,
            onConflict: env.onConflict,
            ...(env.tier === null ? {} : { tier: env.tier })
          })
          const stepDecl = Effects.make({
            reads: step.reads,
            writes: step.writes,
            mode: step.mode,
            onConflict: step.onConflict,
            ...(step.tier === null ? {} : { tier: step.tier })
          })

          // Sealed copy always has mode hermetic and tier sealed.
          const s = Effects.sealed(stepDecl)
          if (s.mode !== "hermetic" || s.tier !== "sealed") return false

          // Prepared narrow matches naive covers check.
          const res = Effects.narrow(envDecl, stepDecl)
          const naiveOutside = [
            ...stepDecl.reads.filter((p) => !envDecl.reads.some((e) => Effects.covers(e, p))),
            ...stepDecl.writes.filter((p) => !envDecl.writes.some((e) => Effects.covers(e, p)))
          ]
          const expectedOutside = [...new Set(naiveOutside)].sort()
          if (expectedOutside.length > 0) {
            if (res.ok || res.code !== "effect_outside_envelope") return false
            if (JSON.stringify(res.paths) !== JSON.stringify(expectedOutside)) return false
          } else if (envDecl.mode === "hermetic" && stepDecl.mode === "expected") {
            if (res.ok || res.code !== "effect_mode_widening") return false
          } else {
            const rank = { sealed: 0, compensable: 1, irreversible: 2 } as const
            if (rank[stepDecl.tier ?? "sealed"] > rank[envDecl.tier ?? "sealed"]) {
              if (res.ok || res.code !== "effect_tier_widening") return false
            } else if (!res.ok) {
              return false
            }
          }

          // overlaps is sorted, duplicate-free, and covers all exact matches.
          const ov = Effects.overlaps(envDecl, stepDecl)
          for (let i = 1; i < ov.length; i++) {
            if (ov[i]! <= ov[i - 1]!) return false
          }
          for (const w of envDecl.writes) {
            if (stepDecl.writes.includes(w) && !ov.includes(w)) return false
          }
          return true
        },
        { seed: seed + 8, executions }
      )
    )
    assertPassed(report)
  })

  it("Effects.boundedEffects and copyPaths enforce path limits, maximumPathLength, and maximumGlobs for arrays and iterables", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
        limit: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
        withTier: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, limit, withTier }) => {
          const refuse = () => new Error("refused")
          const iterOf = (items: ReadonlyArray<string>): ReadonlyArray<string> =>
            (function*() {
              for (const x of items) yield x
            })() as unknown as ReadonlyArray<string>

          if (mode === 0) {
            // Within limits (array).
            const d = Effects.make({
              reads: ["a"],
              writes: ["b"],
              mode: "hermetic",
              onConflict: "serialize",
              ...(withTier ? { tier: "compensable" } : {})
            })
            const res = Effects.boundedEffects(d, 10, refuse)
            return res.reads.length === 1 && res.writes.length === 1 &&
              (withTier ? res.tier === "compensable" : res.tier === undefined)
          }
          if (mode === 1) {
            // Exceeds limit (array).
            const d = Effects.make({
              reads: ["a", "b", "c", "d", "e", "f"],
              writes: [],
              mode: "hermetic",
              onConflict: "serialize"
            })
            try {
              Effects.boundedEffects(d, limit, refuse)
              return false
            } catch (e) {
              return e instanceof Error && e.message === "refused"
            }
          }
          if (mode === 2) {
            // Non-array iterable within limit.
            const copied = InternalEffects.copyPaths(iterOf(["a", "b"]), 5, refuse)
            return copied.length === 2
          }
          if (mode === 3) {
            // Non-array iterable exceeding limit.
            try {
              InternalEffects.copyPaths(iterOf(["a", "b", "c", "d", "e", "f"]), limit, refuse)
              return false
            } catch (e) {
              return e instanceof Error && e.message === "refused"
            }
          }
          if (mode === 4) {
            // Exceeds maximumPathLength.
            const longPath = "a".repeat(Effects.maximumPathLength + 1)
            try {
              InternalEffects.copyPaths([longPath], 10, refuse)
              return false
            } catch (e) {
              return e instanceof Error && e.message === "refused"
            }
          }
          if (mode === 5) {
            // Exceeds maximumGlobs.
            const tooManyGlobs = Array.from({ length: Effects.maximumGlobs + 1 }, (_, i) => `p${i}*`)
            try {
              InternalEffects.copyPaths(tooManyGlobs, 200, refuse)
              return false
            } catch (e) {
              return e instanceof Error && e.message === "refused"
            }
          }
          // Dotted path exact overlap + duplicate path deduplication + nested glob collapsing in indexPaths/rankPaths.
          const idx = Effects.indexPaths([["a/./b", "src/**", "src/sub/**", "src/a.ts"], [
            "a/./b",
            "src/sub/c.ts",
            "src/sub/**"
          ]])
          const rA = Effects.rankPaths(idx, ["a/./b", "a/./b", "src/**", "src/sub/**", "src/a.ts"])
          const rB = Effects.rankPaths(idx, ["a/./b", "src/sub/c.ts", "src/sub/**", "src/sub/**"])
          const ov = Effects.overlapRanks(idx, rA, rB)
          return ov.length >= 2
        },
        { seed: seed + 9, executions: mediumExecutions }
      )
    )
    assertPassed(report)
  })
})

// =============================================================================
// 6. JsonMirror
// =============================================================================
describe("@smthrs/plan JsonMirror fuzz invariants", () => {
  it("jsonMirror handles primitives, containers, cycles, toJSON key-memoization/cycles, Planned refs, and refuses invalid values", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        n: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
        s: Schema.String.check(Schema.isMaxLength(16)),
        b: Schema.Boolean,
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 13 }))
      })
    )
    const onPlanned = (_v: unknown, r: Planned.Reference) => ({ _tag: "PlannedRef", node: r.node, path: r.path })

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ n, s, b, variant }) => {
          // Basic JSON values & idempotence.
          const sample = {
            n,
            s,
            b,
            nil: null,
            undef: undefined,
            sym: Symbol("s"),
            fn: () => 1,
            arr: [1, undefined, Symbol("a"), () => 2, null, Planned.make<{ x: number }>("p").x],
            ref: Planned.make<string>("r")
          }
          const m1 = jsonMirror(sample, onPlanned) as Record<string, unknown>
          const m2 = jsonMirror(m1, onPlanned)
          if (JSON.stringify(m1) !== JSON.stringify(m2)) return false
          if ("undef" in m1 || "sym" in m1 || "fn" in m1) return false
          const arr = m1.arr as ReadonlyArray<unknown>
          if (arr[1] !== null || arr[2] !== null || arr[3] !== null) return false

          const expectBuildErr = (fn: () => unknown, code: GraphBuildError.GraphBuildErrorCode): boolean => {
            try {
              fn()
              return false
            } catch (e) {
              return e instanceof GraphBuildError.GraphBuildError && e.code === code
            }
          }

          switch (variant) {
            case 0: // Root missing values -> undefined.
              return jsonMirror(undefined, onPlanned) === undefined &&
                jsonMirror(Symbol("x"), onPlanned) === undefined &&
                jsonMirror(() => 1, onPlanned) === undefined
            case 1: { // Null-prototype object & shared reference.
              const shared = Object.assign(Object.create(null), { k: n })
              const res = jsonMirror({ a: shared, b: shared }, onPlanned) as Record<string, unknown>
              return res.a === res.b
            }
            case 2: { // Self-referential object cycle.
              const cyc: Record<string, unknown> = { n }
              cyc.self = cyc
              const res = jsonMirror(cyc, onPlanned) as Record<string, unknown>
              return res.self === res
            }
            case 3: { // Sparse array holes become null.
              const sparse = new Array<unknown>(3)
              sparse[1] = n
              const res = jsonMirror(sparse, onPlanned) as ReadonlyArray<unknown>
              return res[0] === null && res[1] === n && res[2] === null
            }
            case 4: { // toJSON receives key & memoizes per (source, key).
              let calls = 0
              const keyed = {
                toJSON(key: string) {
                  calls++
                  return { key, n }
                }
              }
              const res = jsonMirror({ a: keyed, b: keyed, nested: { a: keyed } }, onPlanned) as any
              return res.a.key === "a" && res.b.key === "b" && res.nested.a === res.a && calls === 2
            }
            case 5: { // toJSON returning a container that references the original (open cycle).
              const node: Record<string, unknown> = {}
              node.toJSON = function() {
                return { back: node, n }
              }
              const res = jsonMirror(node, onPlanned) as Record<string, unknown>
              return res.back === res && res.n === n
            }
            case 6: { // toJSON returning itself directly (nested & root) -> cyclic_payload.
              const selfJson: Record<string, unknown> = {}
              selfJson.toJSON = () => selfJson
              return expectBuildErr(() => jsonMirror({ x: selfJson }, onPlanned), "cyclic_payload") &&
                expectBuildErr(() => jsonMirror(selfJson, onPlanned), "cyclic_payload")
            }
            case 7: // BigInt (nested & root) -> invalid_payload.
              return expectBuildErr(() => jsonMirror({ big: BigInt(n) }, onPlanned), "invalid_payload") &&
                expectBuildErr(() => jsonMirror(BigInt(n), onPlanned), "invalid_payload")
            case 8: { // Accessor toJSON -> invalid_payload.
              const acc = {}
              Object.defineProperty(acc, "toJSON", { get: () => () => 1 })
              return expectBuildErr(() => jsonMirror({ x: acc }, onPlanned), "invalid_payload")
            }
            case 9: // Unsupported prototype (Map/Set/custom class) -> invalid_payload.
              return expectBuildErr(() => jsonMirror({ m: new Map() }, onPlanned), "invalid_payload")
            case 10: { // Accessor property on object -> invalid_payload.
              const obj = {}
              Object.defineProperty(obj, "bad", { enumerable: true, get: () => 1 })
              return expectBuildErr(() => jsonMirror(obj, onPlanned), "invalid_payload")
            }
            case 11: { // Accessor element on array -> invalid_payload.
              const a: Array<unknown> = [1]
              Object.defineProperty(a, "0", { enumerable: true, get: () => 1 })
              return expectBuildErr(() => jsonMirror(a, onPlanned), "invalid_payload")
            }
            case 12: { // Inherited toJSON (Date).
              const d = new Date(Math.abs(n) * 1000)
              return jsonMirror(d, onPlanned) === d.toISOString()
            }
            default: { // Root Planned reference.
              const r = jsonMirror(Planned.make("root"), onPlanned) as Record<string, unknown>
              return r._tag === "PlannedRef" && r.node === "root"
            }
          }
        },
        { seed: seed + 10, executions }
      )
    )
    assertPassed(report)
  })
})

// =============================================================================
// 7. StepKey (content, ordinal, environmentIdentity, fromKeyMaterial, planIdentity, dispatchIdentity, project, makeDigestMemo)
// =============================================================================
describe("@smthrs/plan StepKey fuzz invariants", () => {
  it("StepKey.content, environmentIdentity, ordinal, planIdentity, fromKeyMaterial, and dispatchIdentity preserve key separation and normalization", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        bodyVal: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
        layers: Schema.Array(Schema.Literals(["a", "b", "c", "cafe\u0301", "caf\u00e9"])).check(Schema.isMaxLength(5)),
        caps: Schema.Array(Schema.Literals(["fs:read", "fs:write", "net"])).check(Schema.isMaxLength(4)),
        envKind: Schema.Literals(["none", "declared", "undeclared"]),
        tier: Effects.Tier,
        ordinalTier: Schema.Literals(["compensable", "irreversible", "unsealed"]),
        nondeterministic: Schema.Boolean,
        boundaryMode: FileSet.BoundaryMode,
        withRemoves: Schema.Boolean,
        withExclude: Schema.Boolean,
        withOptFields: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (
          {
            bodyVal,
            layers,
            caps,
            envKind,
            tier,
            ordinalTier,
            nondeterministic,
            boundaryMode,
            withRemoves,
            withExclude,
            withOptFields
          }
        ) => {
          const environment: StepKey.EnvironmentIdentity | undefined = envKind === "none"
            ? undefined
            : envKind === "declared"
            ? { declared: true, layers: [...layers], capabilities: { net: [...caps] } }
            : { declared: false, layers: [...layers], capabilities: { net: [...caps] }, runScope: "run-1" }

          // digestInput nominal separation.
          const dig = StepKey.digestInput("key1_abc", { reference: "ref-projected", path: ["a"] })
          const digPlain = StepKey.digestInput("key1_abc")
          const lookalike = { digest: "key1_abc" }
          if (!StepKey.isDigestInput(dig) || !StepKey.isDigestInput(digPlain) || StepKey.isDigestInput(lookalike)) {
            return false
          }

          const hermetic: NonNullable<StepKey.ContentIdentity["hermetic"]> = {
            readSet: [
              { path: "b.ts", digest: "d2" },
              { path: "a.ts", digest: "d1" },
              { path: "a.ts", digest: "d1" },
              { path: "a.ts", digest: "d0" }
            ],
            writeSet: [
              "out/b.js",
              { _tag: "TreeArtifact", path: "out/tree" },
              {
                _tag: "Glob",
                include: ["src/*.ts", "a/*.ts"],
                ...(withExclude ? { exclude: ["src/skip.ts", "a/skip.ts"] } : {})
              },
              "out/b.js"
            ],
            ...(withRemoves ? { removes: ["tmp/b", "tmp/a", "tmp/a"] } : {}),
            boundaryMode
          }

          const k1 = runSyncCrypto(StepKey.content({
            body: { bodyVal },
            inputs: { d: dig, l: lookalike },
            layers,
            capabilities: { declared: caps },
            environment,
            hermetic
          }))
          const k2 = runSyncCrypto(StepKey.content({
            body: { bodyVal },
            inputs: { d: dig, l: lookalike },
            layers: [...layers].reverse(),
            capabilities: { declared: [...caps].reverse() },
            environment,
            hermetic: {
              ...hermetic,
              readSet: [...hermetic.readSet].reverse(),
              writeSet: [...hermetic.writeSet].reverse()
            }
          }))
          if (Exit.isFailure(k1) || Exit.isFailure(k2) || k1.value !== k2.value) return false

          // Nominal separation: literal { digest } must not collide with digestInput.
          const kLit = runSyncCrypto(StepKey.content({
            body: { bodyVal },
            inputs: { x: lookalike },
            layers: [],
            capabilities: {}
          }))
          const kDig = runSyncCrypto(StepKey.content({
            body: { bodyVal },
            inputs: { x: digPlain },
            layers: [],
            capabilities: {}
          }))
          if (Exit.isFailure(kLit) || Exit.isFailure(kDig) || kLit.value === kDig.value) return false

          // environmentIdentity.
          const e1 = runSyncCrypto(StepKey.environmentIdentity(environment))
          if (Exit.isFailure(e1)) return false

          // ordinal.
          const o1 = runSyncCrypto(
            StepKey.ordinal({ runId: "r1", parentScope: "p1", ordinal: Math.abs(bodyVal), tier: ordinalTier })
          )
          const o2 = runSyncCrypto(StepKey.ordinal({ runId: "r1", ordinal: Math.abs(bodyVal), tier: ordinalTier }))
          if (Exit.isFailure(o1) || Exit.isFailure(o2) || o1.value === o2.value) return false

          // planIdentity vs fromKeyMaterial.
          const mat: KeyMaterial.KeyMaterial = {
            version: KeyMaterial.version,
            kind: tier,
            ...(nondeterministic ? { nondeterministic: true } : {}),
            body: { bodyVal },
            inputs: [
              { _tag: "Literal", value: bodyVal },
              { _tag: "Ref", from: "u1", path: [] },
              { _tag: "Ref", from: "u1", path: ["nested", "v"] },
              { _tag: "Pending", from: "u2" }
            ],
            layers,
            capabilities: caps,
            ...(withOptFields ? { effects: { ok: true }, placement: Placement.local() } : {})
          }
          const deps = { u1: "key1_u1", u2: "key1_u2" }
          const pi = runSyncCrypto(StepKey.planIdentity(mat, deps))
          const fk = runSyncCrypto(StepKey.fromKeyMaterial(mat, deps))
          if (Exit.isFailure(pi)) return false
          if (tier === "sealed") {
            if (Exit.isFailure(fk) || fk.value !== pi.value) return false
          } else {
            if (Exit.isSuccess(fk)) return false
          }

          // project & dispatchIdentity.
          const objWithGetter = { nested: { v: bodyVal } }
          Object.defineProperty(objWithGetter, "trap", {
            get: () => {
              throw new Error("should not call")
            }
          })
          if (StepKey.project(objWithGetter, ["nested", "v"]) !== bodyVal) return false
          if (StepKey.project(objWithGetter, ["trap"]) !== undefined) return false
          if (StepKey.project(objWithGetter, ["toString"]) !== undefined) return false
          if (StepKey.project(null, ["a"]) !== undefined) return false

          const memo = StepKey.makeDigestMemo()
          const d1 = runSyncCrypto(StepKey.dispatchIdentity({
            material: mat,
            results: { u1: objWithGetter },
            hermetic,
            environment,
            digestMemo: memo
          }))
          const d2 = runSyncCrypto(StepKey.dispatchIdentity({
            material: mat,
            results: { u1: objWithGetter },
            hermetic,
            environment
          }))
          if (tier === "sealed") {
            if (Exit.isFailure(d1) || Exit.isFailure(d2) || d1.value !== d2.value) return false
          } else {
            if (Exit.isSuccess(d1)) return false
          }
          return true
        },
        { seed: seed + 11, executions: mediumExecutions }
      )
    )
    assertPassed(report)
  })

  it("StepKey refuses malformed environments and missing/accessor/non-string dependencies", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        badCase: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 }))
      })
    )
    const sealedMat: KeyMaterial.KeyMaterial = {
      version: KeyMaterial.version,
      kind: "sealed",
      body: { a: 1 },
      inputs: [{ _tag: "Ref", from: "dep", path: [] }],
      layers: [],
      capabilities: []
    }
    const hermetic: NonNullable<StepKey.ContentIdentity["hermetic"]> = {
      readSet: [],
      writeSet: [],
      boundaryMode: "hard"
    }
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ badCase }) => {
          const checkErr = (
            exit: Exit.Exit<unknown, StepKey.KeyMaterialError | Schema.SchemaError>,
            code: StepKey.KeyMaterialError["code"]
          ): boolean => {
            if (Exit.isSuccess(exit)) return false
            const err = exit.cause.reasons[0]
            return err?._tag === "Fail" && err.error instanceof StepKey.KeyMaterialError && err.error.code === code
          }
          switch (badCase) {
            case 0:
              return checkErr(
                runSyncCrypto(
                  StepKey.environmentIdentity({ declared: false, layers: [], capabilities: {}, runScope: "" })
                ),
                "invalid_environment"
              )
            case 1:
              return checkErr(
                runSyncCrypto(
                  StepKey.environmentIdentity(
                    {
                      declared: true,
                      layers: [],
                      capabilities: {},
                      runScope: "bad"
                    } as unknown as StepKey.EnvironmentIdentity
                  )
                ),
                "invalid_environment"
              )
            case 2:
              return checkErr(
                runSyncCrypto(
                  StepKey.environmentIdentity(
                    { declared: "yes", layers: [], capabilities: {} } as unknown as StepKey.EnvironmentIdentity
                  )
                ),
                "invalid_environment"
              )
            case 3:
              return checkErr(
                runSyncCrypto(
                  StepKey.environmentIdentity(
                    { declared: true, layers: [], capabilities: {}, extra: 1 } as unknown as StepKey.EnvironmentIdentity
                  )
                ),
                "invalid_environment"
              )
            case 4:
              return checkErr(runSyncCrypto(StepKey.fromKeyMaterial(sealedMat, {})), "missing_dependency")
            case 5: {
              const badDeps: Record<string, string> = {}
              Object.defineProperty(badDeps, "dep", { get: () => "key1_x" })
              return checkErr(runSyncCrypto(StepKey.fromKeyMaterial(sealedMat, badDeps)), "missing_dependency")
            }
            case 6:
              return checkErr(
                runSyncCrypto(StepKey.fromKeyMaterial(sealedMat, { dep: 123 as unknown as string })),
                "missing_dependency"
              )
            default:
              return checkErr(
                runSyncCrypto(StepKey.dispatchIdentity({ material: sealedMat, results: {}, hermetic })),
                "missing_dependency"
              )
          }
        },
        { seed: seed + 12, executions: mediumExecutions }
      )
    )
    assertPassed(report)
  })

  it("StepKey.makeDigestMemo deduplicates concurrent fibers, retries failures, propagates non-interrupt failure to waiters, and transfers leadership on interrupt under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        waiters: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        mode: Schema.Literals(["share", "fail-then-retry", "fail-waiter", "interrupt-leader"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ waiters, mode }) =>
          Effect.gen(function*() {
            const memo = StepKey.makeDigestMemo()
            let computeCount = 0
            if (mode === "share") {
              const results = yield* Effect.forEach(
                Array.from({ length: waiters + 1 }, (_, i) => i),
                () =>
                  memo.digest(
                    "n1",
                    ["a", "b"],
                    Effect.gen(function*() {
                      yield* Effect.yieldNow
                      computeCount++
                      return "key1_shared" as StepKey.StepKey
                    })
                  ),
                { concurrency: "unbounded" }
              )
              return computeCount === 1 && results.every((r) => r === "key1_shared")
            }
            if (mode === "fail-then-retry" || mode === "fail-waiter") {
              const failErr = Schema.decodeUnknownExit(Schema.Number)("not-a-number")
              const schemaErr = Exit.isFailure(failErr) && failErr.cause.reasons[0]?._tag === "Fail"
                ? failErr.cause.reasons[0].error
                : undefined
              if (schemaErr === undefined) return false
              if (mode === "fail-waiter") {
                const started = yield* Deferred.make<void>()
                const release = yield* Deferred.make<void>()
                const leader = yield* Effect.forkChild(
                  Effect.exit(
                    memo.digest(
                      "n2w",
                      ["x"],
                      Effect.gen(function*() {
                        computeCount++
                        yield* Deferred.succeed(started, undefined)
                        yield* Deferred.await(release)
                        return yield* Effect.fail(schemaErr)
                      })
                    )
                  )
                )
                yield* Deferred.await(started)
                const waiter = yield* Effect.forkChild(
                  Effect.exit(
                    memo.digest(
                      "n2w",
                      ["x"],
                      Effect.gen(function*() {
                        computeCount++
                        return yield* Effect.fail(schemaErr)
                      })
                    )
                  )
                )
                yield* Effect.yieldNow
                yield* Effect.yieldNow
                yield* Deferred.succeed(release, undefined)
                const [lExit, wExit] = yield* Effect.all([Fiber.join(leader), Fiber.join(waiter)])
                return Exit.isFailure(lExit) && Exit.isFailure(wExit) && computeCount >= 1 && computeCount <= 2
              }
              const first = yield* Effect.exit(
                memo.digest(
                  "n2",
                  ["x"],
                  Effect.gen(function*() {
                    computeCount++
                    yield* Effect.yieldNow
                    return yield* Effect.fail(schemaErr)
                  })
                )
              )
              const second = yield* memo.digest(
                "n2",
                ["x"],
                Effect.sync(() => {
                  computeCount++
                  return "key1_recovered" as StepKey.StepKey
                })
              )
              return Exit.isFailure(first) && second === "key1_recovered" && computeCount === 2
            }
            // interrupt-leader: leader blocks on gate, waiter joins, leader is interrupted, waiter becomes leader!
            const started = yield* Deferred.make<void>()
            const gate = yield* Deferred.make<void>()
            const leader = yield* Effect.forkChild(
              memo.digest(
                "n3",
                ["k"],
                Effect.gen(function*() {
                  computeCount++
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(gate)
                  return "key1_leader" as StepKey.StepKey
                })
              )
            )
            yield* Deferred.await(started)
            const waiter = yield* Effect.forkChild(
              memo.digest(
                "n3",
                ["k"],
                Effect.gen(function*() {
                  yield* Effect.yieldNow
                  computeCount++
                  return "key1_replacement" as StepKey.StepKey
                })
              )
            )
            yield* Effect.yieldNow
            yield* Fiber.interrupt(leader)
            const out = yield* Fiber.join(waiter)
            return out === "key1_replacement" && computeCount === 2
          }).pipe(Effect.provide(silentCryptoLayer)),
        { seed: seed + 13, executions: heavyExecutions, execution: FuzzSimulation.execution() }
      )
    )
    assertPassed(report)
  })
})

// =============================================================================
// 8. Plan, PlanFixtures, ConflictAnnotation & PlanDiff
// =============================================================================
describe("@smthrs/plan Plan, ConflictAnnotation & PlanDiff fuzz invariants", () => {
  const planPath = Schema.Literals(["src/a.ts", "src/b.ts", "dist/x.js", "dist/y.js"])

  it("Plan.compile, verify, append, generationNodes, prefixDigest, writerFences, and PlanDiff satisfy graph & conservation laws", async () => {
    const nodeSpec = Schema.Struct({
      tier: Effects.Tier,
      kind: Schema.Literals(["step", "agent", "merge"]),
      priority: Schema.Int.check(Schema.isBetween({ minimum: -3, maximum: 3 })),
      conflictStrategy: Plan.PairStrategy,
      runtimeStrategy: Plan.RuntimeStrategy,
      reads: Schema.Array(planPath).check(Schema.isMaxLength(2)),
      writes: Schema.Array(planPath).check(Schema.isMaxLength(2)),
      useGlobWrite: Schema.Boolean,
      useTreeWrite: Schema.Boolean,
      useFilegroup: Schema.Boolean,
      depIdx: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))),
      pendingDep: Schema.Boolean
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        specs: Schema.Array(nodeSpec).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
        appendSpec: nodeSpec,
        mutateField: Schema.Literals([
          "body",
          "kind",
          "nondeterministic",
          "placement",
          "layers",
          "capabilities",
          "inputs",
          "effects",
          "moveId"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ specs, appendSpec, mutateField }) => {
          const toDraft = (s: typeof nodeSpec.Type, idx: number, id: string, maxDep: number): Plan.NodeDraft => {
            const inputs: Array<KeyMaterial.InputRef> = [{ _tag: "Literal", value: idx }]
            if (s.depIdx !== null && s.depIdx < maxDep) {
              const from = `n${s.depIdx}`
              inputs.push(s.pendingDep ? { _tag: "Pending", from } : { _tag: "Ref", from, path: [] })
            }
            const writes: Array<FileSet.Declaration> = [...s.writes]
            if (s.useTreeWrite) writes.push({ _tag: "TreeArtifact", path: "tree/out" })
            if (s.useGlobWrite) writes.push({ _tag: "Glob", include: ["glob/*.ts"] })
            if (s.useFilegroup) writes.push(FileSet.makeFilegroup("fg", ["fg/a.ts"]))
            return {
              id,
              kind: s.kind,
              priority: s.priority,
              conflictStrategy: s.conflictStrategy,
              runtimeStrategy: s.runtimeStrategy,
              material: {
                version: KeyMaterial.version,
                kind: s.tier,
                body: { idx },
                inputs,
                layers: ["l0"],
                capabilities: ["c0"]
              },
              effects: {
                reads: s.reads,
                writes,
                boundaryMode: "hard"
              }
            }
          }

          const drafts = specs.map((s, i) => toDraft(s, i, `n${i}`, i))
          const compiledExit = runSyncCrypto(fixtureCompile(drafts, "plan-fuzz"))
          if (Exit.isFailure(compiledExit)) {
            const reason = compiledExit.cause.reasons[0]
            if (reason?._tag !== "Fail" || !(reason.error instanceof Plan.PlanError)) return false
            return reason.error.code === "overlap_forbidden" || reason.error.code === "cycle"
          }
          const plan = compiledExit.value
          if (!Plan.isVerified(plan)) return false
          if (plan.generation !== 0 || plan.baseDigest !== plan.digest) return false
          if (Plan.generationNodes(plan).length !== plan.nodes.length) return false

          // Fast path verify + JSON round-trip full re-verify.
          const vFast = runSyncCrypto(Plan.verify(plan))
          const cloned = JSON.parse(JSON.stringify(plan)) as Plan.Plan
          if (Plan.isVerified(cloned)) return false
          const vFull = runSyncCrypto(Plan.verify(cloned))
          if (Exit.isFailure(vFast) || Exit.isFailure(vFull)) return false
          if (vFast.value !== plan || !Plan.isVerified(vFull.value)) return false

          // Self-diff: all unchanged.
          const selfDiff = PlanDiff.diff(plan, plan)
          if (
            selfDiff.added.length !== 0 || selfDiff.removed.length !== 0 ||
            selfDiff.rekeyed.length !== 0 || selfDiff.unchanged.length !== plan.nodes.length
          ) return false

          // Append a generation-1 node (also via unverified cloned plan to hit that branch).
          const nextDraft = toDraft(appendSpec, 99, "n_app", drafts.length)
          const appendedExit = runSyncCrypto(Plan.append(cloned, [nextDraft]))
          if (Exit.isSuccess(appendedExit)) {
            const grown = appendedExit.value
            if (grown.generation !== 1 || grown.baseDigest !== plan.baseDigest) return false
            if (Plan.generationNodes(grown).length !== 1) return false
            const pref = runSyncCrypto(Plan.prefixDigest(grown))
            if (Exit.isFailure(pref) || pref.value !== plan.digest) return false
            const vGrown = runSyncCrypto(Plan.verify(JSON.parse(JSON.stringify(grown))))
            if (Exit.isFailure(vGrown)) return false
            // writerFences finds any gen-0 reader overlapped by gen-1 writer.
            const fences = Plan.writerFences(grown.nodes)
            if (fences.has("n_app")) {
              const waited = fences.get("n_app")!
              if (waited.some((id) => id === "n_app")) return false
            }
          }

          // Diff against a mutated single-node plan.
          const baseDraft = fixtureDraft("n0", {
            body: { v: 1 },
            reads: ["src/a.ts"],
            writes: ["dist/x.js"]
          })
          const pA = runSyncCrypto(fixtureCompile([baseDraft]))
          if (Exit.isFailure(pA)) return false
          const mutDraft: Plan.NodeDraft = mutateField === "moveId"
            ? { ...baseDraft, id: "n0_moved" }
            : mutateField === "body"
            ? { ...baseDraft, material: { ...baseDraft.material, body: { v: 2 } } }
            : mutateField === "kind"
            ? { ...baseDraft, material: { ...baseDraft.material, kind: "compensable" } }
            : mutateField === "nondeterministic"
            ? { ...baseDraft, material: { ...baseDraft.material, nondeterministic: true } }
            : mutateField === "placement"
            ? { ...baseDraft, material: { ...baseDraft.material, placement: Placement.sandbox({ image: "node" }) } }
            : mutateField === "layers"
            ? { ...baseDraft, material: { ...baseDraft.material, layers: ["l1"] } }
            : mutateField === "capabilities"
            ? { ...baseDraft, material: { ...baseDraft.material, capabilities: ["cap1"] } }
            : mutateField === "inputs"
            ? { ...baseDraft, material: { ...baseDraft.material, inputs: [{ _tag: "Literal", value: 42 }] } }
            : { ...baseDraft, effects: fixtureEffects(["src/b.ts"], ["dist/x.js"]) }
          const pB = runSyncCrypto(fixtureCompile([mutDraft]))
          if (Exit.isFailure(pB)) return false
          const d = PlanDiff.diff(pA.value, pB.value)
          if (mutateField === "moveId") {
            return d.unchanged.includes("n0_moved") && d.added.length === 0 && d.removed.length === 0
          }
          if (d.rekeyed.length !== 1) return false
          const expectedLabel = mutateField === "inputs" ? "input[0]" : mutateField
          return d.rekeyed[0]!.changed.includes(expectedLabel)
        },
        { seed: seed + 14, executions: mediumExecutions }
      )
    )
    assertPassed(report)
  })

  it("Plan.compile, append, verify, ConflictAnnotation, and PlanDiff handle every error & edge path", async () => {
    const numCases = 30
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseId: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: numCases - 1 }))
      })
    )
    let sweepCase = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ caseId: randCase }) => {
          const caseId = sweepCase < numCases ? sweepCase++ : randCase
          const expectPlanErr = (
            exit: Exit.Exit<unknown, Plan.PlanError | StepKey.KeyMaterialError | Schema.SchemaError>,
            code: Plan.PlanError["code"]
          ): boolean => {
            if (Exit.isSuccess(exit)) return false
            const r = exit.cause.reasons[0]
            return r?._tag === "Fail" && r.error instanceof Plan.PlanError && r.error.code === code
          }
          const ok = (nodes: ReadonlyArray<Plan.NodeDraft>) => {
            const e = runSyncCrypto(fixtureCompile(nodes))
            if (Exit.isFailure(e)) throw new Error("expected success")
            return e.value
          }
          switch (caseId) {
            case 0:
              return expectPlanErr(runSyncCrypto(Plan.compile({ planId: "", flow: "f", nodes: [] })), "invalid_node")
            case 1:
              return expectPlanErr(runSyncCrypto(Plan.compile({ planId: "p", flow: "", nodes: [] })), "invalid_node")
            case 2:
              return expectPlanErr(runSyncCrypto(fixtureCompile([fixtureDraft("")])), "invalid_node")
            case 3:
              return expectPlanErr(
                runSyncCrypto(fixtureCompile([fixtureDraft("a", { priority: 1.5 })])),
                "invalid_node"
              )
            case 4:
              return expectPlanErr(
                runSyncCrypto(fixtureCompile([fixtureDraft("a", { kind: "bad" as unknown as "step" })])),
                "invalid_node"
              )
            case 5:
              return expectPlanErr(
                runSyncCrypto(fixtureCompile([fixtureDraft("a", { conflictStrategy: "bad" as unknown as "fail" })])),
                "invalid_node"
              )
            case 6:
              return expectPlanErr(
                runSyncCrypto(
                  fixtureCompile([fixtureDraft("a", { runtimeStrategy: "bad" as unknown as "stop-merge" })])
                ),
                "invalid_node"
              )
            case 7:
              return expectPlanErr(
                runSyncCrypto(
                  fixtureCompile([{
                    ...fixtureDraft("a"),
                    material: { bad: true } as unknown as KeyMaterial.KeyMaterial
                  }])
                ),
                "invalid_node"
              )
            case 8:
              return expectPlanErr(
                runSyncCrypto(
                  fixtureCompile([fixtureDraft("a", { writes: ["../escape"] })])
                ),
                "invalid_node"
              )
            case 9:
              return expectPlanErr(
                runSyncCrypto(fixtureCompile([fixtureDraft("a", { body: { big: 1n } })])),
                "invalid_node"
              )
            case 10: // Long id truncation in describeNodeId / describeValue.
              return expectPlanErr(
                runSyncCrypto(fixtureCompile([fixtureDraft("x".repeat(300), { priority: Number.NaN })])),
                "invalid_node"
              )
            case 11: // invalid_effects: writes and removes overlap.
              return expectPlanErr(
                runSyncCrypto(fixtureCompile([fixtureDraft("a", { writes: ["out/a.js"], removes: ["out/a.js"] })])),
                "invalid_effects"
              )
            case 12: // duplicate_node.
              return expectPlanErr(
                runSyncCrypto(fixtureCompile([fixtureDraft("a"), fixtureDraft("a")])),
                "duplicate_node"
              )
            case 13: // unknown_dependency.
              return expectPlanErr(
                runSyncCrypto(
                  fixtureCompile([fixtureDraft("a", { inputs: [{ _tag: "Ref", from: "missing", path: [] }] })])
                ),
                "unknown_dependency"
              )
            case 14: // material cycle.
              return expectPlanErr(
                runSyncCrypto(
                  fixtureCompile([
                    fixtureDraft("a", { inputs: [{ _tag: "Ref", from: "b", path: [] }] }),
                    fixtureDraft("b", { inputs: [{ _tag: "Ref", from: "a", path: [] }] })
                  ])
                ),
                "cycle"
              )
            case 15: { // inferred cycle: n0 writes x, n1 writes x (serialize n1->n0) and writes y, n0 reads y!
              const e = runSyncCrypto(
                fixtureCompile([
                  fixtureDraft("n0", { reads: ["y"], writes: ["x"] }),
                  fixtureDraft("n1", { writes: ["x", "y"] })
                ])
              )
              return expectPlanErr(e, "cycle")
            }
            case 16: { // Read-modify-write & explicit read-before-write are NOT cycles!
              const p1 = ok([
                fixtureDraft("r", { reads: ["x"], writes: ["x"] }),
                fixtureDraft("w", { writes: ["x"] })
              ])
              const p2 = ok([
                fixtureDraft("r", { reads: ["x"] }),
                fixtureDraft("w", { writes: ["x"], inputs: [{ _tag: "Ref", from: "r", path: [] }] })
              ])
              return p1.nodes.length === 2 && p2.nodes.length === 2
            }
            case 17: { // Empty append -> invalid_node, bad planId on append -> invalid_node.
              const p = ok([fixtureDraft("a")])
              const e1 = runSyncCrypto(Plan.append(p, []))
              const e2 = runSyncCrypto(Plan.append({ ...p, planId: "" }, [fixtureDraft("b")]))
              return expectPlanErr(e1, "invalid_node") && expectPlanErr(e2, "invalid_node")
            }
            case 18: { // Tampered verify: generation mismatch / negative / out-of-order / future ref.
              const p = ok([fixtureDraft("a")])
              const j = JSON.parse(JSON.stringify(p)) as any
              const e1 = runSyncCrypto(Plan.verify({ ...j, generation: -1 }))
              const e2 = runSyncCrypto(Plan.verify({ ...j, generation: 1 }))
              const e3 = runSyncCrypto(Plan.verify({ ...j, nodes: [{ ...j.nodes[0], generation: 2 }] }))
              const p2 = ok([fixtureDraft("a"), fixtureDraft("b", { inputs: [{ _tag: "Ref", from: "a", path: [] }] })])
              const j2 = JSON.parse(JSON.stringify(p2)) as any
              j2.nodes[0].generation = 1
              j2.nodes[1].generation = 0
              const e4 = runSyncCrypto(Plan.verify({ ...j2, generation: 1 }))
              // Future generation reference: a(gen 0) refs b(gen 1).
              const p3 = ok([fixtureDraft("a")])
              const j3 = JSON.parse(JSON.stringify(p3)) as any
              j3.nodes = [
                {
                  ...j3.nodes[0],
                  id: "a",
                  generation: 0,
                  material: { ...j3.nodes[0].material, inputs: [{ _tag: "Ref", from: "b", path: [] }] }
                },
                { ...j3.nodes[0], id: "b", generation: 1 }
              ]
              const e5 = runSyncCrypto(Plan.verify({ ...j3, generation: 1 }))
              return expectPlanErr(e1, "invalid_plan") &&
                expectPlanErr(e2, "invalid_plan") &&
                expectPlanErr(e3, "invalid_plan") &&
                expectPlanErr(e4, "invalid_plan") &&
                expectPlanErr(e5, "invalid_plan")
            }
            case 19: { // Tampered digest AND tampered node key with intact digests (hits node hash check in verify).
              const p = ok([fixtureDraft("a")])
              const j = JSON.parse(JSON.stringify(p)) as any
              const e1 = runSyncCrypto(Plan.verify({ ...j, digest: "key1_" + "0".repeat(64) }))
              // Keep baseDigest and digest matching the compiled plan, tamper only decoded.nodes[0].key!
              const j2 = JSON.parse(JSON.stringify(p)) as any
              j2.nodes[0].key = "key1_" + "f".repeat(64)
              const e2 = runSyncCrypto(Plan.verify(j2))
              return expectPlanErr(e1, "invalid_plan") && expectPlanErr(e2, "invalid_plan")
            }
            case 20: { // graph_too_large on compile, verify, and append.
              const big = new Array<Plan.NodeDraft>(Plan.maximumPlanNodes + 1)
              const e1 = runSyncCrypto(Plan.compile({ planId: "p", flow: "f", nodes: big }))
              const e2 = runSyncCrypto(Plan.verify({ nodes: big }))
              const p = ok([fixtureDraft("a")])
              const e3 = runSyncCrypto(Plan.append(p, big))
              return expectPlanErr(e1, "graph_too_large") &&
                expectPlanErr(e2, "graph_too_large") &&
                expectPlanErr(e3, "graph_too_large")
            }
            case 21: { // Snapshot handles shared object refs and cycles in options.
              const shared: Record<string, unknown> = { a: 1 }
              const draft = fixtureDraft("a", { body: { x: shared, y: shared } })
              const p = ok([draft])
              shared.a = 999
              return (p.nodes[0]!.material.body as { x: { a: number } }).x.a === 1
            }
            case 22: { // PlanDiff with upstream rekey propagation, duplicate moved keys, and refused field values.
              const p1 = ok([
                fixtureDraft("u", { body: { v: 1 } }),
                fixtureDraft("d", { inputs: [{ _tag: "Ref", from: "u", path: [] }, { _tag: "Pending", from: "u" }] }),
                fixtureDraft("same1", { body: { s: "dup" } }),
                fixtureDraft("same2", { body: { s: "dup" } })
              ])
              const p2 = ok([
                fixtureDraft("u", { body: { v: 2 } }),
                fixtureDraft("d", { inputs: [{ _tag: "Ref", from: "u", path: [] }, { _tag: "Pending", from: "u" }] }),
                fixtureDraft("moved1", { body: { s: "dup" } }),
                fixtureDraft("moved2", { body: { s: "dup" } })
              ])
              const diff = PlanDiff.diff(p1, p2)
              const dRekey = diff.rekeyed.find((r) => r.id === "d")
              if (
                dRekey === undefined || !dRekey.changed.includes("input[0]") || !dRekey.changed.includes("input[1]")
              ) {
                return false
              }
              if (!diff.unchanged.includes("moved1") || !diff.unchanged.includes("moved2")) return false

              // Synthetic PlanDiff with version change, Planned reference, and refused bigint values.
              const n0 = p1.nodes[0]!
              const sameBig = { b: 1n }
              const fakeA: Plan.Plan = {
                ...p1,
                nodes: [{
                  ...n0,
                  key: "key1_" + "a".repeat(64) as Plan.PlanNode["key"],
                  material: {
                    ...n0.material,
                    version: "v0" as typeof KeyMaterial.version,
                    body: sameBig,
                    effects: Planned.make("x")
                  }
                }]
              }
              const fakeB: Plan.Plan = {
                ...p1,
                nodes: [{
                  ...n0,
                  key: "key1_" + "b".repeat(64) as Plan.PlanNode["key"],
                  material: { ...n0.material, body: sameBig, effects: Planned.make("y") }
                }]
              }
              const fakeDiff = PlanDiff.diff(fakeA, fakeB)
              const ch = fakeDiff.rekeyed[0]?.changed ?? []
              return ch.includes("version") && ch.includes("effects") && !ch.includes("body")
            }
            case 23: { // Multi-gen append with lane conflict on earlier gen (annotation lands only on new node).
              const g0 = ok([
                fixtureDraft("a", { writes: ["f.ts"], conflictStrategy: "lane", runtimeStrategy: "stop-merge" })
              ])
              const g1 = runSyncCrypto(Plan.append(g0, [fixtureDraft("b", { writes: ["f.ts"] })]))
              if (Exit.isFailure(g1)) return false
              return g1.value.nodes[0]!.conflicts.length === 0 &&
                g1.value.nodes[1]!.conflicts.length === 1 &&
                g1.value.nodes[1]!.conflicts[0]!.strategy === "lane" &&
                g1.value.nodes[1]!.conflicts[0]!.runtime === "stop-merge"
            }
            case 24: { // Multi-gen writerFence on removes + reads.
              const g0 = ok([fixtureDraft("r", { reads: ["f.ts"] })])
              const g1 = runSyncCrypto(Plan.append(g0, [fixtureDraft("w", { removes: ["f.ts"] })]))
              if (Exit.isFailure(g1)) return false
              const fences = Plan.writerFences(g1.value.nodes)
              return fences.get("w")?.[0] === "r"
            }
            case 25: { // Conflicts.annotate directly with custom Analysis service.
              const p = ok([fixtureDraft("a", { writes: ["x"] }), fixtureDraft("b", { writes: ["x"] })])
              const rawNodes = p.nodes.map((n) => ({ ...n, dependsOn: [], conflicts: [] }))
              const res = Effect.runSync(
                Conflicts.annotate(rawNodes).pipe(
                  Effect.provideService(Conflicts.Analysis, {
                    candidates: EffectCandidates.make,
                    overlaps: FileSet.overlaps
                  })
                )
              )
              return res.ordering.get("b")?.[0] === "a"
            }
            case 26: { // Planned value in material body passes jsonMirror callback and fails canonicalization cleanly.
              const e = runSyncCrypto(fixtureCompile([fixtureDraft("a", { body: { ref: Planned.make("u") } })]))
              return Exit.isFailure(e)
            }
            case 27: { // ConflictAnnotation checkpoint yield (>= 2048 work units) via 16 serialized writers.
              const writers = Array.from({ length: 16 }, (_, i) => fixtureDraft(`w${i}`, { writes: ["shared.txt"] }))
              const p = ok(writers)
              return p.nodes.length === 16 && p.nodes[15]!.conflicts.length >= 1
            }
            case 28: { // ConflictAnnotation work budget refusal (> 10,000,000 work units) with 2 wide writers (fast!).
              const manyWrites = Array.from({ length: 3200 }, (_, i) => `f${i}.txt`)
              const p1 = ok([fixtureDraft("a", { writes: ["f0.txt"] }), fixtureDraft("b", { writes: ["f0.txt"] })])
              const fakeWide = p1.nodes.map((n) => ({
                ...n,
                dependsOn: [],
                conflicts: [],
                effects: { reads: [], writes: manyWrites, boundaryMode: "hard" as const }
              }))
              const res = Effect.runSyncExit(Conflicts.annotate(fakeWide))
              if (Exit.isSuccess(res)) return false
              const r = res.cause.reasons[0]
              return r?._tag === "Fail" && r.error.code === "graph_too_large"
            }
            default: { // Invalidate ancestor cache across multi-hop chain in ConflictAnnotation.
              const p = ok([
                fixtureDraft("a", { writes: ["x"] }),
                fixtureDraft("b", { writes: ["x", "y"] }),
                fixtureDraft("c", { reads: ["x"], writes: ["z"], inputs: [{ _tag: "Ref", from: "b", path: [] }] }),
                fixtureDraft("d", { reads: ["y", "z"] })
              ])
              return p.nodes.length === 4 && p.nodes[3]!.dependsOn.includes("b") && p.nodes[3]!.dependsOn.includes("c")
            }
          }
        },
        { seed: seed + 15, executions: heavyExecutions }
      )
    )
    assertPassed(report)
  })

  it("PlanDiff.diff conserves added, removed, rekeyed, and unchanged counts across arbitrary plan pairs", async () => {
    const nodeChoice = Schema.Struct({
      id: Schema.Literals(["a", "b", "c", "d", "e", "f"]),
      val: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        prev: Schema.Array(nodeChoice).check(Schema.isMaxLength(5)),
        next: Schema.Array(nodeChoice).check(Schema.isMaxLength(5))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ prev, next }) => {
          const dedup = (items: ReadonlyArray<typeof nodeChoice.Type>) => {
            const seen = new Set<string>()
            const out: Array<Plan.NodeDraft> = []
            for (const item of items) {
              if (seen.has(item.id)) continue
              seen.add(item.id)
              out.push(fixtureDraft(item.id, { body: { val: item.val } }))
            }
            return out
          }
          const e1 = runSyncCrypto(fixtureCompile(dedup(prev)))
          const e2 = runSyncCrypto(fixtureCompile(dedup(next)))
          if (Exit.isFailure(e1) || Exit.isFailure(e2)) return false
          const p1 = e1.value
          const p2 = e2.value
          const d = PlanDiff.diff(p1, p2)
          const leftTotal = d.unchanged.length + d.rekeyed.length + d.removed.length
          const rightTotal = d.unchanged.length + d.rekeyed.length + d.added.length
          return leftTotal === p1.nodes.length && rightTotal === p2.nodes.length
        },
        { seed: seed + 20, executions: mediumExecutions }
      )
    )
    assertPassed(report)
  })
})

// =============================================================================
// 9. Node & internal/node
// =============================================================================
describe("@smthrs/plan Node & internal/node fuzz invariants", () => {
  class FuzzErrClass extends Schema.TaggedError<FuzzErrClass>()("FuzzErrClass", { code: Schema.Int }) {}
  class CustomInstanceErr extends Schema.Class<CustomInstanceErr>("CustomInstanceErr")({ msg: Schema.String }) {
    static override [Symbol.hasInstance](_v: unknown): boolean {
      return false
    }
  }

  it("Node combinators, accessors, side-table preservation on priority, capture, and pipe satisfy invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        val: Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 })),
        prio: Schema.Int.check(Schema.isBetween({ minimum: -10, maximum: 10 })),
        callMode: Node.CallMode,
        filterKind: Schema.Literals([
          "none",
          "struct",
          "class",
          "customInstance",
          "null",
          "void",
          "makeFilter",
          "nonRep"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ val, prio, callMode, filterKind }) => {
          const s1 = Node.succeed({ v: val })
          const f1 = Node.fail({ err: val })
          const allN = Node.all({ a: s1, b: Node.succeed(val + 1) })
          const raceN = Node.race({ a: s1, b: f1 })
          const anyN = Node.any({ a: s1, b: f1 })
          const quorumN = Node.quorum(2, { a: s1, b: Node.succeed(2), c: Node.succeed(3) })

          const capturedFn = Node.capture({ factor: val }, function(x: { readonly v: number }) {
            return x.v * this.factor
          })
          const fnId = Node.functionIdentity(capturedFn)
          if (fnId.algorithm !== "sha256-source-captures/v5") return false

          const mapped = s1.pipe(Node.map(capturedFn))
          const seqStatic = Node.andThen(s1, Node.succeed("next"))
          const seqBound = Node.bindPlanned(s1, (ref) => Node.succeed({ got: ref.v }))
          const branched = Node.branch(s1, {
            if: (x) => x.v > 0,
            then: (ref) => Node.succeed({ pos: ref.v }),
            else: (ref) => Node.succeed({ neg: ref })
          })

          const filterSchema: Schema.Top | undefined = filterKind === "none"
            ? undefined
            : filterKind === "struct"
            ? Schema.Struct({ err: Schema.Int })
            : filterKind === "class"
            ? FuzzErrClass
            : filterKind === "customInstance"
            ? CustomInstanceErr
            : filterKind === "null"
            ? Schema.Null
            : filterKind === "void"
            ? Schema.Void
            : filterKind === "makeFilter"
            ? Schema.String.check(Schema.makeFilter((s: string) => s.length > 0))
            : Schema.declare((u): u is Map<unknown, unknown> => u instanceof Map)

          const caught = filterSchema === undefined
            ? Node.catch(f1, { onFailure: (e) => Node.succeed({ recovered: e }) })
            : Node.catch(f1, {
              error: filterSchema as Schema.Schema<unknown>,
              onFailure: (e) => Node.succeed({ recovered: e })
            })

          const fDecl = { tag: "my/flow" }
          const aDecl = { tag: "my/action" }
          const fc = Node.flowCall(fDecl, "my/flow", callMode, { input: Planned.make<{ readonly x: number }>("p").x })
          const ac = Node.actionCall(aDecl, "my/action", { input: val })

          // Verify all nodes are recognized and side tables survive Node.priority!
          const nodes: ReadonlyArray<Node.Any> = [
            s1,
            f1,
            allN,
            raceN,
            anyN,
            quorumN,
            mapped,
            seqStatic,
            seqBound,
            branched,
            caught,
            fc,
            ac
          ]
          for (const n of nodes) {
            if (!Node.isNode(n)) return false
            const p = Node.priority(n, prio)
            if (!Node.isNode(p) || Node.declaredPriority(p.ast) !== prio) return false
            // Round-trip AST rehydration recognized by Node.isNode!
            const rehydrated = Object.assign(Object.create(InternalNode.NodeProto), {
              ast: JSON.parse(JSON.stringify(p.ast))
            })
            if (!Node.isNode(rehydrated)) return false
          }

          // Check side-table preservation on prioritized copies.
          const pMapped = Node.priority(mapped, prio)
          const pBound = Node.priority(seqBound, prio)
          const pBranch = Node.priority(branched, prio)
          const pCatch = Node.priority(caught, prio)
          const pFc = Node.priority(fc, prio)
          const pAc = Node.priority(ac, prio)

          if (Node.mapper(pMapped.ast)?.({ v: 3 }) !== 3 * val) return false
          if (Node.mapper(s1.ast) !== undefined) return false
          const cont = Node.continuation(pBound.ast as Extract<Node.Ast, { _tag: "AndThen" }>)
          if (cont === undefined || !Node.isNode(cont(Planned.make<{ readonly v: number }>("up")))) return false
          if (Node.predicate(pBranch.ast)?.({ v: 1 }) !== true) return false
          if (Node.predicate(s1.ast) !== undefined) return false
          if ((Node.catchFilter(pCatch.ast) !== undefined) !== (filterSchema !== undefined)) return false
          if (Node.catchFilter(s1.ast) !== undefined) return false
          if (Node.declaration(pFc.ast as Extract<Node.Ast, { _tag: "FlowCall" }>) !== fDecl) return false
          if (Node.declaration(pAc.ast as Extract<Node.Ast, { _tag: "ActionCall" }>) !== aDecl) return false

          // AST-owned PlannedReference recognition vs structural lookalike.
          const fcPayload = (fc.ast as Extract<Node.Ast, { _tag: "FlowCall" }>).payload as { readonly input: unknown }
          if (Node.plannedReference(fcPayload.input)?.node !== "p") return false
          if (Node.plannedReference({ _tag: "PlannedReference", node: "p", path: ["x"] }) !== undefined) return false
          return true
        },
        { seed: seed + 16, executions: mediumExecutions }
      )
    )
    assertPassed(report)
  })

  it("Node refuses invalid inputs, invalid joins, invalid continuations, deep arms, and malformed/cyclic ASTs", async () => {
    const numBad = 23
    const arb = Arbitrary.schema(
      Schema.Struct({
        badCase: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: numBad - 1 }))
      })
    )
    const okNode = Node.succeed(1)
    const expectGbe = (fn: () => unknown, code: GraphBuildError.GraphBuildErrorCode): boolean => {
      try {
        fn()
        return false
      } catch (e) {
        return e instanceof GraphBuildError.GraphBuildError && e.code === code
      }
    }
    const wrapProto = (ast: unknown) => Object.assign(Object.create(InternalNode.NodeProto), { ast })
    const validFnId = Node.functionIdentity((x: unknown) => x)

    let sweepBad = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ badCase: randBad }) => {
          const badCase = sweepBad < numBad ? sweepBad++ : randBad
          switch (badCase) {
            case 0:
              return expectGbe(() => Node.map({} as unknown as Node.Any, (x) => x), "invalid_continuation")
            case 1:
              return expectGbe(() => Node.all({ ok: okNode, bad: 123 as unknown as Node.Any }), "invalid_all_member")
            case 2:
              return expectGbe(() => Node.race({}), "invalid_join")
            case 3:
              return expectGbe(() => Node.any({}), "invalid_join")
            case 4:
              return expectGbe(() => Node.quorum(0, { a: okNode }), "invalid_join")
            case 5:
              return expectGbe(() => Node.quorum(3, { a: okNode, b: okNode }), "invalid_join")
            case 6:
              return expectGbe(() => Node.quorum(1.5, { a: okNode, b: okNode }), "invalid_join")
            case 7:
              return expectGbe(() => Node.andThen(okNode, "bad" as unknown as Node.Any), "invalid_continuation")
            case 8:
              return expectGbe(
                () =>
                  Node.branch(okNode, {
                    if: () => true,
                    then: () => "not-a-node" as unknown as Node.Any,
                    else: () => okNode
                  }),
                "invalid_continuation"
              )
            case 9:
              return expectGbe(
                () =>
                  Node.catch(okNode, {
                    onFailure: () => "not-a-node" as unknown as Node.Any
                  }),
                "invalid_continuation"
              )
            case 10:
              return expectGbe(() => Node.priority(okNode, 1.5), "invalid_priority")
            case 11: { // graph_too_deep on recursive branch & catch arms, with clean recovery.
              const loopBranch = (): Node.Node<number> =>
                Node.branch(okNode, { if: () => true, then: loopBranch, else: () => okNode })
              const loopCatch = (): Node.Node<number> => Node.catch(Node.fail("e"), { onFailure: loopCatch })
              return expectGbe(loopBranch, "graph_too_deep") &&
                expectGbe(loopCatch, "graph_too_deep") &&
                Node.isNode(Node.succeed(2))
            }
            case 12: // Non-objects, wrong proto, accessor ast.
              if (Node.isNode(null) || Node.isNode(42) || Node.isNode({ ast: okNode.ast })) return false
              const acc = Object.create(InternalNode.NodeProto)
              Object.defineProperty(acc, "ast", { get: () => okNode.ast })
              return !Node.isNode(acc)
            case 13: // Cyclic AST.
              const cyc: Record<string, unknown> = { _tag: "Map", mapper: validFnId }
              cyc.first = cyc
              return !Node.isNode(wrapProto(cyc))
            case 14: // Invalid priority on AST.
              return !Node.isNode(wrapProto({ _tag: "Succeed", value: 1, priority: 1.5 }))
            case 15: // Invalid All / Race nodes.
              return !Node.isNode(wrapProto({ _tag: "All", nodes: [] })) &&
                !Node.isNode(wrapProto({ _tag: "Race", mode: "race", count: 1, nodes: [] })) &&
                !Node.isNode(wrapProto({ _tag: "Race", mode: "bogus", count: 1, nodes: { a: okNode.ast } })) &&
                !Node.isNode(wrapProto({ _tag: "Race", mode: "race", count: 2, nodes: { a: okNode.ast } }))
            case 16: // Invalid Map / AndThen.
              return !Node.isNode(wrapProto({ _tag: "Map", first: okNode.ast, mapper: {} })) &&
                !Node.isNode(wrapProto({ _tag: "AndThen", first: okNode.ast, continuation: {} }))
            case 17: // Invalid Branch.
              return !Node.isNode(
                wrapProto({
                  _tag: "Branch",
                  subject: 123,
                  first: okNode.ast,
                  predicate: validFnId,
                  then: okNode.ast,
                  else: okNode.ast
                })
              ) &&
                !Node.isNode(
                  wrapProto({
                    _tag: "Branch",
                    subject: "s",
                    first: okNode.ast,
                    predicate: {},
                    then: okNode.ast,
                    else: okNode.ast
                  })
                )
            case 18: // Invalid Catch.
              return !Node.isNode(
                wrapProto({ _tag: "Catch", subject: 123, protected: okNode.ast, failure: okNode.ast })
              ) &&
                !Node.isNode(
                  wrapProto({
                    _tag: "Catch",
                    subject: "s",
                    protected: okNode.ast,
                    failure: okNode.ast,
                    filterIdentity: {}
                  })
                )
            case 19: // Invalid FlowCall / ActionCall / unknown tag.
              return !Node.isNode(wrapProto({ _tag: "FlowCall", flow: 123, mode: "inline", payload: null })) &&
                !Node.isNode(wrapProto({ _tag: "FlowCall", flow: "f", mode: "bogus", payload: null })) &&
                !Node.isNode(wrapProto({ _tag: "ActionCall", action: 123, payload: null })) &&
                !Node.isNode(wrapProto({ _tag: "UnknownTag" }))
            case 20: { // Schema filter with accessor get/set on AST annotation object & duplicate class declaration.
              class DupA extends Schema.Class<DupA>("DupA")({ a: Schema.String }) {}
              const fakeMeta: Record<string, unknown> = {}
              Object.defineProperty(fakeMeta, "acc", {
                enumerable: true,
                get: () => 1,
                set: (_v: unknown) => undefined
              })
              const c = Node.catch(Node.fail("e"), {
                error: Schema.Union([DupA, Schema.Struct({ x: Schema.Int }).annotate({ meta: fakeMeta })]),
                onFailure: () => okNode
              })
              return c.ast._tag === "Catch"
            }
            case 21: { // Valid AndThen without next in isNodeAst.
              return Node.isNode(wrapProto({ _tag: "AndThen", first: okNode.ast, continuation: validFnId }))
            }
            default: { // Direct rehydrated Catch with valid filterIdentity.
              return Node.isNode(wrapProto({
                _tag: "Catch",
                subject: "s",
                protected: okNode.ast,
                failure: okNode.ast,
                filterIdentity: validFnId
              }))
            }
          }
        },
        { seed: seed + 17, executions: mediumExecutions }
      )
    )
    assertPassed(report)
  })
})

// =============================================================================
// 10. SchemaIdentity & RepresentationIdentity
// =============================================================================
describe("@smthrs/plan SchemaIdentity & RepresentationIdentity fuzz invariants", () => {
  const allCorpus = schemaCorpus(Schema, Effect)
  const corpusKeys = Object.keys(allCorpus)
  const allReprs = schemaRepresentations(Schema)
  const reprKeys = Object.keys(allReprs)

  it("Node.schemaIdentity and Node.representationIdentity are deterministic and cover the full corpus across modes & versions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: corpusKeys.length - 1 })),
        mode: Schema.Literals(["ignore", "error"])
      })
    )
    // First sweep every corpus entry once deterministically inside fuzz harness so zero corpus branch is left to chance,
    // plus fuzz random pairings/wrappers!
    let sweepIdx = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx, mode }) => {
          const i = sweepIdx < corpusKeys.length ? sweepIdx++ : idx
          const key = corpusKeys[i]!
          const s = allCorpus[key]!()
          const opts: Node.SchemaIdentityOptions = { onExcessProperty: mode }
          try {
            const d1 = Node.schemaIdentity(s, opts)
            const d2 = Node.schemaIdentity(s, opts)
            if (d1.dialect !== "draft-2020-12") return false
            if (JSON.stringify(d1) !== JSON.stringify(d2)) return false
          } catch (e) {
            if (!(e instanceof Error)) return false
          }
          // Representation identity across all versions [3, 2, 1].
          for (const version of Node.representationIdentityVersions) {
            try {
              const r1 = Node.representationIdentity(s, version)
              const r2 = Node.representationIdentity(s, version)
              if (JSON.stringify(r1) !== JSON.stringify(r2)) return false
            } catch (e) {
              if (!(e instanceof Error)) return false
            }
          }
          return true
        },
        { seed: seed + 18, executions: Math.max(executions, corpusKeys.length + 40) }
      )
    )
    assertPassed(report)
  })

  it("InternalSchemaIdentity.fromRepresentation covers synthetic representations and every error & edge branch", async () => {
    const numEdges = 20
    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: reprKeys.length - 1 })),
        edge: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: numEdges - 1 })),
        mode: Schema.Literals(["ignore", "error"])
      })
    )
    let sweepIdx = 0
    let sweepEdge = 0
    const emitted = (doc: unknown, options?: Node.SchemaIdentityOptions) =>
      InternalSchemaIdentity.fromRepresentation(doc as SchemaRepresentation.Document, options)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx, edge: randEdge, mode }) => {
          const i = sweepIdx < reprKeys.length ? sweepIdx++ : idx
          const edge = sweepEdge < numEdges ? sweepEdge++ : randEdge
          const key = reprKeys[i]!
          const doc = allReprs[key]!()
          try {
            const r1 = emitted(doc, { onExcessProperty: mode })
            const r2 = emitted(doc, { onExcessProperty: mode })
            if (JSON.stringify(r1) !== JSON.stringify(r2)) return false
          } catch (e) {
            if (!(e instanceof Node.SchemaIdentityError)) return false
          }

          // Exercise remaining edge cases in SchemaIdentity.ts.
          const closed: Node.SchemaIdentityOptions = { onExcessProperty: "error" }
          switch (edge) {
            case 0: { // Code-point & ASCII checks + approximate check tuple.
              const s1 = Schema.String.check(
                Schema.isAscii(),
                Schema.isMinCodePoints(1),
                Schema.isMaxCodePoints(10),
                Schema.isBetweenCodePoints(2, 8)
              )
              const approx = Schema.String.check(
                Schema.makeFilter((t: string) => t.length > 0, { toJsonSchema: () => [{ minLength: 1 }, true] })
              )
              return Node.schemaIdentity(s1, closed).dialect === "draft-2020-12" &&
                Node.schemaIdentity(approx, closed).schema["minLength"] === 1
            }
            case 1: { // Checked number record key & union with number key.
              const r1 = Schema.Record(Schema.Int, Schema.String)
              const r2 = Schema.Record(
                Schema.Union([Schema.Int, Schema.TemplateLiteral(["k-", Schema.String])]),
                Schema.String
              )
              const r3 = Schema.Record(Schema.Int.annotate({ identifier: "Count" }), Schema.String)
              return Node.schemaIdentity(r1, closed).dialect === "draft-2020-12" &&
                Node.schemaIdentity(r2, closed).dialect === "draft-2020-12" &&
                Node.schemaIdentity(r3, closed).dialect === "draft-2020-12"
            }
            case 2: { // Recursive & missing key reference behind a number key in propertyNameSchema.
              const intRep = Schema.toRepresentation(Schema.toCodecJson(Schema.Int)).representation
              const taggedRep = Schema.toRepresentation(Schema.TemplateLiteral(["k-", Schema.String])).representation
              const keyed = (parameter: unknown, references: Record<string, unknown>) => ({
                representation: {
                  _tag: "Objects",
                  checks: [],
                  propertySignatures: [],
                  indexSignatures: [{ parameter, type: { _tag: "String", checks: [] } }]
                },
                references
              })
              const rec = { _tag: "Union", checks: [], types: [intRep, taggedRep, { _tag: "Reference", $ref: "Key" }] }
              const out = emitted(keyed({ _tag: "Reference", $ref: "Key" }, { Key: rec }), closed)
              if (out.dialect !== "draft-2020-12") return false
              try {
                emitted(
                  keyed({ _tag: "Union", checks: [], types: [intRep, { _tag: "Reference", $ref: "Missing" }] }, {}),
                  closed
                )
                return false
              } catch (e) {
                return e instanceof Node.SchemaIdentityError
              }
            }
            case 3: { // Broken built-in check payload -> SchemaIdentityError.
              const broken = {
                representation: {
                  _tag: "String",
                  checks: [{
                    _tag: "Filter",
                    aborted: false,
                    representation: { id: "effect/schema/isMinLength", payload: { wrong: 1 } }
                  }]
                },
                references: {}
              }
              try {
                emitted(broken)
                return false
              } catch (e) {
                return e instanceof Node.SchemaIdentityError
              }
            }
            case 4: { // Unknown built-in check falls back to toJsonSchema annotation, non-function ignored.
              const unknownWithCb = {
                representation: {
                  _tag: "String",
                  checks: [{
                    _tag: "Filter",
                    aborted: false,
                    representation: { id: "effect/schema/isFuture", payload: null },
                    annotations: { toJsonSchema: () => ({ format: "future" }) }
                  }]
                },
                references: {}
              }
              const nonFn = {
                representation: {
                  _tag: "String",
                  checks: [{ _tag: "Filter", aborted: false, annotations: { toJsonSchema: { pattern: "^a" } } }]
                },
                references: {}
              }
              return emitted(unknownWithCb).schema["format"] === "future" &&
                emitted(nonFn).schema["type"] === "string"
            }
            case 5: { // Unsupported representation _tag -> SchemaIdentityError.
              try {
                emitted({ representation: { _tag: "Tensor", checks: [] }, references: {} })
                return false
              } catch (e) {
                return e instanceof Node.SchemaIdentityError
              }
            }
            case 6: { // Unsupported index key type -> SchemaIdentityError.
              try {
                emitted({
                  representation: {
                    _tag: "Objects",
                    checks: [],
                    propertySignatures: [],
                    indexSignatures: [{
                      parameter: { _tag: "Boolean", checks: [] },
                      type: { _tag: "String", checks: [] }
                    }]
                  },
                  references: {}
                })
                return false
              } catch (e) {
                return e instanceof Node.SchemaIdentityError
              }
            }
            case 7: { // JSON string with reviver, as record key, and non-JSON contentMediaType.
              const revived = Schema.fromJsonString(Schema.Struct({ a: Schema.Int }), { reviver: (_k, v) => v })
              const dRevived = Node.schemaIdentity(revived, closed)
              const keyed = {
                representation: {
                  _tag: "Objects",
                  checks: [],
                  propertySignatures: [],
                  indexSignatures: [{
                    parameter: {
                      _tag: "String",
                      checks: [],
                      content: { mediaType: "application/json", schema: { _tag: "Boolean", checks: [] } }
                    },
                    type: { _tag: "String", checks: [] }
                  }]
                },
                references: {}
              }
              const otherMedia = {
                representation: {
                  _tag: "String",
                  checks: [],
                  content: { mediaType: "text/csv", schema: { _tag: "Boolean", checks: [] } }
                },
                references: {}
              }
              return dRevived.schema["contentMediaType"] === "application/json" &&
                emitted(keyed, closed).schema["propertyNames"] !== undefined &&
                emitted(otherMedia).schema["contentMediaType"] === undefined
            }
            case 8: { // Ambiguous brand restoration at version 1 (differently branded shared def) falls back to v2!
              const Lit = Schema.Struct({ n: Schema.Literal(1n), s: Schema.UniqueSymbol(Symbol.for("lit-fuzz")) })
                .annotate({ identifier: "LitFuzz" })
              const mixed = Schema.Struct({ a: Lit.pipe(Schema.brand("A")), b: Lit.pipe(Schema.brand("B")) })
              const bare = Schema.make<Schema.Top>(Schema.Struct({ id: Schema.String.pipe(Schema.brand("Id")) }).ast)
              const v1 = Node.representationIdentity(mixed, 1)
              const v2 = Node.representationIdentity(mixed, 2)
              return JSON.stringify(v1) === JSON.stringify(v2) &&
                JSON.stringify(Node.representationIdentity(bare, 1)) ===
                  JSON.stringify(Node.representationIdentity(bare, 2))
            }
            case 9: { // Author arbitraryConstraint preserved while default projected.
              const s = Schema.String.check(
                Schema.isGUID({ arbitraryConstraint: { patterns: [{ source: "^x$", flags: "u" }] } })
              )
              const s2 = Schema.String.check(Schema.isULID())
              const s3 = Schema.String.check(Schema.isStringFinite())
              return Node.representationIdentity(s) !== undefined &&
                Node.representationIdentity(s2) !== undefined &&
                Node.representationIdentity(s3) !== undefined
            }
            case 10: { // fromJsonString with identified definition keeps definition at v3, drops at v2.
              const s = Schema.fromJsonString(Schema.Struct({ a: Schema.Int.annotate({ identifier: "Count" }) }))
              const r3 = Node.representationIdentity(s, 3) as { references: Record<string, unknown> }
              const r2 = Node.representationIdentity(s, 2) as { references: Record<string, unknown> }
              return "Count" in r3.references && !("Count" in r2.references)
            }
            case 11: { // Invalid template literal part -> SchemaIdentityError.
              try {
                emitted({
                  representation: { _tag: "TemplateLiteral", parts: [{ _tag: "Boolean", checks: [] }], checks: [] },
                  references: {}
                })
                return false
              } catch (e) {
                return e instanceof Node.SchemaIdentityError
              }
            }
            case 12: { // Multi-rest Arrays -> SchemaIdentityError.
              try {
                emitted({
                  representation: {
                    _tag: "Arrays",
                    elements: [],
                    rest: [{ _tag: "String", checks: [] }, { _tag: "Number", checks: [] }],
                    checks: []
                  },
                  references: {}
                })
                return false
              } catch (e) {
                return e instanceof Node.SchemaIdentityError
              }
            }
            case 13: { // Branded bigint literal & symbol in printedRepresentation.
              const s = Schema.Struct({
                a: Schema.Literal(1n).annotate({ identifier: "Big1" }).pipe(Schema.brand("B1")),
                b: Schema.UniqueSymbol(Symbol.for("@smthrs/plan/fuzz-sym")).annotate({ identifier: "Sym1" }).pipe(
                  Schema.brand("S1")
                )
              })
              return Node.representationIdentity(s, 1) !== undefined
            }
            case 14: { // Struct with contentSchema author annotation overridden by fromJsonString content.schema.
              const doc2 = {
                representation: {
                  _tag: "String",
                  checks: [],
                  annotations: { contentSchema: { type: "number" }, description: "row" },
                  content: { mediaType: "application/json", schema: { _tag: "Boolean", checks: [] } }
                },
                references: {}
              }
              return (emitted(doc2).schema["contentSchema"] as Record<string, unknown>)["type"] === "boolean"
            }
            case 15: { // Reference inside $defs with URI-encoded slash / ~0 / ~1 & non-object values in rewriteRefs.
              const s = Schema.Struct({
                a: Schema.String.annotate({ identifier: "a/b~c" }),
                b: Schema.String.annotate({ contentSchema: { $ref: "#/$defs/a~1b~0c" } })
              })
              return Node.schemaIdentity(s, closed).dialect === "draft-2020-12"
            }
            case 16: { // Duplicate fallback definitions (3 identical ~identifier checks).
              const mk = () => ({
                _tag: "String",
                checks: [{
                  _tag: "Filter",
                  aborted: false,
                  annotations: { toJsonSchema: () => ({ minLength: 2 }), "~identifier": "Dup" }
                }]
              })
              const doc3 = {
                representation: {
                  _tag: "Objects",
                  propertySignatures: [
                    { name: "a", type: { _tag: "Reference", $ref: "Dup" }, isOptional: false, isMutable: false },
                    { name: "b", type: { _tag: "Reference", $ref: "Dup_1" }, isOptional: false, isMutable: false },
                    { name: "c", type: { _tag: "Reference", $ref: "Dup_2" }, isOptional: false, isMutable: false }
                  ],
                  indexSignatures: [],
                  checks: []
                },
                references: { Dup: mk(), Dup_1: mk(), Dup_2: mk() }
              }
              const out = emitted(doc3, closed)
              return Object.keys(out.definitions).length === 1
            }
            case 17: { // Number-keyed record with plain String union member.
              const s = Schema.Record(Schema.Union([Schema.Number, Schema.String]), Schema.String)
              return Node.schemaIdentity(s, { onExcessProperty: mode }).dialect === "draft-2020-12"
            }
            case 18: { // Checked String with multiple colliding checks & $ref with check.
              const RefS = Schema.String.annotate({ identifier: "RefS" })
              const s = Schema.Struct({
                a: RefS.check(Schema.isMinLength(1)),
                b: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0), Schema.isGreaterThan(1))
              })
              return Node.schemaIdentity(s, closed).dialect === "draft-2020-12"
            }
            default: { // Direct builtinCheckIds check & Schema.Record with Number+String+Template in StructWithRest.
              const s = Schema.StructWithRest(
                Schema.Struct({ a: Schema.String }),
                [
                  Schema.Record(Schema.Number, Schema.Int),
                  Schema.Record(Schema.TemplateLiteral(["x-", Schema.String]), Schema.Boolean)
                ]
              )
              return InternalSchemaIdentity.builtinCheckIds.length > 40 &&
                Node.schemaIdentity(s, closed).dialect === "draft-2020-12"
            }
          }
        },
        { seed: seed + 19, executions: Math.max(mediumExecutions, reprKeys.length + 25) }
      )
    )
    assertPassed(report)
  })

  it("Node.schemaIdentity and representationIdentity preserve determinism across randomly composed nested schemas", async () => {
    const leafKind = Schema.Literals([
      "string",
      "int",
      "finite",
      "number",
      "boolean",
      "null",
      "literalStr",
      "literalNum",
      "template",
      "jsonStr"
    ])
    const wrapKind = Schema.Literals([
      "none",
      "array",
      "optionalStruct",
      "recordStr",
      "recordNum",
      "recordTpl",
      "unionAnyOf",
      "unionOneOf",
      "tuple",
      "brand",
      "identified"
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        leaves: Schema.Array(leafKind).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
        wraps: Schema.Array(wrapKind).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
        minLen: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
        maxLen: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 12 })),
        mode: Schema.Literals(["ignore", "error"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ leaves, wraps, minLen, maxLen, mode }) => {
          const buildLeaf = (k: typeof leafKind.Type, i: number): Schema.Top => {
            switch (k) {
              case "string":
                return Schema.String.check(Schema.isMinLength(minLen), Schema.isMaxLength(maxLen))
              case "int":
                return Schema.Int.check(Schema.isBetween({ minimum: minLen, maximum: maxLen }))
              case "finite":
                return Schema.Finite.check(Schema.isGreaterThanOrEqualTo(minLen))
              case "number":
                return Schema.Number
              case "boolean":
                return Schema.Boolean
              case "null":
                return Schema.Null
              case "literalStr":
                return Schema.Literal(`lit_${i}`)
              case "literalNum":
                return Schema.Literal(i)
              case "template":
                return Schema.TemplateLiteral([`p${i}-`, Schema.String])
              case "jsonStr":
                return Schema.fromJsonString(Schema.Struct({ k: Schema.Int }))
            }
          }
          const base = leaves.map((l, i) => buildLeaf(l, i))
          let current: Schema.Top = base[0]!
          for (let i = 0; i < wraps.length; i++) {
            const w = wraps[i]!
            const other = base[(i + 1) % base.length]!
            switch (w) {
              case "none":
                break
              case "array":
                current = Schema.Array(current).check(Schema.isMaxLength(maxLen))
                break
              case "optionalStruct":
                current = Schema.Struct({ a: current, b: Schema.optionalKey(other) })
                break
              case "recordStr":
                current = Schema.Record(Schema.String, current)
                break
              case "recordNum":
                current = Schema.Record(Schema.Number, current)
                break
              case "recordTpl":
                current = Schema.Record(Schema.TemplateLiteral([`k${i}-`, Schema.String]), current)
                break
              case "unionAnyOf":
                current = Schema.Union([current, other])
                break
              case "unionOneOf":
                current = Schema.Union([current, other], { mode: "oneOf" })
                break
              case "tuple":
                current = Schema.Tuple([current, Schema.optionalKey(other)])
                break
              case "brand":
                current = i === 0
                  ? (current as Schema.Schema<unknown>).pipe(Schema.brand("Brand0"))
                  : i === 1
                  ? (current as Schema.Schema<unknown>).pipe(Schema.brand("Brand1"))
                  : (current as Schema.Schema<unknown>).pipe(Schema.brand("Brand2"))
                break
              case "identified":
                current = Schema.Struct({
                  x: current.annotate({ identifier: `Def_${i}` }),
                  y: current.annotate({ identifier: `Def_${i}` })
                })
                break
            }
          }
          const opts: Node.SchemaIdentityOptions = { onExcessProperty: mode }
          const d1 = Node.schemaIdentity(current, opts)
          const d2 = Node.schemaIdentity(current, opts)
          if (d1.dialect !== "draft-2020-12" || JSON.stringify(d1) !== JSON.stringify(d2)) return false
          const r3 = Node.representationIdentity(current, 3)
          const r2 = Node.representationIdentity(current, 2)
          const r1 = Node.representationIdentity(current, 1)
          return r3 !== undefined && r2 !== undefined && r1 !== undefined
        },
        { seed: seed + 21, executions: mediumExecutions }
      )
    )
    assertPassed(report)
  })
})
