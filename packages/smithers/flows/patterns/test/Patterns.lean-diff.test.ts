/**
 * The operational patterns against their Lean 4 reference specification (`spec/lean/patterns`), generated: every case
 * is run by the implementation and answered by the specification's compiled oracle, and the two must agree exactly on
 * the call trace and on the settled outcome.
 *
 * - Saga: the forward chain, the reversed unwind, the residue, and all three policies, on failure, defect and
 *   interruption.
 * - Bounded: the first refusal, the priority ranking, the sliding window of `run` and the batches of `all`.
 * - Quarantine: both policies, and `settle`.
 * - ReviewLoop: the round bound and the stall breaker over all three signals.
 * - Escalation: the three deciders, the fallback and exhaustion.
 * - Intervene: the approval gate and the dry run.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A name crosses as its UTF-16 code units, so a lone surrogate arrives as it left.
 *
 * A machine with `lake` builds the oracle first, and builds it again when a source of the specification is newer than
 * it. A machine without `lake` runs a built oracle only when it is at least as new as every source of the
 * specification; a missing or older oracle skips the file under a named reason, never a pass against another
 * specification.
 */
import { Flow, Graph } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as Node from "@smthrs/plan/Node"
import { Arbitrary, Cause, Deferred, Effect, Exit, Fiber, Logger, Schema } from "effect"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Bounded, Escalation, Intervene, PatternError, Quarantine, ReviewLoop, Saga } from "../src/index.ts"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "patterns")
const binary = join(specDir, ".lake", "build", "bin", "patterns-spec")
const elan = join(homedir(), ".elan", "bin")
const lake = [...(process.env["PATH"] ?? "").split(delimiter).filter((directory) => directory !== ""), elan]
  .map((directory) => join(directory, "lake"))
  .find((path) => existsSync(path))
/** The specification's sources are here and `lake` can build them. A confined run may be shown neither. */
const buildable = lake !== undefined && existsSync(join(specDir, "lakefile.toml"))

/** The specification's sources, relative to its directory, or `undefined` when this run cannot see them all. */
const specSources = (): ReadonlyArray<string> | undefined => {
  const listed = ["Main.lean", "PatternsSpec.lean", "lakefile.toml", "lean-toolchain"]
  if (!existsSync(join(specDir, "PatternsSpec"))) return undefined
  const sources = [...listed, ...readdirSync(join(specDir, "PatternsSpec")).map((name) => join("PatternsSpec", name))]
  return sources.every((source) => existsSync(join(specDir, source))) ? sources : undefined
}

/**
 * True when a source of the specification is newer than the built oracle, there is no built oracle, or the sources
 * cannot all be seen, so the oracle's freshness cannot be shown.
 */
const stale = (): boolean => {
  const sources = specSources()
  if (!existsSync(binary) || sources === undefined) return true
  const built = statSync(binary).mtimeMs
  return sources.some((source) => statSync(join(specDir, source)).mtimeMs > built)
}

/** Why the differential cannot run here, or `undefined` when it can. */
const unavailable: string | undefined = buildable
  ? undefined
  : !existsSync(binary)
  ? "no built oracle and no `lake` to build one"
  : stale()
  ? "the built oracle is older than its specification (or the specification is not visible) and no `lake` can rebuild it"
  : undefined
const oracleReady = unavailable === undefined
const differential = it.skipIf(!oracleReady)
if (unavailable !== undefined) it.skip(`Lean differential evidence unavailable: ${unavailable}`, () => {})

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
}, 180_000)

afterAll(() => {
  if (oracleReady) oracle.close()
})

// --- the wire -------------------------------------------------------------------------------------------------------

type Units = ReadonlyArray<number>

/** A text as its UTF-16 code units. */
const units = (text: string): Array<number> => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))

/**
 * A number option as the oracle reads it: a finite number is itself, so a fraction and an unsafe integer arrive
 * exactly, and anything else is its name, which the oracle reads as not a number.
 */
const wireNum = (value: unknown): number | string =>
  typeof value === "number" && Number.isFinite(value) ? value : `${typeof value}:${String(value)}`

/** A decision value as the oracle reads it. */
type Wire =
  | readonly ["u"]
  | readonly ["n"]
  | readonly ["b", boolean]
  | readonly ["i", number]
  | readonly ["s", string]
  | readonly ["o", ReadonlyArray<readonly [string, Wire]>]

/** The JavaScript value a wire value describes. A later field shadows an earlier one of the same key. */
const real = (wire: Wire): unknown => {
  switch (wire[0]) {
    case "u":
      return undefined
    case "n":
      return null
    case "o":
      return Object.fromEntries(wire[1].map(([key, value]) => [key, real(value)]))
    default:
      return wire[1]
  }
}

/** JSON with every object's keys in order, so two answers are compared by content. */
const canon = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : inner)

// --- the harness ----------------------------------------------------------------------------------------------------

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const executions = Math.max(25, Math.min(baseExecutions, 150))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

/** A violated agreement, as the message a counterexample is reported with. */
type Violation = string | undefined

/** Runs a property whose body returns the first disagreement; the report names it beside the shrunk input. */
const holds = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  body: (input: A) => Effect.Effect<Violation>,
  offset: number
): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(
      arbitrary,
      (input) =>
        Effect.flatMap(
          body(input),
          (violation) => violation === undefined ? Effect.succeed(true) : Effect.fail(violation)
        ),
      { seed: seed + offset, executions }
    ).pipe(Effect.provide(Logger.layer([])))
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const ask = (op: string, request: Readonly<Record<string, unknown>>): Effect.Effect<unknown> =>
  Effect.promise(() => oracle.ask(op, request))

/** The disagreement between the implementation's answer and the specification's, if any. */
const agree = (
  op: string,
  request: Readonly<Record<string, unknown>>,
  observed: unknown
): Effect.Effect<Violation> =>
  Effect.map(
    ask(op, request),
    (expected) =>
      canon(observed) === canon(expected)
        ? undefined
        : `${op} ${canon(request)}\n  implementation: ${canon(observed)}\n  specification:  ${canon(expected)}`
  )

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return undefined
  const found = Cause.findErrorOption(exit.cause)
  return found._tag === "Some" ? found.value : undefined
}

const defectOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isSuccess(exit) ? undefined : exit.cause.reasons.find(Cause.isDieReason)?.defect

/** What is between the first and the last double quote of a refusal's message: the member it names. */
const quoted = (message: string): string => message.slice(message.indexOf("\"") + 1, message.lastIndexOf("\""))

/** Yields `count` scheduler turns, so concurrent members really overlap. */
const turns = (count: number): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (let turn = 0; turn < count; turn++) yield* Effect.yieldNow
  })

/** Tracks how many members are in flight and the most that ever were. */
const gauge = () => {
  let live = 0
  let peak = 0
  return {
    peak: () => peak,
    track: <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          live += 1
          peak = Math.max(peak, live)
        }),
        () => effect,
        () =>
          Effect.sync(() => {
            live -= 1
          })
      )
  }
}

// --- generators -----------------------------------------------------------------------------------------------------

const small = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

/** A leaf of a decision value: every reading the deciders distinguish, and near misses of each. */
const leaves: ReadonlyArray<Wire> = [
  ["u"],
  ["n"],
  ["b", true],
  ["b", false],
  ["i", 0],
  ["i", 1],
  ["s", "approved"],
  ["s", "Approved"],
  ["s", "approved "],
  ["s", ""],
  ["s", "denied"],
  ["s", "true"],
  ["o", []],
  ["o", [["approved", ["b", true]]]]
]

const fieldKeys = ["approved", "accepted", "error", "failed", "ok", "value"] as const

/** A generated decision value: a leaf, or an object of up to four fields whose keys may repeat. */
const ValueShape = Schema.Struct({
  leaf: small(0, leaves.length - 1),
  object: Schema.Boolean,
  fields: Schema.Array(Schema.Struct({ key: Schema.Literals(fieldKeys), leaf: small(0, leaves.length - 1) }))
})

const wireOf = (shape: typeof ValueShape.Type): Wire =>
  shape.object
    ? ["o", shape.fields.slice(0, 4).map((field) => [field.key, leaves[field.leaf]!] as const)]
    : leaves[shape.leaf]!

// Names that collide with `Object.prototype` or carry non-BMP, NUL, separator and lone-surrogate characters. None is
// an integer index, so a record keeps them in insertion order.
const hostileNames = [
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "a\0b",
  "../up",
  "\u{1F600}",
  "\uD83D",
  "￿",
  "",
  " ",
  "é",
  "é",
  "Z",
  "a",
  "aa",
  "b"
] as const

const HostileName = Schema.Literals(hostileNames)

/** Distinct member names: the generated ones, deduplicated, in order. */
const distinct = <A extends { readonly name: string }>(members: ReadonlyArray<A>): ReadonlyArray<A> => {
  const seen = new Set<string>()
  return members.filter((member) => !seen.has(member.name) && seen.add(member.name) !== undefined)
}

/** A record with one own data property per entry, whatever the name. */
const record = <A>(entries: ReadonlyArray<readonly [string, A]>): Record<string, A> => Object.fromEntries(entries)

/** Width bounds: the usual ones, then every kind of value the refusal must catch. */
const widths = [1, 2, 3, 4, 5, 1, 2, 3, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53] as const

/** Priorities: the usual ones, both ends of the safe range, then every kind of value the refusal must catch. */
const priorityValues: ReadonlyArray<unknown> = [
  0,
  1,
  -1,
  2,
  -2,
  3,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  -0,
  1,
  2,
  1.5,
  Number.NaN,
  Number.NEGATIVE_INFINITY,
  2 ** 53,
  "3",
  undefined
]

// --- Saga -----------------------------------------------------------------------------------------------------------

// Step ids of ASCII digits and lowercase letters, a letter first: over this alphabet `localeCompare`, which orders
// the residue, is the code-unit order the specification sorts by, and no id is an integer index.
const stepIds = ["a", "b", "ab", "a0", "z9", "aa", "b1", "c", "zz", "m0m"] as const
const suffixes = "abcdefgh"

const SagaCase = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.Literals(stepIds),
      action: Schema.Literals(["ok", "ok", "ok", "ok", "fail", "die"]),
      undo: Schema.Literals(["ok", "ok", "fail", "die", "throw"]),
      sealed: Schema.Boolean
    })
  ),
  /** Usually the ids are made distinct; otherwise a repeat must be refused. */
  repeats: small(0, 4),
  /** The step an interruption lands in, when it is one of the steps. */
  interruptAt: small(-6, 7),
  onFailure: Schema.Literals(["compensate", "compensate-and-fail", "fail", "default"])
})

interface SagaStep {
  readonly id: string
  readonly action: "ok" | "fail" | "die" | "interrupt"
  readonly undo: "ok" | "fail" | "die" | "throw"
  readonly sealed: boolean
}

const sagaSteps = (input: typeof SagaCase.Type): ReadonlyArray<SagaStep> =>
  input.steps.slice(0, 7).map((step, index) => ({
    id: input.repeats === 0 ? step.id : `${step.id}${suffixes[index]!}`,
    action: index === input.interruptAt ? "interrupt" : step.action,
    undo: step.undo,
    sealed: step.sealed
  }))

