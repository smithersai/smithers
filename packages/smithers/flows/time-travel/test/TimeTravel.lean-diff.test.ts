/**
 * The memory store's rewind, fork and lineage walk against their Lean 4 reference specification
 * (`spec/lean/time_travel`), generated: every case is answered by the implementation and by the specification's
 * compiled oracle, and the two answers must be equal, to the order for a list.
 *
 * A case is a seeded store and a sequence of store calls. The implementation runs the calls on a real
 * `MemoryTimeTravelStore`; the oracle runs them on the specification's state. Each call's answer, or the code it was
 * refused with, and the store's final records, archive, edges and reserved fork ids are compared.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle
 * first, and builds it again when a source of the specification is newer than it.
 */
import { Fuzz } from "@smthrs/fuzz"
import type { OwnerId } from "@smthrs/journal/OwnerId"
import type { RunStatus } from "@smthrs/run-store/RunStore"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { forkCreatedEventType, type LineageEdge } from "../src/Frame.ts"
import * as LineageTree from "../src/internal/LineageTree.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import type { TimeTravelError } from "../src/TimeTravelError.ts"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "time_travel")
const binary = join(specDir, ".lake", "build", "bin", "time-travel-spec")
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
    "TimeTravelSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "TimeTravelSpec")).map((name) => join("TimeTravelSpec", name))
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

// --- generators -----------------------------------------------------------------------------------------------------

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const executions = Math.max(25, Math.min(baseExecutions, 150))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const check = async <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (value: A) => Promise<void>): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(arbitrary, (value) => Effect.promise(async () => (await property(value), true)), { executions, seed })
  )
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const int = (minimum: number, maximum: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))

/** One of `values`; a failing case shrinks toward the first. */
const pick = <A>(values: ReadonlyArray<A>): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(int(0, values.length - 1), (index) => values[index]!)

const bit: Arbitrary.Arbitrary<boolean> = Arbitrary.schema(Schema.Boolean)

const list = <A>(item: Arbitrary.Arbitrary<A>, maxLength: number): Arbitrary.Arbitrary<Array<A>> =>
  Arbitrary.array(item, { maxLength })

/** Run ids that collide on purpose: the ids a fork mints for `a` and `b` are in the pool. */
const runIds = ["a", "b", "c", "d", "a:fork:0:1", "a:fork:1:1", "b:fork:0:2", "é/😺"] as const
const runId = pick(runIds)
const seq = int(0, 4)
const lineages = ["L", "M"] as const
const statuses: ReadonlyArray<RunStatus> = ["running", "completed", "pending", "failed", "suspended", "cancelled"]
const terminal: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed", "cancelled"])
const owners: ReadonlyArray<OwnerId> = [
  { hostId: "h0", pid: 0, nonce: "n0" },
  { hostId: "h0", pid: 1, nonce: "n0" },
  { hostId: "h1", pid: 0, nonce: "n0" },
  { hostId: "h0", pid: 0, nonce: "n1" }
]

interface Row {
  readonly runId: string
  readonly seq: number
  readonly eventId: string
  readonly lineageId: string | undefined
  readonly eventType: string | undefined
}

const row: Arbitrary.Arbitrary<Row> = Arbitrary.map(
  Arbitrary.all([
    runId,
    seq,
    pick(["e", "f"]),
    pick([undefined, ...lineages]),
    pick([undefined, "x", forkCreatedEventType])
  ]),
  ([run, at, eventId, lineageId, eventType]) => ({
    runId: run,
    seq: at,
    eventId: `${eventId}${at}`,
    lineageId,
    eventType
  })
)

const edge: Arbitrary.Arbitrary<LineageEdge> = Arbitrary.map(
  Arbitrary.all([runId, seq, runId, pick(["child", "fork", "continuation"] as const), bit]),
  ([parentRunId, parentSeq, childRunId, kind, attached]) => ({ parentRunId, parentSeq, childRunId, kind, attached })
)

