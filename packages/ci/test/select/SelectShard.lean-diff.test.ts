/**
 * Fast mode's selection and the sharding contract against their Lean 4 reference specification
 * (`spec/lean/select_shard`), generated: every case is answered by the implementation and by the specification's
 * compiled oracle, and the two answers must be equal, to the bit for a double (every NaN counts as one
 * value) and to the order for a list. Texts are compared as code units, never decoded.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A text crosses as its UTF-16 code units and a double as the decimal text of its 64 bits, so a lone surrogate,
 * an infinity and a negative zero all arrive as they left.
 *
 * A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
 * and builds it again when a source of the specification is newer than it.
 */
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Plan } from "../../src/contract/Plan.vibe"
import * as Selection from "../../src/contract/Selection.vibe"
import * as Shard from "../../src/contract/Shard.vibe"
import * as Features from "../../src/select/Features.vibe"
import * as Measure from "../../src/select/Measure.vibe"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "..", "spec", "lean", "select_shard")
const binary = join(specDir, ".lake", "build", "bin", "select-shard-spec")
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
    "SelectShardSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "SelectShardSpec")).map((name) => join("SelectShardSpec", name))
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
      env: { ...process.env, PATH: `${elan}${delimiter}${process.env["PATH"] ?? ""}` }
    })
    if (built.status !== 0) throw new Error(`lake build failed in ${specDir}:\n${built.stdout}\n${built.stderr}`)
  }
  oracle = start()
})

afterAll(() => {
  if (oracleReady) oracle.close()
})

// --- the wire -------------------------------------------------------------------------------------------------------

type Units = ReadonlyArray<number>

/** A text as its UTF-16 code units. */
const units = (text: string): Array<number> => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))

const cell = new DataView(new ArrayBuffer(8))

/** A double as the decimal text of its 64 bits; every NaN is `nan`. */
const bitsOf = (value: number): string => {
  if (Number.isNaN(value)) return "nan"
  cell.setFloat64(0, value)
  return cell.getBigUint64(0).toString()
}

/** A double the oracle reads: its 64 bits, a NaN included. */
const sent = (value: number): string => {
  cell.setFloat64(0, value)
  return cell.getBigUint64(0).toString()
}

/** A score as the specification holds it: the bits of the double, with -0 read as 0. */
const keyOf = (score: number): string => bitsOf(score === 0 ? 0 : score)

// --- generators -----------------------------------------------------------------------------------------------------

const int = (minimum: number, maximum: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))

/** One of `values`; a failing case shrinks toward the first. */
const pick = <A>(values: ReadonlyArray<A>): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(int(0, values.length - 1), (index) => values[index]!)

const bit: Arbitrary.Arbitrary<boolean> = Arbitrary.schema(Schema.Boolean)

const list = <A>(item: Arbitrary.Arbitrary<A>, maxLength: number): Arbitrary.Arbitrary<Array<A>> =>
  Arbitrary.array(item, { maxLength })

/** Fails the test with the shrunk counterexample unless the property holds for every generated value. */
const holds = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  options: { readonly runs: number; readonly seed: number },
  property: (value: A) => Promise<void>
): Promise<void> => {
  const outcome = await Effect.runPromise(
    Arbitrary.checkEffect(arbitrary, (value) => Effect.tryPromise(async () => (await property(value), true)), options)
  )
  if (outcome._tag !== "Passed") expect.fail(Arbitrary.formatCheckFailure(outcome))
  expect(outcome._tag).toBe("Passed")
}

/** Pieces a hostile label is built from: separators, a combining mark, both halves of a surrogate pair, a NUL. */
const fragments = [
  "a",
  "b",
  "//",
  ":",
  "/",
  ".",
  "test",
  "pkg",
  "é",
  "é",
  "😺",
  "\ud83d",
  "\ude3a",
  "\u0000",
  "￿",
  "__proto__",
  "constructor",
  " "
] as const

const built: Arbitrary.Arbitrary<string> = Arbitrary.map(list(pick(fragments), 5), (parts) => parts.join(""))

/** A label: a built one, or any string the schema generator makes. */
const label: Arbitrary.Arbitrary<string> = Arbitrary.map(
  Arbitrary.all([int(0, 3), built, Arbitrary.schema(Schema.String)]),
  ([choice, made, free]) => (choice === 0 ? free : made)
)

const pool = ["a", "b", "c", "//a:test", "//a/b:test", "//:root", "", "__proto__", "aa", "😺"] as const

/** A label that repeats often: most come from a pool of ten. */
const name: Arbitrary.Arbitrary<string> = Arbitrary.map(
  Arbitrary.all([int(0, 13), label]),
  ([choice, made]) => pool[choice] ?? made
)

const commits = ["c1", "c2", "c3", "c4", "c5", "", "é"] as const
const targets = ["//a:test", "//a:lint", "//b:test", "//:docs", "t", "", "😺"] as const

/** Scores from 0 to 1: both zeros, the smallest double, neighbours of the swept cutoffs, and sixteenths. */
const scoreValues = [
  0,
  -0,
  5e-324,
  0.01,
  0.02,
  0.05,
  0.05000000000000001,
  0.1,
  0.2,
  0.30000000000000004,
  0.3,
  0.5,
  0.7,
  0.9,
  0.95,
  0.9999999999999999,
  1,
  ...Array.from({ length: 15 }, (_, index) => (index + 1) / 16)
] as const

const scoreValue = pick(scoreValues)
const now = Date.UTC(2026, 10, 14)
const day = Features.day