/** Runs the real saga over scripted steps, interrupting it inside an `interrupt` action. */
const sagaObserved = (
  scripts: ReadonlyArray<SagaStep>,
  onFailure: "compensate" | "compensate-and-fail" | "fail" | "default"
): Effect.Effect<{ readonly observed: unknown; readonly violation: Violation }> =>
  Effect.gen(function*() {
    const started: Array<Units> = []
    const unwound: Array<Units> = []
    const logged: Array<string> = []
    let violation: Violation
    const entered = yield* Deferred.make<void>()
    const steps = scripts.map((script, index): Saga.RuntimeStep<string, number, string, never, string, never> => ({
      id: script.id,
      uninterruptible: script.sealed,
      action: ({ completed, input }) =>
        Effect.gen(function*() {
          started.push(units(script.id))
          // A step sees its input and exactly the values of the steps before it.
          const expected = scripts.slice(0, index).map((before, at) => [before.id, at * 10])
          if (input !== "world" || canon(Object.entries(completed)) !== canon(expected)) {
            violation = `step ${index} saw ${canon(completed)}`
          }
          if (script.action === "fail") return yield* Effect.fail(`action:${script.id}`)
          if (script.action === "die") return yield* Effect.die(`defect:${script.id}`)
          if (script.action === "interrupt") {
            yield* Deferred.succeed(entered, undefined)
            // A sealed step finishes and registers its undo as one unit; any other is cut off here.
            if (!script.sealed) return yield* Effect.never
            yield* turns(4)
          }
          return index * 10
        }),
      compensation: (args) => {
        unwound.push(units(args.id))
        if (args.id !== script.id || args.input !== "world" || args.value !== index * 10) {
          violation = `the compensation of ${script.id} was given ${canon(args)}`
        }
        if (script.undo === "throw") throw new Error(`threw:${script.id}`)
        if (script.undo === "fail") return Effect.fail(`undo:${script.id}`)
        if (script.undo === "die") return Effect.die(`undo-defect:${script.id}`)
        return Effect.yieldNow
      }
    }))
    const logger = Logger.make<unknown, void>((entry) => {
      logged.push(JSON.stringify(entry.message))
    })
    const fiber = yield* Effect.forkChild(
      Saga.run("world", onFailure === "default" ? { steps } : { steps, onFailure }).pipe(
        Effect.provide(Logger.layer([logger]))
      )
    )
    yield* Effect.raceFirst(Deferred.await(entered), Fiber.await(fiber))
    const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))

    const stepOf = (text: unknown, prefix: string): Units | string =>
      typeof text === "string" && text.startsWith(prefix) ? units(text.slice(prefix.length)) : `unreadable ${text}`
    const outcome = (): unknown => {
      if (Exit.isSuccess(exit)) {
        if (exit.value._tag === "Compensated") {
          return { tag: "compensated", failure: stepOf(exit.value.failure, "action:") }
        }
        const values = Object.entries(exit.value.values)
        if (values.some(([id, value]) => scripts.findIndex((script) => script.id === id) * 10 !== value)) {
          violation = `completed values ${canon(exit.value.values)}`
        }
        return { tag: "completed", values: values.map(([id]) => units(id)) }
      }
      if (Exit.hasInterrupts(exit)) {
        const marker = "Saga compensation failed on interruption for: "
        const lines = logged.filter((line) => line.includes(marker))
        if (lines.length > 1) violation = `logged the residue ${lines.length} times`
        const ids = lines.length === 0
          ? []
          : (JSON.parse(lines[0]!) as ReadonlyArray<string>).join("").split(marker)[1]!.split(", ")
        return { tag: "interrupted", reported: ids.map(units) }
      }
      const error = failureOf(exit)
      if (error instanceof PatternError.PatternError) {
        if (error.code === "compensation_failed") {
          const cause = error.cause as {
            readonly failure?: unknown
            readonly residue: ReadonlyArray<{ readonly id: string; readonly error: unknown }>
          }
          if (!cause.residue.every((entry) => error.message.includes(entry.id))) {
            violation = `the message omits a residue id: ${error.message}`
          }
          return {
            tag: "dirty",
            residue: cause.residue.map((entry) => units(entry.id)),
            failure: "failure" in cause ? stepOf(cause.failure, "action:") : null
          }
        }
        return { tag: "refused", reason: error.message.includes("unique") ? "duplicate" : "empty", code: error.code }
      }
      if (error !== undefined) return { tag: "failed", failure: stepOf(error, "action:") }
      return { tag: "died", defect: stepOf(defectOf(exit), "defect:") }
    }
    const settled = outcome()
    return { observed: { started, unwound, outcome: settled }, violation }
  })

const sagaAgrees = (
  scripts: ReadonlyArray<SagaStep>,
  onFailure: "compensate" | "compensate-and-fail" | "fail" | "default"
): Effect.Effect<Violation> =>
  Effect.gen(function*() {
    const { observed, violation } = yield* sagaObserved(scripts, onFailure)
    if (violation !== undefined) return violation
    const expected = yield* ask("saga", {
      policy: onFailure === "default" ? "compensate" : onFailure,
      steps: scripts.map((script) => [units(script.id), script.action, script.undo, script.sealed])
    }) as Effect.Effect<{ readonly outcome: { readonly tag: string } }>
    // A refusal carries its code on the implementation's side only.
    const withCode = expected.outcome.tag === "refused"
      ? { ...expected, outcome: { ...expected.outcome, code: "invalid_decorator" } }
      : expected
    return canon(observed) === canon(withCode)
      ? undefined
      : `saga ${onFailure} ${canon(scripts)}\n  implementation: ${canon(observed)}\n  specification:  ${
        canon(withCode)
      }`
  })

// --- Bounded --------------------------------------------------------------------------------------------------------

const BoundedCase = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      name: HostileName,
      priority: small(0, priorityValues.length - 1),
      explicit: Schema.Boolean,
      fails: small(0, 5)
    })
  ),
  concurrency: small(0, widths.length - 1),
  /** The shared `priority` option; the last index leaves it out. */
  fallback: small(0, priorityValues.length + 6),
  /** Priorities for names that may not be members. */
  strays: Schema.Array(HostileName),
  /** Leaves `priorities` out when it would be empty. */
  bare: Schema.Boolean
})

interface BoundedScript {
  readonly names: ReadonlyArray<string>
  readonly priorities: Readonly<Record<string, unknown>> | undefined
  readonly fallback: unknown
  readonly concurrency: number
  readonly failing: ReadonlyArray<string>
}

