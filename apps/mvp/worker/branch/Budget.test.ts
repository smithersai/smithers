// The sandbox ledger and its admission (worker/branch/Budget.ts, docs/features/sandbox-budgets.md) over this file's
// schema of the compose Postgres: limits, admission under them, a machine's start, renewal, end and release, and the
// month's spend. Time passes by moving a slot's timestamps back, never by waiting.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Cause, Effect, Exit, Logger, Metric, Redacted, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { DEFAULT_SANDBOX_LIMITS } from "../../src/features/spend/contract.ts"
import { CI_OWNER } from "../flows/CiJobMachine.ts"
import { testFile } from "../test/harness.ts"
import * as Budget from "./Budget.ts"

const runtime = testFile("sandbox_budget")

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE sandbox_generations, sandbox_limits`))
)

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect)

const sql = <A extends object = Record<string, unknown>>(statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe<A>(statement))))

const database = () => runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))

/** Every slot, oldest first: what it is for, whether it is open, and its generation. */
const slots = () =>
  sql<{ branchId: string; generation: number | null; personId: string | null; kind: string; instance: string | null; open: boolean }>(`
    SELECT branch_id AS "branchId", generation, person_id AS "personId", kind, instance, ended_at IS NULL AS open
    FROM sandbox_generations ORDER BY id`)

const slot = (branchId: string, personId: string | null = "maya", kind: Budget.Kind = "branch"): Budget.Slot =>
  ({ branchId, personId, kind })

/** Moves every slot of `branchId` back `seconds`, as if that long passed since it started and was last renewed. */
const age = (branchId: string, seconds: number) =>
  sql(`
    UPDATE sandbox_generations SET started_at = started_at - interval '${seconds} seconds',
      seen_at = seen_at - interval '${seconds} seconds'
    WHERE branch_id = '${branchId}'`)

/** Runs `effect`, keeping every log line, metric and span it records. */
const observed = async <A, E>(effect: Effect.Effect<A, E>) => {
  const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logger = Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))
  const registry: Metric.MetricRegistry = new Map()
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  )
  const read = <S>(metric: Metric.Metric<number, S>) =>
    Effect.runSync(Metric.value(metric).pipe(Effect.provideService(Metric.MetricRegistry, registry)))
  return { exit, lines, spans, read }
}

describe("what a machine is for", () => {
  test("a job's, a TODO's attempt branch on GitHub, else the branch's own", () => {
    expect(Budget.kindOf({ branchId: "b", owner: "o", name: "n", branch: "x", kind: "job", forge: "github" })).toBe("job")
    expect(Budget.kindOf({ branchId: "b", owner: "o", name: "n", branch: "x", forge: "github" })).toBe("todo")
    expect(Budget.kindOf({ branchId: "b", owner: "o", name: "n", branch: "x" })).toBe("branch")
  })

  test("the person is the owner, unless it is CI's own or none", () => {
    expect(Budget.personOf("maya")).toBe("maya")
    expect(Budget.personOf(CI_OWNER)).toBeNull()
    expect(Budget.personOf("")).toBeNull()
    expect(Budget.personOf(undefined)).toBeNull()
  })
})

describe("the limits", () => {
  test("the defaults hold until an Admin sets them; setting them again replaces them", async () => {
    expect(await run(Budget.limits)).toEqual(DEFAULT_SANDBOX_LIMITS)
    expect(DEFAULT_SANDBOX_LIMITS).toEqual({ awake: 20, perPerson: 2, monthlyAlertUsd: 100 })
    const first = await run(Budget.setLimits({ awake: 5, perPerson: 1, monthlyAlertUsd: 0 }, "person-admin"))
    expect(await run(Budget.limits)).toEqual({ awake: 5, perPerson: 1, monthlyAlertUsd: 0 })
    const second = await run(Budget.setLimits({ awake: 7, perPerson: 3, monthlyAlertUsd: 250 }, "person-admin"))
    expect(await run(Budget.limits)).toEqual({ awake: 7, perPerson: 3, monthlyAlertUsd: 250 })
    expect(second).toBeGreaterThanOrEqual(first)
    expect(await sql(`SELECT count(*)::int AS rows, max(updated_by) AS by FROM sandbox_limits`)).toEqual([
      { rows: 1, by: "person-admin" },
    ])
  })

  test("Postgres refuses limits outside their bounds", async () => {
    const refused = await runtime.runPromiseExit(Budget.setLimits({ awake: 0, perPerson: 1, monthlyAlertUsd: 1 }, "a"))
    expect(Exit.isFailure(refused)).toBe(true)
  })
})

describe("admission", () => {
  test("a machine is admitted while fewer than the limit are awake, then a new one waits", async () => {
    await run(Budget.setLimits({ awake: 2, perPerson: 2, monthlyAlertUsd: 100 }, "a"))
    expect(await run(Budget.admit(slot("one", "maya")))).toEqual({ _tag: "Admitted", awake: 1 })
    expect(await run(Budget.admit(slot("two", "ben")))).toEqual({ _tag: "Admitted", awake: 2 })
    expect(await run(Budget.admit(slot("three", "gus")))).toEqual({
      _tag: "Waiting",
      scope: "deployment",
      awake: 2,
      limit: 2,
    })
    expect((await slots()).map((row) => row.branchId)).toEqual(["one", "two"])
  })

  test("a branch whose slot is live keeps it, at the limit too, and renews it", async () => {
    await run(Budget.setLimits({ awake: 1, perPerson: 1, monthlyAlertUsd: 100 }, "a"))
    await run(Budget.admit(slot("one")))
    await age("one", 120)
    expect(await run(Budget.admit(slot("one")))).toEqual({ _tag: "Admitted", awake: 1 })
    const [renewed] = await sql<{ fresh: boolean }>(
      `SELECT seen_at > now() - interval '5 seconds' AS fresh FROM sandbox_generations`,
    )
    expect(renewed!.fresh).toBe(true)
    expect(await slots()).toHaveLength(1)
  })

  test("a slot nobody renewed within the lease stops counting; its branch's next admission closes it", async () => {
    await run(Budget.setLimits({ awake: 1, perPerson: 1, monthlyAlertUsd: 100 }, "a"))
    await run(Budget.admit(slot("one", "maya")))
    await age("one", Budget.LEASE_SECONDS + 1)
    // Another branch: the lapsed slot doesn't count against the limit.
    expect(await run(Budget.admit(slot("two", "ben")))).toEqual({ _tag: "Admitted", awake: 1 })
    expect(await run(Budget.awake)).toBe(1)
    // The first branch again: its lapsed slot closes at its last renewal, and it waits behind the live one.
    expect(await run(Budget.admit(slot("one", "maya")))).toMatchObject({ _tag: "Waiting", scope: "deployment" })
    const ended = await sql<{ closed: boolean }>(
      `SELECT ended_at = seen_at AS closed FROM sandbox_generations WHERE branch_id = 'one'`,
    )
    expect(ended).toEqual([{ closed: true }])
  })

  test("a person's own branch machines stop at their limit; TODO, job and CI machines don't count toward it", async () => {
    await run(Budget.setLimits({ awake: 20, perPerson: 2, monthlyAlertUsd: 100 }, "a"))
    expect(await run(Budget.admit(slot("todo", "maya", "todo")))).toMatchObject({ _tag: "Admitted" })
    expect(await run(Budget.admit(slot("job", "maya", "job")))).toMatchObject({ _tag: "Admitted" })
    expect(await run(Budget.admit(slot("one", "maya")))).toMatchObject({ _tag: "Admitted" })
    expect(await run(Budget.admit(slot("two", "maya")))).toMatchObject({ _tag: "Admitted" })
    expect(await run(Budget.admit(slot("three", "maya")))).toEqual({ _tag: "Waiting", scope: "person", awake: 4, limit: 2 })
    // Someone else, a TODO of the same person's, and CI still get machines.
    expect(await run(Budget.admit(slot("ben-1", "ben")))).toMatchObject({ _tag: "Admitted" })
    expect(await run(Budget.admit(slot("todo-2", "maya", "todo")))).toMatchObject({ _tag: "Admitted" })
    expect(await run(Budget.admit(slot("ci", null, "job")))).toEqual({ _tag: "Admitted", awake: 7 })
    expect(await run(Budget.admit(slot("nobody", null)))).toEqual({ _tag: "Admitted", awake: 8 })
  })

  test("concurrent admissions never pass the limit: the advisory lock serializes them", async () => {
    await run(Budget.setLimits({ awake: 3, perPerson: 10, monthlyAlertUsd: 100 }, "a"))
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, index) => run(Budget.admit(slot(`b-${index}`, `p-${index}`)))),
    )
    expect(answers.filter((answer) => answer._tag === "Admitted")).toHaveLength(3)
    expect(await run(Budget.awake)).toBe(3)
  })

  test("it records each admission: Info admitted, Warn waiting with the scope and limit, the awake gauge, a count", async () => {
    const db = await database()
    await run(Budget.setLimits({ awake: 1, perPerson: 1, monthlyAlertUsd: 100 }, "a"))
    const admitted = await observed(Budget.observedAdmit(slot("one", "maya"), db))
    const waiting = await observed(Budget.observedAdmit(slot("two", "ben", "todo"), db))

    expect(admitted.lines).toMatchObject([{
      message: "sandbox.budget",
      level: "INFO",
      annotations: { branchId: "one", kind: "branch", outcome: "admitted", awake: 1 },
    }])
    expect(admitted.read(Budget.awakeGauge).value).toBe(1)
    const admittedCount = Metric.withAttributes(Budget.admissions, { outcome: "admitted", scope: "none", kind: "branch" })
    expect(admitted.read(admittedCount).count).toBe(1)
    expect(waiting.lines).toMatchObject([{
      message: "sandbox.budget",
      level: "WARN",
      annotations: { branchId: "two", kind: "todo", outcome: "waiting", awake: 1, scope: "deployment", limit: 1 },
    }])
    const waitingCount = Metric.withAttributes(Budget.admissions, { outcome: "waiting", scope: "deployment", kind: "todo" })
    expect(waiting.read(waitingCount).count).toBe(1)
    // Never a person's id.
    expect(JSON.stringify([...admitted.lines, ...waiting.lines])).not.toMatch(/maya|ben/)
    expect(admitted.spans.map((span) => span.name)).toContain("sandbox.budget.admit")
  })

  test("Postgres failing fails the admission, logged and counted by its code: the machine doesn't start", async () => {
    const unreachable = Database.layer(
      Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")),
    )
    const failed = await observed(Budget.observedAdmit(slot("one", "maya", "job"), unreachable))
    expect(Exit.isFailure(failed.exit)).toBe(true)
    expect(failed.lines).toMatchObject([{
      message: "sandbox.budget",
      level: "WARN",
      annotations: { branchId: "one", kind: "job", outcome: "failed", errorCode: expect.stringMatching(/^sql:/) },
    }])
    const failedCount = Metric.withAttributes(Budget.admissions, { outcome: "failed", scope: "none", kind: "job" })
    expect(failed.read(failedCount).count).toBe(1)
  })
})

describe("a machine's slot over its life", () => {
  const started = (branchId: string, generation: number, personId: string | null = "maya") =>
    Budget.started({ branchId, personId, kind: "branch", generation, instance: "standard-1" })

  test("an admitted slot takes the generation and instance once its machine starts; the same start again renews it", async () => {
    await run(Budget.admit(slot("one")))
    await age("one", 60)
    await run(started("one", 1))
    expect(await slots()).toEqual([
      { branchId: "one", generation: 1, personId: "maya", kind: "branch", instance: "standard-1", open: true },
    ])
    // Its awake time starts at the start, not the admission.
    const [fresh] = await sql<{ fresh: boolean }>(
      `SELECT started_at > now() - interval '5 seconds' AS fresh FROM sandbox_generations`,
    )
    expect(fresh!.fresh).toBe(true)
    await age("one", 60)
    await run(started("one", 1))
    const [renewed] = await sql<{ seen: boolean; start: boolean }>(`
      SELECT seen_at > now() - interval '5 seconds' AS seen, started_at < now() - interval '30 seconds' AS start
      FROM sandbox_generations`)
    expect(renewed).toEqual({ seen: true, start: true })
  })

  test("a new generation closes the earlier one's slot and opens its own; a start with no slot gets one", async () => {
    await run(started("one", 1))
    await run(started("one", 2))
    expect((await slots()).map(({ generation, open }) => ({ generation, open }))).toEqual([
      { generation: 1, open: false },
      { generation: 2, open: true },
    ])
  })

  test("renewal and end name their generation; a later generation's slot is untouched by an earlier one's", async () => {
    await run(started("one", 1))
    await age("one", 120)
    await run(Budget.seen("one", 1))
    const [seen] = await sql<{ fresh: boolean }>(`SELECT seen_at > now() - interval '5 seconds' AS fresh FROM sandbox_generations`)
    expect(seen!.fresh).toBe(true)
    await run(started("one", 2))
    await run(Budget.ended("one", 1))
    await run(Budget.seen("one", 1))
    expect((await slots()).map(({ generation, open }) => ({ generation, open }))).toEqual([
      { generation: 1, open: false },
      { generation: 2, open: true },
    ])
    await run(Budget.ended("one", 2))
    expect((await slots()).every((row) => !row.open)).toBe(true)
    expect(await run(Budget.awake)).toBe(0)
  })

  test("a wake that failed before its machine started gives the slot back; a started one keeps it", async () => {
    await run(Budget.admit(slot("one")))
    await run(Budget.release("one"))
    expect(await slots()).toMatchObject([{ branchId: "one", generation: null, open: false }])
    await run(started("two", 1))
    await run(Budget.release("two"))
    expect(await slots()).toMatchObject([{ branchId: "one", open: false }, { branchId: "two", open: true }])
  })
})

describe("spend", () => {
  test("a second awake costs each instance type's vCPUs, memory and disk; an unknown type is priced as the largest", () => {
    expect(Budget.pricePerSecond("standard-1")).toBeCloseTo(0.5 * 0.00002 + 4 * 0.0000025 + 8 * 0.00000007, 12)
    expect(Budget.pricePerSecond("standard-1") * 3600).toBeCloseTo(0.074, 3)
    expect(Budget.pricePerSecond("lite")).toBeLessThan(Budget.pricePerSecond("basic"))
    expect(Budget.pricePerSecond("mystery")).toBe(Budget.pricePerSecond("standard-4"))
  })

  test("a month is its UTC calendar month, December into January", () => {
    expect(Budget.monthOf(Date.UTC(2026, 9, 25, 13))).toEqual({
      label: "2026-10",
      from: Date.UTC(2026, 9, 1),
      until: Date.UTC(2026, 10, 1),
    })
    expect(Budget.monthOf(Date.UTC(2026, 11, 31, 23, 59))).toEqual({
      label: "2026-12",
      from: Date.UTC(2026, 11, 1),
      until: Date.UTC(2027, 0, 1),
    })
  })

  test("prices each slot's awake time within the month: ended, live to now, lapsed to its last renewal, never unstarted", async () => {
    const month = Budget.monthOf(Date.now())
    // Ended: two hours awake on standard-1.
    await sql(`
      INSERT INTO sandbox_generations (branch_id, generation, kind, instance, started_at, seen_at, ended_at)
      VALUES ('ended', 1, 'branch', 'standard-1', now() - interval '3 hours', now() - interval '1 hour', now() - interval '1 hour')`)
    // Live: renewed a minute ago, awake an hour so far, on basic.
    await sql(`
      INSERT INTO sandbox_generations (branch_id, generation, kind, instance, started_at, seen_at)
      VALUES ('live', 1, 'todo', 'basic', now() - interval '1 hour', now() - interval '1 minute')`)
    // Lapsed: last renewed 30 minutes after its start, an hour ago.
    await sql(`
      INSERT INTO sandbox_generations (branch_id, generation, kind, instance, started_at, seen_at)
      VALUES ('lapsed', 1, 'job', 'standard-1', now() - interval '90 minutes', now() - interval '60 minutes')`)
    // Admitted, never started: no instance, no cost.
    await run(Budget.admit(slot("waiting")))
    const spent = await run(Budget.spendIn(month))
    const expectedHours = 2 + 1 + 0.5
    const expectedUsd = (2 + 0.5) * 3600 * Budget.pricePerSecond("standard-1") + 3600 * Budget.pricePerSecond("basic")
    // Within the month only: when the month began under 3 hours ago, less of the ended slot counts.
    const sinceMonthStart = (Date.now() - month.from) / 3_600_000
    if (sinceMonthStart > 3) {
      expect(spent.hours).toBeCloseTo(expectedHours, 2)
      expect(spent.usd).toBeCloseTo(expectedUsd, 4)
    } else {
      expect(spent.hours).toBeLessThanOrEqual(expectedHours)
    }
  })

  test("a slot from before the month counts only from the month's start; one from after it not at all", async () => {
    const month = Budget.monthOf(Date.now())
    const previous = Budget.monthOf(month.from - 1)
    const at = (ms: number) => `to_timestamp(${ms / 1000})`
    await sql(`
      INSERT INTO sandbox_generations (branch_id, generation, kind, instance, started_at, seen_at, ended_at)
      VALUES ('across', 1, 'branch', 'standard-1', ${at(month.from - 3_600_000)}, ${at(month.from + 1_800_000)},
        ${at(month.from + 1_800_000)})`)
    expect((await run(Budget.spendIn(month))).hours).toBeCloseTo(0.5, 3)
    expect((await run(Budget.spendIn(previous))).hours).toBeCloseTo(1, 3)
    expect(await run(Budget.spendIn(Budget.monthOf(month.until)))).toEqual({ usd: 0, hours: 0 })
  })

  test("no machines, no spend", async () => {
    expect(await run(Budget.spendIn(Budget.monthOf(Date.now())))).toEqual({ usd: 0, hours: 0 })
    expect(await run(Budget.awake)).toBe(0)
  })
})

test("Postgres failing fails the admission as a defect of the query, never as Waiting", async () => {
  const exit = await Effect.runPromiseExit(
    Budget.admit(slot("one")).pipe(
      Effect.provide(Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))),
    ),
  )
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeTruthy()
})
