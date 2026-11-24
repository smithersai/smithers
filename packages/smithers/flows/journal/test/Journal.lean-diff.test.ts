/**
 * The durable journal against its Lean 4 reference specification (`spec/lean/journal`), generated: every script of
 * calls runs on the real SQL journal over a fresh database and through the specification's compiled oracle, and the
 * two must agree on every receipt, refusal and page, and on the rows left in the database at the end.
 *
 * A script follows one run: owners take and lose its lease, fenced and unfenced durable writes arrive with supplied
 * and allocated producer sequences, checkpoints and compactions are attempted by owners and by zombies, pages are
 * read from arbitrary cursors, and the journal process restarts. The automatic compaction policy runs when a script's
 * settings turn it on, with a thief taking the lease during capture: the race of issue 4555.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A payload crosses as its UTF-16 code units, so a lone surrogate arrives as it left.
 *
 * A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
 * and builds it again when a source of the specification is newer than it.
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Context, Effect, Layer, Logger, Option, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Journal, type JournalError, type Service } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as Redaction from "../src/Redaction.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "journal")
const binary = join(specDir, ".lake", "build", "bin", "journal-spec")
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
    "JournalSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "JournalSpec")).map((name) => join("JournalSpec", name))
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
})

afterAll(() => {
  if (oracleReady) oracle.close()
})

// --- the wire -------------------------------------------------------------------------------------------------------

/** A text as its UTF-16 code units. */
const units = (text: string): Array<number> => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))

/** One call of a script, in the oracle's shape. Owners and producers are small numbers. */
type Call =
  | { readonly t: "hold"; readonly owner: number }
  | { readonly t: "release" }
  | { readonly t: "restart" }
  | {
    readonly t: "emit"
    readonly owner: number | null
    readonly source: number
    readonly sourceSeq: number | null
    readonly payload: string
    readonly steal: number | null
  }
  | { readonly t: "checkpoint"; readonly seq: number; readonly state: number; readonly owner: number }
  | { readonly t: "compact"; readonly upTo: number | null; readonly owner: number }
  | { readonly t: "entries"; readonly after: number | null; readonly limit: number; readonly descending: boolean }
  | { readonly t: "latestCheckpoint" }

interface Settings {
  readonly maxEntryBytes: number
  readonly threshold: number | null
}

interface Script {
  readonly settings: Settings
  readonly calls: ReadonlyArray<Call>
}

const wireCall = (call: Call): unknown => (call.t === "emit" ? { ...call, payload: units(call.payload) } : call)

// --- the implementation, driven by a script --------------------------------------------------------------------------

const run = "r" as RunId
const owners: ReadonlyArray<OwnerId> = [0, 1, 2].map((index) => ({
  hostId: `host-${index}`,
  pid: index + 1,
  nonce: `nonce-${index}`
}))
const sources = ["engine", "telemetry", "tool"] as const

/** A fresh database, and no log output: a refused automatic compaction warns by design. */
const database = Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer), Logger.layer([]))

const refusal = (cause: JournalError) => ({ error: cause.code, checkpointSeq: cause.checkpointSeq ?? null })

/** The state the automatic policy captures at `upTo`; the specification's `captured`. */
const captured = (upTo: number): number => 7 * upTo + 1

/**
 * Runs a script on the real journal over a fresh database and returns what the oracle returns for it: each call's
 * outcome and the rows the database holds at the end.
 */