const boundedScript = (input: typeof BoundedCase.Type): BoundedScript => {
  const members = distinct(input.members.slice(0, 8))
  // Mostly safe integers: one generated refusal in a few cases, not in every case.
  const priorityOf = (index: number, salt: number): unknown =>
    priorityValues[index >= 11 && salt % 3 !== 0 ? index - 11 : index]
  const entries: Array<readonly [string, unknown]> = [
    ...members.filter((member) => member.explicit).map((member, at) =>
      [member.name, priorityOf(member.priority, at)] as const
    ),
    ...input.strays.slice(0, input.strays.length % 3 === 1 ? 2 : 0).map((name) => [name, 1] as const)
  ]
  return {
    names: members.map((member) => member.name),
    priorities: entries.length === 0 && input.bare ? undefined : record(entries),
    fallback: input.fallback >= priorityValues.length - 1 ? undefined : priorityValues[input.fallback],
    concurrency: widths[input.concurrency]!,
    failing: members.filter((member) => member.fails === 0).map((member) => member.name)
  }
}

const boundedRequest = (script: BoundedScript): Readonly<Record<string, unknown>> => ({
  members: script.names.map(units),
  priorities: Object.entries(script.priorities ?? {}).map(([name, value]) => [units(name), wireNum(value)]),
  ...(script.fallback === undefined ? {} : { fallback: wireNum(script.fallback) }),
  concurrency: wireNum(script.concurrency),
  failing: script.failing.map(units)
})

const boundedRefusal = (error: PatternError.PatternError): unknown => {
  const message = error.message
  if (error.code !== "invalid_decorator") return { tag: "refused", reason: `code ${error.code}` }
  if (message.includes("concurrency must be")) return { tag: "refused", reason: "width" }
  if (message.includes("at least one member")) return { tag: "refused", reason: "empty" }
  if (message.includes("unknown member")) return { tag: "refused", reason: "unknown", name: units(quoted(message)) }
  if (message.includes("must be a safe integer")) {
    return { tag: "refused", reason: "priority", name: units(quoted(message.split(" must be a safe integer")[0]!)) }
  }
  return { tag: "refused", reason: message }
}

const worker = Flow.make("lean-diff/worker", {
  payload: { input: Schema.Unknown },
  success: Schema.Unknown,
  body: ({ input }) => Node.succeed(input)
})

/** The batches `Bounded.all` declares, read off the built graph: the members under each join, in plan order. */
const declaredBatches = (script: BoundedScript): ReadonlyArray<ReadonlyArray<Units>> => {
  const members = record(script.names.map((name) => {
    const call = worker.call({ input: name }) as Node.Any
    const own = script.priorities !== undefined && Object.hasOwn(script.priorities, name)
    return [name, own ? Node.priority(call, script.priorities![name] as number) : call] as const
  }))
  const node = Bounded.all(members, {
    concurrency: script.concurrency,
    ...(script.fallback === undefined ? {} : { priority: script.fallback as number })
  })
  const graph = Graph.build(
    Flow.make("lean-diff/host", { payload: { input: Schema.Unknown }, success: Schema.Unknown, body: () => node }),
    { input: undefined }
  )
  const batches = new Map<string, Array<Units>>()
  for (const planned of Graph.nodes(graph)) {
    const at = planned.id.lastIndexOf(".all.")
    if (planned.kind !== "FlowCall" || at === -1) continue
    const join = planned.id.slice(0, at)
    batches.set(join, [...(batches.get(join) ?? []), units(planned.id.slice(at + ".all.".length))])
  }
  return [...batches.values()]
}

const boundedAgrees = (script: BoundedScript): Effect.Effect<Violation> =>
  Effect.gen(function*() {
    const started: Array<Units> = []
    const width = gauge()
    const members = record(script.names.map((name) =>
      [
        name,
        width.track(Effect.gen(function*() {
          started.push(units(name))
          // Every member holds its slot for the same time, so the window slides one member at a time.
          yield* turns(2)
          if (script.failing.includes(name)) return yield* Effect.fail(`failed:${name}`)
          return `value:${name}`
        }))
      ] as const
    ))
    const exit = yield* Effect.exit(Bounded.run(members, {
      concurrency: script.concurrency,
      ...(script.fallback === undefined ? {} : { priority: script.fallback as number }),
      ...(script.priorities === undefined ? {} : { priorities: script.priorities as Record<string, number> })
    }))
    const request = boundedRequest(script)
    const expected = (yield* ask("bounded", request)) as {
      readonly batches: ReadonlyArray<ReadonlyArray<Units>>
      readonly outcome: { readonly tag: string }
    }
    const error = failureOf(exit)
    const outcome = Exit.isSuccess(exit)
      ? Object.entries(exit.value).every(([name, value]) => value === `value:${name}`)
        ? { tag: "joined", names: Object.keys(exit.value).map(units) }
        : { tag: "joined", values: exit.value }
      : error instanceof PatternError.PatternError
      ? boundedRefusal(error)
      : { tag: "failed", name: units(String(error).slice("failed:".length)) }
    const observed = { started, peak: width.peak(), batches: expected.batches, outcome }
    if (canon(observed) !== canon(expected)) {
      return `bounded ${canon(request)}\n  implementation: ${canon(observed)}\n  specification:  ${canon(expected)}`
    }
    // The declared form cuts the same ranking into batches. It reads a priority off the member node, and a node
    // takes only a safe integer, so it is compared when the operational form was not refused for a priority.
    if (expected.outcome.tag === "refused") return undefined
    const batches = declaredBatches(script)
    return canon(batches) === canon(expected.batches)
      ? undefined
      : `bounded batches ${canon(request)}\n  implementation: ${canon(batches)}\n  specification:  ${
        canon(expected.batches)
      }`
  })

// --- Quarantine -----------------------------------------------------------------------------------------------------

const QuarantineCase = Schema.Struct({
  members: Schema.Array(Schema.Struct({ name: HostileName, fails: small(0, 3) })),
  policy: Schema.Literals(["quarantine", "halt"]),
  /** The last index is `"unbounded"`, the one before leaves the option out. */
  concurrency: small(0, widths.length + 1)
})

