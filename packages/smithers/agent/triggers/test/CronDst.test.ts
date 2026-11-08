/**
 * Occurrence computation across daylight-saving transitions.
 *
 * A trigger's `timezone` makes its cron a wall-clock schedule: a transition
 * should move the UTC instant of an occurrence and nothing else. These tests
 * pin what the public API answers for `America/Los_Angeles` and
 * `America/New_York` across the 2026 United States transitions, spring
 * forward on Sunday 8 March and fall back on Sunday 1 November: the instants
 * `Cron` searches, the instants a `Scheduler` launches over the real SQL store
 * on a test clock, and the idempotency keys it launches them under. Each
 * instant is also read back through `Intl` in its zone, independently of the
 * cron arithmetic, so a wrong offset cannot pass by agreeing with itself.
 *
 * The host's own zone is part of the answer (see the last case), so every
 * case runs on a host pinned to UTC unless it names another host zone.
 *
 * The rules those answers follow, fixed by
 * https://github.com/smithersai/smithers/issues/1930:
 *
 * - A wall time that spring forward skips fires at the instant it would have
 *   had on the old offset: a daily 02:30 fires at 03:30 daylight time, and the
 *   scheduler launches the gap day once.
 * - A wall time that fall back repeats fires once, at its first instant, so a
 *   tick inside the repeated hour launches nothing. An expression whose hour
 *   field is every hour fires in both passes, so it never stalls for an hour.
 * - Occurrences are whole seconds in UTC, so the host's zone never moves one.
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Cron from "../src/Cron.ts"
import * as Scheduler from "../src/Scheduler.ts"
import * as SqlTriggerStore from "../src/SqlTriggerStore.ts"
import * as Trigger from "../src/Trigger.ts"
import { TriggerError } from "../src/TriggerError.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const minute = 60 * 1_000
const hour = 60 * minute

// Node applies a change to `TZ` to every later local-time conversion in the
// process, so the host zone is set per case and restored after the file.
const hostZone = process.env.TZ
const setHostZone = (zone: string | undefined): void => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
}
beforeAll(() => setHostZone("UTC"))
afterAll(() => setHostZone(hostZone))

/** Runs `body` on a host whose local zone is `zone`, then returns the host to UTC. */
const onHost = async <A>(zone: string, body: () => Promise<A>): Promise<A> => {
  setHostZone(zone)
  try {
    return await body()
  } finally {
    setHostZone("UTC")
  }
}

/** The zone's own reading of an instant, from ICU rather than from the cron. */
const wallClock = (instant: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short"
  }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value
  return `${part("weekday")} ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${
    part("timeZoneName")
  }`
}

const iso = (instants: ReadonlyArray<Date>): ReadonlyArray<string> => instants.map((instant) => instant.toISOString())

/** One instant as `<UTC>` beside `<the zone's wall clock>`. */
const read = (instants: ReadonlyArray<Date>, timeZone: string): ReadonlyArray<string> =>
  instants.map((instant) => `${instant.toISOString()} ${wallClock(instant, timeZone)}`)

interface Zone {
  readonly timezone: string
  /** Weekly Friday 09:00 across spring forward: two standard weeks, two daylight weeks. */
  readonly fridaysSpring: ReadonlyArray<string>
  /** Weekly Friday 09:00 across fall back: two daylight weeks, two standard weeks. */
  readonly fridaysFall: ReadonlyArray<string>
  /** Daily 02:30, Friday 6 to Monday 9 March. */
  readonly gap: ReadonlyArray<string>
  /** Daily 01:30, Friday 30 October to Monday 2 November. */
  readonly repeat: ReadonlyArray<string>
  /** 01:00 standard time on 1 November, inside the repeated hour. */
  readonly repeatedOne: string
  /** 01:30 standard time on 1 November, the repeated 01:30. */
  readonly repeatedOneThirty: string
}