const execute = (script: Script) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    /** Who takes the lease while the policy captures, for the emit in flight. */
    let thief: number | null = null
    const compaction = script.settings.threshold === null ? undefined : {
      entryThreshold: script.settings.threshold,
      capture: (_runId: RunId, upTo: Seq) =>
        Effect.as(
          thief === null ? Effect.void : Leases.hold(sql, run, owners[thief]!),
          captured(upTo)
        ).pipe(Effect.orDie)
    }
    /** A journal process over the same database. */
    const open = Effect.map(
      Layer.build(SqlJournal.layer({
        capacity: 64,
        overflow: "reject",
        maxEntryBytes: script.settings.maxEntryBytes,
        redact: Redaction.makeNoop(),
        ...(compaction === undefined ? {} : { compaction })
      })),
      (context): Service => Context.get(context, Journal)
    )
    let journal = yield* open
    const outcomes: Array<unknown> = []
    for (const call of script.calls) {
      switch (call.t) {
        case "hold":
          yield* Leases.hold(sql, run, owners[call.owner]!)
          outcomes.push(null)
          break
        case "release":
          yield* Leases.release(sql, run)
          outcomes.push(null)
          break
        case "restart":
          journal = yield* open
          outcomes.push(null)
          break
        case "emit": {
          const input = new Input({
            runId: run,
            sourceId: sources[call.source]! as SourceId,
            ...(call.sourceSeq === null ? {} : { sourceSeq: call.sourceSeq as SourceSeq }),
            eventType: "event",
            payload: call.payload
          })
          thief = call.steal
          outcomes.push(
            yield* Effect.match(
              call.owner === null
                ? journal.emitDurableUnfenced(input)
                : journal.emitDurable(input, owners[call.owner]!),
              {
                onFailure: refusal,
                onSuccess: (receipt) => ({ tag: receipt._tag, seq: receipt.seq, sourceSeq: receipt.sourceSeq })
              }
            )
          )
          thief = null
          break
        }
        case "checkpoint":
          outcomes.push(
            yield* Effect.match(
              journal.checkpoint({ runId: run, seq: call.seq as Seq, state: call.state }, owners[call.owner]!),
              {
                onFailure: refusal,
                onSuccess: (checkpoint) => ({
                  checkpoint: [checkpoint.seq, checkpoint.state, checkpoint.compactedAtMs !== null]
                })
              }
            )
          )
          break
        case "compact":
          outcomes.push(
            yield* Effect.match(
              journal.compact(
                { runId: run, ...(call.upTo === null ? {} : { upTo: call.upTo as Seq }) },
                owners[call.owner]!
              ),
              {
                onFailure: refusal,
                onSuccess: (receipt) => ({ checkpointSeq: receipt.checkpointSeq, deleted: receipt.deleted })
              }
            )
          )
          break
        case "entries":
          outcomes.push(
            yield* Effect.match(
              journal.entries({
                runId: run,
                limit: call.limit,
                ...(call.after === null ? {} : { after: call.after as Seq }),
                ...(call.descending ? { order: "desc" as const } : {})
              }),
              {
                onFailure: refusal,
                onSuccess: (page) => ({
                  entries: page.entries.map((entry) => [
                    entry.seq,
                    sources.indexOf(entry.sourceId as typeof sources[number]),
                    entry.sourceSeq,
                    units(entry.payload as string)
                  ]),
                  hasMore: page.hasMore
                })
              }
            )
          )
          break
        case "latestCheckpoint":
          outcomes.push({
            latest: Option.match(yield* journal.latestCheckpoint(run), {
              onNone: () => null,
              onSome: (checkpoint) => [checkpoint.seq, checkpoint.state, checkpoint.compactedAtMs !== null]
            })
          })
          break
      }
    }
    const entries = yield* sql<{ seq: number; source_id: string; source_seq: number; payload_json: string }>`
      SELECT seq, source_id, source_seq, payload_json FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq
    `
    const retired = yield* sql<{ seq: number; source_id: string; source_seq: number }>`
      SELECT seq, source_id, source_seq FROM flows_journal_dedup WHERE run_id = ${run} ORDER BY seq
    `
    const checkpoints = yield* sql<{ seq: number; state_json: string; compacted_at_ms: number | null }>`
      SELECT seq, state_json, compacted_at_ms FROM flows_journal_checkpoints WHERE run_id = ${run} ORDER BY seq
    `
    const sourceOf = (id: string) => sources.indexOf(id as typeof sources[number])
    return {
      outcomes,
      entries: entries.map((row) => [
        Number(row.seq),
        sourceOf(row.source_id),
        Number(row.source_seq),
        units(JSON.parse(row.payload_json) as string)
      ]),
      retired: retired.map((row) => [Number(row.seq), sourceOf(row.source_id), Number(row.source_seq)]),
      checkpoints: checkpoints.map((row) => [
        Number(row.seq),
        JSON.parse(row.state_json) as number,
        row.compacted_at_ms !== null
      ])
    }
  }).pipe(Effect.scoped, Effect.provide(database))

// --- generators -----------------------------------------------------------------------------------------------------

const baseExecutions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "100"))
const executions = Math.max(25, Math.min(baseExecutions, 150))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261123")

const int = (minimum: number, maximum: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))

