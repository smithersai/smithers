import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { OwnerIdentity, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Fuzz } from "@smthrs/fuzz"
import * as Jj from "@smthrs/jj/Jj"
import { Arbitrary, Effect, Layer, Logger, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Flows from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/flows barrel & Runtime.validate/layer/make fuzz invariants", () => {
  it("Runtime.validate accepts all valid options and rejects every malformed option with RuntimeConfigurationError", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hostId: Schema.Literals(["host-a", "worker-1", ""]),
        badField: Schema.Literals([
          "none",
          "ownerMissing",
          "isAlive",
          "canExecute",
          "canActivate",
          "requestResume",
          "cacheEnvironment",
          "sourceRevision",
          "privilegedJj",
          "sweep",
          "placement",
          "resumeConcurrencyZero",
          "resumeConcurrencyFloat"
        ]),
        sweepKind: Schema.Literals(["undef", "process", "host", "hostFlow"]),
        withCacheEnv: Schema.Boolean,
        withSourceRevFn: Schema.Boolean,
        withPlacement: Schema.Boolean,
        resumeConcurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ hostId, badField, sweepKind, withCacheEnv, withSourceRevFn, withPlacement, resumeConcurrency }) =>
          Effect.sync(() => {
            const base: Record<string, unknown> = {
              owner: { hostId },
              isAlive: () => Effect.succeed(true),
              canExecute: () => Effect.succeed(true),
              canActivate: () => Effect.succeed(true),
              requestResume: () => Effect.void,
              cacheEnvironment: withCacheEnv
                ? { layers: ["node"], capabilities: { fs: ["read"] } }
                : undefined,
              sourceRevision: withSourceRevFn ? () => Effect.succeed("rev-1") : "rev-1",
              privilegedJj: Jj.layerNoop({}),
              sweep: sweepKind === "undef"
                ? undefined
                : sweepKind === "process"
                ? "process"
                : sweepKind === "host"
                ? { host: "h1" }
                : { host: "h1", flow: "sweep/flow" },
              placement: withPlacement ? "local" : undefined,
              resumeConcurrency
            }

            if (badField === "ownerMissing") delete base.owner
            else if (badField === "isAlive") base.isAlive = "nope"
            else if (badField === "canExecute") base.canExecute = 42
            else if (badField === "canActivate") base.canActivate = {}
            else if (badField === "requestResume") base.requestResume = true
            else if (badField === "cacheEnvironment") base.cacheEnvironment = { bad: 1 }
            else if (badField === "sourceRevision") base.sourceRevision = ""
            else if (badField === "privilegedJj") base.privilegedJj = {}
            else if (badField === "sweep") base.sweep = { host: "" }
            else if (badField === "placement") base.placement = ""
            else if (badField === "resumeConcurrencyZero") base.resumeConcurrency = 0
            else if (badField === "resumeConcurrencyFloat") base.resumeConcurrency = 1.5

            const shouldFail = badField !== "none" || hostId === ""
            try {
              const validated = Flows.Runtime.validate(base as unknown as Flows.Runtime.Options, "FuzzRuntime")
              if (shouldFail) return false
              if (!Object.isFrozen(validated) || !Object.isFrozen(validated.owner)) return false
              if (validated.owner.hostId !== hostId) return false
              return true
            } catch (err) {
              if (!shouldFail) return false
              return err instanceof Flows.Runtime.RuntimeConfigurationError && err.message.startsWith("FuzzRuntime ")
            }
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Runtime.make & Runtime.layer compose full durable flows over real SQLite across option combinations and barrel namespaces", async () => {
    for (const ns of Flows.namespaces) {
      expect(Flows[ns]).toBeDefined()
    }
    const arb = Arbitrary.schema(
      Schema.Struct({
        input: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
        withCacheEnv: Schema.Boolean,
        withPrivJj: Schema.Boolean,
        withRegistry: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ input, withCacheEnv, withPrivJj, withRegistry }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const Double = Flows.Action.make("fuzz/Double", {
                payload: { n: Schema.Number },
                success: Schema.Number
              })
              const flow = Flows.Flow.make("fuzz/double", {
                payload: { n: Schema.Number },
                success: Schema.Number,
                body: ({ n }) => Double.call({ n })
              })
              const regLayer = Flows.Interpreter.layer(flow).pipe(
                Layer.provideMerge(Double.toLayer(({ n }) => Effect.succeed(n * 2))),
                Layer.provideMerge(Flows.Action.layerImplementations)
              )
              const opts: Flows.Runtime.Options = {
                owner: { hostId: "fuzz-host" },
                isAlive: () => Effect.succeed(true),
                ...(withCacheEnv ? { cacheEnvironment: { layers: ["node"], capabilities: {} } } : {}),
                ...(withPrivJj ? { privilegedJj: Jj.layerNoop({}) } : {})
              }
              const hostDeps = OwnerIdentity.layerWithoutPid.pipe(
                Layer.provideMerge(
                  Layer.mergeAll(
                    NodeDatabase.layer({ filename: ":memory:" }),
                    NodeCrypto.layer,
                    Jj.layerNoop({}),
                    Logger.layer([])
                  )
                )
              )
              const rtLayer = (withRegistry
                ? Flows.Runtime.layer(
                  opts,
                  StepBoundary.layerUnsupported,
                  WorkspaceSandbox.layerUnsupported,
                  regLayer,
                  Layer.empty
                )
                : Flows.Runtime.layer(
                  opts,
                  StepBoundary.layerUnsupported,
                  WorkspaceSandbox.layerUnsupported,
                  regLayer
                )).pipe(Layer.provide(hostDeps))

              const out = yield* Effect.flatMap(
                Flows.FlowRuntime.FlowRuntime,
                (fr) => fr.execute(flow, { executionId: `fuzz-${input}-${withCacheEnv ? 1 : 0}`, payload: { n: input } })
              ).pipe(Effect.provide(rtLayer))
              if (out !== input * 2) return false
              const built = yield* Flows.Runtime.make(
                opts,
                StepBoundary.layerUnsupported,
                WorkspaceSandbox.layerUnsupported,
                regLayer
              ).pipe(Effect.provide(hostDeps))
              return built !== undefined
            })
          ),
        { seed: seed + 1, executions: Math.min(executions, 20) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