type Step =
  | {
    readonly do: "rewind"
    readonly run: string
    readonly lineage: string
    readonly seq: number
    readonly owner: number
    readonly childOwners: ReadonlyArray<readonly [string, number]>
  }
  | {
    readonly do: "fork"
    readonly parent: string
    readonly lineage: string
    readonly seq: number
    readonly child: string | undefined
  }
  | { readonly do: "reserve"; readonly parent: string; readonly seq: number }
  | { readonly do: "append"; readonly record: Row }
  | { readonly do: "archivedAt"; readonly run: string; readonly seq: number; readonly generation: number | undefined }
  | { readonly do: "descendants"; readonly run: string; readonly seq: number }

const step: Arbitrary.Arbitrary<Step> = Arbitrary.map(
  Arbitrary.all({
    choice: int(0, 9),
    run: runId,
    seq,
    lineage: pick(["L", "M", ""]),
    owner: pick([0, 0, 0, 1, 2, 3]),
    childOwners: list(Arbitrary.all([runId, pick([0, 0, 1, 3])]), 4),
    child: pick([undefined, undefined, "n", ...runIds]),
    record: row,
    generation: pick([undefined, 0, 1, 2])
  }),
  ({ choice, run, seq: at, lineage, owner, childOwners, child, record, generation }): Step => {
    if (choice < 4) return { do: "rewind", run, lineage, seq: at, owner, childOwners }
    if (choice < 7) return { do: "fork", parent: run, lineage: lineage === "" ? "L" : lineage, seq: at, child }
    if (choice === 7) return { do: "reserve", parent: run, seq: at }
    if (choice === 8) return { do: "append", record }
    return choice === 9 && generation === 2
      ? { do: "descendants", run, seq: at }
      : { do: "archivedAt", run, seq: at, generation }
  }
)

interface Case {
  readonly records: ReadonlyArray<Row>
  readonly edges: ReadonlyArray<LineageEdge>
  readonly live: ReadonlyArray<string>
  readonly statuses: ReadonlyArray<readonly [string, number]>
  readonly owners: ReadonlyArray<readonly [string, number]>
  readonly steps: ReadonlyArray<Step>
}

/** A store whose runs are mostly owned by the first owner, so most rewinds pass their fence. */
const scenario = (maxEdges: number): Arbitrary.Arbitrary<Case> =>
  Arbitrary.all({
    records: list(row, 10),
    edges: list(edge, maxEdges),
    live: list(runId, 1),
    statuses: list(Arbitrary.all([runId, int(0, statuses.length - 1)]), 3),
    owners: list(Arbitrary.all([runId, pick([0, 0, 0, 1])]), 6),
    steps: list(step, 6)
  })

// --- the wire -------------------------------------------------------------------------------------------------------

const rowWire = (
  record: Pick<MemoryTimeTravelStore.JournalRecord, "runId" | "seq" | "eventId" | "lineageId" | "eventType">
): ReadonlyArray<unknown> => [
  record.runId,
  record.seq,
  record.eventId,
  record.lineageId ?? null,
  record.eventType ?? null
]

const edgeWire = (each: LineageEdge): ReadonlyArray<unknown> => [
  each.parentRunId,
  each.parentSeq,
  each.childRunId,
  each.kind,
  each.attached
]

const ownerWire = (index: number): ReadonlyArray<unknown> => {
  const owner = owners[index]!
  return [owner.hostId, owner.pid, owner.nonce]
}

/** A map's entries: the first value given for a key is the one the map holds. */
const first = <A>(entries: ReadonlyArray<readonly [string, A]>): Array<readonly [string, A]> => {
  const held = new Map<string, A>()
  for (const [key, value] of entries) if (!held.has(key)) held.set(key, value)
  return [...held]
}

const stepWire = (each: Step): Readonly<Record<string, unknown>> => {
  switch (each.do) {
    case "rewind":
      return {
        ...each,
        owner: ownerWire(each.owner),
        childOwners: first(each.childOwners).map(([run, owner]) => [run, ownerWire(owner)])
      }
    case "fork":
      return { ...each, child: each.child ?? null }
    case "append":
      return { do: "append", record: rowWire(each.record) }
    case "archivedAt":
      return { ...each, generation: each.generation ?? null }
    default:
      return each
  }
}

// --- the implementation ---------------------------------------------------------------------------------------------

type Answer = { readonly ok: unknown } | { readonly error: string }

