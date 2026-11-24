/**
 * Cron parsing, formatting, matching and the occurrence searches against their Lean 4 reference specification
 * (`spec/lean/cron`), generated: every case is answered by the implementation and by the specification's compiled
 * oracle, and the two answers must be equal. Every schedule is in UTC, where a wall time is its instant.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. An expression crosses as a JSON string, a schedule as its six sets and its `and` flag, and an instant as a
 * whole number of milliseconds.
 *
 * A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
 * and builds it again when a source of the specification is newer than it.
 */
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cron as EffectCron, Effect, Result, Schema } from "effect"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Cron } from "../src/index.ts"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "cron")
const binary = join(specDir, ".lake", "build", "bin", "cron-spec")
const elan = join(homedir(), ".elan", "bin")
const lake = [...(process.env["PATH"] ?? "").split(delimiter).filter((directory) => directory !== ""), elan]
  .map((directory) => join(directory, "lake"))
  .find((path) => existsSync(path))
/** The specification's sources are here and `lake` can build them. A confined run may be shown neither. */
const buildable = lake !== undefined && existsSync(join(specDir, "lakefile.toml"))
const oracleReady = existsSync(binary) || buildable
const differential = it.skipIf(!oracleReady)

/** True when a source of the specification is newer than the built oracle, or there is no built oracle. */
const stale = (): boolean => {
  if (!existsSync(binary)) return true
  const built = statSync(binary).mtimeMs
  const sources = [
    "Main.lean",
    "CronSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "CronSpec")).map((name) => join("CronSpec", name))
  ]
  return sources.some((source) => statSync(join(specDir, source)).mtimeMs > built)
}

interface Oracle {
  readonly ask: (op: string, request: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly asked: () => number
  readonly close: () => void
}

const start = (): Oracle => {
  const child: ChildProcessWithoutNullStreams = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] })
  const waiting: Array<{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }> = []
  let asked = 0
  createInterface({ input: child.stdout }).on("line", (line) => {
    const next = waiting.shift()
    const response = JSON.parse(line) as { readonly ok?: unknown; readonly error?: string }
    if (response.error === undefined) next?.resolve(response.ok)
    else next?.reject(new Error(`the oracle refused: ${response.error}`))
  })
  child.on("close", () => {
    for (const each of waiting.splice(0)) each.reject(new Error("the oracle exited before it answered"))
  })
  return {
    ask: (op, request) =>
      new Promise((resolve, reject) => {
        asked++
        waiting.push({ resolve, reject })
        child.stdin.write(`${JSON.stringify({ op, ...request })}\n`)
      }),
    asked: () => asked,
    close: () => child.stdin.end()
  }
}

let oracle: Oracle