const zones: ReadonlyArray<Zone> = [
  {
    timezone: "America/Los_Angeles",
    fridaysSpring: [
      "2026-02-27T17:00:00.000Z Fri 2026-02-27 09:00 PST",
      "2026-03-06T17:00:00.000Z Fri 2026-03-06 09:00 PST",
      "2026-03-13T16:00:00.000Z Fri 2026-03-13 09:00 PDT",
      "2026-03-20T16:00:00.000Z Fri 2026-03-20 09:00 PDT"
    ],
    fridaysFall: [
      "2026-10-23T16:00:00.000Z Fri 2026-10-23 09:00 PDT",
      "2026-10-30T16:00:00.000Z Fri 2026-10-30 09:00 PDT",
      "2026-11-06T17:00:00.000Z Fri 2026-11-06 09:00 PST",
      "2026-11-13T17:00:00.000Z Fri 2026-11-13 09:00 PST"
    ],
    gap: [
      "2026-03-06T10:30:00.000Z Fri 2026-03-06 02:30 PST",
      "2026-03-07T10:30:00.000Z Sat 2026-03-07 02:30 PST",
      "2026-03-08T10:30:00.000Z Sun 2026-03-08 03:30 PDT",
      "2026-03-09T09:30:00.000Z Mon 2026-03-09 02:30 PDT"
    ],
    repeat: [
      "2026-10-30T08:30:00.000Z Fri 2026-10-30 01:30 PDT",
      "2026-10-31T08:30:00.000Z Sat 2026-10-31 01:30 PDT",
      "2026-11-01T08:30:00.000Z Sun 2026-11-01 01:30 PDT",
      "2026-11-02T09:30:00.000Z Mon 2026-11-02 01:30 PST"
    ],
    repeatedOne: "2026-11-01T09:00:00.000Z",
    repeatedOneThirty: "2026-11-01T09:30:00.000Z"
  },
  {
    timezone: "America/New_York",
    fridaysSpring: [
      "2026-02-27T14:00:00.000Z Fri 2026-02-27 09:00 EST",
      "2026-03-06T14:00:00.000Z Fri 2026-03-06 09:00 EST",
      "2026-03-13T13:00:00.000Z Fri 2026-03-13 09:00 EDT",
      "2026-03-20T13:00:00.000Z Fri 2026-03-20 09:00 EDT"
    ],
    fridaysFall: [
      "2026-10-23T13:00:00.000Z Fri 2026-10-23 09:00 EDT",
      "2026-10-30T13:00:00.000Z Fri 2026-10-30 09:00 EDT",
      "2026-11-06T14:00:00.000Z Fri 2026-11-06 09:00 EST",
      "2026-11-13T14:00:00.000Z Fri 2026-11-13 09:00 EST"
    ],
    gap: [
      "2026-03-06T07:30:00.000Z Fri 2026-03-06 02:30 EST",
      "2026-03-07T07:30:00.000Z Sat 2026-03-07 02:30 EST",
      "2026-03-08T07:30:00.000Z Sun 2026-03-08 03:30 EDT",
      "2026-03-09T06:30:00.000Z Mon 2026-03-09 02:30 EDT"
    ],
    repeat: [
      "2026-10-30T05:30:00.000Z Fri 2026-10-30 01:30 EDT",
      "2026-10-31T05:30:00.000Z Sat 2026-10-31 01:30 EDT",
      "2026-11-01T05:30:00.000Z Sun 2026-11-01 01:30 EDT",
      "2026-11-02T06:30:00.000Z Mon 2026-11-02 01:30 EST"
    ],
    repeatedOne: "2026-11-01T06:00:00.000Z",
    repeatedOneThirty: "2026-11-01T06:30:00.000Z"
  }
]

/** The UTC instant at the front of one `read` line. */
const instantOf = (line: string): number => Date.parse(line.slice(0, 24))

const declare = (timezone: string, id: string, cron: string) =>
  Trigger.make({ id, flowId: `reviews/${id}`, input: { team: "builders" }, cron, timezone, enabled: true })

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

interface RunnerFixture {
  readonly service: Scheduler.RunnerService
  readonly starts: Array<Scheduler.StartInput>
}

/** A runner whose runs finish as soon as they start, so overlap never holds a tick. */
const runnerFixture = (): RunnerFixture => {
  const starts: Array<Scheduler.StartInput> = []
  return {
    starts,
    service: Scheduler.makeRunner({
      start: (input) =>
        Effect.sync(() => {
          starts.push(input)
          return `run-${starts.length}`
        }),
      inspect: () => Effect.succeed("completed"),
      cancel: () => Effect.void
    })
  }
}

type Tick = (instant: number) => Effect.Effect<void, TriggerError>

const scheduler = (runner: RunnerFixture): Effect.Effect<Tick, TriggerError, TriggerStore.TriggerStore | Scope.Scope> =>
  Effect.map(
    Scheduler.make().pipe(Effect.provideService(Scheduler.Runner, runner.service)),
    (service) => (instant) =>
      Effect.gen(function*() {
        yield* TestClock.setTime(instant)
        yield* service.runOnce
        // A tick does not wait for its launch; let the launch record itself.
        for (let turn = 0; turn < 8; turn++) yield* Effect.yieldNow
      })
  )

