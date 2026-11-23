import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Context, Effect, Layer, Logger, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  Bind,
  Config,
  type FirstHook,
  type FlowsHooks,
  Host,
  JsonSchema,
  Kernel,
  Keys,
  Load,
  make as makePlugin,
  Manifest,
  type ParallelHook,
  PluginError,
  Plugins,
  Resolve,
  type SequentialHook,
  type WaterfallHook,
  When
} from "../src/index.ts"
import { host, minimal, owned, queueManifest } from "./support/hostFacts.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "600" : "150"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const silentLayer = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

interface CustomHooks extends FlowsHooks {
  readonly seq: SequentialHook<(n: number) => Effect.Effect<number, unknown, never>>
  readonly par: ParallelHook<(n: number) => Effect.Effect<void, unknown, never>>
  readonly fst: FirstHook<(n: number) => Effect.Effect<Option.Option<string>, unknown, never>>
  readonly wf: WaterfallHook<(v: string) => Effect.Effect<string | void, unknown, never>>
}

const customCatalog = {
  config: "waterfall",
  configResolved: "parallel",
  seq: "sequential",
  par: "parallel",
  fst: "first",
  wf: "waterfall"
} as const

describe("@smthrs/plugin When, Keys, Bind, JsonSchema & Host fuzz invariants", () => {
  it("When.parse/evaluate/view, Keys.parse/match & Host.pathOf obey grammar & truth-table laws", async () => {
    const clauseArb = Schema.Struct({
      negated: Schema.Boolean,
      kind: Schema.Literals(["view", "item", "focus"]),
      view: Schema.Literals(["queue/queue", "queue/detail", "alpha/main"]),
      field: Schema.Literals(["question", "approval", "missing"])
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        clauses: Schema.Array(clauseArb).pipe(Schema.check(Schema.isMaxLength(4))),
        ctxView: Schema.Literals(["queue/queue", "queue/detail", "other/x"]),
        question: Schema.Boolean,
        approval: Schema.Boolean,
        focusInput: Schema.Boolean,
        hasItem: Schema.Boolean,
        key1: Schema.Literals(["a", "g", "digit", "enter", "space", "?", "arrowup", "["]),
        key2: Schema.Union([Schema.Undefined, Schema.Literals(["q", "digit", "escape", "/"])]),
        mod: Schema.Boolean,
        ctrl: Schema.Boolean,
        alt: Schema.Boolean,
        shift: Schema.Boolean,
        mac: Schema.Boolean,
        digitVal: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 9 }))),
        scope: Schema.Literals(["app", "repository"]),
        path: Schema.Literals(["", "inbox", "a/b"]),
        hasRepo: Schema.Boolean,
        garbage: Schema.String.pipe(Schema.check(Schema.isMaxLength(40)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          clauses,
          ctxView,
          question,
          approval,
          focusInput,
          hasItem,
          key1,
          key2,
          mod,
          ctrl,
          alt,
          shift,
          mac,
          digitVal,
          scope,
          path,
          hasRepo,
          garbage
        }) =>
          Effect.sync(() => {
            // When grammar & evaluation
            const expr = clauses
              .map((c) => {
                const body = c.kind === "view"
                  ? `view == ${c.view}`
                  : c.kind === "item"
                  ? `item.${c.field}`
                  : "focus.input"
                return c.negated ? `!${body}` : body
              })
              .join(" && ")
            const parsed = When.parse(expr)
            if (Result.isFailure(parsed)) return false
            const ctx: When.Context = {
              view: ctxView,
              item: hasItem ? { question, approval } : undefined,
              focusInput
            }
            const actual = When.evaluate(parsed.success, ctx)
            const expected = clauses.every((c) => {
              const raw = c.kind === "view"
                ? ctxView === c.view
                : c.kind === "item"
                ? hasItem && (c.field === "question" ? question : c.field === "approval" ? approval : false)
                : focusInput
              return raw !== c.negated
            })
            if (actual !== expected) return false

            const firstView = clauses.find((c) => !c.negated && c.kind === "view")?.view
            if (When.view(parsed.success) !== firstView) return false

            // Garbage when never throws
            const gWhen = When.parse(garbage)
            if (!Result.isSuccess(gWhen) && !Result.isFailure(gWhen)) return false

            // Keys parse & match
            const mods = [
              ...(mod ? ["mod"] : []),
              ...(ctrl ? ["ctrl"] : []),
              ...(alt ? ["alt"] : []),
              ...(shift ? ["shift"] : [])
            ]
            const stroke1 = [...mods, key1].join("+")
            const binding = key2 === undefined ? stroke1 : `${stroke1} ${key2}`
            const parsedKeys = Keys.parse(binding)
            if (Result.isFailure(parsedKeys)) return false

            const toPressed = (k: string, withMods: boolean): Keys.Pressed => ({
              key: k === "digit" ? String(digitVal) : k === "space" ? " " : k.toUpperCase(),
              meta: withMods ? mac && mod : false,
              ctrl: withMods ? ctrl || (!mac && mod) : false,
              alt: withMods ? alt : false,
              shift: withMods ? (k === "?" ? !shift : shift) : false
            })

            const p1 = toPressed(key1, true)
            if (key2 === undefined) {
              const m = Keys.match(parsedKeys.success, [p1], { mac })
              if (!m.matched || m.partial) return false
              if (key1 === "digit" && m.index !== digitVal - 1) return false
            } else {
              const partial = Keys.match(parsedKeys.success, [p1], { mac })
              if (partial.matched || !partial.partial) return false
              const p2 = toPressed(key2, false)
              const full = Keys.match(parsedKeys.success, [p1, p2], { mac })
              if (!full.matched || full.partial) return false
              if (key2 === "digit" && full.index !== digitVal - 1) return false
            }
            if (Keys.match(parsedKeys.success, [], { mac }).matched) return false

            // Garbage keys never throws
            const gKeys = Keys.parse(garbage)
            if (!Result.isSuccess(gKeys) && !Result.isFailure(gKeys)) return false

            // Host.pathOf
            const url = Host.pathOf(
              { plugin: "queue", scope, path },
              hasRepo ? { owner: "o", name: "r" } : undefined
            )
            if (scope === "app" && (url === undefined || !url.startsWith("/app/queue"))) return false
            if (scope === "repository" && hasRepo && (url === undefined || !url.startsWith("/o/r/-/queue"))) {
              return false
            }
            if (scope === "repository" && !hasRepo && url !== undefined) return false

            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)

    // Invalid Keys & When edge cases
    expect(Result.isFailure(Keys.parse("a b c"))).toBe(true)
    expect(Result.isFailure(Keys.parse("mod+mod+a"))).toBe(true)
    expect(Result.isFailure(Keys.parse("bogus"))).toBe(true)
    expect(Result.isFailure(When.parse("view == bad"))).toBe(true)
    expect(Result.isFailure(When.parse("item.123bad"))).toBe(true)
  })

  it("Bind.references/bind and JsonSchema.resolve/validate/at enforce closed grammars and reject secrets", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
        num: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -5, maximum: 15 }))),
        str: Schema.String.pipe(Schema.check(Schema.isMaxLength(12))),
        extraProp: Schema.Boolean,
        useBadRef: Schema.Boolean
      })
    )

    const defs: Record<string, JsonSchema.Json> = {
      Tag: { type: "string", minLength: 1, maxLength: 8 },
      Payload: {
        type: "object",
        title: "Payload",
        description: "Test payload",
        properties: {
          n: { type: "integer", minimum: 0, maximum: 10 },
          s: { type: ["string", "null"], minLength: 0, maxLength: 8 },
          tags: { type: "array", items: { $ref: "#/$defs/Tag" }, minItems: 0, maxItems: 3 },
          kind: { enum: ["a", "b", { k: 1 }, [1, 2]] },
          fixed: { const: true },
          choice: {
            oneOf: [
              { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
              { type: "object", properties: { y: { type: "boolean" } }, required: ["y"] }
            ]
          },
          anyVal: {
            anyOf: [
              { type: "string" },
              { type: "integer" }
            ]
          }
        },
        required: ["n", "fixed"],
        additionalProperties: false
      }
    }

    const resolved = await Effect.runPromise(JsonSchema.resolve({ $ref: "#/$defs/Payload" }, defs))
    expect(JsonSchema.properties(resolved)).toContain("n")
    expect(JsonSchema.at(resolved, ["choice", "x"])).toBeDefined()
    expect(JsonSchema.properties(resolved.properties!.choice!)).toContain("x")
    expect(JsonSchema.at(resolved, ["tags", 0])).toBeDefined()
    expect(JsonSchema.at(resolved, ["missing"])).toBeUndefined()

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx, num, str, extraProp, useBadRef }) =>
          Effect.sync(() => {
            // Bind.references & Bind.bind
            const args: Record<string, Schema.Json> = {
              lit: "plain",
              arr: ["$item.options[0]", "$item.options[$event.idx]", "$key.index"],
              nested: { who: useBadRef ? "$unknown.x" : "$item.id", ev: "$event.note" }
            }
            const refs = Bind.references(args, "events[0].args")
            if (useBadRef) {
              if (Result.isSuccess(refs)) return false
            } else {
              if (Result.isFailure(refs) || refs.success.length !== 5) return false
              const scope: Bind.Scope = {
                item: { id: "row-1", options: ["o0", "o1", "o2"] },
                event: { idx, note: str },
                key: { index: idx }
              }
              const bound = Bind.bind(args, scope)
              if (Result.isFailure(bound)) return false
              if ((bound.success.arr as ReadonlyArray<unknown>)[1] !== `o${idx}`) return false
              // Missing scope field fails cleanly
              const missing = Bind.bind(args, { item: {}, event: { idx: -1 } })
              if (Result.isSuccess(missing)) return false
            }

            // JsonSchema.validate matches exact constraints
            const candidate: Record<string, unknown> = {
              n: num,
              s: str,
              tags: str.length >= 1 && str.length <= 8 ? [str] : [],
              kind: [1, 2],
              fixed: true,
              choice: { x: 1.5 },
              anyVal: num,
              ...(extraProp ? { unexpected: 1 } : {})
            }
            const valid = num >= 0 && num <= 10 && [...str].length <= 8 && !extraProp
            const validated = JsonSchema.validate(resolved, candidate)
            return Option.isNone(validated) === valid
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)

    // JsonSchema refusal paths (secrets, unknown keywords, bad/cyclic refs, depth, budget, malformed keywords)
    const expectRefusal = async (
      schema: JsonSchema.Json,
      customDefs: Record<string, JsonSchema.Json> = {},
      reason?: string
    ) => {
      const res = await Effect.runPromise(Effect.result(JsonSchema.resolve(schema, customDefs)))
      expect(Result.isFailure(res)).toBe(true)
      if (Result.isFailure(res) && reason !== undefined) expect(res.failure.reason).toBe(reason)
    }
    await expectRefusal("not-an-object", {}, "invalid")
    await expectRefusal({ type: "string", format: "password" }, {}, "secret_field")
    await expectRefusal({ type: "string", writeOnly: true }, {}, "secret_field")
    await expectRefusal({ type: "object", properties: { apiToken: { type: "string" } } }, {}, "secret_field")
    await expectRefusal({ type: "string", pattern: "^a+$" } as unknown as JsonSchema.Json, {}, "schema_unresolved")
    await expectRefusal({ $ref: "https://evil.example/schema.json" }, {}, "schema_unresolved")
    await expectRefusal({ $ref: "#/$defs/Missing" }, {}, "schema_unresolved")
    await expectRefusal({ $ref: "#/$defs/Tag", type: "string" }, defs, "schema_unresolved")
    await expectRefusal(
      { $ref: "#/$defs/A" },
      { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } },
      "schema_unresolved"
    )
    await expectRefusal({ type: "bogus" } as unknown as JsonSchema.Json, {}, "invalid")
    await expectRefusal({ properties: "bad" } as unknown as JsonSchema.Json, {}, "invalid")
    await expectRefusal({ required: [1] } as unknown as JsonSchema.Json, {}, "invalid")
    await expectRefusal({ additionalProperties: {} } as unknown as JsonSchema.Json, {}, "schema_unresolved")
    await expectRefusal({ items: [{ type: "string" }] } as unknown as JsonSchema.Json, {}, "schema_unresolved")
    await expectRefusal({ enum: [] }, {}, "invalid")
    await expectRefusal({ minimum: "1" } as unknown as JsonSchema.Json, {}, "invalid")
    await expectRefusal({ minLength: -1 }, {}, "invalid")
    await expectRefusal({ title: 123 } as unknown as JsonSchema.Json, {}, "invalid")
    await expectRefusal({ oneOf: [] }, {}, "invalid")

    // Depth & shared budget refusal
    let deep: JsonSchema.Json = { type: "string" }
    for (let i = 0; i < 35; i++) deep = { type: "array", items: deep }
    await expectRefusal(deep, {}, "invalid")
    const tightBudget: JsonSchema.Budget = { remaining: 5 }
    const budgetRes = await Effect.runPromise(
      Effect.result(JsonSchema.resolve({ type: "string", title: "hello world" }, {}, "", tightBudget))
    )
    expect(Result.isFailure(budgetRes)).toBe(true)
  })
})

