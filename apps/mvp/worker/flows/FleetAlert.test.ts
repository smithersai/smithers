// Fleet alert faults use failed Effect services; subject reads use the real Postgres schema.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Data, Effect, Exit, Layer, Logger, Metric, Option } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as Flows from "../Flows.ts"
import { testFile } from "../test/harness.ts"
import * as Fleet from "../runners/Fleet.ts"
import * as FleetAlert from "./FleetAlert.ts"

const runtime = testFile("fleet_alert_edges")
class Unreachable extends Data.TaggedError("Unreachable")<{}> {}
const down = Layer.effect(SqlClient.SqlClient, Effect.fail(new Unreachable()))
const alert: Fleet.Alert = { alertId: "offline-missing", kind: "offline", repoId: "github/acme/widgets", subject: "missing" }

test("a runner that disappeared has no incident to describe", async () => {
  expect(await runtime.runPromise(FleetAlert.describe(alert))).toEqual(Option.none())
})

test("database faults are typed, logged by code and counted without losing the operation", async () => {
  const registry: Metric.MetricRegistry = new Map()
  const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logger = Logger.make((line) => { lines.push(StructuredLogger.formatStructured.log(line)) })
  const observed = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(
    Effect.result,
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.provideService(Metric.MetricRegistry, registry),
  ))
  expect(await observed(FleetAlert.observedBell(alert, "github/acme/widgets", down)))
    .toMatchObject({ _tag: "Failure", failure: { reason: "database" } })
  expect(await observed(FleetAlert.check(down, 45, () => Effect.void)({ from: 0, until: 60_000 })))
    .toMatchObject({ _tag: "Failure", failure: { reason: "database" } })
  expect(lines.map((line) => line.message)).toContain("fleet.alert.bell")
  expect(lines.map((line) => line.message)).toContain("runner.health")
  expect(Effect.runSync(Metric.value(Metric.withAttributes(FleetAlert.checks, { outcome: "failed" })).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count).toBe(1)
})

test("starting an existing alert is idempotent; an unavailable starter preserves its typed failure", async () => {
  const conflict = Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartConflict()) })
  expect(await Effect.runPromise(Effect.exit(FleetAlert.startWith(conflict)(alert)))).toEqual(Exit.void)
  const failure = new Flows.StartUnavailable({ errorCode: "unreachable" })
  const unavailable = Flows.FlowStarter.of({ start: () => Effect.fail(failure) })
  expect(await Effect.runPromise(Effect.result(FleetAlert.startWith(unavailable)(alert)))).toMatchObject({ _tag: "Failure", failure })
})

test("the minute sampler records failed admission and deduplicates an already recorded window", async () => {
  const registry: Metric.MetricRegistry = new Map()
  const unavailable = Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "unreachable" })) })
  await Effect.runPromise(Effect.gen(function* () {
    const start = yield* FleetAlert.sampler
    yield* start.pipe(Effect.provideService(Flows.FlowStarter, unavailable))
    yield* start.pipe(Effect.provideService(Flows.FlowStarter, Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartConflict()) })))
    // The existing receipt stops admission; the unavailable service must not be asked again in this window.
    yield* start.pipe(Effect.provideService(Flows.FlowStarter, unavailable))
  }).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Metric.MetricRegistry, registry)))
  expect(Effect.runSync(Metric.value(Metric.withAttributes(FleetAlert.checks, { outcome: "not_started" })).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count).toBe(1)
  expect(FleetAlert.healthExecutionId({ from: 0, until: 60_000 })).toBe("runner-health-60000-0")
})


test("a long Unicode TODO title is clipped within the alert bound without cutting a surrogate pair", async () => {
  for (const number of [7, 12]) {
    const subject = `unicode-${number}`
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO agent_runs (key, repo_id, agent, generation, queued_at, number, title)
      VALUES (${subject}, 'github/acme/widgets', 'coder', 1, now(), ${number}, ${"🟢".repeat(120)})`))
    const described = Option.getOrThrow(await runtime.runPromise(FleetAlert.describe({
      alertId: `stall-${number}`, kind: "stalled", repoId: "github/acme/widgets", subject,
    })))
    expect(described.title.length).toBeLessThanOrEqual(200)
    expect(described.title.startsWith(`T${number} `)).toBe(true)
    expect(described.title.endsWith("🟢…")).toBe(true)
  }
})


test("a projection with a missing title or no reported cost still describes its incident", async () => {
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO agent_runs (key, repo_id, agent, generation, queued_at, number, title)
    VALUES ('untitled', 'github/acme/widgets', 'coder', 1, now(), 42, NULL),
      ('cost', 'github/acme/widgets', 'coder', 1, now(), NULL, NULL)`))
  const describe = async (subject: string, kind: Fleet.Kind) => Option.getOrThrow(await runtime.runPromise(FleetAlert.describe({
    alertId: `alert-${subject}`, subject, kind, repoId: "github/acme/widgets",
  })))
  expect((await describe("untitled", "waiting")).title).toBe("T42 · Waiting for a runner")
  expect((await describe("cost", "cost")).title).toBe("Agent run · Cost · coder")
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE agent_runs SET cost_usd = 6.5 WHERE key = 'cost'`))
  expect((await describe("cost", "cost")).title).toBe("Agent run · Cost · $6.50")
})

test("an alert that cannot be admitted never fails the probe or marks its incident as raised", async () => {
  const registry: Metric.MetricRegistry = new Map()
  const unavailable = Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "unreachable" })) })
  await Effect.runPromise(Fleet.raiseAll("missing", [alert], FleetAlert.startWith(unavailable), (effect) => Effect.provide(effect, down)).pipe(
    Effect.provideService(Metric.MetricRegistry, registry),
  ))
  expect(Effect.runSync(Metric.value(Metric.withAttributes(Fleet.raised, { kind: "offline", outcome: "not_started" })).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count).toBe(1)
  expect(Effect.runSync(Metric.value(Metric.withAttributes(Fleet.raised, { kind: "offline", outcome: "started" })).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count).toBe(0)
})