interface Warning {
  readonly message: unknown
  readonly cause: Cause.Cause<unknown>
}

/**
 * Runs one scenario on a fresh SQLite trigger store under a test clock,
 * collecting every warning the scheduler logs.
 */
const onStore = <A>(
  scenario: (
    warnings: ReadonlyArray<Warning>
  ) => Effect.Effect<A, TriggerError, TriggerStore.TriggerStore | Scope.Scope>
): Promise<A> => {
  const warnings: Array<Warning> = []
  const capture = Logger.make((entry) => {
    warnings.push({ message: entry.message, cause: entry.cause })
  })
  return Effect.runPromise(
    Effect.scoped(scenario(warnings)).pipe(
      Effect.provide(SqlTriggerStore.layer.pipe(Layer.provide(TestDatabase.layer))),
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))
    )
  )
}

/** The typed failure behind each "A trigger tick failed" warning. */
const tickFailures = (warnings: ReadonlyArray<Warning>): ReadonlyArray<unknown> =>
  warnings.flatMap((warning) => {
    const [message] = Array.isArray(warning.message) ? warning.message : [warning.message]
    return message === "A trigger tick failed" ? [Cause.squash(warning.cause)] : []
  })

/** Every hour from `from` up to and excluding `to`. */
const hourly = (from: string, to: string): ReadonlyArray<number> => {
  const ticks: Array<number> = []
  for (let instant = Date.parse(from); instant < Date.parse(to); instant += hour) ticks.push(instant)
  return ticks
}