describe("@smthrs/plugin Config, Resolve, Plugins & Kernel fuzz invariants", () => {
  it("Resolve ordering matches Vite enforce/order partition, and Plugins dispatches all 4 hook kinds cleanly", async () => {
    const enforceArb = Schema.Union([Schema.Undefined, Schema.Literals(["pre", "post"])])
    const itemArb = Schema.Struct({
      enforce: enforceArb,
      hookOrder: enforceArb,
      applyMode: Schema.Literals(["always", "engine", "harness", "fnTrue", "fnFalse"])
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        specs: Schema.Array(itemArb).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8))),
        target: Schema.Literals(["engine", "harness"]),
        patchVal: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50 })))
      })
    )

    const rankOf = (v: "pre" | "post" | undefined): number => (v === "pre" ? 0 : v === "post" ? 2 : 1)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ specs, target, patchVal }) =>
          Effect.gen(function*() {
            const input = [
              false as const,
              null,
              undefined,
              specs.map((spec, idx) =>
                makePlugin<CustomHooks>({
                  name: `p-${idx}`,
                  version: `1.0.${idx}`,
                  enforce: spec.enforce,
                  apply: spec.applyMode === "always"
                    ? undefined
                    : spec.applyMode === "engine"
                    ? "engine"
                    : spec.applyMode === "harness"
                    ? "harness"
                    : spec.applyMode === "fnTrue"
                    ? () => true
                    : () => false,
                  hooks: {
                    config: {
                      order: spec.hookOrder,
                      handler: () => Effect.succeed({ [`k${idx}`]: patchVal + idx })
                    },
                    configResolved: () => Effect.void,
                    seq: {
                      order: spec.hookOrder,
                      handler: (n) => Effect.succeed(n + idx)
                    },
                    par: () => Effect.void,
                    fst: {
                      order: spec.hookOrder,
                      handler: (n) => Effect.succeed(idx === n ? Option.some(`p-${idx}`) : Option.none())
                    },
                    wf: {
                      order: spec.hookOrder,
                      handler: (v) => Effect.succeed(`${v},${idx}`)
                    }
                  }
                })
              )
            ]

            const kernel = yield* Kernel.make<CustomHooks>(
              input,
              { base: { a: 1 } },
              {
                target,
                hooks: customCatalog,
                parallelConcurrency: 4,
                handlerTimeout: 5000,
                cacheEnvironment: { layers: ["host@1"], capabilities: { cap: ["a"] } }
              }
            )

            const expectedIncluded = specs
              .map((spec, idx) => ({ spec, idx }))
              .filter(({ spec }) =>
                spec.applyMode === "always" ||
                spec.applyMode === "fnTrue" ||
                spec.applyMode === target
              )

            // Plugin order: enforce rank then original index
            const expectedPlugins = [...expectedIncluded]
              .sort((a, b) => rankOf(a.spec.enforce) - rankOf(b.spec.enforce) || a.idx - b.idx)
              .map(({ idx }) => `p-${idx}`)
            if (
              JSON.stringify(kernel.plugins.resolved.plugins.map((p) => p.name)) !== JSON.stringify(expectedPlugins)
            ) {
              return false
            }

            // Handler order: per-hook order rank, then plugin enforce rank, then plugin index
            const expectedHandlerOrder = [...expectedIncluded]
              .sort(
                (a, b) =>
                  rankOf(a.spec.hookOrder) - rankOf(b.spec.hookOrder) ||
                  rankOf(a.spec.enforce) - rankOf(b.spec.enforce) ||
                  a.idx - b.idx
              )
              .map(({ idx }) => idx)

            const seqRes = yield* kernel.plugins.sequential("seq", 10)
            if (JSON.stringify(seqRes) !== JSON.stringify(expectedHandlerOrder.map((i) => 10 + i))) return false

            const wfRes = yield* kernel.plugins.waterfall("wf", "start", (_prev, next) => next)
            if (wfRes !== `start${expectedHandlerOrder.map((i) => `,${i}`).join("")}`) return false

            const fstRes = yield* kernel.plugins.first("fst", expectedHandlerOrder[0] ?? 999)
            if (expectedHandlerOrder.length > 0 && Option.getOrUndefined(fstRes) !== `p-${expectedHandlerOrder[0]}`) {
              return false
            }

            const parErrs = yield* kernel.plugins.parallel("par", 1)
            if (parErrs.length !== 0 || kernel.observerErrors.length !== 0) return false

            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)

    // Exercise Config, Resolve, Plugins, Layer & error boundaries
    await Effect.runPromise(
      Effect.gen(function*() {
        // Config.merge, deepFreeze, schema decode, reserved keys
        const merged = Config.merge({ a: { x: 1 }, b: 2 }, { a: { y: 3 }, c: [1, 2] })
        expect(merged).toEqual({ a: { x: 1, y: 3 }, b: 2, c: [1, 2] })
        expect(Config.merge(merged, undefined)).toBe(merged)
        expect(Config.deepFreeze({ ok: [true, null, "hi"] })).toEqual({ ok: [true, null, "hi"] })
        const decodedCfg = yield* Schema.decodeUnknownEffect(Config.FlowsConfig)({ ns: { k: 1 } })
        expect(decodedCfg).toEqual({ ns: { k: 1 } })

        for (const reserved of ["engine", "retry", "store", "plugins"]) {
          const r = yield* Effect.result(Config.snapshot({ [reserved]: {} }))
          expect(Result.isFailure(r) && r.failure.code === "config_invalid").toBe(true)
        }
        expect(() => Config.deepFreeze({ bad: Number.NaN } as unknown as Config.ConfigValue)).toThrow()

        // Plugins.makeNoop / layerNoop / layer
        const noop = Plugins.makeNoop()
        expect(noop.handlers("config")).toEqual([])
        const svcFromNoop = yield* Plugins.Plugins.pipe(Effect.provide(Plugins.layerNoop))
        expect(svcFromNoop.handlers("config")).toEqual([])
        const emptyResolved = yield* Resolve.resolve([])
        const svcFromLayer = yield* Plugins.Plugins.pipe(Effect.provide(Plugins.layer(emptyResolved)))
        expect(svcFromLayer.resolved.plugins).toEqual([])

        // Plugin layers merge left-to-right and wrap layer_failed
        class TagA extends Context.Service<TagA, string>()("PluginFuzz/TagA") {}
        const withLayer = yield* Kernel.make([
          makePlugin({ name: "l1", version: "1", layer: Layer.succeed(TagA)("v1") as Layer.Layer<never, any, any> }),
          makePlugin({ name: "l2", version: "1", layer: Layer.succeed(TagA)("v2") as Layer.Layer<never, any, any> })
        ])
        const tagVal = yield* TagA.pipe(Effect.provide(withLayer.layer as Layer.Layer<TagA, PluginError>))
        expect(tagVal).toBe("v2")

        const badLayerKernel = yield* Kernel.make([
          makePlugin({
            name: "fail-layer",
            layer: Layer.effectDiscard(Effect.fail(new Error("boom"))) as Layer.Layer<never, any, any>
          })
        ])
        const builtBad = yield* Effect.result(
          Effect.scoped(Layer.build(badLayerKernel.layer as unknown as Layer.Layer<never, PluginError>))
        )
        expect(Result.isFailure(builtBad) && builtBad.failure.code === "layer_failed").toBe(true)

        // Parallel observer errors & hook failures & kind mismatches
        const errKernel = yield* Kernel.make<CustomHooks>(
          [
            makePlugin<CustomHooks>({
              name: "faulty",
              hooks: {
                configResolved: () => Effect.fail(new Error("obs fail")),
                fst: () => Effect.succeed("not-an-option" as unknown as Option.Option<string>),
                seq: () => "not-an-effect" as unknown as Effect.Effect<number>,
                wf: () => Effect.succeed("bad")
              }
            })
          ],
          {},
          { hooks: customCatalog }
        )
        expect(errKernel.observerErrors.length).toBe(1)
        const fstBad = yield* Effect.result(errKernel.plugins.first("fst", 1))
        expect(Result.isFailure(fstBad) && fstBad.failure.code === "invalid_hook_result").toBe(true)
        const seqBad = yield* Effect.result(errKernel.plugins.sequential("seq", 1))
        expect(Result.isFailure(seqBad) && seqBad.failure.code === "hook_failed").toBe(true)
        const wfBad = yield* Effect.result(
          errKernel.plugins.waterfall("wf", "x", () => {
            throw new Error("merge fail")
          })
        )
        expect(Result.isFailure(wfBad) && wfBad.failure.code === "config_invalid").toBe(true)
        const wrongKind = yield* Effect.result(
          (errKernel.plugins.sequential as unknown as (h: string) => Effect.Effect<unknown, PluginError>)("wf")
        )
        expect(Result.isFailure(wrongKind) && wrongKind.failure.code === "hook_kind_mismatch").toBe(true)

        // Resolve failure modes
        const dupRes = yield* Effect.result(Resolve.resolve([makePlugin({ name: "a" }), makePlugin({ name: "a" })]))
        expect(Result.isFailure(dupRes) && dupRes.failure.code === "duplicate_name").toBe(true)
        const unkHook = yield* Effect.result(
          Resolve.resolve([
            makePlugin({ name: "a", hooks: { bogus: () => Effect.void } as unknown as Partial<FlowsHooks> })
          ])
        )
        expect(Result.isFailure(unkHook) && unkHook.failure.code === "unknown_hook").toBe(true)
        const badCatalog = yield* Effect.result(
          Resolve.resolve([], { hooks: { config: "parallel" } as unknown as Resolve.Options["hooks"] })
        )
        expect(Result.isFailure(badCatalog) && badCatalog.failure.code === "hook_kind_mismatch").toBe(true)
        const throwApply = yield* Effect.result(
          Resolve.resolve([makePlugin({
            name: "a",
            apply: () => {
              throw new Error("boom")
            }
          })])
        )
        expect(Result.isFailure(throwApply) && throwApply.failure.code === "apply_failed").toBe(true)
        const nonBoolApply = yield* Effect.result(
          Resolve.resolve([makePlugin({ name: "a", apply: (() => 123) as unknown as () => boolean })])
        )
        expect(Result.isFailure(nonBoolApply) && nonBoolApply.failure.code === "invalid_plugin").toBe(true)
        const badTarget = yield* Effect.result(
          Resolve.resolve([], { target: "bad" as unknown as "engine" })
        )
        expect(Result.isFailure(badTarget) && badTarget.failure.code === "invalid_plugin").toBe(true)
        const badConc = yield* Effect.result(Resolve.resolve([], { parallelConcurrency: 0 }))
        expect(Result.isFailure(badConc) && badConc.failure.code === "resource_limit").toBe(true)
        const badTimeout = yield* Effect.result(Resolve.resolve([], { handlerTimeout: 0 }))
        expect(Result.isFailure(badTimeout) && badTimeout.failure.code === "resource_limit").toBe(true)
        const missingVerCache = yield* Effect.result(
          Resolve.resolve([makePlugin({ name: "no-ver" })], {
            cacheEnvironment: { layers: [], capabilities: {} }
          })
        )
        expect(Result.isFailure(missingVerCache) && missingVerCache.failure.code === "cache_environment_invalid").toBe(
          true
        )

        // Preset cycle
        const cyc: Array<unknown> = []
        cyc.push(cyc)
        const cycRes = yield* Effect.result(Resolve.resolve(cyc as unknown as Array<never>))
        expect(Result.isFailure(cycRes) && cycRes.failure.code === "invalid_plugin").toBe(true)
      }).pipe(Effect.provide(silentLayer))
    )
  })
})