/** A time before `now` at a window's edge: a day count the windows use, one millisecond either side. */
const age = Arbitrary.map(
  Arbitrary.all([pick([0, 1, 3, 7, 14, 28, 56, 2, 6, 8, 57, 100, -1, -7]), int(-1, 1)]),
  ([days, ms]) => now - days * day - ms
)

// --- shapes ---------------------------------------------------------------------------------------------------------

const rowOf = (commit: string, target: string, failed: boolean, flaky: boolean): Selection.Row => ({
  commit,
  target,
  features: {
    extensions: [],
    fileChanges: { d3: 0, d14: 0, d56: 0 },
    failureRates: { d7: 0, d14: 0, d28: 0, d56: 0 },
    project: Features.projectOf(target),
    testCount: 0,
    graphDistance: 0
  },
  attempts: [!failed],
  failed,
  flaky
})

const rowWire = (row: Selection.Row): ReadonlyArray<unknown> => [
  units(row.commit),
  units(row.target),
  row.failed,
  row.flaky
]
const scoreWire = (score: Selection.Score): ReadonlyArray<unknown> => [
  units(score.commit),
  units(score.target),
  keyOf(score.score)
]
const observationWire = (observation: Features.Observation): ReadonlyArray<unknown> => [
  observation.at,
  rowWire(observation.row)
]
const settingsWire = (settings: Selection.Settings): { readonly cutoff: string; readonly top: number } => ({
  cutoff: keyOf(settings.scoreCutoff),
  top: settings.countCutoff
})

interface Counted {
  readonly rows: number
  readonly selected: number
  readonly failures: number
  readonly failedChanges: number
  readonly selectionRate: string
  readonly testRecall: string | null
  readonly changeRecall: string | null
}

interface OracleCounts extends Counted {
  readonly skipped: number
  readonly caught: number
  readonly caughtChanges: number
}

interface OraclePoint {
  readonly cutoff: string
  readonly top: number
  readonly metrics: OracleCounts
}

/** The implementation's metrics as the oracle writes them. */
const counted = (metrics: Selection.Metrics): Counted => ({
  rows: metrics.rows,
  selected: metrics.selected,
  failures: metrics.failures,
  failedChanges: metrics.failedChanges,
  selectionRate: bitsOf(metrics.selectionRate),
  testRecall: metrics.testRecall === undefined ? null : bitsOf(metrics.testRecall),
  changeRecall: metrics.changeRecall === undefined ? null : bitsOf(metrics.changeRecall)
})

/** The oracle's counts without the three the implementation does not report, after checking those three. */
const reported = (counts: OracleCounts): Counted => {
  expect(counts.skipped).toBe(counts.rows - counts.selected)
  expect(counts.caught).toBeLessThanOrEqual(counts.failures)
  expect(counts.caughtChanges).toBeLessThanOrEqual(counts.failedChanges)
  return {
    rows: counts.rows,
    selected: counts.selected,
    failures: counts.failures,
    failedChanges: counts.failedChanges,
    selectionRate: counts.selectionRate,
    testRecall: counts.testRecall,
    changeRecall: counts.changeRecall
  }
}

const pointOf = (point: Measure.Point) => ({ ...settingsWire(point.settings), metrics: counted(point.metrics) })
const oraclePoint = (point: OraclePoint) => ({ cutoff: point.cutoff, top: point.top, metrics: reported(point.metrics) })

// --- sharding -------------------------------------------------------------------------------------------------------

/** Durations a ledger could hold and ones it should not: zeros, ties, sums that round or overflow, not-numbers. */
const durationValues = [
  0,
  1,
  1,
  2,
  3,
  7,
  0.5,
  0.1,
  -0,
  -3,
  5e-324,
  2 ** 53,
  2 ** 53 + 2,
  2 ** 60,
  1e308,
  Number.MAX_VALUE,
  Infinity,
  -Infinity,
  NaN
] as const

interface AssignCase {
  readonly labels: ReadonlyArray<string>
  readonly count: number
  readonly durations: ReadonlyArray<readonly [string, number]>
}

const assignCase = (durations: Arbitrary.Arbitrary<number>): Arbitrary.Arbitrary<AssignCase> =>
  Arbitrary.map(
    Arbitrary.all({
      labels: list(name, 18),
      count: int(1, 9),
      own: list(durations, 18),
      other: list(Arbitrary.all([name, durations]), 6)
    }),
    ({ labels, count, own, other }) => ({
      labels,
      count,
      durations: Object.entries(
        Object.fromEntries([
          ...other,
          ...labels.flatMap((each, index) => index < own.length ? [[each, own[index]!]] : [])
        ])
      ) as Array<[string, number]>
    })
  )

/** `assign` by the implementation and by the oracle's double arithmetic: the same labels, shards and order. */
const assignAgrees = async (input: AssignCase): Promise<ReadonlyArray<readonly [string, number]>> => {
  const actual = [...Shard.assign(input.labels, input.count, Object.fromEntries(input.durations))]
  const expected = await oracle.ask("assign", {
    labels: input.labels.map(units),
    count: input.count,
    durations: input.durations.map(([each, duration]) => [units(each), sent(duration)])
  }) as ReadonlyArray<readonly [Units, number]>
  expect(actual.map(([each, index]) => [units(each), index])).toEqual(expected)
  for (const [, index] of actual) expect(index).toBeLessThan(input.count)
  expect(actual.map(([each]) => each).sort()).toEqual([...new Set(input.labels)].sort())
  return actual
}