const answered = <A>(effect: Effect.Effect<A, TimeTravelError>, wire: (value: A) => unknown): Promise<Answer> =>
  Effect.runPromise(
    Effect.match(effect, {
      onFailure: (error): Answer => ({ error: error.code }),
      onSuccess: (value): Answer => ({ ok: wire(value) })
    })
  )

/** Runs a case on a real memory store: each call's answer and the store's final state, as the oracle writes them. */
const implementation = async (input: Case): Promise<unknown> => {
  const store = MemoryTimeTravelStore.make({
    records: input.records.map((record) => ({ ...record, payload: { seq: record.seq } })),
    edges: input.edges,
    liveRuns: new Set(input.live),
    runStatuses: new Map(first(input.statuses).map(([run, status]) => [run, statuses[status]!])),
    runOwners: new Map(first(input.owners).map(([run, owner]) => [run, owners[owner]!]))
  })
  const answers: Array<Answer> = []
  for (const each of input.steps) {
    switch (each.do) {
      case "rewind":
        answers.push(
          await answered(
            store.archiveAndTruncate(
              each.run,
              { lineageId: each.lineage, seq: each.seq },
              [],
              owners[each.owner]!,
              new Map(first(each.childOwners).map(([run, owner]) => [run, owners[owner]!]))
            ),
            (result) => ({ archived: result.archived, orphaned: result.orphaned.map(edgeWire) })
          )
        )
        break
      case "fork":
        answers.push(
          await answered(
            store.createFork(each.parent, { lineageId: each.lineage, seq: each.seq }, each.child),
            (result) => {
              expect(result.edge).toEqual({
                parentRunId: each.parent,
                parentSeq: each.seq,
                childRunId: result.runId,
                kind: "fork",
                attached: false
              })
              return result.runId
            }
          )
        )
        break
      case "reserve":
        answers.push(await answered(store.nextForkId(each.parent, { lineageId: "L", seq: each.seq }), (id) => id))
        break
      case "append":
        try {
          store.append({ ...each.record, payload: null })
          answers.push({ ok: null })
        } catch (cause) {
          answers.push({ error: (cause as TimeTravelError).code })
        }
        break
      case "archivedAt":
        answers.push(await answered(store.archivedAt(each.run, each.seq, each.generation), (held) => held))
        break
      case "descendants":
        answers.push(
          await answered(store.descendants(each.run, { lineageId: "L", seq: each.seq }), (found) => ({
            attached: found.attached.map(edgeWire),
            detached: found.detached.map(edgeWire)
          }))
        )
        break
    }
  }
  const state = store.state()
  return {
    answers,
    state: {
      archived: state.archived.map((record) => [rowWire(record), record.generation]),
      edges: state.edges.map(edgeWire),
      intents: state.forkIntents.map((intent) => [intent.childRunId, intent.parentRunId, intent.parentSeq]),
      records: state.records.map(rowWire)
    }
  }
}

const specification = (input: Case): Promise<unknown> =>
  oracle.ask("run", {
    state: {
      records: input.records.map(rowWire),
      edges: input.edges.map(edgeWire),
      live: input.live,
      statuses: first(input.statuses).map(([run, status]) => [run, terminal.has(statuses[status]!)]),
      owners: first(input.owners).map(([run, owner]) => [run, ownerWire(owner)])
    },
    steps: input.steps.map(stepWire)
  })

/** Both sides answer the case, and their answers are equal; returns the common answer. */
const agrees = async (input: Case): Promise<{ readonly answers: ReadonlyArray<Answer>; readonly state: unknown }> => {
  const expected = await specification(input)
  const actual = await implementation(input)
  expect(actual).toEqual(expected)
  return actual as { readonly answers: ReadonlyArray<Answer>; readonly state: unknown }
}

const owned = (...runs: ReadonlyArray<string>): Array<readonly [string, number]> => runs.map((run) => [run, 0])

const journal = (run: string, length: number): Array<Row> =>
  Array.from({ length }, (_, at) => ({
    runId: run,
    seq: at,
    eventId: `e${at}`,
    lineageId: "L",
    eventType: "x"
  }))

// --- the differential properties ------------------------------------------------------------------------------------

