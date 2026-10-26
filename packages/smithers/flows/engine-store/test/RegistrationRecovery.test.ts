/**
 * What an engine's registrations recovered, as its host reports it: one Info
 * line per report, `engine-store.registration.recovered`, with how many
 * registrations recovered and how long they took in all, and each
 * registration's own recovery at Debug.
 *
 * A browser engine registers hundreds of flows per start; at Info per
 * registration, every cold page load wrote one line per registration (446 in
 * production on 2026-10-25), each relayed to the telemetry endpoint.
 *
 * Every case runs over a real SQLite store.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

// No step here touches a workspace; Jj is only the host port the engine requires.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "recovery" as never, changeId: "recovery" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const engine = (sweep: EngineStore.Sweep) =>
  EngineStore.layer({ owner: { hostId: "recovery" }, journalSource: "recovery-engine", sweep }).pipe(
    Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(":memory:"), StepBoundary.layerUnsupported, jj))
  )

const catalog = ["recovery/a", "recovery/b", "recovery/c"].map((tag) =>
  Flow.make(tag, { payload: {}, success: Schema.String, body: opaqueHandlerBody })
)

type Line = ReturnType<typeof Logger.formatStructured.log>

/** Runs `use` over `sweep`'s engine, given every line it logs at Debug and above. */
const observed = <A, E>(
  sweep: EngineStore.Sweep,
  use: (lines: ReadonlyArray<Line>) => Effect.Effect<A, E, FlowRuntime.FlowRuntime | EngineStore.Driver | Scope.Scope>
) => {
  const lines: Array<Line> = []
  const logger = Logger.make((options) => {
    lines.push(Logger.formatStructured.log(options))
  })
  return withCrypto(Effect.scoped(use(lines).pipe(Effect.provide(engine(sweep))))).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.map((value) => ({ value, lines }))
  )
}

const named = (lines: ReadonlyArray<Line>, message: string) => lines.filter((line) => line.message === message)

const registerAll = (flows: ReadonlyArray<(typeof catalog)[number]>) =>
  Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    for (const flow of flows) yield* runtime.register(flow, () => Effect.succeed("done"))
  })

describe("registration recovery", () => {
  it.effect("logs each registration at Debug and their sum once at Info, when the host reports", () =>
    Effect.gen(function*() {
      const { lines, value } = yield* observed(
        "process",
        (logged) =>
          Effect.gen(function*() {
            // A flow registered twice recovers twice, as a catalog's shared system flows do.
            yield* registerAll([...catalog, catalog[0]!])
            const registered = named(logged, "engine-store.registration.recovered").length
            const report = yield* (yield* EngineStore.Driver).reportRecovery
            return { registered, report }
          })
      )
      // Registering logs nothing at Info.
      expect(value.registered).toBe(0)
      expect(value.report).toEqual({ registrations: 4, durationMs: expect.any(Number) })
      expect(Number.isInteger(value.report.durationMs) && value.report.durationMs >= 0).toBe(true)
      const summary = named(lines, "engine-store.registration.recovered")
      expect(summary).toHaveLength(1)
      expect(summary[0]!.level).toBe("INFO")
      expect(summary[0]!.annotations).toEqual(value.report)
      const detail = named(lines, "engine-store.registration.flow.recovered")
      expect(detail.map((line) => [line.level, line.annotations["smithers.flow"]])).toEqual([
        ["DEBUG", "recovery/a"],
        ["DEBUG", "recovery/b"],
        ["DEBUG", "recovery/c"],
        ["DEBUG", "recovery/a"]
      ])
      for (const line of detail) {
        expect(Number.isInteger(line.annotations["durationMs"])).toBe(true)
      }
    }))

  it.effect("reports only the registrations since the last report", () =>
    Effect.gen(function*() {
      const { value } = yield* observed(
        "process",
        () =>
          Effect.gen(function*() {
            const driver = yield* EngineStore.Driver
            const none = yield* driver.reportRecovery
            yield* registerAll(catalog.slice(0, 2))
            const first = yield* driver.reportRecovery
            const again = yield* driver.reportRecovery
            yield* registerAll(catalog.slice(2))
            const later = yield* driver.reportRecovery
            return [none, first, again, later].map((report) => report.registrations)
          })
      )
      expect(value).toEqual([0, 2, 0, 1])
    }))

  it.effect("counts only the hosted flow's registration on a hosted store", () =>
    Effect.gen(function*() {
      const { lines, value } = yield* observed(
        { host: "recovery-run", flow: "recovery/b" },
        () =>
          Effect.gen(function*() {
            yield* registerAll(catalog)
            return yield* (yield* EngineStore.Driver).reportRecovery
          })
      )
      expect(value.registrations).toBe(1)
      expect(named(lines, "engine-store.registration.flow.recovered").map((line) => line.annotations["smithers.flow"]))
        .toEqual(["recovery/b"])
    }))
})