beforeAll(() => {
  if (!oracleReady) return
  if (lake !== undefined && buildable && stale()) {
    const built = spawnSync(lake, ["build"], {
      cwd: specDir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${elan}${delimiter}${process.env["PATH"] ?? ""}` }
    })
    if (built.status !== 0) throw new Error(`lake build failed in ${specDir}:\n${built.stdout}\n${built.stderr}`)
  }
  oracle = start()
}, 150_000)

afterAll(() => {
  if (oracleReady) oracle.close()
})

const ask = <A>(op: string, request: Readonly<Record<string, unknown>>): Effect.Effect<A> =>
  Effect.promise(() => oracle.ask(op, request) as Promise<A>)

// --- the wire -------------------------------------------------------------------------------------------------------

/** A schedule as the specification holds it. */
interface Wire {
  readonly seconds: ReadonlyArray<number>
  readonly minutes: ReadonlyArray<number>
  readonly hours: ReadonlyArray<number>
  readonly days: ReadonlyArray<number>
  readonly months: ReadonlyArray<number>
  readonly weekdays: ReadonlyArray<number>
  readonly and: boolean
}

/** What the specification says of an expression. */
type Parsed = { readonly invalid: string } | (Wire & { readonly satisfiable: boolean })

/** Whether day of month and weekday must both match. Effect keeps the flag off its public type; every cron has it. */
const bothOf = (cron: EffectCron.Cron): boolean => (cron as EffectCron.Cron & { readonly and: boolean }).and

const wireOf = (cron: EffectCron.Cron): Wire => ({
  seconds: [...cron.seconds],
  minutes: [...cron.minutes],
  hours: [...cron.hours],
  days: [...cron.days],
  months: [...cron.months],
  weekdays: [...cron.weekdays],
  and: bothOf(cron)
})

// --- generators -----------------------------------------------------------------------------------------------------

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const executions = Math.max(25, Math.min(baseExecutions, 150))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const check = async <A, E>(arbitrary: Arbitrary.Arbitrary<A>, property: (value: A) => Effect.Effect<boolean, E>) => {
  const report = await Effect.runPromise(Fuzz.run(arbitrary, property, { executions, seed }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const int = (minimum: number, maximum: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))

/** One of `values`; a failing case shrinks toward the first. */
const pick = <A>(values: ReadonlyArray<A>): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(int(0, values.length - 1), (index) => values[index]!)

const list = <A>(item: Arbitrary.Arbitrary<A>, minLength: number, maxLength: number): Arbitrary.Arbitrary<Array<A>> =>
  Arbitrary.array(item, { minLength, maxLength })

/** The limits of a field and the names it reads. */
interface Field {
  readonly min: number
  readonly max: number
  readonly names: ReadonlyArray<string>
}

const fields: ReadonlyArray<Field> = [
  { min: 0, max: 59, names: [] },
  { min: 0, max: 59, names: [] },
  { min: 0, max: 23, names: [] },
  { min: 1, max: 31, names: [] },
  { min: 1, max: 12, names: ["jan", "FEB", "Mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "DEC"] },
  { min: 0, max: 7, names: ["sun", "MON", "Tue", "wed", "thu", "fri", "sat"] }
]

/** A well-formed item of a field: `*`, a value or a range, with or without a step. */
const item = (field: Field): Arbitrary.Arbitrary<string> =>
  Arbitrary.map(
    Arbitrary.all([
      int(0, 9),
      int(field.min, field.max),
      int(field.min, field.max),
      int(0, 6),
      int(1, field.max),
      int(0, 3)
    ]),
    ([shape, left, right, stepped, step, named]) => {
      const write = (value: number): string =>
        named === 0 && field.names.length > 0 && value - field.min < field.names.length
          ? field.names[value - field.min]!
          : `${value}`
      const low = Math.min(left, right)
      const high = Math.max(left, right)
      const body = shape === 0 ? "*" : shape <= 5 ? write(left) : `${write(low)}-${write(high)}`
      return stepped === 0 ? `${body}/${step}` : body
    }
  )

/** A well-formed field: most are one item, and one in four is unrestricted. */
const segment = (field: Field): Arbitrary.Arbitrary<string> =>
  Arbitrary.map(
    Arbitrary.all([int(0, 3), list(item(field), 1, 3)]),
    ([choice, items]) => (choice === 0 ? "*" : items.join(","))
  )

/** A well-formed expression of five or six fields. */
const expression: Arbitrary.Arbitrary<string> = Arbitrary.map(
  Arbitrary.all([
    Arbitrary.schema(Schema.Boolean),
    segment(fields[0]!),
    segment(fields[1]!),
    segment(fields[2]!),
    segment(fields[3]!),
    segment(fields[4]!),
    segment(fields[5]!)
  ]),
  ([seconds, ...segments]) => (seconds ? segments : segments.slice(1)).join(" ")
)

/** Pieces a hostile field is built from: limits and their neighbours, names, stray separators, odd numerals. */
const fragments = [
  "*",
  "0",
  "1",
  "5",
  "7",
  "8",
  "12",
  "13",
  "23",
  "24",
  "29",
  "31",
  "32",
  "59",
  "60",
  "007",
  "1e1",
  "+1",
  "1.0",
  "0x1",
  "9".repeat(400),
  "9".repeat(20),
  "jan",
  "FEB",
  "dec",
  "sun",
  "SAT",
  "mon",
  "sept",
  "toString",
  "__proto__",
  "constructor",
  "-",
  "/",
  ",",
  "/0",
  "/1",
  "/2",
  "/7",
  "/8",
  "/31",
  "/60",
  "/x",
  "x",
  "?",
  "L",
  ""
] as const

const hostileSegment: Arbitrary.Arbitrary<string> = Arbitrary.map(
  list(pick(fragments), 1, 4),
  (parts) => parts.join("")
)

/** White space JavaScript splits on, and two characters it does not. */
const gaps = [" ", " ", " ", "  ", "\t", "\n", "\r\n", " ", " ", " ", "　", "﻿", ""] as const

/** Any expression: three to eight fields, each well formed or hostile, between any white space. */
const hostileExpression: Arbitrary.Arbitrary<string> = Arbitrary.map(
  Arbitrary.all([
    list(
      Arbitrary.all([int(0, 2), int(0, 5), hostileSegment, pick(gaps), ...fields.map(segment)]),
      3,
      8
    ),
    pick(gaps),
    int(0, 5)
  ]),
  ([parts, lead, drop]) => {
    const written = parts.map(([choice, , hostile, gap, ...formed], index) =>
      `${choice === 0 ? hostile : formed[Math.min(index, 5)]!}${gap === "" ? " " : gap}`
    )
    // Most expressions keep five or six fields, so a hostile field is reached rather than the count refused.
    return `${lead}${(drop === 0 ? written : written.slice(0, 5 + (drop % 2))).join("")}`
  }
)

const second = 1_000
const day = 86_400_000

/** Instants the calendar turns on: leap days kept and skipped, year ends, the epoch, and a week's ends. */
const anchors = [
  Date.UTC(2026, 10, 23),
  Date.UTC(1970, 0, 1),
  Date.UTC(1969, 11, 31, 23, 59, 59),
  Date.UTC(2024, 1, 29),
  Date.UTC(2000, 1, 29),
  Date.UTC(1900, 1, 28, 23, 59, 59),
  Date.UTC(2100, 1, 28, 23, 59, 59),
  Date.UTC(2096, 1, 29),
  Date.UTC(2025, 11, 31, 23, 59, 59),
  Date.UTC(2027, 0, 31),
  Date.UTC(2026, 3, 30, 12),
  Date.UTC(1600, 1, 29),
  Date.UTC(1582, 9, 10),
  Date.UTC(2399, 11, 31)
] as const

/** An instant near an anchor, to the millisecond. */
const instant: Arbitrary.Arbitrary<number> = Arbitrary.map(
  Arbitrary.all([pick(anchors), int(-3, 3), int(-90_000, 90_000), int(-1, 1)]),
  ([anchor, days, seconds, millis]) => anchor + days * day + seconds * second + millis
)

/** A satisfiable schedule the implementation parsed, or none when the expression has no occurrence. */
const scheduleOf = (text: string): Effect.Effect<Cron.Cron | undefined> =>
  Cron.parse(text, "UTC").pipe(Effect.catch(() => Effect.succeed(undefined)))

// --- properties -----------------------------------------------------------------------------------------------------

/** Checks one expression's parse against the specification's and returns whether they agree. */
const parseAgrees = (text: string): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const specified = yield* ask<Parsed>("parse", { expression: text })
    const parsed = yield* Effect.result(Cron.parse(text, "UTC"))
    if ("invalid" in specified) {
      expect(Result.isFailure(parsed) && [parsed.failure.code, parsed.failure.message]).toEqual([
        "invalid_cron",
        specified.invalid
      ])
      return true
    }
    const { satisfiable, ...schedule } = specified
    // The field parser is consulted directly, so an unsatisfiable expression's fields are compared too.
    expect(wireOf(EffectCron.parseUnsafe(text, "UTC"))).toEqual(schedule)
    if (!satisfiable) {
      expect(Result.isFailure(parsed) && parsed.failure.code).toBe("unsatisfiable_cron")
      return true
    }
    expect(Result.isSuccess(parsed) && [parsed.success.expression, wireOf(parsed.success.value)]).toEqual([
      text,
      schedule
    ])
    return true
  })

describe("parsing", () => {
  differential("reads every well-formed expression as the specification does", () => check(expression, parseAgrees))

  differential(
    "refuses a malformed expression with the specification's message, and reads the rest alike",
    () => check(hostileExpression, parseAgrees)
  )

  differential("agrees on the expressions the documentation and the field limits name", async () => {
    const cases = [
      "* * * * *",
      "* * * * * *",
      "*/15 0 1,15 * 1-5",
      "0 0 30 2 *",
      "0 0 31 4,6,9,11 *",
      "0 0 29 2 *",
      "0 0 29 feb MON-fri/2",
      "0 0 */2 * 1",
      "0 0 1 * */2",
      "0 0 *,5 * 1",
      "0 0 */1,5 * 1",
      "0 0 * * 7",
      "0 0 * * 5-7",
      "0 0 * * sun-sat",
      "0 0 * JAN-dec *",
      "5/15 * * * *",
      "0-59/60 * * * *",
      "0 24 * * *",
      "0 0 0 * *",
      "0 0 * 13 *",
      "0 0 * * 8",
      "5-1 * * * *",
      "*/0 * * * *",
      "*/60 * * * *",
      "*/59 * * * *",
      "1-2-3 * * * *",
      "1/2/3 * * * *",
      "1,,2 * * * *",
      ", * * * *",
      "*-5 * * * *",
      "5-* * * * *",
      "mon * * * *",
      "0 0 * mon *",
      "0 0 * * jan",
      "",
      "   ",
      "* * * *",
      "* * * * * * *",
      "\t0\n0 * *﻿*  ",
      "0​0 * * * *",
      `${"9".repeat(400)} * * * *`,
      `*/${"9".repeat(400)} * * * *`,
      `*/${"0".repeat(30)}5 * * * *`
    ]
    for (const text of cases) expect(await Effect.runPromise(parseAgrees(text)), text).toBe(true)
  })
})

describe("formatting", () => {
  differential(
    "writes every parsed schedule as the specification does, and reads its own writing back",
    () =>
      check(
        Arbitrary.all([expression, Arbitrary.schema(Schema.Boolean)]),
        ([text, includeSeconds]) =>
          Effect.gen(function*() {
            const parsed = EffectCron.parseUnsafe(text, "UTC")
            const written = EffectCron.format(parsed, { includeSeconds })
            expect(written).toBe(yield* ask<string>("format", { cron: wireOf(parsed), includeSeconds }))
            // The written text holds the same sets; only the `and` flag depends on how a field was spelled.
            const reread = yield* ask<Parsed>("parse", { expression: written })
            expect({ ...reread, and: bothOf(parsed), satisfiable: undefined }).toEqual({
              ...wireOf(parsed),
              satisfiable: undefined
            })
            return true
          })
      )
  )
})

describe("matching", () => {
  differential(
    "says a schedule fires at an instant exactly when the specification does",
    () =>
      check(Arbitrary.all([expression, list(instant, 1, 4)]), ([text, instants]) =>
        Effect.gen(function*() {
          const parsed = EffectCron.parseUnsafe(text, "UTC")
          for (const at of instants) {
            expect(EffectCron.match(parsed, at)).toBe(yield* ask<boolean>("match", { cron: wireOf(parsed), at }))
          }
          return true
        }))
  )

  differential(
    "reads the calendar date of a day as the specification does",
    () =>
      check(int(-1_000_000, 1_000_000), (epochDay) =>
        Effect.gen(function*() {
          const date = new Date(epochDay * day)
          expect(yield* ask<ReadonlyArray<number>>("civil", { day: epochDay })).toEqual([
            date.getUTCFullYear(),
            date.getUTCMonth() + 1,
            date.getUTCDate(),
            date.getUTCDay()
          ])
          return true
        }))
  )
})

describe("occurrences", () => {
  differential(
    "finds the specification's next occurrence, which fires and is strictly later",
    () =>
      check(Arbitrary.all([expression, instant]), ([text, from]) =>
        Effect.gen(function*() {
          const schedule = yield* scheduleOf(text)
          if (schedule === undefined) return true
          const cron = wireOf(schedule.value)
          let cursor = from
          for (let step = 0; step < 3; step++) {
            const found = (yield* Cron.next(schedule, new Date(cursor))).getTime()
            expect(found).toBe(yield* ask<number | null>("next", { cron, from: cursor }))
            expect(found).toBeGreaterThan(cursor)
            expect(EffectCron.match(schedule.value, found)).toBe(true)
            cursor = found
          }
          return true
        }))
  )

  differential(
    "finds the specification's latest occurrence at or before an instant",
    () =>
      check(Arbitrary.all([expression, instant]), ([text, at]) =>
        Effect.gen(function*() {
          const schedule = yield* scheduleOf(text)
          if (schedule === undefined) return true
          const cron = wireOf(schedule.value)
          const found = (yield* Cron.previousAtOrBefore(schedule, new Date(at))).getTime()
          expect(found).toBe(yield* ask<number | null>("previous", { cron, at }))
          expect(found).toBeLessThanOrEqual(at)
          // Nothing fires between the latest occurrence and the instant, so the next one from it is later.
          expect((yield* Cron.next(schedule, new Date(found))).getTime()).toBeGreaterThan(at - (at % second) - second)
          return true
        }))
  )

  differential(
    "lists the specification's occurrences of an interval under a limit",
    () =>
      check(
        Arbitrary.all([expression, instant, int(-second, 3 * day), int(0, 12)]),
        ([text, from, span, limit]) =>
          Effect.gen(function*() {
            const schedule = yield* scheduleOf(text)
            if (schedule === undefined) {
              return true
            }
            const to = from + span
            const found = yield* Cron.occurrencesBetween(schedule, new Date(from), new Date(to), limit)
            expect(found.map((occurrence) => occurrence.getTime())).toEqual(
              yield* ask<ReadonlyArray<number>>("between", { cron: wireOf(schedule.value), from, to, limit })
            )
            return true
          })
      )
  )

  differential("agrees on the rare dates: leap days, a weekday on a date, and a month's last day", async () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["0 0 29 2 *", Date.UTC(2096, 1, 29)],
      ["0 0 29 2 *", Date.UTC(1896, 1, 29)],
      ["0 0 31 * *", Date.UTC(2026, 0, 31)],
      ["0 0 */30 2,3 1", Date.UTC(2026, 1, 1)],
      ["0 0 */2 2 1", Date.UTC(2027, 1, 1)],
      ["59 59 23 31 12 *", Date.UTC(2025, 11, 31, 23, 59, 59)],
      ["* * * * * *", Date.UTC(1969, 11, 31, 23, 59, 59, 999)],
      ["* * * * * *", -1],
      ["0 0 1 1 *", -1]
    ]
    for (const [text, from] of cases) {
      const schedule = await Effect.runPromise(Cron.parse(text, "UTC"))
      const cron = wireOf(schedule.value)
      expect((await Effect.runPromise(Cron.next(schedule, new Date(from)))).getTime(), text).toBe(
        await oracle.ask("next", { cron, from })
      )
      expect((await Effect.runPromise(Cron.previousAtOrBefore(schedule, new Date(from)))).getTime(), text).toBe(
        await oracle.ask("previous", { cron, at: from })
      )
    }
  })
})

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope")
    await expect(oracle.ask("parse", { expression: 1 })).rejects.toThrow("the oracle refused")
    expect(await oracle.ask("civil", { day: 0 })).toEqual([1970, 1, 1, 4])
  })

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(1_000)
  })
})