describe("the lineage walk against its specification", () => {
  differential("crosses the same descendants in the same order, cycles and repeated children included", () =>
    check(
      Arbitrary.all({ edges: list(edge, 14), run: runId, seq }),
      async ({ edges, run, seq: at }) => {
        const expected = await oracle.ask("descendants", { edges: edges.map(edgeWire), run, seq: at })
        const actual = LineageTree.descendants(edges, run, { lineageId: "L", seq: at })
        expect({
          attached: actual.attached.map(edgeWire),
          detached: actual.detached.map(edgeWire),
          drained: true
        }).toEqual(expected)
        expect([...actual.attachedRunIds]).toEqual(actual.attached.map((each) => each.childRunId))
      }
    ))

  differential("a chain of attached children is walked to its end, and a detached child stops the walk", async () => {
    const chain: Array<LineageEdge> = [
      { parentRunId: "c", parentSeq: 0, childRunId: "d", kind: "child", attached: true },
      { parentRunId: "b", parentSeq: 0, childRunId: "c", kind: "fork", attached: false },
      { parentRunId: "a", parentSeq: 2, childRunId: "b", kind: "child", attached: true },
      { parentRunId: "b", parentSeq: 9, childRunId: "a", kind: "child", attached: true },
      { parentRunId: "a", parentSeq: 1, childRunId: "é/😺", kind: "child", attached: true }
    ]
    expect(await oracle.ask("descendants", { edges: chain.map(edgeWire), run: "a", seq: 1 })).toEqual({
      attached: [edgeWire(chain[2]!)],
      detached: [edgeWire(chain[1]!)],
      drained: true
    })
    const actual = LineageTree.descendants(chain, "a", { lineageId: "L", seq: 1 })
    expect(actual.attached).toEqual([chain[2]])
    expect(actual.detached).toEqual([chain[1]])
  })
})

describe("the memory store against its specification", () => {
  differential(
    "any sequence of rewinds, forks, reservations and appends leaves the same store",
    () =>
      check(scenario(6), async (input) => {
        await agrees(input)
      })
  )

  differential("rewinds over a dense lineage tree archive the same records under the same generations", () =>
    check(
      Arbitrary.map(
        Arbitrary.all({
          base: scenario(12),
          rewinds: list(Arbitrary.all([pick(["a", "b", "c"]), seq]), 5),
          probes: list(Arbitrary.all([runId, seq, pick([undefined, 0, 1, 2, 3])]), 4)
        }),
        ({ base, rewinds, probes }): Case => ({
          ...base,
          statuses: [],
          owners: owned(...runIds),
          steps: [
            ...rewinds.map(([run, at]): Step => ({
              do: "rewind",
              run,
              lineage: "L",
              seq: at,
              owner: 0,
              childOwners: []
            })),
            ...probes.map(([run, at, generation]): Step => ({ do: "archivedAt", run, seq: at, generation }))
          ]
        })
      ),
      async (input) => {
        const { answers } = await agrees(input)
        for (const each of answers.slice(0, input.steps.filter((one) => one.do === "rewind").length)) {
          expect(each).toHaveProperty("ok")
        }
      }
    ))

  differential("forks of a real journal copy the same prefix under the same minted ids", () =>
    check(
      Arbitrary.map(
        Arbitrary.all({
          length: int(0, 5),
          steps: list(
            Arbitrary.all({
              choice: int(0, 5),
              parent: pick(["a", "a", "a:fork:0:1", "a:fork:1:1", "a:fork:1:2", "b"]),
              seq,
              lineage: pick(lineages),
              child: pick([undefined, undefined, undefined, "n", "a"])
            }),
            7
          )
        }),
        ({ length, steps }): Case => ({
          records: journal("a", length),
          edges: [],
          live: [],
          statuses: [],
          owners: owned("a"),
          steps: steps.map(({ choice, parent, seq: at, lineage, child }): Step =>
            choice === 0
              ? { do: "reserve", parent, seq: at }
              : choice === 1
              ? { do: "rewind", run: "a", lineage, seq: at, owner: 0, childOwners: [] }
              : { do: "fork", parent, lineage, seq: at, child }
          )
        })
      ),
      async (input) => {
        await agrees(input)
      }
    ))
})

// --- the laws the specification proves, on the implementation -------------------------------------------------------