const quarantineAgrees = (input: typeof QuarantineCase.Type): Effect.Effect<Violation> =>
  Effect.gen(function*() {
    const scripts = distinct(input.members.slice(0, 8)).map((member) => ({
      name: member.name,
      fails: member.fails === 0
    }))
    const concurrency: number | "unbounded" | undefined = input.concurrency === widths.length + 1
      ? "unbounded"
      : widths[input.concurrency]
    const started: Array<Units> = []
    const members = record(scripts.map((script) =>
      [
        script.name,
        Effect.gen(function*() {
          started.push(units(script.name))
          yield* turns(2)
          if (script.fails) return yield* Effect.fail(`failed:${script.name}`)
          return `value:${script.name}`
        })
      ] as const
    ))
    const options = concurrency === undefined ? {} : { concurrency }
    const joined: Effect.Effect<Readonly<Record<string, unknown>>, unknown> = input.policy === "quarantine"
      ? Quarantine.run(members, { policy: "quarantine", ...options })
      : Quarantine.run(members, { policy: "halt", ...options })
    const exit = yield* Effect.exit(joined)
    const error = failureOf(exit)
    const entry = (name: string, settled: unknown): unknown => {
      const envelope = settled as Quarantine.Settled<string, string>
      if (envelope.member !== name) return ["misnamed", units(name)]
      if (Quarantine.isSucceeded(envelope)) {
        return [envelope.value === `value:${name}` ? "succeeded" : "wrong", units(name)]
      }
      return [envelope.error === `failed:${name}` ? "quarantined" : "wrong", units(name)]
    }
    const outcome = Exit.isSuccess(exit)
      ? input.policy === "quarantine"
        ? {
          tag: "settled",
          entries: Object.entries(exit.value).map(([name, settled]) => entry(name, settled))
        }
        : Object.entries(exit.value).every(([name, value]) => value === `value:${name}`)
        ? { tag: "joined", names: Object.keys(exit.value).map(units) }
        : { tag: "joined", values: exit.value }
      : error instanceof PatternError.PatternError
      ? { tag: "refused", reason: error.message.includes("at least one member") ? "empty" : "width", code: error.code }
      : { tag: "failed", name: units(String(error).slice("failed:".length)) }
    const expected = (yield* ask("quarantine", {
      members: scripts.map((script) => [units(script.name), script.fails]),
      policy: input.policy,
      ...(concurrency === undefined || concurrency === "unbounded" ? {} : { concurrency: wireNum(concurrency) })
    })) as { readonly outcome: { readonly tag: string } }
    const withCode = expected.outcome.tag === "refused"
      ? { ...expected, outcome: { ...expected.outcome, code: "invalid_decorator" } }
      : expected
    const observed = { started, outcome }
    return canon(observed) === canon(withCode)
      ? undefined
      : `quarantine ${canon(input)}\n  implementation: ${canon(observed)}\n  specification:  ${canon(withCode)}`
  })

const SettleCase = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      name: HostileName,
      kind: Schema.Literals(["succeeded", "succeeded", "succeeded", "quarantined", "invalid"]),
      /** Which near miss of an envelope an invalid entry is. */
      shape: small(0, 4)
    })
  )
})

/** Values that are not an envelope: a raw value, a wrong tag, a missing or extra field, a non-text member. */
const nearMisses = (name: string): ReadonlyArray<unknown> => [
  `value:${name}`,
  { _tag: "Settled", member: name, value: 1 },
  { _tag: "Succeeded", member: name },
  { _tag: "Quarantined", member: name, error: "e", value: 1 },
  { _tag: "Succeeded", member: 7, value: 1 }
]

const settleAgrees = (input: typeof SettleCase.Type): Effect.Effect<Violation> =>
  Effect.gen(function*() {
    const scripts = distinct(input.entries.slice(0, 8))
    const result = record(scripts.map((script) =>
      [
        script.name,
        script.kind === "succeeded"
          // A value shaped like a quarantine envelope is still a value.
          ? { _tag: "Succeeded", member: script.name, value: { _tag: "Quarantined", member: script.name, error: 1 } }
          : script.kind === "quarantined"
          ? { _tag: "Quarantined", member: script.name, error: `failed:${script.name}` }
          : nearMisses(script.name)[script.shape]
      ] as const
    ))
    const exit = yield* Effect.exit(Quarantine.settle(result as Record<string, Quarantine.Settled<unknown, string>>))
    const error = failureOf(exit)
    const named = (message: string, prefix: string): ReadonlyArray<string> =>
      // The names are joined with ", " and none of the generated names holds one.
      message.startsWith(prefix) ? message.slice(prefix.length).split(", ") : [`unreadable ${message}`]
    const observed = Exit.isSuccess(exit)
      ? { tag: "values", names: Object.keys(exit.value).map(units) }
      : error instanceof PatternError.PatternError && error.code === "invalid_input"
      ? { tag: "invalid", names: named(error.message, "Invalid quarantine outcomes: ").map(units) }
      : error instanceof PatternError.PatternError && error.code === "quarantined"
      ? {
        tag: "quarantined",
        names: (error.cause as ReadonlyArray<{ readonly member: string; readonly error: unknown }>).map((each) =>
          each.error === `failed:${each.member}` &&
            canon(named(error.message, "Quarantined members: ")) ===
              canon((error.cause as ReadonlyArray<{ readonly member: string }>).map((entry) => entry.member))
            ? units(each.member)
            : "wrong"
        )
      }
      : { tag: "unreadable" }
    return yield* agree("settle", { entries: scripts.map((script) => [units(script.name), script.kind]) }, observed)
  })

// --- ReviewLoop -----------------------------------------------------------------------------------------------------

const maxRoundsValues = [1, 2, 3, 4, 5, 6, 7, 3, 5, 0, -1, 1.5, Number.NaN, 2 ** 53] as const
const stallRoundsValues = [2, 2, 3, 3, 4, 2, 3, 1, 0, 2.5, Number.NaN, 2 ** 53] as const