describe("sharding against the Lean specification", () => {
  differential("shardOf is the specification's FNV-1a over UTF-16 code units, modulo the count", async () => {
    await holds(
      Arbitrary.all({
        label,
        count: int(1, 64),
        large: pick([1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1]),
        big: bit
      }),
      { runs: 500, seed: 8101 },
      async (input) => {
        const count = input.big ? input.large : input.count
        expect(await oracle.ask("shardOf", { label: units(input.label), count })).toBe(
          Shard.shardOf(input.label, count)
        )
      }
    )
  })

  differential("a well-formed string has the code units the specification's string model gives it", async () => {
    await holds(label, { runs: 300, seed: 8102 }, async (text) => {
      if (!text.isWellFormed()) return
      expect(await oracle.ask("utf16", { text })).toEqual(units(text))
    })
  })

  differential(
    "labelsOf keeps the specification's labels in the given order, and the shards partition them",
    async () => {
      await holds(
        Arbitrary.all({ labels: list(name, 20), count: int(1, 7), index: int(0, 7) }),
        { runs: 400, seed: 8103 },
        async (input) => {
          const actual = Shard.labelsOf(input.labels, { index: input.index, count: input.count })
          const expected = await oracle.ask("labelsOf", {
            labels: input.labels.map(units),
            index: input.index,
            count: input.count
          }) as ReadonlyArray<Units>
          expect(actual.map(units)).toEqual(expected)
          const every = Array.from(
            { length: input.count },
            (_, index) => Shard.labelsOf(input.labels, { index, count: input.count })
          ).flat()
          expect(every.sort()).toEqual([...input.labels].sort())
        }
      )
    }
  )

  differential("assign places every label where the specification does, whatever the durations", async () => {
    await holds(assignCase(pick(durationValues)), { runs: 500, seed: 8104 }, async (input) => {
      await assignAgrees(input)
    })
  })

  differential("assign with whole durations is the specification's exact algorithm", async () => {
    await holds(assignCase(int(0, 1000)), { runs: 400, seed: 8105 }, async (input) => {
      const actual = await assignAgrees(input)
      const exact = await oracle.ask("assignExact", {
        labels: input.labels.map(units),
        count: input.count,
        durations: input.durations.map(([each, duration]) => [units(each), duration])
      }) as ReadonlyArray<readonly [Units, number]>
      expect(actual.map(([each, index]) => [units(each), index])).toEqual(exact)
    })
  })

  differential(
    "assign agrees at the boundaries: empty, one label, one shard, ties, overflow and absorption",
    async () => {
      const huge = Number.MAX_VALUE
      const many = Array.from({ length: 300 }, (_, index) => `//pkg/${index % 97}:t${index}`)
      const corpus: ReadonlyArray<AssignCase> = [
        { labels: [], count: 1, durations: [] },
        { labels: [], count: 9, durations: [["ghost", 4]] },
        { labels: ["only"], count: 5, durations: [] },
        { labels: ["only"], count: 5, durations: [["only", 3]] },
        { labels: ["only"], count: 5, durations: [["only", 0]] },
        { labels: ["only"], count: 5, durations: [["only", NaN]] },
        { labels: ["a", "b", "c", "a", "b"], count: 1, durations: [["a", 3], ["b", 2]] },
        { labels: ["a", "b", "c", "d", "e", "f"], count: 3, durations: [] },
        {
          labels: ["a", "b", "c", "d", "e", "f"],
          count: 3,
          durations: ["a", "b", "c", "d", "e", "f"].map((each) => [each, 1])
        },
        {
          labels: ["f", "e", "d", "c", "b", "a"],
          count: 4,
          durations: ["a", "b", "c", "d", "e", "f"].map((each) => [each, 7])
        },
        { labels: ["a", "b", "c", "d"], count: 2, durations: [["a", huge], ["b", huge], ["c", huge], ["d", huge]] },
        {
          labels: ["a", "b", "c", "d", "e"],
          count: 2,
          durations: [["a", huge], ["b", huge], ["c", huge], ["d", 1], ["e", 1]]
        },
        { labels: ["a", "b", "c", "d"], count: 2, durations: [["a", 2 ** 60], ["b", 2 ** 60], ["c", 1], ["d", 1]] },
        {
          labels: ["a", "b", "c", "d", "e"],
          count: 3,
          durations: [["a", 2 ** 53], ["b", 2 ** 53], ["c", 2 ** 53], ["d", 1], ["e", 1]]
        },
        { labels: ["a", "b", "c"], count: 2, durations: [["a", Infinity], ["b", -Infinity], ["c", NaN]] },
        { labels: ["a", "b", "c"], count: 2, durations: [["a", -1], ["b", -0], ["c", 5e-324]] },
        { labels: ["__proto__", "constructor", "toString"], count: 3, durations: [["__proto__", 2], ["toString", 1]] },
        { labels: ["\ud83d", "\ude3a", "😺", "😺"], count: 4, durations: [["😺", 1], ["\ud83d", 1]] },
        { labels: many, count: 8, durations: many.map((each, index) => [each, (index * 7919) % 211]) },
        {
          labels: many,
          count: 7,
          durations: many.map((each, index) => [each, index % 3 === 0 ? huge : 2 ** (index % 61)])
        }
      ]
      for (const input of corpus) {
        const actual = await assignAgrees(input)
        if (input.count === 1) expect(actual.every(([, index]) => index === 0)).toBe(true)
      }
      expect(await assignAgrees({ labels: ["only"], count: 5, durations: [["only", 3]] })).toEqual([["only", 0]])
      expect(await assignAgrees({ labels: ["only"], count: 5, durations: [] })).toEqual([[
        "only",
        Shard.shardOf("only", 5)
      ]])
    }
  )
})