for (const zone of zones) {
  const { timezone } = zone

  describe(`a weekly Friday 09:00 in ${timezone}`, () => {
    for (
      const [transition, expected, from, to] of [
        ["spring forward", zone.fridaysSpring, "2026-02-26T00:00:00.000Z", "2026-03-21T00:00:00.000Z"],
        ["fall back", zone.fridaysFall, "2026-10-22T00:00:00.000Z", "2026-11-14T00:00:00.000Z"]
      ] as const
    ) {
      it(`keeps 09:00 local and moves the UTC instant by one hour across ${transition}`, async () => {
        const trigger = await run(declare(timezone, "weekly-review", "0 9 * * 5"))
        const cron = await run(Cron.parse(trigger.cron, trigger.timezone))
        const occurrences = await run(Cron.occurrencesBetween(cron, new Date(from), new Date(to)))

        expect(read(occurrences, timezone)).toEqual(expected)
        // One week apart on the wall clock, so one hour shorter or longer in UTC
        // across the transition and exactly seven days everywhere else.
        const week = 7 * 24 * hour
        expect(occurrences.slice(1).map((occurrence, index) => occurrence.getTime() - occurrences[index]!.getTime()))
          .toEqual([week, transition === "spring forward" ? week - hour : week + hour, week])
        for (const [index, occurrence] of occurrences.entries()) {
          const within = new Date(occurrence.getTime() + 37 * minute + 457)
          expect(await run(Cron.previousAtOrBefore(cron, within))).toEqual(occurrence)
          expect(await run(Cron.previousAtOrBefore(cron, occurrence))).toEqual(occurrence)
          const following = await run(Cron.next(cron, occurrence))
          if (index + 1 < occurrences.length) expect(following).toEqual(occurrences[index + 1])
        }

        // A key names the occurrence's UTC instant, so every week has its own,
        // and a fresh parse searched from another instant names the same ones.
        const keys = occurrences.map((occurrence) => Scheduler.idempotencyKey(trigger.id, occurrence.getTime()))
        expect(keys).toEqual(expected.map((line) => `weekly-review:${line.slice(0, 24)}`))
        expect(new Set(keys).size).toBe(keys.length)
        const reparsed = await run(Cron.parse("0 9 * * 5", timezone))
        const again = await run(
          Cron.occurrencesBetween(reparsed, new Date(Date.parse(from) + 5 * hour + 3 * minute), new Date(to))
        )
        expect(again.map((occurrence) => Scheduler.idempotencyKey(trigger.id, occurrence.getTime()))).toEqual(keys)
      })

      it(`launches each Friday once, under its own stable key, across ${transition}`, async () => {
        const runner = runnerFixture()
        const outcome = await onStore((warnings) =>
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* store.register(yield* declare(timezone, "weekly-review", "0 9 * * 5"))
            const tick = yield* scheduler(runner)
            // Every hour of the window, so the old-offset hour after each
            // transition is ticked too and must launch nothing.
            for (const instant of hourly(from, to)) yield* tick(instant)
            const launched = runner.starts.length
            // A restarted scheduler has no process state; the store alone
            // must keep it from launching the last Friday again.
            const restarted = yield* scheduler(runner)
            yield* restarted(instantOf(expected.at(-1)!) + 30 * minute)
            const history = yield* store.history({ triggerId: "weekly-review" })
            return { launched, history: history.items, failures: tickFailures(warnings) }
          })
        )

        const keys = expected.map((line) => `weekly-review:${line.slice(0, 24)}`)
        expect(runner.starts.map((start) => start.idempotencyKey)).toEqual(keys)
        expect(outcome.launched).toBe(keys.length)
        expect(runner.starts.every((start) => start.flowId === "reviews/weekly-review")).toBe(true)
        expect(outcome.history.map((fire) => fire.occurrence).sort((left, right) => left - right)).toEqual(
          expected.map(instantOf)
        )
        expect(outcome.history.every((fire) => fire.outcome === "completed")).toBe(true)
        expect(outcome.failures).toEqual([])
      })
    }
  })

  describe(`a daily 02:30 across the spring-forward gap in ${timezone}`, () => {
    it("names 03:30 daylight time as the gap day's one occurrence", async () => {
      const cron = await run(Cron.parse("30 2 * * *", timezone))
      const occurrences = await run(
        Cron.occurrencesBetween(cron, new Date("2026-03-06T00:00:00.000Z"), new Date("2026-03-10T00:00:00.000Z"))
      )

      expect(read(occurrences, timezone)).toEqual(zone.gap)
      const gapDay = instantOf(zone.gap[2]!)
      expect(await run(Cron.next(cron, new Date(instantOf(zone.gap[1]!))))).toEqual(new Date(gapDay))
      const keys = occurrences.map((occurrence) => Scheduler.idempotencyKey("nightly-sync", occurrence.getTime()))
      expect(new Set(keys).size).toBe(4)
    })

    it("fires the gap day once, at 03:30 daylight time, and fails no tick", async () => {
      const cron = await run(Cron.parse("30 2 * * *", timezone))
      const [, saturday, gapDay, monday] = zone.gap.map(instantOf)
      const previous = async (instant: number) =>
        (await run(Cron.previousAtOrBefore(cron, new Date(instant)))).getTime()
      expect(await previous(gapDay!)).toBe(gapDay)
      expect(await previous(gapDay! + 90 * minute + 457)).toBe(gapDay)
      // 03:00 daylight time, the first instant after the gap, is before it.
      expect(await previous(gapDay! - 30 * minute)).toBe(saturday)
      expect(await previous(monday!)).toBe(monday)

      const runner = runnerFixture()
      const failures = await onStore((warnings) =>
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* TestClock.setTime(saturday! - 10 * hour)
          yield* store.register(yield* declare(timezone, "nightly-sync", "30 2 * * *"))
          const tick = yield* scheduler(runner)
          for (
            const instant of [
              saturday! - 10 * hour,
              saturday!,
              gapDay! - 30 * minute,
              gapDay!,
              gapDay! + 90 * minute,
              monday!
            ]
          ) {
            yield* tick(instant)
          }
          return tickFailures(warnings)
        })
      )

      expect(runner.starts.map((start) => start.idempotencyKey)).toEqual(
        [saturday!, gapDay!, monday!].map((instant) => `nightly-sync:${new Date(instant).toISOString()}`)
      )
      expect(failures).toEqual([])
    })
  })

  describe(`a daily 01:30 across the fall-back repeat in ${timezone}`, () => {
    it("names the first, daylight-time 01:30 as the repeated day's one occurrence", async () => {
      const cron = await run(Cron.parse("30 1 * * *", timezone))
      const occurrences = await run(
        Cron.occurrencesBetween(cron, new Date("2026-10-30T00:00:00.000Z"), new Date("2026-11-03T00:00:00.000Z"))
      )

      expect(read(occurrences, timezone)).toEqual(zone.repeat)
      const repeatDay = instantOf(zone.repeat[2]!)
      expect(await run(Cron.next(cron, new Date(instantOf(zone.repeat[1]!))))).toEqual(new Date(repeatDay))
      const keys = occurrences.map((occurrence) => Scheduler.idempotencyKey("nightly-sync", occurrence.getTime()))
      expect(new Set(keys).size).toBe(4)
    })

    it("does not match the repeated 01:30, so a tick inside it launches nothing", async () => {
      const cron = await run(Cron.parse("30 1 * * *", timezone))
      const first = instantOf(zone.repeat[2]!)
      const monday = instantOf(zone.repeat[3]!)
      const repeated = Date.parse(zone.repeatedOneThirty)
      expect(wallClock(new Date(repeated), timezone)).toBe(
        `Sun 2026-11-01 01:30 ${timezone === "America/New_York" ? "EST" : "PST"}`
      )
      expect(await run(Cron.previousAtOrBefore(cron, new Date(repeated)))).toEqual(new Date(first))
      // `next` is strictly after its argument, inside the repeated hour too.
      const inside = new Date(zone.repeatedOne)
      expect(await run(Cron.next(cron, inside))).toEqual(new Date(monday))
      expect(await run(Cron.next(cron, new Date(first)))).toEqual(new Date(monday))

      const runner = runnerFixture()
      const failures = await onStore((warnings) =>
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* TestClock.setTime(first - 12 * hour)
          yield* store.register(yield* declare(timezone, "nightly-sync", "30 1 * * *"))
          const tick = yield* scheduler(runner)
          for (const instant of [first - 12 * hour, first, first + 30 * minute, repeated, repeated + minute]) {
            yield* tick(instant)
          }
          return tickFailures(warnings)
        })
      )

      expect(runner.starts.map((start) => start.idempotencyKey)).toEqual([
        `nightly-sync:${new Date(first).toISOString()}`
      ])
      expect(failures).toEqual([])
    })
  })

  describe(`an hourly :30 across both transitions in ${timezone}`, () => {
    for (
      const [transition, from, to] of [
        ["spring forward", "2026-03-08T00:00:00.000Z", "2026-03-08T16:00:00.000Z"],
        ["fall back", "2026-11-01T00:00:00.000Z", "2026-11-01T16:00:00.000Z"]
      ] as const
    ) {
      it(`fires every elapsed hour exactly once across ${transition}`, async () => {
        const cron = await run(Cron.parse("30 * * * *", timezone))
        const occurrences = await run(Cron.occurrencesBetween(cron, new Date(from), new Date(to)))

        expect(occurrences).toHaveLength(16)
        expect(occurrences[0]).toEqual(new Date(Date.parse(from) + 30 * minute))
        expect(occurrences.slice(1).map((occurrence, index) => occurrence.getTime() - occurrences[index]!.getTime()))
          .toEqual(Array.from({ length: 15 }, () => hour))
        const walls = occurrences.map((occurrence) => wallClock(occurrence, timezone).slice(15, 20))
        if (transition === "spring forward") expect(walls).not.toContain("02:30")
        else expect(walls.filter((wall) => wall === "01:30")).toHaveLength(2)
        for (const occurrence of occurrences) {
          expect(await run(Cron.previousAtOrBefore(cron, new Date(occurrence.getTime() + 29 * minute)))).toEqual(
            occurrence
          )
        }
      })
    }
  })

  describe(`a weekly Friday evening that crosses UTC midnight in ${timezone}`, () => {
    // 16:30 in Los Angeles and 19:30 in New York are 00:30 UTC on Saturday in
    // standard time and 23:30 UTC on Friday in daylight time.
    const [clock, expression] = timezone === "America/New_York" ? ["19:30", "30 19 * * 5"] : ["16:30", "30 16 * * 5"]
    const [standard, daylight] = timezone === "America/New_York" ? ["EST", "EDT"] : ["PST", "PDT"]
    for (
      const [transition, from, to, expected] of [
        ["spring forward", "2026-02-26T00:00:00.000Z", "2026-03-21T00:00:00.000Z", [
          `2026-02-28T00:30:00.000Z Fri 2026-02-27 ${clock} ${standard}`,
          `2026-03-07T00:30:00.000Z Fri 2026-03-06 ${clock} ${standard}`,
          `2026-03-13T23:30:00.000Z Fri 2026-03-13 ${clock} ${daylight}`,
          `2026-03-20T23:30:00.000Z Fri 2026-03-20 ${clock} ${daylight}`
        ]],
        ["fall back", "2026-10-22T00:00:00.000Z", "2026-11-15T00:00:00.000Z", [
          `2026-10-23T23:30:00.000Z Fri 2026-10-23 ${clock} ${daylight}`,
          `2026-10-30T23:30:00.000Z Fri 2026-10-30 ${clock} ${daylight}`,
          `2026-11-07T00:30:00.000Z Fri 2026-11-06 ${clock} ${standard}`,
          `2026-11-14T00:30:00.000Z Fri 2026-11-13 ${clock} ${standard}`
        ]]
      ] as const
    ) {
      it(`reads Friday in the zone, not in UTC, and launches each week once across ${transition}`, async () => {
        const cron = await run(Cron.parse(expression, timezone))
        const occurrences = await run(Cron.occurrencesBetween(cron, new Date(from), new Date(to)))
        expect(read(occurrences, timezone)).toEqual(expected)
        for (const occurrence of occurrences) {
          expect(await run(Cron.previousAtOrBefore(cron, new Date(occurrence.getTime() + 45 * minute)))).toEqual(
            occurrence
          )
        }

        const runner = runnerFixture()
        const failures = await onStore((warnings) =>
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* store.register(yield* declare(timezone, "weekly-close", expression))
            const tick = yield* scheduler(runner)
            for (const instant of [...hourly(from, to), Date.parse(to)]) yield* tick(instant)
            return tickFailures(warnings)
          })
        )
        expect(runner.starts.map((start) => start.idempotencyKey)).toEqual(
          expected.map((line) => `weekly-close:${line.slice(0, 24)}`)
        )
        expect(failures).toEqual([])
      })
    }
  })

  describe(`a UTC schedule on a host whose own zone is ${timezone}`, () => {
    it("answers the same whole-second occurrence and launches once, whatever the host's zone", async () => {
      // A daily UTC cron whose occurrence is the host zone's repeated 01:30.
      const repeated = Date.parse(zone.repeatedOneThirty)
      const expression = `30 ${new Date(repeated).getUTCHours()} * * *`
      const previous = (cron: Cron.Cron) => run(Cron.previousAtOrBefore(cron, new Date(repeated + 457)))
      const cron = await run(Cron.parse(expression, "UTC"))

      expect(await previous(cron)).toEqual(new Date(repeated))
      expect(await onHost(timezone, () => previous(cron))).toEqual(new Date(repeated))

      const launches = (host: string) =>
        onHost(host, async () => {
          const runner = runnerFixture()
          await onStore(() =>
            Effect.gen(function*() {
              const store = yield* TriggerStore.TriggerStore
              yield* TestClock.setTime(repeated - 12 * hour)
              yield* store.register(yield* declare("UTC", "daily-export", expression))
              const tick = yield* scheduler(runner)
              for (const instant of [repeated - 12 * hour, repeated, repeated + minute]) yield* tick(instant)
            })
          )
          return runner.starts.map((start) => start.idempotencyKey)
        })

      const key = [`daily-export:${new Date(repeated).toISOString()}`]
      expect(await launches("UTC")).toEqual(key)
      expect(await launches(timezone)).toEqual(key)
    })
  })

  describe(`a schedule with no timezone on a host whose own zone is ${timezone}`, () => {
    it("follows the host's wall clock across both transitions", async () => {
      const [gap, repeat] = await onHost(timezone, async () => {
        const gapCron = await run(Cron.parse("30 2 * * *"))
        const repeatCron = await run(Cron.parse("30 1 * * *"))
        return [
          await run(
            Cron.occurrencesBetween(gapCron, new Date("2026-03-06T00:00:00.000Z"), new Date("2026-03-10T00:00:00.000Z"))
          ),
          await run(
            Cron.occurrencesBetween(
              repeatCron,
              new Date("2026-10-30T00:00:00.000Z"),
              new Date("2026-11-03T00:00:00.000Z")
            )
          )
        ]
      })
      expect(read(gap, timezone)).toEqual(zone.gap)
      expect(read(repeat, timezone)).toEqual(zone.repeat)
    })
  })
}

describe("a fixed-offset timezone", () => {
  it("has no transitions to adjust for", async () => {
    const cron = await run(Cron.parse("30 2 * * *", "+02:00"))
    const occurrences = await run(
      Cron.occurrencesBetween(cron, new Date("2026-03-07T00:00:00.000Z"), new Date("2026-03-09T00:00:00.000Z"))
    )
    expect(iso(occurrences)).toEqual(["2026-03-07T00:30:00.000Z", "2026-03-08T00:30:00.000Z"])
    expect(await run(Cron.previousAtOrBefore(cron, new Date("2026-03-08T00:30:59.999Z")))).toEqual(
      new Date("2026-03-08T00:30:00.000Z")
    )
  })
})