describe("the proved laws hold of the implementation", () => {
  differential("a rewind keeps a prefix of the journal and a second rewind to the frame archives nothing", async () => {
    const { answers, state } = await agrees({
      records: [...journal("a", 4), ...journal("b", 2)],
      edges: [
        { parentRunId: "a", parentSeq: 3, childRunId: "b", kind: "child", attached: true },
        { parentRunId: "a", parentSeq: 3, childRunId: "c", kind: "fork", attached: false }
      ],
      live: [],
      statuses: [["b", 0]],
      owners: owned("a", "b"),
      steps: [
        { do: "rewind", run: "a", lineage: "L", seq: 1, owner: 0, childOwners: [] },
        { do: "rewind", run: "a", lineage: "L", seq: 1, owner: 0, childOwners: [["b", 0]] },
        { do: "rewind", run: "a", lineage: "L", seq: 1, owner: 0, childOwners: [] },
        { do: "rewind", run: "a", lineage: "L", seq: 0, owner: 0, childOwners: [] },
        { do: "archivedAt", run: "a", seq: 2, generation: 0 },
        { do: "archivedAt", run: "a", seq: 1, generation: 0 },
        { do: "archivedAt", run: "a", seq: 1, generation: 2 },
        { do: "archivedAt", run: "b", seq: 1, generation: 0 }
      ]
    })
    expect(answers).toEqual([
      { error: "fence_lost" },
      { ok: { archived: 4, orphaned: [["a", 3, "c", "fork", false]] } },
      { ok: { archived: 0, orphaned: [["a", 3, "c", "fork", false]] } },
      { ok: { archived: 1, orphaned: [["a", 3, "c", "fork", false]] } },
      { ok: true },
      { ok: false },
      { ok: true },
      { ok: true }
    ])
    expect((state as { readonly records: ReadonlyArray<unknown> }).records).toEqual([rowWire(journal("a", 1)[0]!)])
  })

  differential("a fork copies the prefix, leaves the parent alone, and refuses a taken or live run", async () => {
    const { answers, state } = await agrees({
      records: journal("a", 3),
      edges: [],
      live: ["d"],
      statuses: [],
      owners: owned("a"),
      steps: [
        { do: "reserve", parent: "a", seq: 1 },
        { do: "fork", parent: "a", lineage: "L", seq: 1, child: undefined },
        { do: "fork", parent: "a", lineage: "L", seq: 1, child: "a:fork:1:1" },
        { do: "fork", parent: "a", lineage: "L", seq: 1, child: "a" },
        { do: "fork", parent: "a", lineage: "M", seq: 1, child: "n" },
        { do: "fork", parent: "a", lineage: "L", seq: 3, child: "n" },
        { do: "fork", parent: "d", lineage: "L", seq: 0, child: "n" },
        { do: "fork", parent: "a:fork:1:1", lineage: "L", seq: 2, child: undefined },
        { do: "append", record: { ...journal("a", 3)[2]!, eventId: "again" } },
        { do: "append", record: { ...journal("a", 4)[3]!, lineageId: undefined } }
      ]
    })
    expect(answers).toEqual([
      { ok: "a:fork:1:1" },
      { ok: "a:fork:1:2" },
      { ok: "a:fork:1:1" },
      { error: "invalid" },
      { error: "not_found" },
      { error: "not_found" },
      { error: "live_parent" },
      { ok: "a:fork:1:1:fork:2:1" },
      { error: "invalid" },
      { ok: null }
    ])
    const records = (state as { readonly records: ReadonlyArray<ReadonlyArray<unknown>> }).records
    expect(records.slice(0, 3)).toEqual(journal("a", 3).map(rowWire))
    expect(records.filter((record) => record[0] === "a:fork:1:2")).toEqual([
      ["a:fork:1:2", 0, "fork:a:fork:1:2:e0", "L", "x"],
      ["a:fork:1:2", 1, "fork:a:fork:1:2:e1", "L", "x"],
      ["a:fork:1:2", 2, "fork:a:fork:1:2:created", "L", forkCreatedEventType]
    ])
  })
})

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope")
    await expect(oracle.ask("descendants", { edges: "not edges", run: "a", seq: 0 })).rejects.toThrow(
      "the oracle refused"
    )
    expect(await oracle.ask("descendants", { edges: [], run: "a", seq: 0 })).toEqual({
      attached: [],
      detached: [],
      drained: true
    })
  })

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(4 * executions)
  })
})