// --- selection ------------------------------------------------------------------------------------------------------

const scoreEntry = Arbitrary.all({ commit: pick(commits), target: pick(targets), score: scoreValue })
const rowEntry = Arbitrary.map(
  Arbitrary.all({ commit: pick(commits), target: pick(targets), failed: bit, flaky: bit }),
  (entry) => rowOf(entry.commit, entry.target, entry.failed, entry.flaky)
)

interface SelectCase {
  readonly scores: ReadonlyArray<Selection.Score>
  readonly settings: Selection.Settings
}

/** `select` by the implementation and by the oracle, and the oracle's skipped targets as the rest. */
const selectAgrees = async (input: SelectCase): Promise<ReadonlyArray<string>> => {
  const actual = Selection.select(input.scores, input.settings)
  const expected = await oracle.ask("select", {
    scores: input.scores.map(scoreWire),
    ...settingsWire(input.settings)
  }) as { readonly selected: ReadonlyArray<Units>; readonly skipped: ReadonlyArray<Units> }
  expect(actual.map(units)).toEqual(expected.selected)
  const scored = [...new Set(input.scores.map((score) => score.target))]
  expect(scored.filter((target) => !actual.includes(target)).sort().map(units)).toEqual(expected.skipped)
  return actual
}

interface MeasureCase {
  readonly rows: ReadonlyArray<Selection.Row>
  readonly scores: ReadonlyArray<Selection.Score>
}

/** `measure` by the implementation and by the oracle. */
const measureAgrees = async (input: MeasureCase, settings: Selection.Settings): Promise<Selection.Metrics> => {
  const point = Measure.measure(input.rows, input.scores, settings)
  expect(point.settings).toEqual(settings)
  const actual = point.metrics
  const expected = await oracle.ask("measure", {
    rows: input.rows.map(rowWire),
    scores: input.scores.map(scoreWire),
    ...settingsWire(settings)
  }) as OracleCounts
  expect(counted(actual)).toEqual(reported(expected))
  return actual
}

interface OracleReport {
  readonly rows: number
  readonly changes: number
  readonly failures: number
  readonly failedChanges: number
  readonly flaky: number
  readonly measured: boolean
  readonly start: OraclePoint
  readonly byScore: ReadonlyArray<OraclePoint>
  readonly byCount: ReadonlyArray<OraclePoint>
  readonly weekly: OraclePoint | null
  readonly calibrated: OraclePoint | null
}

/** `report` by the implementation and by the oracle: every sweep point, the weekly check and the calibration. */
const reportAgrees = async (input: MeasureCase): Promise<Measure.Report> => {
  const actual = Measure.report(input.rows, input.scores)
  const refusal = "refused: no entry failed, so there is no failure to recall"
  const expected = await oracle.ask("report", {
    rows: input.rows.map(rowWire),
    scores: input.scores.map(scoreWire)
  }) as OracleReport
  expect({
    rows: actual.rows,
    changes: actual.changes,
    failures: actual.failures,
    failedChanges: actual.failedChanges,
    flaky: actual.flaky,
    measured: actual.recall === "measured",
    start: pointOf(actual.start),
    byScore: actual.byScore.map(pointOf),
    byCount: actual.byCount.map(pointOf),
    weekly: actual.weekly === undefined ? null : pointOf(actual.weekly),
    calibrated: actual.calibrated === undefined ? null : pointOf(actual.calibrated)
  }).toEqual({
    rows: expected.rows,
    changes: expected.changes,
    failures: expected.failures,
    failedChanges: expected.failedChanges,
    flaky: expected.flaky,
    measured: expected.measured,
    start: oraclePoint(expected.start),
    byScore: expected.byScore.map(oraclePoint),
    byCount: expected.byCount.map(oraclePoint),
    weekly: expected.weekly === null ? null : oraclePoint(expected.weekly),
    calibrated: expected.calibrated === null ? null : oraclePoint(expected.calibrated)
  })
  expect(actual.recall).toBe(expected.measured ? "measured" : refusal)
  return actual
}

/** `failures` failing rows, one change each, of which the first `caught` score 1 and the rest score 0.001. */
const ladder = (failures: number, caught: number, passing = 0): MeasureCase => ({
  rows: [
    ...Array.from({ length: failures }, (_, index) => rowOf(`c${index}`, "//a:test", true, false)),
    ...Array.from({ length: passing }, (_, index) => rowOf(`p${index}`, "//a:test", false, index % 2 === 0))
  ],
  scores: [
    ...Array.from({ length: failures }, (_, index) => ({
      commit: `c${index}`,
      target: "//a:test",
      score: index < caught ? 1 : 0.001
    })),
    ...Array.from({ length: passing }, (_, index) => ({ commit: `p${index}`, target: "//a:test", score: 0.001 }))
  ]
})