describe("@smthrs/plugin Manifest & Load fuzz invariants", () => {
  it("Load.load never fails on mutated manifests and enforces tiers, dependencies, conflicts & capabilities", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mutation: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 14 }))),
        tier: Schema.Literals(["built-in", "repository", "personal"]),
        rawGarbage: Schema.String.pipe(Schema.check(Schema.isMaxLength(40)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mutation, tier, rawGarbage }) =>
          Effect.gen(function*() {
            const m = queueManifest()
            if (tier !== "built-in") {
              m.contributes.views[0].render = { kind: "blocks", blocks: [] }
              m.contributes.slots[0].render = { kind: "blocks", blocks: [] }
            }
            switch (mutation) {
              case 0:
                break // valid manifest
              case 1:
                m.id = "core" // reserved
                break
              case 2:
                m.requires.api = "^9.0.0" // incompatible
                break
              case 3:
                m.requires.api = "not-a-range!!!" // range_unreadable
                break
              case 4:
                m.capabilities = ["write:danger"] // capability_exceeded for repo/personal
                break
              case 5:
                m.uses = ["missing/flow"] // undeclared_use
                break
              case 6:
                m.contributes.views[0].minimum = "anyone" // minimum_below_flow
                break
              case 7:
                m.contributes.views[0].reads = ["other/query"] // invalid reads
                break
              case 8:
                m.contributes.slots[0].when = "bad when !!" // invalid when
                break
              case 9:
                m.contributes.keybindings[0].key = "a b c" // invalid key
                break
              case 10:
                m.contributes.keybindings[0].command = "queue/nonexistent" // unknown command
                break
              case 11:
                m.contributes.commands[0].args = { to: "$item.runId" } // non-fixed command args
                break
              case 12:
                m.contributes.views[0].events[0].args = { runId: "$item.nonexistent" }
                break
              case 13:
                m.contributes.cards = [{ id: "queue/c" }] // unsupported point
                break
              case 14:
                m.skills = ["s1"] // unsupported skills
                break
            }

            const loaded = yield* Load.load(host({ slash: ["taken"] }), [
              { tier, manifest: m },
              { tier: "personal", manifest: rawGarbage }
            ])
            if (!Array.isArray(loaded.refused) || !Array.isArray(loaded.contributions.plugins)) return false
            // rawGarbage is always refused
            if (loaded.refused.length === 0) return false
            // Refusals are deterministically sorted by plugin id
            for (let i = 1; i < loaded.refused.length; i++) {
              const a = loaded.refused[i - 1]!.plugin ?? ""
              const b = loaded.refused[i]!.plugin ?? ""
              if (a > b) return false
            }
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    assertPassed(report)

    // Multi-plugin scenarios: dependency ordering, cycles, tier conflict resolution, owned flows & userOnly, header limit
    await Effect.runPromise(
      Effect.gen(function*() {
        const h = host({
          points: ["views", "slots", "commands", "keybindings", "flows"],
          slash: ["reserved-slash"]
        })

        // 1. Dependency chain + owned flows + userOnly
        const base = minimal("alpha", {
          version: "1.2.0",
          flows: ["alpha/run", "alpha/approve"],
          userOnly: { "alpha/approve": "human confirmation" }
        })
        const dep = minimal("beta", {
          version: "1.0.0",
          requires: { api: "^1.0.0", plugins: { alpha: "^1.0.0" } },
          uses: ["alpha/run"]
        })
        const res1 = yield* Load.load(h, [
          { tier: "built-in", manifest: dep },
          {
            tier: "built-in",
            manifest: base,
            flows: [
              owned("alpha/run"),
              owned("alpha/approve", { modelInvocable: false, personOnly: true })
            ]
          }
        ])
        expect(res1.refused).toEqual([])
        expect(res1.contributions.plugins.map((p) => p.id)).toEqual(["alpha", "beta"])

        // 2. Cycle + dependent behind cycle + missing dep + incompatible dep version
        const cycA = minimal("cyca", { requires: { api: "^1.0.0", plugins: { cycb: "^1.0.0" } } })
        const cycB = minimal("cycb", { requires: { api: "^1.0.0", plugins: { cyca: "^1.0.0" } } })
        const behind = minimal("behind", { requires: { api: "^1.0.0", plugins: { cyca: "^1.0.0" } } })
        const badVer = minimal("badver", { requires: { api: "^1.0.0", plugins: { alpha: "^2.0.0" } } })
        const missingDep = minimal("miss", { requires: { api: "^1.0.0", plugins: { ghost: "^1.0.0" } } })
        const res2 = yield* Load.load(h, [
          {
            tier: "built-in",
            manifest: base,
            flows: [owned("alpha/run"), owned("alpha/approve", { modelInvocable: false, personOnly: true })]
          },
          { tier: "built-in", manifest: cycA },
          { tier: "built-in", manifest: cycB },
          { tier: "built-in", manifest: behind },
          { tier: "built-in", manifest: badVer },
          { tier: "built-in", manifest: missingDep }
        ])
        expect(res2.refused.map((r) => r.reason)).toEqual(
          expect.arrayContaining(["cycle", "missing_dependency", "incompatible"])
        )

        // 3. Tier conflicts (built-in beats personal; same-tier tie refuses both)
        const res3 = yield* Load.load(h, [
          { tier: "built-in", manifest: minimal("dup") },
          { tier: "personal", manifest: minimal("dup") },
          { tier: "repository", manifest: minimal("tie") },
          { tier: "repository", manifest: minimal("tie") }
        ])
        expect(res3.contributions.plugins.map((p) => p.id)).toEqual(["dup"])
        expect(res3.refused.filter((r) => r.reason === "conflict").length).toBe(3)

        // 4. Shell header limit (> 6 entries) & system flow ownership conflict & throwing proxy manifest
        const manyHeaders = minimal("hdr", {
          contributes: {
            slots: Array.from({ length: 7 }, (_, i) => ({
              id: `hdr/s${i}`,
              slot: "shell.header",
              render: { kind: "blocks", blocks: [] }
            }))
          }
        })
        const sysConflict = minimal("sysc", { flows: ["run/answer"] })
        const badProxy = new Proxy({}, {
          getOwnPropertyDescriptor() {
            throw new Error("boom")
          }
        })
        const res4 = yield* Load.load(h, [
          { tier: "built-in", manifest: manyHeaders },
          { tier: "built-in", manifest: sysConflict, flows: [owned("run/answer")] },
          { tier: "personal", manifest: badProxy }
        ])
        expect(res4.refused.length).toBe(3)
      })
    )
  })
})