const ReviewCase = Schema.Struct({
  maxRounds: small(0, maxRoundsValues.length - 1),
  /** Whether there is a stall option at all. */
  breaker: small(0, 3),
  stallRounds: small(0, stallRoundsValues.length - 1),
  on: Schema.Literals(["default", "stop", "park", "escalate"]),
  /** The stall option names its own signals; otherwise a round's whole output is compared. */
  custom: Schema.Boolean,
  rounds: Schema.Array(
    Schema.Struct({
      review: ValueShape,
      /** Most reviews refuse, so a loop usually lasts. */
      refuses: small(0, 5),
      tree: small(-1, 1),
      checks: Schema.Array(small(0, 2)),
      /** -2: an output with no canonical form; -1: none; otherwise the output's key. */
      output: small(-2, 1)
    })
  )
})

const reviewAgrees = (input: typeof ReviewCase.Type): Effect.Effect<Violation> =>
  Effect.gen(function*() {
    const maxRounds = maxRoundsValues[input.maxRounds]!
    const length = Math.max(Number.isSafeInteger(maxRounds) && maxRounds < 10 ? maxRounds : 0, 1)
    // One scripted round per round the bound allows; a round the generator did not script refuses and repeats.
    const rounds = Array.from({ length }, (_, index) => {
      const round = input.rounds[index]
      const review: Wire = round === undefined || round.refuses !== 0 ? ["s", "revise"] : wireOf(round.review)
      const checks = (round?.checks ?? []).slice(0, 3)
      const tree = round?.tree ?? -1
      const output = round?.output ?? 0
      return input.custom
        ? { review, tree: tree === -1 ? null : tree, checks, output: output < 0 ? null : output, raw: output }
        // The whole output is the signal: `{ key }` is equal exactly when the key is.
        : { review, tree: null, checks: [], output: output + 2, raw: output }
    })
    const outputs = rounds.map((round) => ({ key: round.raw + 2 }))
    const stalls = input.breaker !== 0
    const stall = !stalls ? undefined : {
      rounds: stallRoundsValues[input.stallRounds]!,
      ...(input.on === "default" ? {} : { on: input.on }),
      ...(input.custom
        ? {
          signals: (output: { readonly key: number }) => {
            const round = rounds[outputs.indexOf(output)]!
            return {
              ...(round.tree === null ? {} : { tree: `t${round.tree}` }),
              ...(round.checks.length === 0 && round.raw === -1
                ? {}
                : { checks: round.checks.map((check) => `c${check}`) }),
              ...(round.raw === -1 ? {} : { output: round.raw === -2 ? 1n : round.raw })
            }
          }
        }
        : {})
    }
    let reviews = 0
    let produced = 0
    let violation: Violation
    const reviewed: Array<unknown> = []
    const exit = yield* Effect.exit(ReviewLoop.run("brief", {
      maxRounds,
      ...(stall === undefined ? {} : { stall }),
      produce: (brief: string) =>
        Effect.sync(() => {
          produced += 1
          if (brief !== "brief") violation = `produce was given ${brief}`
          return outputs[0]!
        }),
      review: (output: { readonly key: number }, round: number) =>
        Effect.sync(() => {
          if (output !== outputs[reviews] || round !== reviews + 1) {
            violation = `review ${reviews + 1} saw round ${round}`
          }
          const review = real(rounds[reviews]!.review)
          reviews += 1
          reviewed.push(review)
          return review
        }),
      revise: ({ output, review, round }) =>
        Effect.sync(() => {
          if (output !== outputs[round - 1] || round !== reviews || review !== reviewed[round - 1]) {
            violation = `revise saw round ${round} after ${reviews} reviews`
          }
          return outputs[round]!
        })
    }))
    const error = failureOf(exit)
    const held = (settled: { readonly output: unknown; readonly review?: unknown }, reviewHeld: boolean): boolean =>
      settled.output === outputs[reviews - 1] && (!reviewHeld || settled.review === reviewed[reviews - 1])
    const verdict = Exit.isSuccess(exit)
      ? exit.value._tag === "Approved"
        ? { tag: held(exit.value, false) ? "approved" : "approved the wrong output" }
        : exit.value._tag === "Exhausted"
        ? { tag: held(exit.value, true) ? "exhausted" : "exhausted with the wrong output" }
        : {
          tag: held(exit.value, true) && exit.value.stalled._tag === "Stalled" ? "stalled" : "stalled wrongly",
          signal: exit.value.stalled.signal,
          rounds: exit.value.stalled.rounds,
          on: exit.value.stalled.on
        }
      : !(error instanceof PatternError.PatternError)
      ? { tag: "unreadable" }
      : error.code === "stalled"
      ? { tag: "escalated", rounds: Number(/for (\d+) rounds in a row/.exec(error.message)?.[1]) }
      : error.code === "invalid_decorator" && produced === 0
      ? { tag: "refused", reason: error.message.includes("maxRounds") ? "maxRounds" : "stall" }
      : { tag: `code ${error.code}` }
    if (violation !== undefined) return violation
    return yield* agree(
      "reviewLoop",
      {
        maxRounds: wireNum(maxRounds),
        ...(stall === undefined ? {} : {
          stall: { rounds: wireNum(stall.rounds), ...(input.on === "default" ? {} : { on: input.on }) }
        }),
        rounds: rounds.map((round) => [round.review, round.tree, round.checks, round.output])
      },
      { round: reviews, verdict }
    )
  })

// --- Escalation -----------------------------------------------------------------------------------------------------

const EscalationCase = Schema.Struct({
  rungs: Schema.Array(
    Schema.Struct({
      result: ValueShape,
      /** Whether the rung names its own `escalateIf`. */
      predicate: small(0, 2),
      answer: ValueShape,
      decision: ValueShape,
      /** A rung with no predicate may be a bare function. */
      bare: Schema.Boolean
    })
  ),
  accept: Schema.Boolean,
  fallback: Schema.Boolean
})