describe("selection against the Lean specification", () => {
  differential("select picks the specification's targets for every cutoff and top-K", async () => {
    await holds(
      Arbitrary.all({ scores: list(scoreEntry, 26), scoreCutoff: scoreValue, countCutoff: int(0, 28) }),
      { runs: 500, seed: 8201 },
      async (input) => {
        await selectAgrees({
          scores: input.scores,
          settings: { scoreCutoff: input.scoreCutoff, countCutoff: input.countCutoff }
        })
      }
    )
  })

  differential("select with hostile targets: any string, repeated, tied at every score", async () => {
    await holds(
      Arbitrary.all({
        scores: list(Arbitrary.all({ commit: pick(commits), target: name, score: pick([0, 0.5, 0.5, 1, -0]) }), 20),
        scoreCutoff: pick([0, 0.5, 1, 5e-324]),
        countCutoff: int(0, 6)
      }),
      { runs: 400, seed: 8202 },
      async (input) => {
        await selectAgrees({
          scores: input.scores,
          settings: { scoreCutoff: input.scoreCutoff, countCutoff: input.countCutoff }
        })
      }
    )
  })

  differential("a lower cutoff or a higher top-K only adds targets, as the specification proves", async () => {
    await holds(
      Arbitrary.all({
        scores: list(scoreEntry, 26),
        cutoffs: Arbitrary.all([scoreValue, scoreValue]),
        counts: Arbitrary.all([int(0, 12), int(0, 12)])
      }),
      { runs: 400, seed: 8203 },
      async (input) => {
        const order = (a: number, b: number): number => a - b
        const [low, high] = [...input.cutoffs].sort(order) as [number, number]
        const [few, more] = [...input.counts].sort(order) as [number, number]
        const strict = await selectAgrees({ scores: input.scores, settings: { scoreCutoff: high, countCutoff: few } })
        const loose = await selectAgrees({ scores: input.scores, settings: { scoreCutoff: low, countCutoff: more } })
        for (const target of strict) expect(loose).toContain(target)
      }
    )
  })

  differential("a score's key in the specification is its bits, ordered as the scores are, with -0 as 0", async () => {
    await holds(Arbitrary.all([scoreValue, scoreValue]), { runs: 300, seed: 8205 }, async ([a, b]) => {
      const [first, second] = [
        await oracle.ask("scoreKey", { score: sent(a) }),
        await oracle.ask("scoreKey", { score: sent(b) })
      ] as [string, string]
      expect([first, second]).toEqual([keyOf(a), keyOf(b)])
      expect(BigInt(first) < BigInt(second)).toBe(a < b)
      expect(first === second).toBe(a === b)
    })
  })

  differential("select agrees at the boundaries: no scores, one score, every cutoff edge", async () => {
    const one = [{ commit: "c", target: "t", score: 0.5 }]
    const tied = ["d", "b", "a", "c", "b"].map((target) => ({ commit: "c", target, score: 0.25 }))
    const corpus: ReadonlyArray<SelectCase> = [
      { scores: [], settings: { scoreCutoff: 0, countCutoff: 0 } },
      { scores: [], settings: { scoreCutoff: 1, countCutoff: 100 } },
      { scores: one, settings: { scoreCutoff: 0.5, countCutoff: 0 } },
      { scores: one, settings: { scoreCutoff: 0.5000000000000001, countCutoff: 0 } },
      { scores: one, settings: { scoreCutoff: 1, countCutoff: 1 } },
      { scores: tied, settings: { scoreCutoff: 1, countCutoff: 0 } },
      { scores: tied, settings: { scoreCutoff: 1, countCutoff: 2 } },
      { scores: tied, settings: { scoreCutoff: 1, countCutoff: 3 } },
      { scores: tied, settings: { scoreCutoff: 0.25, countCutoff: 0 } },
      { scores: tied, settings: { scoreCutoff: 0, countCutoff: 0 } },
      {
        scores: [{ commit: "c", target: "z", score: -0 }, { commit: "c", target: "a", score: 0 }],
        settings: { scoreCutoff: 0, countCutoff: 0 }
      },
      {
        scores: [{ commit: "c", target: "z", score: -0 }, { commit: "c", target: "a", score: 0 }],
        settings: { scoreCutoff: 5e-324, countCutoff: 1 }
      },
      {
        scores: [{ commit: "c", target: "\ude3a", score: 1 }, { commit: "c", target: "😺", score: 1 }, {
          commit: "c",
          target: "￿",
          score: 1
        }],
        settings: { scoreCutoff: 1, countCutoff: 0 }
      },
      { scores: tied, settings: Selection.defaultSettings },
      { scores: tied, settings: Measure.defaults }
    ]
    for (const input of corpus) await selectAgrees(input)
    expect(Selection.defaultSettings).toEqual({ scoreCutoff: 0.1, countCutoff: 5 })
    expect(Measure.defaults).toEqual({ scoreCutoff: 0.05, countCutoff: 5 })
    expect(await selectAgrees({ scores: tied, settings: { scoreCutoff: 1, countCutoff: 2 } })).toEqual(["a", "b"])
    expect(await selectAgrees({ scores: tied, settings: { scoreCutoff: 1, countCutoff: 0 } })).toEqual([])
  })

  differential("metrics counts and divides as the specification does, for any selection", async () => {
    await holds(
      Arbitrary.all({
        rows: list(rowEntry, 30),
        selected: list(Arbitrary.all([pick(commits), list(pick(targets), 6)]), 7)
      }),
      { runs: 400, seed: 8204 },
      async (input) => {
        const selected = new Map<string, ReadonlyArray<string>>(input.selected)
        const actual = Selection.metrics(input.rows, selected)
        const expected = await oracle.ask("metrics", {
          rows: input.rows.map(rowWire),
          selected: [...selected].map(([commit, chosen]) => [units(commit), chosen.map(units)])
        }) as OracleCounts
        expect(counted(actual)).toEqual(reported(expected))
        expect(actual.selected).toBeLessThanOrEqual(actual.rows)
        expect(actual.failures).toBeLessThanOrEqual(actual.rows)
        expect(actual.failedChanges).toBeLessThanOrEqual(actual.failures)
        expect(actual.testRecall ?? 0).toBeLessThanOrEqual(1)
        expect(actual.changeRecall ?? 0).toBeLessThanOrEqual(1)
      }
    )
  })
})

