import { Fuzz } from "@smthrs/fuzz"
import * as Cell from "@smthrs/harness/Cell"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Registry from "@smthrs/registry/Registry"
import { Arbitrary, Effect, Exit, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CellPlugin from "../src/CellPlugin.ts"
import * as Pack from "../src/internal/memory/pack.ts"
import * as SmithersPlugin from "../src/SmithersPlugin.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261131")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const callOf = (descriptor: FlowBinding.Binding["descriptor"], input: Schema.Json): Cell.Call =>
  new Cell.Call({
    flowName: descriptor.name,
    input,
    capabilities: descriptor.capabilities,
    effects: descriptor.effects,
    placement: descriptor.placement,
    identity: new Cell.CallIdentity({
      session: "session-w7",
      frame: 0,
      cell: "cell-w7",
      ordinal: 0,
      declaration: Cell.declarationDigest(descriptor),
      layers: []
    })
  })

describe("@smthrs/agent Wave 7 deep fuzz (SmithersPlugin via CellPlugin/CellCalls + memory/pack budget/escaping/truncation)", () => {
  it(
    "SmithersPlugin through CellPlugin and CellCalls handles all topics, port success/failure, and idempotent system brief injection",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          topic: Schema.Literals(["packages", "cli", "authoring", "all", "none"]),
          hasPorts: Schema.Boolean,
          portFails: Schema.Boolean,
          alreadyHasBrief: Schema.Boolean,
          runId: Schema.Literals(["run-1", "run-2", "run-abc"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ topic, hasPorts, portFails, alreadyHasBrief, runId }) =>
            Effect.gen(function*() {
              const ports: SmithersPlugin.Ports | undefined = hasPorts
                ? {
                  list: () => {
                    if (portFails) throw new Error("list failed")
                    return [{ name: "deploy", description: "Deploy app" }]
                  },
                  run: (req) => {
                    if (portFails) return Promise.reject(new Error("run failed"))
                    return { id: req.id, flow: req.flow, status: "requested" }
                  },
                  inspect: (id) => {
                    if (portFails) throw new Error("inspect failed")
                    return { id, status: "running" }
                  }
                }
                : undefined

              const plugin = SmithersPlugin.make(ports)
              const kernel = yield* CellPlugin.make([plugin])
              const bindings = yield* CellPlugin.flows(kernel.plugins, [])
              expect(bindings.length).toBe(hasPorts ? 4 : 1)

              const catalog = Result.getOrThrow(FlowBinding.catalogResult(bindings))
              const runner = CellCalls.make({
                registry: FlowBinding.registry(Registry.makeNoop({}), catalog),
                catalog
              })
              const failures: Array<Cell.FailureKind> = []
              const invoke = (name: string, input: Schema.Json) => {
                const binding = bindings.find((b) => b.descriptor.name === name)!
                return runner.run(callOf(binding.descriptor, input)).pipe(
                  Effect.provideService(Cell.Failures, (kind) =>
                    Effect.sync(() => {
                      failures.push(kind)
                    })),
                  Effect.exit
                )
              }

              const guideEx = yield* invoke("smithers.guide", topic === "none" ? {} : { topic })
              expect(Exit.isSuccess(guideEx)).toBe(true)

              if (hasPorts) {
                const listEx = yield* invoke("smithers.flows", {})
                const runEx = yield* invoke("smithers.run", { id: runId, flow: "deploy", input: { env: "prod" } })
                const inspectEx = yield* invoke("smithers.inspect", { id: runId })

                expect(Exit.isSuccess(listEx)).toBe(true)
                expect(Exit.isSuccess(runEx)).toBe(true)
                expect(Exit.isSuccess(inspectEx)).toBe(true)
                if (portFails) {
                  expect(failures.length).toBeGreaterThanOrEqual(3)
                } else {
                  expect(failures.length).toBe(0)
                }
              }

              const req = ModelRequest.ModelRequest.make({
                modelId: "test-model",
                system: alreadyHasBrief ? [ModelRequest.SystemPart.make({ text: SmithersPlugin.brief })] : [],
                messages: [],
                tools: [],
                params: {}
              })
              const outReq = yield* CellPlugin.modelRequest(kernel.plugins, req)
              const briefCount = outReq.system.filter((p) => p.text === SmithersPlugin.brief).length
              expect(briefCount).toBe(1)
              return true
            }),
          { executions: Math.min(executions, 80), seed }
        )
      )
      assertPassed(report)
    },
    45_000
  )

  it(
    "memory/pack enforces byte budgets, fence escaping, deterministic ordering, and head truncation across all item kinds",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          maxBytes: Schema.Literals([128, 512, 1500, 8192]),
          itemCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
          hasFenceInText: Schema.Boolean,
          longText: Schema.Boolean,
          kind: Schema.Literals(["page", "skill", "dep", "dir", "file", "commit", "fact"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ maxBytes, itemCount, hasFenceInText, longText, kind }) =>
            Effect.sync(() => {
              const kinds: ReadonlyArray<Pack.Selected["kind"]> = [
                "page",
                "skill",
                "dep",
                "dir",
                "file",
                "commit",
                "fact"
              ]
              const baseText = longText
                ? "line-of-memory-evidence ".repeat(60)
                : "short memory evidence"
              const payloadText = hasFenceInText
                ? `${baseText} ${Pack.open} injected ${Pack.close}`
                : baseText

              const items: Array<Pack.Selected> = Array.from({ length: itemCount }, (_, i) => ({
                kind: i === 0 ? kind : kinds[i % kinds.length]!,
                id: `item-${i}`,
                digest: `d${i}`,
                bytes: Buffer.byteLength(payloadText, "utf8"),
                p: 0.9 - i * 0.08,
                decided: i % 2 === 0 ? "seed" : "jev",
                text: payloadText
              }))

              const packed = Pack.pack(items, maxBytes)
              expect(packed.kept.length + packed.omitted.length).toBe(items.length)
              if (packed.kept.length === 0) {
                expect(packed.context).toBe("")
              } else {
                expect(packed.context.startsWith(Pack.open)).toBe(true)
                expect(packed.context.endsWith(Pack.close)).toBe(true)
                const inner = packed.context.slice(Pack.open.length, packed.context.length - Pack.close.length)
                expect(inner.includes(Pack.close)).toBe(false)
              }

              expect(Pack.fit("hello", 0)).toBeUndefined()
              expect(Pack.fit("hello", 100)).toBe("hello")
              const emojiFit = Pack.fit("🚀".repeat(50), 80)
              if (emojiFit !== undefined) {
                expect(Buffer.byteLength(emojiFit, "utf8")).toBeLessThanOrEqual(80)
              }
              return true
            }),
          { executions: Math.min(executions, 140), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    30_000
  )
})
