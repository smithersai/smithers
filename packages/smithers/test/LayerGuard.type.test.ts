/**
 * Compile probes for the test harnesses that provide a layer and run a body.
 *
 * A harness that ends in `as Effect.Effect<A>` tells tsc every requirement is
 * met, so a missing service surfaces only as a runtime "Service not found"
 * (#2331, #2347). Each harness below derives what it accepts from what its
 * layer provides. The `@ts-expect-error` lines are the probe: if a harness
 * erased its requirements again, the directive would go unused and
 * `tsc -p tsconfig.test.json` would fail.
 *
 * Nothing here runs: every harness is read through `typeof import(...)`, so
 * this file opens no database, process, or fixture.
 */
import { Context, Effect, type Layer, type Scope } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"

type TimeTravel = typeof import("../flows/time-travel/test/RealTimeTravelHarness.ts")
type Bridged = typeof import("./BridgedEngineRun.ts")
type Served = typeof import("./faults/harness/servedSuite.ts")

declare const runReal: TimeTravel["runReal"]
declare const runRealEngine: TimeTravel["runRealEngine"]
declare const runOn: Bridged["runOn"]
declare const stack: Bridged["stack"]
declare const servedSuite: Served["servedSuite"]

class Missing extends Context.Service<Missing, { readonly value: string }>()("test/LayerGuard/Missing") {}

/** The bridged stack plus one more service, so the probe can remove it again. */
declare const stackWithMissing: Layer.Layer<Layer.Success<Bridged["stack"]> | Missing, never, Scope.Scope>
declare const needsMissing: Effect.Effect<string, never, Missing>

/** Never called; tsc checks it. */
const probe = () => {
  expectTypeOf<typeof needsMissing>().not.toExtend<Parameters<typeof runReal>[1]>()
  expectTypeOf<typeof needsMissing>().not.toExtend<Parameters<typeof runRealEngine>[2]>()
  const remote = servedSuite("layer-guard").remote
  expectTypeOf<typeof needsMissing>().not.toExtend<Parameters<typeof remote>[0]>()
  const withMissing = runOn<Layer.Success<typeof stackWithMissing>, never, string, never>
  const withoutMissing = runOn<Layer.Success<typeof stack>, never, string, never>
  expectTypeOf<typeof needsMissing>().toExtend<Parameters<typeof withMissing>[1]>()
  expectTypeOf<typeof needsMissing>().not.toExtend<Parameters<typeof withoutMissing>[1]>()
}

describe("missing service compile probe", () => {
  it("removing one provided service makes tsc reject the harness run type", () => {
    // The assertions are the `@ts-expect-error` directives above.
    expect(probe).toBeTypeOf("function")
  })
})