// --- measuring ------------------------------------------------------------------------------------------------------

const measureCase: Arbitrary.Arbitrary<MeasureCase> = Arbitrary.all({
  rows: list(rowEntry, 36),
  scores: list(scoreEntry, 44)
})

/** Rows that fail often and scores that follow the failure, so the recall bars are reached and missed. */
const tracked: Arbitrary.Arbitrary<MeasureCase> = Arbitrary.map(
  list(
    Arbitrary.all({ commit: int(0, 11), target: pick(targets), failed: int(0, 3), high: scoreValue, miss: int(0, 9) }),
    40
  ),
  (entries) => {
    const distinct = [...new Map(entries.map((entry) => [`${entry.commit} ${entry.target}`, entry])).values()]
    return {
      rows: distinct.map((entry) => rowOf(`c${entry.commit}`, entry.target, entry.failed > 0, entry.failed === 0)),
      scores: distinct.map((entry) => ({
        commit: `c${entry.commit}`,
        target: entry.target,
        score: entry.failed > 0 && entry.miss > 0 ? Math.max(entry.high, 0.9) : Math.min(entry.high, 0.3)
      }))
    }
  }
)

const observationCase = list(
  Arbitrary.map(
    Arbitrary.all({ commit: pick(commits), target: pick(targets), failed: bit, flaky: bit, at: age }),
    (entry): Features.Observation => ({
      at: entry.at,
      row: rowOf(entry.commit, entry.target, entry.failed, entry.flaky)
    })
  ),
  30
)