/** One of `values`; a failing case shrinks toward the first. */
const pick = <A>(values: ReadonlyArray<A>): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(int(0, values.length - 1), (index) => values[index]!)

const bit: Arbitrary.Arbitrary<boolean> = Arbitrary.schema(Schema.Boolean)

const list = <A>(item: Arbitrary.Arbitrary<A>, maxLength: number): Arbitrary.Arbitrary<Array<A>> =>
  Arbitrary.array(item, { maxLength })

/** `value` one time in `outOf`, else null. */
const sometimes = (outOf: number, value: Arbitrary.Arbitrary<number>): Arbitrary.Arbitrary<number | null> =>
  Arbitrary.map(Arbitrary.all([int(1, outOf), value]), ([choice, made]) => (choice === 1 ? made : null))

/** Pieces a payload is built from: every escape class, each UTF-8 width, and both halves of a surrogate pair. */
const fragments = [
  "a",
  "b",
  "\"",
  "\\",
  "\n",
  "\u0000",
  "\u007f",
  "é",
  "ࠀ",
  "￿",
  "😺",
  "\ud83d",
  "\ude3a"
] as const

const payload: Arbitrary.Arbitrary<string> = Arbitrary.map(list(pick(fragments), 5), (parts) => parts.join(""))

const owner = int(0, 2)

/** Mostly the first owner's fenced write, so most scripts commit entries. */
const emit: Arbitrary.Arbitrary<Call> = Arbitrary.map(
  Arbitrary.all([int(0, 5), int(0, 2), sometimes(2, int(0, 4)), payload, sometimes(4, owner)]),
  ([who, source, sourceSeq, made, steal]) => ({
    t: "emit" as const,
    owner: who <= 2 ? 0 : who === 3 ? 1 : who === 4 ? 2 : null,
    source,
    sourceSeq,
    payload: made,
    steal
  })
)

const other: Arbitrary.Arbitrary<Call> = Arbitrary.map(
  Arbitrary.all([int(0, 9), owner, int(0, 7), int(0, 99), sometimes(2, int(0, 7)), int(1, 6), bit]),
  ([choice, who, seq, state, cursor, limit, descending]): Call =>
    choice <= 1
      ? { t: "hold", owner: who }
      : choice === 2
      ? { t: "release" }
      : choice === 3
      ? { t: "restart" }
      : choice <= 5
      ? { t: "checkpoint", seq, state, owner: who }
      : choice <= 7
      ? { t: "compact", upTo: cursor, owner: who }
      : choice === 8
      ? { t: "entries", after: cursor, limit, descending }
      : { t: "latestCheckpoint" }
)

const call: Arbitrary.Arbitrary<Call> = Arbitrary.map(
  Arbitrary.all([int(0, 9), emit, other]),
  ([choice, write, rest]) => (choice <= 4 ? write : rest)
)

/** A bound most payloads fit and some do not, or the roomy one. */
const settings: Arbitrary.Arbitrary<Settings> = Arbitrary.map(
  Arbitrary.all([pick([4096, 14, 9, 20]), sometimes(2, int(1, 5))]),
  ([maxEntryBytes, threshold]) => ({ maxEntryBytes, threshold })
)

/** A script that starts with the first owner holding the run, so the first writes are admitted. */
const script: Arbitrary.Arbitrary<Script> = Arbitrary.map(
  Arbitrary.all([settings, list(call, 14)]),
  ([made, calls]) => ({ settings: made, calls: [{ t: "hold" as const, owner: 0 }, ...calls] })
)

/** Asks the oracle for a script's outcomes and final rows. */
const specified = (made: Script): Promise<unknown> =>
  oracle.ask("run", { ...made.settings, calls: made.calls.map(wireCall) })

/** Fails the test with the shrunk counterexample unless the property holds for every generated value. */
const agrees = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  offset: number,
  property: (value: A) => Effect.Effect<void, unknown>
): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(arbitrary, (generated) => Effect.as(property(generated), true), { seed: seed + offset, executions })
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** The script's answers from both sides must be equal. */
const same = (made: Script) =>
  Effect.gen(function*() {
    const actual = yield* execute(made)
    const expected = yield* Effect.promise(() => specified(made))
    yield* Effect.try(() => expect(actual).toEqual(expected))
    return actual
  })

// --- the suite ------------------------------------------------------------------------------------------------------