const escalationAgrees = (input: typeof EscalationCase.Type): Effect.Effect<Violation> =>
  Effect.gen(function*() {
    const scripts = input.rungs.slice(0, 6).map((rung) => ({
      result: wireOf(rung.result),
      escalateIf: rung.predicate === 0 ? wireOf(rung.answer) : null,
      decision: wireOf(rung.decision),
      bare: rung.bare
    }))
    const results = scripts.map((script) => real(script.result))
    const marker = { fallback: true }
    let ran = 0
    let fellBack = 0
    let violation: Violation
    const predicated: Array<number> = []
    const asked: Array<number> = []
    const rungs = scripts.map((script, index) => {
      const run = (brief: string) =>
        Effect.sync(() => {
          if (brief !== "brief" || ran !== index) violation = `rung ${index} ran out of order`
          ran += 1
          return results[index]
        })
      if (script.escalateIf === null) return script.bare ? run : { run }
      return {
        run,
        escalateIf: (result: unknown, level: number) =>
          Effect.sync(() => {
            if (!Object.is(result, results[index]) || level !== index) {
              violation = `escalateIf ${index} saw level ${level}`
            }
            predicated.push(level)
            // The reader compares against `false`, so any other answer escalates.
            return real(script.escalateIf!) as boolean
          })
      }
    })
    const exit = yield* Effect.exit(Escalation.run("brief", {
      rungs,
      ...(input.accept
        ? {
          accept: (result: unknown) =>
            Effect.sync(() => {
              if (!Object.is(result, results[ran - 1])) violation = `accept saw another rung's result`
              asked.push(ran - 1)
              return real(scripts[ran - 1]!.decision)
            })
        }
        : {}),
      ...(input.fallback
        ? {
          fallback: (brief: string) =>
            Effect.sync(() => {
              if (brief !== "brief") violation = `the fallback was given ${brief}`
              fellBack += 1
              return marker
            })
        }
        : {})
    }))
    const error = failureOf(exit)
    const outcome = Exit.isSuccess(exit)
      ? exit.value.exhausted
        ? {
          tag: Object.is(exit.value.result, results.at(-1)) && exit.value.accepted === false && fellBack === 0
            ? "exhausted"
            : "exhausted wrongly",
          level: exit.value.level
        }
        : exit.value.result === marker
        ? { tag: fellBack === 1 ? "reached" : "fell back twice", level: exit.value.level, fallback: true }
        : {
          tag: Object.is(exit.value.result, results[exit.value.level]) && fellBack === 0
            ? "reached"
            : "reached wrongly",
          level: exit.value.level,
          fallback: false
        }
      : error instanceof PatternError.PatternError && error.code === "invalid_decorator"
      ? { tag: "refused" }
      : { tag: "unreadable" }
    if (violation !== undefined) return violation
    return yield* agree(
      "escalation",
      {
        accept: input.accept,
        fallback: input.fallback,
        rungs: scripts.map((script) => [script.result, script.escalateIf, script.decision])
      },
      { ran, predicated, asked, outcome }
    )
  })

// --- Intervene ------------------------------------------------------------------------------------------------------

const phases = ["read", "propose", "approval", "apply", "report"] as const

const InterveneCase = Schema.Struct({
  dryRun: Schema.Boolean,
  /** Whether an approval is configured. */
  gated: small(0, 3),
  decision: ValueShape,
  /** Most approvals approve, so the gate opens as often as it shuts. */
  approves: Schema.Boolean,
  /** The phase that fails, when it is one of the phases. */
  failAt: small(0, 14)
})

const interveneAgrees = (input: typeof InterveneCase.Type): Effect.Effect<Violation> =>
  Effect.gen(function*() {
    const decision: Wire | null = input.gated === 0 ? null : input.approves ? ["s", "approved"] : wireOf(input.decision)
    const failAt = phases[input.failAt] ?? null
    const calls: Array<string> = []
    let violation: Violation
    const call = <A>(phase: typeof phases[number], seen: boolean, value: A): Effect.Effect<A, string> =>
      Effect.suspend(() => {
        calls.push(phase)
        if (!seen) violation = `${phase} was given the wrong arguments`
        return failAt === phase ? Effect.fail(`failed:${phase}`) : Effect.succeed(value)
      })
    const exit = yield* Effect.exit(Intervene.run("target", {
      dryRun: input.dryRun,
      read: (args) => call("read", args.phase === "read" && args.input === "target", "context"),
      propose: (args) =>
        call("propose", args.phase === "propose" && args.input === "target" && args.context === "context", "proposal"),
      ...(decision === null ? {} : {
        approval: (args: { readonly input: string; readonly proposal: string }) =>
          call("approval", args.input === "target" && args.proposal === "proposal", real(decision))
      }),
      apply: (args) =>
        call("apply", args.phase === "apply" && args.input === "target" && args.proposal === "proposal", "applied"),
      report: (args) =>
        call(
          "report",
          args.phase === "report" && args.input === "target" && args.proposal === "proposal" &&
            (args.applied === undefined || args.applied === "applied"),
          { applied: args.applied !== undefined, dryRun: args.dryRun }
        )
    }))
    const error = failureOf(exit)
    const outcome = Exit.isSuccess(exit)
      ? { tag: "reported", ...exit.value }
      : Schema.isSchemaError(error)
      ? { tag: "denied" }
      : typeof error === "string" && error.startsWith("failed:")
      ? { tag: "failed", phase: error.slice("failed:".length) }
      : { tag: "unreadable" }
    if (violation !== undefined) return violation
    return yield* agree("intervene", { dryRun: input.dryRun, approval: decision, failAt }, { calls, outcome })
  })

// --- the properties -------------------------------------------------------------------------------------------------

