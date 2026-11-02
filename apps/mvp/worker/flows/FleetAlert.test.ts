// Fleet alert faults use failed Effect services; subject reads use the real Postgres schema.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Data, Effect, Exit, Layer, Logger, Metric, Option } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
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

describe("a bell row carries the incident's kind, its repository and its link, nothing private", () => {
  const WIDGETS = "github/acme/widgets"
  const query = (text: string, ...params: ReadonlyArray<unknown>) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.orDie(sql.unsafe<Record<string, unknown>>(text, params))))
  const bellRows = (alertId: string) =>
    query(`SELECT recipient, title, href FROM notifications WHERE subject = $1 ORDER BY recipient`, `fleet:${alertId}`)
  const ring = async (alert: Fleet.Alert) =>
    runtime.runPromise(Effect.flatMap(TestDatabase.Scratch, (scratch) => FleetAlert.observedBell(alert, "github/acme/home", scratch.database)))

  test("a revoked Admin whose stale cached row still says Admin hears the kind and the repository, never the title or the cost", async () => {
    const revoked = crypto.randomUUID()
    await query(`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at) VALUES ($1, $2, 'admin', now() - interval '2 hours')`, WIDGETS, revoked)
    await query(`INSERT INTO agent_runs (key, repo_id, agent, generation, queued_at, number, title, cost_usd)
      VALUES ('private-cost', $1, 'coder', 1, now(), 9, 'acquire initech quietly', 12.5)`, WIDGETS)
    await ring({ alertId: "cost-private", kind: "cost", repoId: WIDGETS, subject: "private-cost" })
    expect(await bellRows("cost-private")).toEqual([
      { recipient: revoked, title: "Agent run cost · acme/widgets", href: "/acme/widgets/stack/9" },
    ])
    expect(JSON.stringify(await bellRows("cost-private"))).not.toMatch(/initech|12\.50|coder/)
  })

  test("the committer: no row while a cached row says no role or less than Member; else the kind and the repository", async () => {
    const todo = async (committer: string, number: number) => {
      const attemptId = crypto.randomUUID()
      const todoId = crypto.randomUUID()
      await query(`INSERT INTO stacks (repo_id) VALUES ($1) ON CONFLICT DO NOTHING`, WIDGETS)
      await query(`INSERT INTO todos (id, repo_id, number, title, state, position, created_by, created_login, failure)
        VALUES ($1, $2, $3, 'acquire initech quietly', 'working', $3, $4, 'someone', 'implement')`, todoId, WIDGETS, number, committer)
      await query(`INSERT INTO todo_attempts (id, todo_id, repo_id, ordinal, revision, status) VALUES ($1, $2, $3, 1, 1, 'running')`,
        attemptId, todoId, WIDGETS)
      return { alertId: Fleet.alertId.failed(attemptId), kind: "failed", repoId: WIDGETS, subject: attemptId } satisfies Fleet.Alert
    }
    const removed = crypto.randomUUID()
    const guest = crypto.randomUUID()
    const unknown = crypto.randomUUID()
    const stale = crypto.randomUUID()
    // A read that claimed the row and never heard from GitHub: no role recorded, not a denial.
    const unresolved = crypto.randomUUID()
    await query(`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at) VALUES
      ($1, $2, NULL, now()), ($1, $3, 'guest', now()), ($1, $4, 'admin', now() - interval '2 hours'), ($1, $5, NULL, '-infinity')`,
      WIDGETS, removed, guest, stale, unresolved)
    for (
      const [committer, number, heard] of [[removed, 1, false], [guest, 2, false], [unknown, 3, true], [stale, 4, true], [unresolved, 5, true]] as const
    ) {
      const alert = await todo(committer, number)
      await ring(alert)
      const rows = await bellRows(alert.alertId)
      // Others with cached roles are in every failure's audience; the committer is who this checks.
      expect(rows.filter((row) => row.recipient === committer)).toEqual(heard ? [{ recipient: committer, title: "Agent run failed · acme/widgets", href: `/acme/widgets/stack/${number}` }] : [])
      expect(JSON.stringify(rows)).not.toMatch(/initech|implement/)
    }
  })
})

test("a bell title with a repository's longest name is cut to a title's 200 characters", () => {
  const title = FleetAlert.bellTitleOf("waiting", `github/${"o".repeat(100)}/${"n".repeat(100)}`)
  expect(title).toHaveLength(200)
  expect(title.endsWith("…")).toBe(true)
})