describe("measuring against the Lean specification", () => {
  differential("selected groups scores by change and selects each change as the specification does", async () => {
    await holds(
      Arbitrary.all({ scores: list(scoreEntry, 44), scoreCutoff: scoreValue, countCutoff: int(0, 8) }),
      { runs: 400, seed: 8301 },
      async (input) => {
        const settings = { scoreCutoff: input.scoreCutoff, countCutoff: input.countCutoff }
        const expected = await oracle.ask("selected", {
          scores: input.scores.map(scoreWire),
          ...settingsWire(settings)
        }) as ReadonlyArray<readonly [Units, ReadonlyArray<Units>]>
        const actual = [...Measure.selected(input.scores, settings)]
        expect(actual.map(([commit, chosen]) => [units(commit), chosen.map(units)])).toEqual(expected)
      }
    )
  })

  differential(
    "measure agrees, and looser settings never lose a caught failure, a caught change or a row",
    async () => {
      await holds(
        Arbitrary.all({
          input: measureCase,
          cutoffs: Arbitrary.all([scoreValue, scoreValue]),
          counts: Arbitrary.all([int(0, 8), int(0, 8)])
        }),
        { runs: 400, seed: 8302 },
        async ({ input, cutoffs, counts }) => {
          const order = (a: number, b: number): number => a - b
          const [low, high] = [...cutoffs].sort(order) as [number, number]
          const [few, more] = [...counts].sort(order) as [number, number]
          const strict = await measureAgrees(input, { scoreCutoff: high, countCutoff: few })
          const loose = await measureAgrees(input, { scoreCutoff: low, countCutoff: more })
          expect(loose.selected).toBeGreaterThanOrEqual(strict.selected)
          expect(loose.testRecall ?? 0).toBeGreaterThanOrEqual(strict.testRecall ?? 0)
          expect(loose.changeRecall ?? 0).toBeGreaterThanOrEqual(strict.changeRecall ?? 0)
          expect([loose.rows, loose.failures, loose.failedChanges]).toEqual([
            strict.rows,
            strict.failures,
            strict.failedChanges
          ])
        }
      )
    }
  )

  differential("report sweeps, checks and calibrates as the specification does, on any rows and scores", async () => {
    await holds(measureCase, { runs: 250, seed: 8303 }, async (input) => {
      await reportAgrees(input)
    })
  })

  differential("report agrees where scores follow failures and the recall bars are in reach", async () => {
    let weekly = 0
    let calibrated = 0
    let refused = 0
    await holds(tracked, { runs: 300, seed: 8304 }, async (input) => {
      const actual = await reportAgrees(input)
      if (actual.weekly !== undefined) weekly++
      if (actual.calibrated !== undefined) calibrated++
      if (actual.recall !== "measured") refused++
    })
    expect(weekly).toBeGreaterThan(20)
    expect(calibrated).toBeGreaterThan(20)
    expect(refused).toBeGreaterThan(0)
  })

  differential(
    "report agrees at the edges of the recall bars: 0.9, 0.95 and 0.999, a failure either side",
    async () => {
      const at = async (input: MeasureCase): Promise<Measure.Report> => await reportAgrees(input)
      expect((await at(ladder(10, 9))).weekly?.settings.scoreCutoff).toBe(1)
      expect((await at(ladder(10, 8))).weekly?.settings.scoreCutoff).toBe(0)
      expect((await at(ladder(20, 18, 7))).weekly?.settings.scoreCutoff).toBe(1)
      expect((await at(ladder(20, 19))).calibrated?.settings).toEqual({ scoreCutoff: 0, countCutoff: 0 })
      expect((await at(ladder(20, 20))).calibrated?.settings).toEqual({ scoreCutoff: 1, countCutoff: 0 })
      expect((await at(ladder(21, 20))).calibrated?.settings).toEqual({ scoreCutoff: 1, countCutoff: 1 })
      expect((await at(ladder(40, 39, 3))).calibrated?.settings).toEqual({ scoreCutoff: 1, countCutoff: 1 })
      expect((await at(ladder(0, 0, 5))).recall).not.toBe("measured")
      expect((await at({ rows: [], scores: [] })).recall).not.toBe("measured")
      expect((await at({ rows: ladder(3, 3).rows, scores: [] })).calibrated).toBeUndefined()
      const thousand = await at(ladder(1000, 999))
      expect(thousand.byScore[0]!.metrics.changeRecall).toBe(0.999)
      expect(thousand.calibrated?.settings).toEqual({ scoreCutoff: 1, countCutoff: 1 })
      const wide = Array.from({ length: 120 }, (_, index) => `//t${index}:x`)
      const swept = await at({
        rows: wide.map((target) => rowOf("w", target, true, false)),
        scores: wide.map((target, index) => ({ commit: "w", target, score: index * 1e-5 }))
      })
      expect(swept.byCount.map((point) => point.metrics.selected)).toEqual([0, 1, 2, 5, 10, 20, 50, 100])
    }
  )

  differential("split cuts history from the test set where the specification does", async () => {
    await holds(observationCase, { runs: 300, seed: 8305 }, async (observations) => {
      const actual = Measure.split(observations)
      expect({
        from: actual.from,
        to: actual.to,
        history: actual.history.map(observationWire),
        test: actual.test.map(observationWire)
      }).toEqual(await oracle.ask("split", { observations: observations.map(observationWire) }))
      expect(actual.history.length + actual.test.length).toBe(observations.length)
      for (const kept of [...actual.history, ...actual.test]) expect(observations).toContain(kept)
    })
  })

  differential("sample keeps the specification's evenly spaced changes, with all of their rows", async () => {
    await holds(
      Arbitrary.all({ test: observationCase, count: int(0, 9) }),
      { runs: 300, seed: 8306 },
      async (input) => {
        const actual = Measure.sample(input.test, input.count)
        expect(actual.map(observationWire)).toEqual(
          await oracle.ask("sample", { observations: input.test.map(observationWire), count: input.count })
        )
        for (const kept of actual) expect(input.test).toContain(kept)
      }
    )
  })

  differential("lowerBound is the specification's Wilson bound, bit for bit, for counts", async () => {
    await holds(
      Arbitrary.all({ caught: int(0, 4000), missed: int(0, 4000), all: bit }),
      { runs: 500, seed: 8307 },
      async (input) => {
        const total = input.caught + (input.all ? 0 : input.missed)
        const actual = Measure.lowerBound(input.caught, total)
        expect(bitsOf(actual)).toBe(await oracle.ask("lowerBound", { caught: sent(input.caught), total: sent(total) }))
        expect(bitsOf(actual)).toBe(await oracle.ask("lowerBoundOfCounts", { caught: input.caught, total }))
        if (total > 0) {
          expect(actual).toBeGreaterThanOrEqual(0)
          expect(actual).toBeLessThanOrEqual(input.caught / total)
        }
      }
    )
  })

  differential(
    "lowerBound agrees on numbers no count is: zero totals, fractions, infinities, not-numbers",
    async () => {
      const hostile = [0, -0, 1, 2, 0.5, -1, 5e-324, 1e308, 2 ** 53, Infinity, -Infinity, NaN, 1000, 999] as const
      await holds(Arbitrary.all([pick(hostile), pick(hostile)]), { runs: 300, seed: 8308 }, async ([caught, total]) => {
        expect(bitsOf(Measure.lowerBound(caught, total))).toBe(
          await oracle.ask("lowerBound", { caught: sent(caught), total: sent(total) })
        )
      })
      expect(Measure.lowerBound(0, 0)).toBe(0)
      expect(Measure.lowerBound(1000, 1000)).toBeLessThan(0.999)
      expect(Measure.lowerBound(2700, 2700)).toBeGreaterThan(0.998)
    }
  )
})

// --- features -------------------------------------------------------------------------------------------------------

const paths = [
  "a/x.ts",
  "a/b/y.ts",
  "a/b/c/z",
  "b/q",
  "README",
  "ab/x",
  "a",
  "plain/f",
  "b:c/f",
  "/x",
  "",
  "😺/f"
] as const
const graphLabels = [
  "//a:test",
  "//a:lint",
  "//a/b:test",
  "//a/b/c:x",
  "//:root",
  "//.:dot",
  "plain",
  "//b:test",
  "b:c:d",
  "//",
  ":",
  "//a:",
  "a/b",
  "//😺:t",
  "//ghost:x"
] as const

const planOf = (planned: ReadonlyArray<readonly [string, ReadonlyArray<string>]>): Plan => ({
  verb: "ci",
  pattern: "//...",
  roots: [],
  targets: planned.map(([each, dependencies]) => ({
    label: each,
    rule: "test",
    key: "k",
    cacheable: true,
    dependencies
  }))
})

interface GraphCase {
  readonly files: ReadonlyArray<string>
  readonly targets: ReadonlyArray<string>
  readonly plan: ReadonlyArray<readonly [string, ReadonlyArray<string>]> | undefined
}

/** `graphDistances` by the implementation and by the oracle: the same labels, distances and order. */
const graphAgrees = async (input: GraphCase): Promise<ReadonlyArray<readonly [string, number]>> => {
  const actual = [
    ...Features.graphDistances(input.files, input.targets, input.plan === undefined ? undefined : planOf(input.plan))
  ]
  const expected = await oracle.ask("graphDistances", {
    files: input.files.map(units),
    targets: input.targets.map(units),
    plan: input.plan === undefined
      ? null
      : input.plan.map(([each, dependencies]) => [units(each), dependencies.map(units)])
  }) as ReadonlyArray<readonly [Units, number]>
  expect(actual.map(([each, distance]) => [units(each), distance])).toEqual(expected)
  return actual
}

