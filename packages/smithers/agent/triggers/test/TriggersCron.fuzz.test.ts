import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Cron as EffectCron, Effect, Layer, Schema } from "effect"
import { expect, it } from "vitest"
import { Cron, SqlTriggerStore, TriggerStore } from "../src/index.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

const check = async <A, E>(
  arb: Arbitrary.Arbitrary<A>,
  property: (value: A) => Effect.Effect<boolean, E>,
  options: Fuzz.Options = {}
) => {
  const report = await Effect.runPromise(Fuzz.run(arb, property, { executions: pureExecutions, seed, ...options }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

it("round-trips cron fields and returns exactly the matching instants in (from, to]", () =>
  check(
    Arbitrary.all({
      start: int(0, 10),
      end: int(30, 59),
      step: int(2, 13),
      extra: int(0, 59),
      second: int(0, 59),
      boundary: Arbitrary.schema(
        Schema.Literals(["2000-02-29", "2100-03-01", "2024-03-01", "2025-01-01", "2024-05-01"])
      ),
      millis: int(-999, 999)
    }),
    ({ start, end, step, extra, second, boundary, millis }) =>
      Effect.gen(function*() {
        const expr = `${second} ${start}-${end}/${step},${extra} * * * *`
        const cron = yield* Cron.parse(expr, "UTC")
        const formatted = EffectCron.format(cron.value)
        const roundTrip = yield* Cron.parse(formatted, cron.timezone)
        expect(EffectCron.format(roundTrip.value)).toBe(formatted)
        const midnight = Date.parse(boundary + "T00:00:00Z")
        const from = midnight - hour + millis
        const to = midnight + hour + millis
        const expected: Array<number> = []
        for (let t = Math.floor(from / minute) * minute + second * 1000; t <= to; t += minute) {
          const m = new Date(t).getUTCMinutes()
          const matches = m === extra || (m >= start && m <= end && (m - start) % step === 0)
          expect(EffectCron.match(roundTrip.value, t)).toBe(matches)
          if (matches && t > from) expected.push(t)
        }
        for (const schedule of [cron, roundTrip]) {
          const actual = yield* Cron.occurrencesBetween(schedule, new Date(from), new Date(to))
          expect(actual.map(Number)).toEqual(expected)
          let previous = from
          for (const instant of expected) {
            expect(Number(yield* Cron.next(schedule, new Date(previous)))).toBe(instant)
            expect(instant).toBeGreaterThan(previous)
            previous = instant
          }
        }
        return true
      }),
    { execution: FuzzSimulation.execution() }
  ))

it("finds successive leap days across century exceptions at the requested minute", () =>
  check(
    Arbitrary.all({
      year: Arbitrary.schema(Schema.Literals([1896, 1996, 2000, 2024, 2096, 2104])),
      m: int(0, 59),
      h: int(0, 23)
    }),
    ({ year, m, h }) =>
      Effect.gen(function*() {
        const leapDay = (y: number) => Date.UTC(y, 1, 29, h, m)
        const first = leapDay(year)
        let y = year + 1
        while (new Date(leapDay(y)).getUTCMonth() !== 1) y++
        const cron = yield* Cron.parse(`${m} ${h} 29 FEB *`, "UTC")
        expect(Number(yield* Cron.next(cron, new Date(first - 1)))).toBe(first)
        expect(Number(yield* Cron.next(cron, new Date(first)))).toBe(leapDay(y))
        expect(Number(yield* Cron.previousAtOrBefore(cron, new Date(leapDay(y) - 1)))).toBe(first)
        return true
      }),
    { execution: FuzzSimulation.execution() }
  ))

it("fires fixed wall hours once through a gap or fold and every hour through both passes", () =>
  check(
    Arbitrary.all({ m: int(0, 59), spring: Arbitrary.schema(Schema.Boolean), east: Arbitrary.schema(Schema.Boolean) }),
    ({ m, spring, east }) =>
      Effect.gen(function*() {
        const zone = east ? "America/New_York" : "America/Los_Angeles"
        const transition = spring ? Date.UTC(2026, 2, 8, east ? 7 : 10) : Date.UTC(2026, 10, 1, east ? 6 : 9)
        const fixed = yield* Cron.parse(`${m} ${spring ? 2 : 1} * * *`, zone)
        const expected = transition + m * minute - (spring ? 0 : hour)
        const from = new Date(transition - 2 * hour)
        const to = new Date(transition + 2 * hour - 1)
        expect((yield* Cron.occurrencesBetween(fixed, from, to)).map(Number)).toEqual([expected])
        expect(Number(yield* Cron.next(fixed, new Date(expected)))).toBe(expected + day + (spring ? -hour : hour))
        const hourly = yield* Cron.parse(`${m} * * * *`, zone)
        const instants = [0, 1, 2, 3].map((i) => Number(from) + i * hour + m * minute)
        expect((yield* Cron.occurrencesBetween(hourly, new Date(Number(from) - 1), to)).map(Number)).toEqual(instants)
        for (const instant of instants) {
          expect(Number(yield* Cron.next(hourly, new Date(instant)))).toBe(instant + hour)
        }
        return true
      }),
    { execution: FuzzSimulation.execution() }
  ))

it("claims each scheduled instant once per trigger under repeated and reordered deliveries", () =>
  check(
    Arbitrary.all({
      m: int(0, 59),
      deliveries: Arbitrary.array(int(0, 5), { minLength: 2, maxLength: 10 })
    }),
    ({ m, deliveries }) =>
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const expression = `${m} * * * *`
        const cron = yield* Cron.parse(expression, "UTC")
        const occurrences = yield* Cron.occurrencesBetween(cron, new Date(-1), new Date(3 * hour - 1))
        const triggers = yield* Effect.forEach(["a", "b"], (id) =>
          store.register({
            id,
            flowId: "flow",
            input: {},
            cron: expression,
            timezone: "UTC",
            enabled: true,
            catchUp: "none",
            maxCatchUp: 0,
            overlap: "skip"
          }))
        const seen = new Set<number>()
        // Always redeliver the same occurrence, including to two different triggers.
        for (const delivery of [0, 1, ...deliveries, ...[...deliveries].reverse(), 1, 0]) {
          const trigger = triggers[delivery % 2]!
          const fire = {
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
            occurrence: Number(occurrences[Math.floor(delivery / 2)]!)
          }
          const claim = yield* store.claimFire(fire)
          expect(claim.claimed).toBe(!seen.has(delivery))
          if (claim.claimed && claim.action === "fire") {
            expect(yield* store.claimFire(fire)).toEqual({ claimed: false })
            const runId = `run-${delivery}`
            yield* store.recordResult({ ...fire, outcome: "launched", runId, reservationId: claim.reservationId })
            yield* store.recordResult({ ...fire, outcome: "completed", runId })
            seen.add(delivery)
          } else if (claim.claimed) return false
        }
        const actual = (yield* store.history()).items.map((row) => [row.triggerId, row.occurrence, row.outcome])
        expect(actual).toHaveLength(seen.size)
        for (const d of seen) {
          expect(actual).toContainEqual([triggers[d % 2]!.id, Number(occurrences[Math.floor(d / 2)]), "completed"])
        }
        return true
      }).pipe(Effect.provide(SqlTriggerStore.layer.pipe(Layer.provide(TestDatabase.sqliteLayer)))),
    { executions: ioExecutions }
  ))