describe("Saga against the specification", () => {
  differential(
    "unwinds what the specification unwinds, for every policy, failure, defect and interruption",
    async () => {
      await holds(Arbitrary.schema(SagaCase), (input) => sagaAgrees(sagaSteps(input), input.onFailure), 0)
    }
  )

  differential("agrees on the fixed cases", async () => {
    const step = (id: string, action: SagaStep["action"], undo: SagaStep["undo"] = "ok", sealed = false): SagaStep => ({
      id,
      action,
      undo,
      sealed
    })
    const cases: ReadonlyArray<readonly [ReadonlyArray<SagaStep>, "compensate" | "compensate-and-fail" | "fail"]> = [
      [[], "compensate"],
      [[step("a", "ok"), step("a", "ok")], "compensate"],
      [[step("a", "ok"), step("b", "ok")], "compensate"],
      [[step("a", "ok"), step("b", "fail")], "compensate"],
      [[step("a", "ok"), step("b", "fail")], "compensate-and-fail"],
      [[step("a", "ok", "fail"), step("b", "fail")], "fail"],
      // Dirty state outranks the failure and the defect that started the unwind, sorted by id.
      [[step("z9", "ok", "throw"), step("b", "ok", "die"), step("a0", "ok", "fail"), step("c", "fail")], "compensate"],
      [[step("b", "ok", "fail"), step("a", "ok"), step("c", "die")], "compensate-and-fail"],
      // An interruption commits a sealed step and no other, and logs the residue it cannot return.
      [[step("a", "ok", "fail"), step("b", "interrupt", "die", true), step("c", "ok")], "compensate"],
      [[step("a", "ok", "fail"), step("b", "interrupt", "die", false), step("c", "ok")], "compensate"],
      [[step("a", "ok", "fail"), step("b", "interrupt", "die", true)], "fail"],
      [[step("a", "interrupt", "ok", true)], "compensate-and-fail"]
    ]
    for (const [steps, policy] of cases) {
      expect(await Effect.runPromise(sagaAgrees(steps, policy).pipe(Effect.provide(Logger.layer([]))))).toBeUndefined()
    }
  })

  differential("orders step ids of digits and lowercase letters as `localeCompare` does", async () => {
    await holds(
      Arbitrary.schema(Schema.Array(Schema.Array(small(0, 35)))),
      (texts) => {
        const ids = [
          ...new Set(texts.slice(0, 8).map((text) => text.slice(0, 4).map((digit) => digit.toString(36)).join("")))
        ]
        return agree(
          "sortTexts",
          { texts: ids.map(units) },
          [...ids].sort((left, right) => left.localeCompare(right)).map(units)
        )
      },
      1
    )
  })
})

describe("Bounded against the specification", () => {
  differential("refuses, ranks, slides its window and cuts its batches as the specification does", async () => {
    await holds(Arbitrary.schema(BoundedCase), (input) => boundedAgrees(boundedScript(input)), 2)
  })

  differential("agrees on the fixed cases", async () => {
    const cases: ReadonlyArray<BoundedScript> = [
      { names: [], priorities: undefined, fallback: undefined, concurrency: 1, failing: [] },
      // The width is refused before the empty record, and the empty record before a stray priority.
      { names: [], priorities: { ghost: 1 }, fallback: undefined, concurrency: 0, failing: [] },
      { names: [], priorities: { ghost: 1 }, fallback: undefined, concurrency: 2, failing: [] },
      // A stray priority is refused before a member's unsafe one.
      { names: ["a", "b"], priorities: { a: 1.5, ghost: 1 }, fallback: undefined, concurrency: 2, failing: [] },
      { names: ["a", "b"], priorities: { b: Number.NaN }, fallback: 2 ** 53, concurrency: 2, failing: [] },
      // Equal priorities keep declaration order, and both ends of the safe range still order.
      {
        names: ["a", "__proto__", "b", "c", "d"],
        priorities: { c: Number.MAX_SAFE_INTEGER, __proto__: Number.MIN_SAFE_INTEGER, d: 1 },
        fallback: 1,
        concurrency: 2,
        failing: []
      },
      { names: ["a", "b", "c", "d", "e"], priorities: { e: 9 }, fallback: undefined, concurrency: 2, failing: ["b"] },
      { names: ["a", "b", "c"], priorities: {}, fallback: undefined, concurrency: 5, failing: ["a", "c"] },
      // The shrunk counterexample this file found: `Bounded.all` read each member off the planned batch record by
      // name, and a planned value refuses `toString`, so the declaration could not be built.
      { names: ["toString"], priorities: {}, fallback: 0, concurrency: 1, failing: ["toString"] },
      {
        names: ["then", "valueOf", "toJSON"],
        priorities: { toJSON: 1 },
        fallback: undefined,
        concurrency: 2,
        failing: []
      }
    ]
    for (const script of cases) expect(await Effect.runPromise(boundedAgrees(script))).toBeUndefined()
  })
})

describe("Quarantine against the specification", () => {
  differential("isolates or halts as the specification does", async () => {
    await holds(Arbitrary.schema(QuarantineCase), quarantineAgrees, 3)
  })

  differential("settles a joined result as the specification does", async () => {
    await holds(Arbitrary.schema(SettleCase), settleAgrees, 4)
  })
})

describe("ReviewLoop against the specification", () => {
  differential("ends at the round, with the verdict, the specification gives", async () => {
    await holds(Arbitrary.schema(ReviewCase), reviewAgrees, 5)
  })
})

describe("Escalation against the specification", () => {
  differential("stops at the rung, having asked the deciders, the specification gives", async () => {
    await holds(Arbitrary.schema(EscalationCase), escalationAgrees, 6)
  })

  differential("reads a decision and a result as the specification does", async () => {
    await holds(
      Arbitrary.schema(ValueShape),
      (shape) =>
        Effect.gen(function*() {
          const wire = wireOf(shape)
          const accepted = yield* agree("accepted", { value: wire }, ReviewLoop.accepted(real(wire)))
          if (accepted !== undefined) return accepted
          if (ReviewLoop.accepted(real(wire)) !== Escalation.accepted(real(wire))) return "the two readers disagree"
          return yield* agree("defaultEscalate", { value: wire }, Escalation.defaultEscalate(real(wire)))
        }),
      7
    )
  })
})

describe("Intervene against the specification", () => {
  differential("applies exactly when the specification does", async () => {
    await holds(Arbitrary.schema(InterveneCase), interveneAgrees, 8)
  })
})

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope")
    await expect(oracle.ask("saga", { policy: "retry", steps: [] })).rejects.toThrow("the oracle refused")
    expect(await oracle.ask("accepted", { value: ["s", "approved"] })).toBe(true)
  })

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(9 * 25)
  })
})