describe("features against the Lean specification", () => {
  differential("projectOf drops the leading slashes and the last colon's tail as the specification does", async () => {
    await holds(label, { runs: 400, seed: 8401 }, async (text) => {
      expect(units(Features.projectOf(text))).toEqual(await oracle.ask("projectOf", { label: units(text) }))
    })
    for (const text of graphLabels) {
      expect(units(Features.projectOf(text))).toEqual(await oracle.ask("projectOf", { label: units(text) }))
    }
  })

  differential("fileChanges counts the specification's commits in each window, to the millisecond", async () => {
    await holds(
      Arbitrary.all({
        files: list(pick(paths), 5),
        shift: int(-1, 1),
        history: list(Arbitrary.all({ at: age, files: list(pick(paths), 4) }), 30)
      }),
      { runs: 400, seed: 8402 },
      async (input) => {
        const at = now + input.shift
        const actual = Features.fileChanges(input.files, at, input.history)
        expect([actual.d3, actual.d14, actual.d56]).toEqual(
          await oracle.ask("fileChanges", {
            files: input.files.map(units),
            at,
            history: input.history.map((commit) => [commit.at, commit.files.map(units)])
          })
        )
        expect(actual.d3).toBeLessThanOrEqual(actual.d14)
        expect(actual.d14).toBeLessThanOrEqual(actual.d56)
      }
    )
  })

  differential("failureRates divides the specification's failed runs by its runs in each window", async () => {
    await holds(
      Arbitrary.all({ shift: int(-1, 1), runs: list(Arbitrary.all({ at: age, failed: bit, flaky: bit }), 40) }),
      { runs: 400, seed: 8403 },
      async (input) => {
        const at = now + input.shift
        const runs = input.runs.map((run): Features.Observation => ({
          at: run.at,
          row: rowOf("old", "//a:test", run.failed, run.flaky)
        }))
        const actual = Features.failureRates(at, runs)
        const expected = await oracle.ask("failureRates", { at, runs: runs.map(observationWire) }) as ReadonlyArray<
          readonly [number, number, string]
        >
        expect([actual.d7, actual.d14, actual.d28, actual.d56].map(bitsOf)).toEqual(expected.map(([, , rate]) => rate))
        for (const [failed, total] of expected) expect(failed).toBeLessThanOrEqual(total)
        expect(expected.map(([, total]) => total)).toEqual(expected.map(([, total]) => total).sort((a, b) => a - b))
      }
    )
  })

  differential(
    "graphDistances walks the plan to the specification's distances: cycles, repeats, unknown labels",
    async () => {
      await holds(
        Arbitrary.all({
          files: list(pick(paths), 4),
          targets: list(pick(graphLabels), 8),
          planned: bit,
          plan: list(Arbitrary.all([pick(graphLabels), list(pick(graphLabels), 4)]), 12)
        }),
        { runs: 500, seed: 8404 },
        async (input) => {
          await graphAgrees({
            files: input.files,
            targets: input.targets,
            plan: input.planned ? input.plan : undefined
          })
        }
      )
    }
  )

  differential("graphDistances agrees at the boundaries: no plan, no files, a long chain, a cycle", async () => {
    const chain = Array.from({ length: 60 }, (_, index) => `//p${index}:t`)
    const links = chain.map((each, index): readonly [string, ReadonlyArray<string>] => [
      each,
      index === 0 ? [] : [chain[index - 1]!]
    ])
    expect(await graphAgrees({ files: [], targets: [], plan: undefined })).toEqual([])
    expect(await graphAgrees({ files: ["a/x"], targets: ["//a:t", "//b:t"], plan: undefined })).toEqual([
      ["//a:t", 0],
      ["//b:t", Features.unreachable]
    ])
    expect((await graphAgrees({ files: ["p0/x"], targets: [], plan: links })).at(-1)).toEqual(["//p59:t", 59])
    expect(await graphAgrees({ files: ["p0/x"], targets: [], plan: [...links].reverse() })).toHaveLength(60)
    expect(
      await graphAgrees({
        files: ["a/x"],
        targets: ["//a:t"],
        plan: [["//a:t", ["//b:t"]], ["//b:t", ["//a:t", "//b:t"]]]
      })
    )
      .toEqual([["//a:t", 0], ["//b:t", 1]])
    expect(await graphAgrees({ files: ["a/b/x"], targets: ["//a:t", "//a/b:t", "//:r"], plan: undefined })).toEqual([
      ["//a:t", Features.unreachable],
      ["//a/b:t", 0],
      ["//:r", Features.unreachable]
    ])
    expect(
      await graphAgrees({
        files: ["a/x"],
        targets: ["//a:t"],
        plan: [["//a:t", []], ["//a:t", ["//a:t"]], ["//c:t", ["//a:t", "//a:t"]]]
      })
    )
      .toEqual([["//a:t", 0], ["//c:t", 1]])
  })
})

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope")
    await expect(oracle.ask("shardOf", { label: "not units", count: 1 })).rejects.toThrow("the oracle refused")
    expect(await oracle.ask("shardOf", { label: [], count: 7 })).toBe(0x811c9dc5 % 7)
  })

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(10_000)
  })
})