describe("the durable journal agrees with the Lean specification", () => {
  differential("every script of durable calls is answered and persisted as the specification says", async () => {
    await agrees(script, 0, same)
  })

  differential("the entry byte bound is exact, and a refused entry costs no sequence (#4558)", async () => {
    await agrees(
      Arbitrary.all([payload, payload, bit, sometimes(2, int(0, 4))]),
      1,
      ([big, next, fits, sourceSeq]) =>
        Effect.gen(function*() {
          const bytes = (yield* Effect.promise(() => oracle.ask("entryBytes", { payload: units(big) }))) as number
          const write = (made: string): Call => ({
            t: "emit",
            owner: 0,
            source: 0,
            sourceSeq,
            payload: made,
            steal: null
          })
          const made: Script = {
            settings: { maxEntryBytes: fits ? bytes : bytes - 1, threshold: null },
            calls: [{ t: "hold", owner: 0 }, write(big), write(next), {
              t: "entries",
              after: null,
              limit: 6,
              descending: false
            }]
          }
          const actual = yield* same(made)
          // The bound is the encoded size itself: one byte under it refuses, and the refusal reserved nothing.
          yield* Effect.try(() =>
            expect(actual.outcomes[1]).toEqual(
              fits
                ? { tag: "Accepted", seq: 0, sourceSeq: sourceSeq ?? 0 }
                : { error: "invalid_event", checkpointSeq: null }
            )
          )
        })
    )
  })

  differential("a zombie's write, checkpoint and compaction leave the live owner's history whole (#4555)", async () => {
    await agrees(
      Arbitrary.all([list(payload, 6), int(1, 4), int(1, 2), list(other, 4), payload]),
      2,
      ([history, threshold, zombie, attempts, late]) =>
        Effect.gen(function*() {
          const writes = history.map((made, index): Call => ({
            t: "emit",
            owner: 0,
            source: 0,
            sourceSeq: index,
            payload: made,
            // The last commit crosses the threshold while the zombie-to-be is displaced mid-capture.
            steal: index === history.length - 1 ? zombie : null
          }))
          const made: Script = {
            settings: { maxEntryBytes: 4096, threshold },
            calls: [
              { t: "hold", owner: 0 },
              ...writes,
              ...attempts.map((attempt): Call =>
                attempt.t === "checkpoint" || attempt.t === "compact" ? { ...attempt, owner: 0 } : attempt
              ),
              { t: "emit", owner: 0, source: 1, sourceSeq: null, payload: late, steal: null },
              { t: "latestCheckpoint" },
              { t: "entries", after: null, limit: 6, descending: false }
            ]
          }
          yield* same(made)
        })
    )
  })

  differential("replay from the latest checkpoint reads the same tail at every page size", async () => {
    await agrees(Arbitrary.all([script, int(1, 4)]), 3, ([made, limit]) =>
      Effect.gen(function*() {
        const final = (yield* Effect.promise(() => specified(made))) as {
          readonly entries: ReadonlyArray<readonly [number, number, number, ReadonlyArray<number>]>
          readonly checkpoints: ReadonlyArray<readonly [number, number, boolean]>
        }
        const from = final.checkpoints.at(-1)?.[0] ?? null
        const tail = final.entries.filter((entry) => from === null || entry[0] > from)
        // Page through the real journal from the checkpoint; the pages, joined, are the specification's tail.
        const pages: Array<Call> = []
        let cursor = from
        for (let index = 0; index < tail.length; index += limit) {
          pages.push({ t: "entries", after: cursor, limit, descending: false })
          cursor = tail[Math.min(index + limit, tail.length) - 1]![0]
        }
        pages.push({ t: "entries", after: cursor, limit, descending: false })
        const actual = yield* same({ settings: made.settings, calls: [...made.calls, ...pages] })
        const read = actual.outcomes.slice(made.calls.length) as ReadonlyArray<
          { readonly entries: ReadonlyArray<unknown>; readonly hasMore: boolean }
        >
        yield* Effect.try(() => {
          expect(read.flatMap((page) => page.entries)).toEqual(tail)
          expect(read.at(-1)).toEqual({ entries: [], hasMore: false })
        })
      }))
  })

  differential("every case above was answered by the oracle", () => {
    expect(oracle.asked()).toBeGreaterThan(executions * 4)
  })
})
