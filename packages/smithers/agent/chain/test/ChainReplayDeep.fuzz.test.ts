/**
 * Deep, stateful property and fuzz tests for the chain spine.
 *
 * Three families, each driven by a generated tape so one seed replays the
 * whole scenario:
 *
 * 1. Journal replay equivalence and crash recovery: random multi-link
 *    programs (tool calls, sub-chains, steering, gate rejections, fuel and
 *    link budgets, approval waits) are run once uninterrupted and once
 *    through a schedule of crashing processes, journal truncations, foreign
 *    writers and tampered histories.
 * 2. Catalog dispatch, call identity and authorization: canonical payload
 *    identity, declaration digests, call keys, and the fail-closed envelope.
 * 3. The JSON boundary and the QuickJS realm: hostile host values, hostile
 *    in-realm values, mutated scripts, resource bombs and escape attempts.
 */
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as Digest from "@smthrs/core/Digest"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  Author,
  AuthorDeclaration,
  Authorize,
  CallKey,
  Catalog,
  Chain,
  Event,
  Journal,
  JsonBoundary,
  Outcome,
  QuickJsRunner,
  Script,
  ScriptRunner,
  Steering,
  SubChains
} from "../src/index.ts"
import { flow } from "./harness.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

type Json = typeof Schema.Json.Type

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** Fails the property with every collected violation, so a finding names its invariant. */
const verdict = (violations: ReadonlyArray<string>): boolean => {
  if (violations.length > 0) throw new Error(violations.slice(0, 6).join("\n"))
  return true
}

// ---------------------------------------------------------------------------
// Tape: one generated integer list decides every choice of a scenario.
// ---------------------------------------------------------------------------

const TapeInput = Schema.Struct({
  tape: Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4095 })))).pipe(
    Schema.check(Schema.isMinLength(8), Schema.isMaxLength(96))
  )
})

const tapeArbitrary = Arbitrary.schema(TapeInput)

interface Tape {
  readonly next: (bound: number) => number
}

/** A short tape wraps around with a stride, so it still reaches every branch. */
const tapeOf = (values: ReadonlyArray<number>): Tape => {
  let cursor = 0
  return {
    next: (bound) => {
      const lap = values.length === 0 ? 0 : Math.floor(cursor / values.length)
      const value = (values[values.length === 0 ? 0 : cursor % values.length] ?? 0) + lap * 13
      cursor = cursor + 1
      return value % bound
    }
  }
}

const pick = <A>(tape: Tape, pool: readonly [A, ...ReadonlyArray<A>]): A => pool[tape.next(pool.length)] ?? pool[0]

// ---------------------------------------------------------------------------
// JSON generation and an independent equality model.
// ---------------------------------------------------------------------------

const textPool = [
  "",
  "a",
  "\u0000",
  "nul\u0000mid",
  "é",
  "e\u0301",
  "😀",
  "\ud83d\ude00\ud83d\ude00",
  "line\nbreak",
  "\u2028",
  "\ufeff",
  "__proto__",
  "\\",
  "\"",
  "0",
  "null"
] as const

const keyPool = [
  "a",
  "b",
  "",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "toJSON",
  "then",
  "length",
  "0",
  "\u0000",
  "é",
  "e\u0301",
  "😀"
] as const

const numberPool = [
  0,
  1,
  -1,
  0.1,
  -1.5,
  1e21,
  5e-324,
  1e308,
  2 ** 53,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER
] as const

/** Defines rather than assigns, so an `__proto__` key lands as own data. */
const setOwn = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true })
}

const genJson = (tape: Tape, depth: number): unknown => {
  const choice = tape.next(depth <= 0 ? 5 : 8)
  if (choice === 0) return null
  if (choice === 1) return tape.next(2) === 0
  if (choice === 2) return pick(tape, numberPool)
  if (choice === 3) return pick(tape, textPool)
  if (choice === 4) return tape.next(7) - 3
  if (choice === 5 || choice === 7) {
    return Array.from({ length: tape.next(4) }, () => genJson(tape, depth - 1))
  }
  const built: Record<string, unknown> = {}
  const size = tape.next(4)
  for (let index = 0; index < size; index = index + 1) setOwn(built, pick(tape, keyPool), genJson(tape, depth - 1))
  return built
}

const isContainer = (value: unknown): value is object => typeof value === "object" && value !== null

const field = (value: object, key: string): unknown => (value as Record<string, unknown>)[key]

/** Structural JSON equality: key order is irrelevant, array order and types are not. */
const jsonEquals = (left: unknown, right: unknown): boolean => {
  if (!isContainer(left) || !isContainer(right)) return left === right
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => jsonEquals(item, right[index]))
  }
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonEquals(field(left, key), field(right, key)))
}

/** The same value with every object's keys inserted in reverse order. */
const reverseKeys = (value: unknown): unknown => {
  if (!isContainer(value)) return value
  if (Array.isArray(value)) return value.map(reverseKeys)
  const reversed: Record<string, unknown> = {}
  for (const key of Object.keys(value).reverse()) setOwn(reversed, key, reverseKeys(field(value, key)))
  return reversed
}

/** A near miss: structurally close to the input, semantically a different value. */
const nearMiss = (tape: Tape, value: unknown): unknown => {
  const choice = tape.next(8)
  if (choice === 0) return [value]
  if (choice === 1) return typeof value === "number" ? String(value) : { value }
  if (choice === 2) return value === null ? "null" : null
  if (choice === 3) return typeof value === "string" ? `${value}\u0000` : [value, value]
  if (choice === 4) return typeof value === "string" ? value.normalize("NFD") : value
  if (choice === 5 && Array.isArray(value)) return value.length === 0 ? {} : value.slice().reverse()
  if (choice === 6 && isContainer(value) && !Array.isArray(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return []
    const dropped: Record<string, unknown> = {}
    for (const key of keys.slice(1)) setOwn(dropped, key, field(value, key))
    return dropped
  }
  return typeof value === "boolean" ? Number(value) : value
}

/** Embeds a JSON value in script source without object-literal `__proto__` semantics. */
const literal = (value: unknown): string => `JSON.parse(${JSON.stringify(JSON.stringify(value))})`

// ---------------------------------------------------------------------------
// Host integrity: nothing a boundary or a realm does may leave a trace here.
// ---------------------------------------------------------------------------

const hostFingerprint = (): string =>
  [
    Object.prototype,
    Array.prototype,
    Function.prototype,
    Promise.prototype,
    String.prototype,
    Number.prototype,
    JSON,
    globalThis
  ].map((target) => Reflect.ownKeys(target).map(String).sort().join(",")).join("|")

const hostIntrinsics = [JSON.stringify, JSON.parse, Object.keys, Object.getPrototypeOf, Number.isFinite, Array.isArray]

const hostIntact = (before: string): ReadonlyArray<string> => {
  const violations: Array<string> = []
  if (hostFingerprint() !== before) violations.push("a host prototype or the host global gained or lost a property")
  const probe: Record<string, unknown> = {}
  if (probe["polluted"] !== undefined || probe["pwned"] !== undefined) violations.push("Object.prototype was polluted")
  const current = [JSON.stringify, JSON.parse, Object.keys, Object.getPrototypeOf, Number.isFinite, Array.isArray]
  if (current.some((intrinsic, index) => intrinsic !== hostIntrinsics[index])) {
    violations.push("a host intrinsic was replaced")
  }
  return violations
}

// ---------------------------------------------------------------------------
// Family 1: programs, worlds and processes.
// ---------------------------------------------------------------------------

type Step =
  | { readonly kind: "echo"; readonly value: unknown }
  | { readonly kind: "nonce" }
  | { readonly kind: "agent"; readonly child: number }
  | { readonly kind: "fail"; readonly caught: boolean }
  | { readonly kind: "missing"; readonly name: string }
  | { readonly kind: "badResult"; readonly which: number }
  | { readonly kind: "inlineAuthor" }
  | { readonly kind: "gated" }
  | { readonly kind: "vault" }
  | { readonly kind: "shifty" }
  | { readonly kind: "hostile"; readonly caught: boolean; readonly expression: string }

interface Crash {
  readonly after: number
  readonly ackLost: boolean
}

type TamperKind = "payload" | "name" | "scriptDigest" | "entryDigest" | "keyLink" | "redeclare" | "reorder"

interface Plan {
  readonly links: ReadonlyArray<ReadonlyArray<Step>>
  readonly children: ReadonlyArray<{ readonly steps: ReadonlyArray<Step>; readonly parks: boolean }>
  readonly ending: "done" | "park"
  readonly badShapes: number
  readonly garbageSalt: number
  readonly steering: ReadonlyArray<ReadonlyArray<string>>
  readonly maxLinks: number
  readonly maxCalls: number
  readonly envelope: unknown
  readonly crashes: ReadonlyArray<Crash>
  readonly pendingApprovals: number
  readonly mixRunners: boolean
  readonly truncations: ReadonlyArray<number>
  readonly tamper: { readonly kind: TamperKind; readonly pick: number }
  readonly intruder: { readonly before: number; readonly sameScope: boolean }
}

const missingNames = [
  "nope/x",
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  "",
  "Echo",
  "echo ",
  "sys/now2"
] as const

const hostileExpressions = [
  "{ x: 0 / 0 }",
  "[1 / 0]",
  "{ f: () => 1 }",
  "\"\\ud800\"",
  "[, 1]",
  "(() => { const a = {}; a.self = a; return a })()",
  "{ u: undefined }",
  "Symbol(\"s\")",
  "new (class K {})()"
] as const

const steeringPool = ["hurry", "stay safe", "[shape] not an observation", "é\u0000 unicode 😀", ""] as const

const tamperKinds = ["payload", "name", "scriptDigest", "entryDigest", "keyLink", "redeclare", "reorder"] as const

const genSteps = (tape: Tape, childCount: number, firstChild: number): ReadonlyArray<Step> =>
  Array.from({ length: 1 + tape.next(4) }, (): Step => {
    const choice = tape.next(40)
    // A child leans on the gated entry, so approval waits are exercised through a sub-chain too.
    if (firstChild > 0 && choice <= 5) return { kind: "gated" }
    if (choice <= 9) return { kind: "echo", value: genJson(tape, 2) }
    if (choice <= 13) return { kind: "nonce" }
    if (choice <= 21 && firstChild < childCount) {
      return { child: firstChild + tape.next(childCount - firstChild), kind: "agent" }
    }
    if (choice <= 24) return { kind: "inlineAuthor" }
    if (choice <= 29) return { kind: "gated" }
    if (choice <= 32) return { caught: true, expression: pick(tape, hostileExpressions), kind: "hostile" }
    if (choice <= 35) return { kind: "shifty" }
    // One step in ten is a gate rejection, so most programs still reach their later links.
    if (choice === 36) return { caught: tape.next(2) === 0, kind: "fail" }
    if (choice === 37) return { kind: "missing", name: pick(tape, missingNames) }
    if (choice === 38) return { kind: "badResult", which: tape.next(8) }
    return tape.next(2) === 0
      ? { kind: "vault" }
      : { caught: false, expression: pick(tape, hostileExpressions), kind: "hostile" }
  })

const genPlan = (tape: Tape): Plan => {
  const childCount = pick(tape, [0, 1, 2, 2])
  const links = Array.from({ length: 1 + tape.next(3) }, () => genSteps(tape, childCount, 0))
  const children = Array.from({ length: childCount }, (_, index) => ({
    parks: tape.next(5) === 0,
    steps: genSteps(tape, childCount, index + 1)
  }))
  return {
    badShapes: pick(tape, [0, 0, 1, 2]),
    children,
    crashes: Array.from({ length: tape.next(5) }, () => ({ ackLost: tape.next(3) === 0, after: tape.next(14) })),
    ending: tape.next(4) === 0 ? "park" : "done",
    envelope: { run: genJson(tape, 2), z: 1, a: [pick(tape, textPool)] },
    garbageSalt: tape.next(4),
    intruder: { before: tape.next(16), sameScope: tape.next(3) === 0 },
    links,
    maxCalls: pick(tape, [64, 64, 64, 64, 64, 8, 3]),
    maxLinks: pick(tape, [32, 32, 32, 32, 32, 4, 2]),
    mixRunners: tape.next(2) === 0,
    pendingApprovals: pick(tape, [0, 1, 1, 2]),
    steering: Array.from({ length: 4 }, () => Array.from({ length: tape.next(3) }, () => pick(tape, steeringPool))),
    tamper: { kind: pick(tape, tamperKinds), pick: tape.next(64) },
    truncations: [tape.next(4096), tape.next(4096)]
  }
}

const stepSource = (step: Step): string => {
  switch (step.kind) {
    case "echo":
      return `r.push(await ctx.call("echo", ${literal(step.value)}))`
    case "nonce":
      return `r.push(await ctx.call("nonce"))`
    case "agent":
      return `r.push(await ctx.call("agent", { goal: "child:${step.child}" }))`
    case "fail":
      return step.caught
        ? `try { await ctx.call("flaky", null); r.push("unreachable") } catch (e) { r.push("caught") }`
        : `await ctx.call("flaky", { why: "uncaught" })`
    case "missing":
      return `await ctx.call(${JSON.stringify(step.name)}, null)`
    case "badResult":
      return `r.push(await ctx.call("bad/result", ${step.which}))`
    case "inlineAuthor":
      return `r.push((await ctx.call("author", { context: ["inline"] })).digest)`
    case "gated":
      return `r.push(await ctx.call("gated", 1))`
    case "vault":
      return `r.push(await ctx.call("vault", 1))`
    case "shifty":
      return `r.push(await ctx.call("shifty", null))`
    case "hostile":
      return step.caught
        ? `try { await ctx.call("echo", ${step.expression}); r.push("crossed") } catch (e) { r.push(String(e.message)) }`
        : `await ctx.call("echo", ${step.expression})`
  }
}

const rootScript = (plan: Plan, link: number, steering: ReadonlyArray<string>): string => {
  const next = link + 1 < plan.links.length
    ? `return to(${JSON.stringify(rootScript(plan, link + 1, []))})`
    : plan.ending === "done"
    ? `return done({ link: ${link}, r })`
    : `return park("timer", "wake at link ${link}")`
  return [
    `const steer = ${literal(steering)}`,
    "const r = []",
    ...(plan.links[link] ?? []).map(stepSource),
    `await ctx.call("commit", { link: ${link}, r, steer })`,
    next
  ].join("\n")
}

const childScript = (plan: Plan, index: number): string => {
  const child = plan.children[index]
  return [
    "const r = []",
    ...(child?.steps ?? []).map(stepSource),
    child?.parks === true ? `return park("event", "child ${index} waits")` : `return done({ child: ${index}, r })`
  ].join("\n")
}

const garbage = [
  "no flow block here",
  `${flow("return done(1)")}\n${flow("return done(2)")}`,
  "```flow\nreturn done(\"\ud800\")\n```",
  ""
] as const

const observationLine = /^\[(?:shape|fuel|catalog|call_failed|script_failed|denied)\] /

const steeringMarker = "[steering] "

/** The model seat as a pure function of its context: a restarted process authors the same text. */
const authorOutput = (plan: Plan, context: ReadonlyArray<string>): string => {
  const goal = context[0] ?? ""
  if (goal === "inline") return flow(`return done("inline")`)
  const rest = context.slice(1)
  const steering = rest.filter((line) => line.startsWith(steeringMarker)).map((line) =>
    line.slice(steeringMarker.length)
  )
  const observations = rest.filter((line) => observationLine.test(line))
  const shapes = observations.filter((line) => line.startsWith("[shape] ")).length
  if (shapes < plan.badShapes) return garbage[(shapes + plan.garbageSalt) % garbage.length] ?? ""
  if (observations.length > shapes) {
    return flow(
      `const e = await ctx.call("echo", ${literal({ observed: observations.length, steer: steering })})`,
      "return done({ recovered: e })"
    )
  }
  const child = /^child:(\d+)$/.exec(goal)
  return child === null ? flow(rootScript(plan, 0, steering)) : flow(childScript(plan, Number(child[1])))
}

interface Invocation {
  readonly process: number
  readonly name: string
  readonly chain: string
  readonly link: number
  readonly ordinal: number
}

interface World {
  readonly store: Array<Event.Event>
  readonly violations: Array<string>
  readonly invocations: Array<Invocation>
  readonly drains: Array<string>
  readonly state: {
    process: number
    crashed: boolean
    trips: number
    authorCalls: number
    nonces: number
    appends: number
  }
}

const makeWorld = (initial: ReadonlyArray<Event.Event> = []): World => ({
  drains: [],
  invocations: [],
  state: { appends: 0, authorCalls: 0, crashed: false, nonces: 0, process: 0, trips: 0 },
  store: [...initial],
  violations: []
})

const scopeOf = (event: Event.Event): string => event.chain ?? ""

const isMarker = (event: Event.Event): boolean =>
  event._tag === "CallSettled" && event.name === AuthorDeclaration.authorName && isContainer(event.result)
  && field(event.result, "rejected") === true

const slotJournaled = (world: World, chain: string, link: number, ordinal: number): boolean =>
  world.store.some((event) =>
    scopeOf(event) === chain
    && ((event._tag === "CallSettled" && event.link === link && event.key.ordinal === ordinal)
      || (event._tag === "GateRejected" && event.link === link && event.ordinal === ordinal))
  )

const rootGoal = "ship the release \u0000 é"

const badResults: ReadonlyArray<() => unknown> = [
  () => Number.NaN,
  () => 1n,
  () => () => 1,
  () => {
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic
    return cyclic
  },
  () => new Date(0),
  () => "\ud800",
  () => {
    const sparse: Array<unknown> = []
    sparse[1] = 1
    return sparse
  },
  () => Symbol("s")
]

const worldEntries = (world: World, redeclare: string | undefined): ReadonlyArray<Catalog.Entry> => {
  const declare = (
    name: string,
    capabilities: ReadonlyArray<string>,
    run: (payload: unknown, slot: Catalog.CallSlot) => Effect.Effect<unknown, Catalog.CallError>
  ): Catalog.Entry => ({
    capabilities,
    description: `${name} test entry${redeclare === name ? " (redeclared)" : ""}`,
    handler: (payload, slot) =>
      Effect.suspend(() => {
        if (slot === undefined) {
          world.violations.push(`"${name}" ran without a call slot`)
          return Effect.succeed(null)
        }
        const where = `${slot.chain}#${slot.link}.${slot.ordinal}`
        if (world.state.crashed) world.violations.push(`"${name}" ran at ${where} after the journal failed`)
        if (slotJournaled(world, slot.chain, slot.link, slot.ordinal)) {
          world.violations.push(`"${name}" re-executed the already journaled slot ${where}`)
        }
        if (slot.key === undefined || slot.key.link !== slot.link || slot.key.ordinal !== slot.ordinal) {
          world.violations.push(`"${name}" received a call key that does not match its slot ${where}`)
        }
        world.invocations.push({
          chain: slot.chain,
          link: slot.link,
          name,
          ordinal: slot.ordinal,
          process: world.state.process
        })
        return run(payload, slot)
      }),
    name
  })
  return [
    declare(
      "echo",
      ["fs:read:echo/data"],
      (payload, slot) => Effect.succeed({ at: `${slot.chain}#${slot.link}.${slot.ordinal}`, echo: payload })
    ),
    declare("nonce", [], () =>
      Effect.sync(() => {
        world.state.nonces = world.state.nonces + 1
        return `nonce#${world.state.process}-${world.state.nonces}`
      })),
    declare("commit", ["fs:write:commit/log"], () => Effect.succeed({ committed: true })),
    declare(
      "flaky",
      ["net:get:flaky.example/x"],
      () => Effect.fail(new Catalog.CallError({ message: "upstream refused", name: "flaky" }))
    ),
    declare(
      "bad/result",
      ["memory:read:bad"],
      (payload) => Effect.sync(() => (badResults[Number(payload) % badResults.length] ?? (() => Number.NaN))())
    ),
    declare("gated", ["fs:write:gated/file"], () => Effect.succeed({ gated: true })),
    // Answers differently on every read: the script must observe the one answer that was journaled.
    declare("shifty", ["memory:read:shifty"], () =>
      Effect.sync(() => {
        let reads = 0
        return Object.defineProperty({}, "v", {
          enumerable: true,
          get: () => {
            reads = reads + 1
            return reads
          }
        })
      })),
    declare("vault", ["fs:read:vault/secret"], () => Effect.succeed("SECRET"))
  ]
}

const rule = (effect: Rule["effect"], action: CapabilityPattern["action"], resource: string): Rule =>
  new Rule({ effect, pattern: new CapabilityPattern({ action, resource }) })

interface Fault {
  remaining: number
  readonly ackLost: boolean
  tripped: boolean
}

interface Intruder {
  remaining: number
  readonly sameScope: boolean
  injected: boolean
}

interface ProcessConfig {
  readonly fault: Fault | undefined
  readonly intruder: Intruder | undefined
  readonly askGated: boolean
  readonly runner: Layer.Layer<ScriptRunner.ScriptRunner>
  readonly redeclare: string | undefined
  readonly envelope: unknown
  readonly goal: string
}

/** A journal over the world's durable store, with an optional crash and an optional second writer. */
const journalLayer = (world: World, config: ProcessConfig): Layer.Layer<Journal.Journal> =>
  Layer.succeed(Journal.Journal)(Journal.make({
    append: (event, expectedPosition) =>
      Effect.suspend(() => {
        if (world.state.crashed) {
          world.violations.push(`a ${event._tag} append was attempted after the journal failed`)
          return Effect.fail(new Journal.JournalError({ message: "the process already crashed" }))
        }
        const intruder = config.intruder
        if (intruder !== undefined && !intruder.injected) {
          if (intruder.remaining === 0) {
            intruder.injected = true
            world.store.push({
              _tag: "GateRejected",
              ...(intruder.sameScope ? {} : { chain: "foreign-writer" }),
              link: 0,
              observation: { kind: "catalog", message: "written by another process" },
              ordinal: 4000
            })
          } else {
            intruder.remaining = intruder.remaining - 1
          }
        }
        if (world.store.length !== expectedPosition) {
          return Effect.fail(
            new Journal.JournalError({
              code: "journal_conflict",
              message: `append expected journal position ${expectedPosition}, found ${world.store.length}`
            })
          )
        }
        const fault = config.fault
        if (fault !== undefined && fault.remaining === 0) {
          fault.tripped = true
          world.state.crashed = true
          world.state.trips = world.state.trips + 1
          if (fault.ackLost) world.store.push(event)
          return Effect.fail(new Journal.JournalError({ message: "the process crashed mid-append" }))
        }
        if (fault !== undefined) fault.remaining = fault.remaining - 1
        world.store.push(event)
        world.state.appends = world.state.appends + 1
        return Effect.void
      }),
    read: Effect.sync(() => world.store.slice())
  }))

const steeringBoundary = /^(\d+)\/(\d+)$/

/** A durable inbox: what a boundary drains is a pure function of the boundary. */
const steeringLayer = (world: World, plan: Plan): Layer.Layer<Steering.Steering> =>
  Layer.succeed(Steering.Steering)(Steering.make({
    admit: () => Effect.void,
    drain: (boundary) =>
      Effect.sync(() => {
        const parsed = steeringBoundary.exec(boundary)
        if (parsed === null) {
          world.violations.push(`a non-root boundary ${JSON.stringify(boundary)} drained the root's steering`)
          return []
        }
        const link = Number(parsed[1])
        const ordinal = Number(parsed[2])
        const alreadyDrained = world.store.some((event) =>
          scopeOf(event) === ""
          && ((event._tag === "SteeringDrained" && event.link === link && event.ordinal === ordinal)
            || (event._tag === "CallSettled" && event.link === link && event.key.ordinal === ordinal))
        )
        if (alreadyDrained) world.violations.push(`boundary ${boundary} was drained again after it was journaled`)
        if (world.state.crashed) world.violations.push(`boundary ${boundary} drained after the journal failed`)
        world.drains.push(boundary)
        return plan.steering[(link * 2 + ordinal) % plan.steering.length] ?? []
      })
  }))

const childMaxLinks = 8

/** Entries whose every call is a gate rejection: a failure, a non-JSON result, a denial. */
const neverSettles: ReadonlyArray<string> = ["flaky", "bad/result", "vault"]

const subChainOptions = (
  plan: Plan,
  entries: ReadonlyArray<Catalog.Entry>
): SubChains.Options => ({ entries, maxCallsPerLink: plan.maxCalls, maxDepth: 3, maxLinks: childMaxLinks })

const runProcess = (world: World, plan: Plan, config: ProcessConfig) => {
  const base = Layer.mergeAll(
    journalLayer(world, config),
    Author.layerFn((input) => {
      world.state.authorCalls = world.state.authorCalls + 1
      if (world.state.crashed) world.violations.push("the author ran after the journal failed")
      return authorOutput(plan, input.context)
    }),
    config.runner,
    steeringLayer(world, plan),
    Authorize.layerRules([
      rule("allow", "*", "**"),
      rule("deny", "fs:read", "vault/**"),
      ...(config.askGated ? [rule("ask", "fs:write", "gated/**")] : [])
    ])
  )
  const catalog = SubChains.layer(subChainOptions(plan, worldEntries(world, config.redeclare))).pipe(
    Layer.provide(base)
  )
  return Chain.run({
    envelope: config.envelope as Json,
    goal: config.goal,
    maxCallsPerLink: plan.maxCalls,
    maxLinks: plan.maxLinks
  }).pipe(Effect.provide(Layer.mergeAll(base, catalog)))
}

const plainConfig = (plan: Plan, runner: Layer.Layer<ScriptRunner.ScriptRunner>): ProcessConfig => ({
  askGated: false,
  envelope: plan.envelope,
  fault: undefined,
  goal: rootGoal,
  intruder: undefined,
  redeclare: undefined,
  runner
})

const maskNonces = (text: string): string => text.replace(/nonce#\d+-\d+/g, "nonce#_")

/** What two histories must agree on: every event except the shape-rejection marker, nonces masked. */
const comparable = (events: ReadonlyArray<Event.Event>): string =>
  maskNonces(Digest.canonical(events.filter((event) => !isMarker(event))))

const comparableOutcome = (outcome: unknown): string => maskNonces(Digest.canonical(outcome))

const callKeys = (events: ReadonlyArray<Event.Event>): string =>
  Digest.canonical(
    events.flatMap((event) => event._tag === "CallSettled" && !isMarker(event) ? [[scopeOf(event), event.key]] : [])
  )

/** The declaration digest every settled call of this plan must be keyed under. */
const declaredDigests = (plan: Plan): ReadonlyMap<string, string> => {
  const entries = worldEntries(makeWorld(), undefined)
  return new Map([
    ...Catalog.withSystem(entries).map((entry) => [entry.name, Catalog.entryDigest(entry)] as const),
    [SubChains.agentName, SubChains.contractDigest(subChainOptions(plan, entries))],
    [AuthorDeclaration.authorName, AuthorDeclaration.authorDigest]
  ])
}

/** Structural invariants of a journal a run finished on. */
const journalViolations = (
  events: ReadonlyArray<Event.Event>,
  digests: ReadonlyMap<string, string>,
  outcome: unknown,
  plan: Plan
): ReadonlyArray<string> => {
  const violations: Array<string> = []
  const scopes = [...new Set(events.map(scopeOf))]
  const settledAgents = new Set<string>()
  for (const scope of scopes) {
    const scoped = events.filter((event) => scopeOf(event) === scope)
    const tag = `scope ${JSON.stringify(scope)}`
    if (scoped[0]?._tag !== "ChainStarted" || scoped.filter((event) => event._tag === "ChainStarted").length !== 1) {
      violations.push(`${tag} does not open with exactly one ChainStarted`)
    }
    const ended = scoped.flatMap((event) => event._tag === "LinkEnded" ? [event] : [])
    // A budget of N links ends at most N links plus the quota park that reports the overrun.
    const maxLinks = scope === "" ? plan.maxLinks : childMaxLinks
    const last = ended[ended.length - 1]
    if (
      ended.length > maxLinks + 1
      || (ended.length === maxLinks + 1 && !(last?.outcome._tag === "Park" && last.outcome.reason.code === "quota"))
    ) {
      violations.push(`${tag} ended ${ended.length} links on a budget of ${maxLinks}`)
    }
    ended.forEach((event, index) => {
      if (event.link !== index) violations.push(`${tag} ended link ${event.link} at position ${index}`)
      if (event.outcome._tag !== "To" && index !== ended.length - 1) {
        violations.push(`${tag} kept running after the terminal link ${event.link}`)
      }
      if (event.outcome._tag === "To") {
        const authored = scoped.filter((candidate) =>
          candidate._tag === "LinkAuthored" && candidate.link === event.link + 1
        )
        const script = authored[0]?._tag === "LinkAuthored" ? authored[0].script : undefined
        if (authored.length !== 1 || script === undefined) {
          violations.push(`${tag} link ${event.link + 1} is not authored exactly once`)
        } else if (
          script.text !== event.outcome.script.text || script.digest !== event.outcome.script.digest
          || script.digest !== Script.make(script.text).digest
        ) {
          violations.push(`${tag} link ${event.link + 1} runs a script its predecessor did not hand on`)
        }
      }
    })
    const slots = new Set<string>()
    const rejectedAt = new Map<number, number>()
    for (const event of scoped) {
      if (event._tag === "GateRejected") {
        const slot = `r${event.link}.${event.ordinal}`
        if (slots.has(slot)) violations.push(`${tag} rejected slot ${slot} twice`)
        slots.add(slot)
        rejectedAt.set(event.link, Math.min(rejectedAt.get(event.link) ?? event.ordinal, event.ordinal))
      }
      if (event._tag !== "CallSettled") continue
      const slot = `s${event.link}.${event.key.ordinal}`
      if (slots.has(slot)) violations.push(`${tag} settled slot ${slot} twice`)
      slots.add(slot)
      if (event.key.link !== event.link) violations.push(`${tag} slot ${slot} is keyed to link ${event.key.link}`)
      // Only strict JSON settles, and an entry that always fails or always answers non-JSON never does.
      const result = JsonBoundary.jsonBoundary(event.result)
      if (
        !("result" in event) || event.result === undefined || result._tag === "Refused"
        || !jsonEquals(result.value, event.result)
      ) {
        violations.push(`${tag} slot ${slot} ("${event.name}") settled a result that is not strict JSON`)
      }
      if (neverSettles.includes(event.name)) {
        violations.push(`${tag} slot ${slot} settled "${event.name}", which can only be rejected`)
      }
      if (event.key.ordinal >= plan.maxCalls) {
        violations.push(`${tag} slot ${slot} settled past the budget of ${plan.maxCalls} calls per link`)
      }
      const authored = Event.authored(scoped, event.link, scope)
      if (event.key.scriptDigest !== CallKey.harnessDigest && event.key.scriptDigest !== authored?.digest) {
        violations.push(`${tag} slot ${slot} is keyed to a script its link never ran`)
      }
      if (digests.get(event.name) !== event.key.entryDigest) {
        violations.push(`${tag} slot ${slot} ("${event.name}") is keyed to a declaration the catalog does not carry`)
      }
      const firstRejection = rejectedAt.get(event.link)
      if (isMarker(event)) {
        if (!slots.has(`r${event.link}.${event.key.ordinal}`)) {
          violations.push(`${tag} slot ${slot} holds a rejection marker without its rejection`)
        }
      } else if (firstRejection !== undefined) {
        if (event.key.scriptDigest !== CallKey.harnessDigest || event.key.ordinal <= firstRejection) {
          violations.push(`${tag} slot ${slot} settled a script call after its link was rejected at ${firstRejection}`)
        }
      }
      if (event.name === SubChains.agentName) {
        const child = `${scope === "" ? "" : `${scope}/`}${event.link}.${event.key.ordinal}`
        settledAgents.add(child)
        const terminal = Event.terminal(events, child)
        if (terminal === undefined || Digest.canonical(terminal) !== Digest.canonical(event.result)) {
          violations.push(`${tag} slot ${slot} settled a result that is not its child's terminal outcome`)
        }
      }
    }
  }
  for (const scope of scopes) {
    if (scope !== "" && !settledAgents.has(scope)) violations.push(`child scope ${scope} has no settled spawning call`)
  }
  const terminal = Event.terminal(events, "")
  if (terminal === undefined || Digest.canonical(terminal) !== Digest.canonical(outcome)) {
    violations.push("the run's outcome is not the journal's terminal outcome")
  }
  return violations
}

interface Runners {
  readonly inProcess: Layer.Layer<ScriptRunner.ScriptRunner>
  readonly quickJs: Layer.Layer<ScriptRunner.ScriptRunner>
}

const loadRunners = async (): Promise<Runners> => ({
  inProcess: ScriptRunner.layerInProcess,
  quickJs: Layer.succeed(ScriptRunner.ScriptRunner)(await Effect.runPromise(QuickJsRunner.make()))
})

/** Runs the uninterrupted reference history of a plan. */
const runReference = (plan: Plan, runners: Runners) =>
  Effect.gen(function*() {
    const world = makeWorld()
    const outcome = yield* runProcess(world, plan, plainConfig(plan, runners.inProcess))
    return { outcome, world }
  })

/** Resumes a durable store to its terminal with no faults; a failure is returned, not thrown. */
const resume = (plan: Plan, runner: Layer.Layer<ScriptRunner.ScriptRunner>, initial: ReadonlyArray<Event.Event>) =>
  Effect.gen(function*() {
    const world = makeWorld(initial)
    const result = yield* Effect.result(runProcess(world, plan, plainConfig(plan, runner)))
    return { result, world }
  })

describe("@smthrs/chain deep replay, dispatch and sandbox invariants", () => {
  it("crash schedules, lost acks and truncations converge on the uninterrupted history", async () => {
    const runners = await loadRunners()
    const report = await Effect.runPromise(
      Fuzz.run(
        tapeArbitrary,
        ({ tape: values }) =>
          Effect.gen(function*() {
            const plan = genPlan(tapeOf(values))
            const digests = declaredDigests(plan)
            const violations: Array<string> = []
            const reference = yield* runReference(plan, runners)
            violations.push(...reference.world.violations)
            violations.push(...journalViolations(reference.world.store, digests, reference.outcome, plan))
            if (reference.world.invocations.some((call) => call.name === "vault")) {
              violations.push("a denied entry's handler ran in the reference run")
            }

            // The same plan through a schedule of crashing and approval-parked processes.
            const world = makeWorld()
            let outcome: Outcome.RunResult | undefined
            const limit = plan.crashes.length + plan.pendingApprovals + 2
            for (let index = 0; index < limit && outcome === undefined; index = index + 1) {
              const crash = plan.crashes[index]
              const fault: Fault | undefined = crash === undefined
                ? undefined
                : { ackLost: crash.ackLost, remaining: crash.after, tripped: false }
              const askGated = index < plan.pendingApprovals
              world.state.process = index
              world.state.crashed = false
              const before = Digest.canonical(world.store)
              const result = yield* Effect.result(runProcess(world, plan, {
                ...plainConfig(plan, plan.mixRunners && index % 2 === 1 ? runners.quickJs : runners.inProcess),
                askGated,
                fault
              }))
              if (Result.isFailure(result)) {
                if (fault?.tripped !== true || result.failure._tag !== "/chain/JournalError") {
                  violations.push(`process ${index} failed without a crash: ${String(result.failure)}`)
                  break
                }
                continue
              }
              if (fault?.tripped === true) violations.push(`process ${index} reported success after a failed append`)
              if (result.success._tag === "ApprovalWait") {
                if (!askGated) violations.push(`process ${index} waited on an approval nobody withheld`)
                // An approval wait is resumable in place, so it must leave no trace of the waiting slot.
                const waiting = world.store.filter((event) => event._tag === "LinkEnded" && scopeOf(event) === "")
                if (waiting.some((event) => event._tag === "LinkEnded" && event.outcome._tag !== "To")) {
                  violations.push(`process ${index} ended a link while waiting on an approval`)
                }
                if (fault === undefined && askGated && plan.crashes.length === 0 && index > 0) {
                  if (Digest.canonical(world.store) !== before) {
                    violations.push(`process ${index} re-waited on the same approval and still changed the journal`)
                  }
                }
                continue
              }
              outcome = result.success
            }
            violations.push(...world.violations)
            if (outcome === undefined) {
              violations.push("the crash schedule never reached a terminal outcome")
              return verdict(violations)
            }
            violations.push(...journalViolations(world.store, digests, outcome, plan))
            if (comparable(world.store) !== comparable(reference.world.store)) {
              violations.push("the recovered journal differs from the uninterrupted journal")
            }
            if (comparableOutcome(outcome) !== comparableOutcome(reference.outcome)) {
              violations.push("the recovered outcome differs from the uninterrupted outcome")
            }
            if (maskNonces(callKeys(world.store)) !== maskNonces(callKeys(reference.world.store))) {
              violations.push("the recovered call keys differ from the uninterrupted call keys")
            }
            // At most one handler and one author call are in flight when a process dies.
            if (world.invocations.length > reference.world.invocations.length + world.state.trips) {
              violations.push("a crash re-executed more handlers than were in flight")
            }
            if (world.state.authorCalls > reference.world.state.authorCalls + world.state.trips) {
              violations.push("a crash re-ran more author calls than were in flight")
            }
            if (world.invocations.some((call) => call.name === "vault")) {
              violations.push("a denied entry's handler ran during recovery")
            }
            for (const event of world.store) {
              if (event._tag !== "CallSettled" || isMarker(event)) continue
              if ([...digests.keys()].includes(event.name) && !["author", "agent"].includes(event.name)) {
                const ran = world.invocations.some((call) =>
                  call.chain === scopeOf(event) && call.link === event.link && call.ordinal === event.key.ordinal
                  && call.name === event.name
                )
                if (!ran) violations.push(`"${event.name}" settled a slot its handler never ran for`)
              }
            }

            // A finished journal replays to the same terminal with every seam unavailable.
            const finished = world.store.slice()
            const replayed = yield* Effect.result(
              Chain.run({ envelope: reverseKeys(plan.envelope) as Json, goal: rootGoal }).pipe(
                Effect.provide(Layer.mergeAll(
                  Journal.layerNoop({ read: Effect.succeed(finished) }),
                  Author.layerNoop(),
                  ScriptRunner.layerNoop(),
                  Steering.layerNoop(),
                  Authorize.layerNoop(),
                  Catalog.layerNoop
                ))
              )
            )
            if (Result.isFailure(replayed)) {
              violations.push(`a finished journal needed a live seam to replay: ${String(replayed.failure)}`)
            } else if (Digest.canonical(replayed.success) !== Digest.canonical(outcome)) {
              violations.push("a finished journal replayed to a different outcome")
            }

            // A finished journal refuses a different run identity without writing.
            for (
              const identity of [{ envelope: [plan.envelope], goal: rootGoal }, { envelope: plan.envelope, goal: "" }]
            ) {
              const stranger = makeWorld(finished)
              const diverged = yield* Effect.result(
                runProcess(stranger, plan, { ...plainConfig(plan, runners.inProcess), ...identity })
              )
              if (
                Result.isSuccess(diverged) || diverged.failure._tag !== "/chain/ChainError"
                || diverged.failure.code !== "replay_divergence"
              ) {
                violations.push("a finished journal accepted a different goal or envelope")
              }
              if (
                stranger.state.appends !== 0 || stranger.invocations.length !== 0 || stranger.state.authorCalls !== 0
              ) {
                violations.push("a refused run identity still wrote, authored or dispatched")
              }
            }

            // Every prefix of the reference journal is a crash state that converges on it.
            for (const [index, cut] of plan.truncations.entries()) {
              const prefix = reference.world.store.slice(0, cut % (reference.world.store.length + 1))
              const resumed = yield* resume(
                plan,
                plan.mixRunners && index === 1 ? runners.quickJs : runners.inProcess,
                prefix
              )
              violations.push(...resumed.world.violations)
              if (Result.isFailure(resumed.result)) {
                violations.push(`a ${prefix.length}-event prefix failed to resume: ${String(resumed.result.failure)}`)
              } else if (
                comparable(resumed.world.store) !== comparable(reference.world.store)
                || comparableOutcome(resumed.result.success) !== comparableOutcome(reference.outcome)
              ) {
                violations.push(`a ${prefix.length}-event prefix resumed to a different history`)
              }
            }
            return verdict(violations)
          }),
        { executions: ioExecutions, seed }
      )
    )
    assertPassed(report)
  })

  it("a tampered or redeclared in-flight call diverges typed, and a reordered payload does not", async () => {
    const runners = await loadRunners()
    const report = await Effect.runPromise(
      Fuzz.run(
        tapeArbitrary,
        ({ tape: values }) =>
          Effect.gen(function*() {
            const plan = genPlan(tapeOf(values))
            const violations: Array<string> = []
            const reference = yield* runReference(plan, runners)
            const redeclarable = ["echo", "commit", "nonce", "gated"]
            const settled = reference.world.store.flatMap((event, index) =>
              event._tag === "CallSettled" && scopeOf(event) === "" && !isMarker(event) ? [{ event, index }] : []
            )
            const declared = settled.filter((candidate) => redeclarable.includes(candidate.event.name))
            // Prefer a catalog entry over the model seat; a redeclaration needs one.
            const candidates = declared.length > 0 && (plan.tamper.kind === "redeclare" || plan.tamper.pick % 3 > 0)
              ? declared
              : settled
            const chosen = candidates[plan.tamper.pick % Math.max(1, candidates.length)]
            if (chosen === undefined) return true
            const at = chosen.index
            const target = chosen.event
            const kind: TamperKind = plan.tamper.kind === "redeclare" && declared.length === 0
              ? "payload"
              : plan.tamper.kind
            const tampered: Event.CallSettled = kind === "payload"
              ? { ...target, payload: { tampered: target.payload } }
              : kind === "name"
              ? { ...target, name: `${target.name}~` }
              : kind === "scriptDigest"
              ? { ...target, key: { ...target.key, scriptDigest: `${target.key.scriptDigest}0` } }
              : kind === "entryDigest"
              ? { ...target, key: { ...target.key, entryDigest: `${target.key.entryDigest}0` } }
              : kind === "keyLink"
              ? { ...target, key: { ...target.key, link: target.key.link + 1 } }
              : kind === "reorder"
              ? { ...target, payload: reverseKeys(target.payload) as Json }
              : target
            const prefix = [...reference.world.store.slice(0, at), tampered]
            const world = makeWorld(prefix)
            const result = yield* Effect.result(runProcess(world, plan, {
              ...plainConfig(plan, runners.inProcess),
              redeclare: kind === "redeclare" ? target.name : undefined
            }))
            violations.push(...world.violations)
            if (kind === "reorder") {
              if (Result.isFailure(result)) {
                violations.push(`a key-reordered journaled payload diverged: ${String(result.failure)}`)
              } else if (
                comparable(world.store) !== comparable(reference.world.store)
                || comparableOutcome(result.success) !== comparableOutcome(reference.outcome)
              ) {
                violations.push("a key-reordered journaled payload changed the history")
              }
              return verdict(violations)
            }
            if (
              Result.isSuccess(result) || result.failure._tag !== "/chain/ChainError"
              || result.failure.code !== "replay_divergence"
            ) {
              violations.push(`a ${kind} tamper of "${target.name}" did not fail as replay_divergence`)
            }
            if (Digest.canonical(world.store) !== Digest.canonical(prefix)) {
              violations.push(`a ${kind} divergence still wrote to the journal`)
            }
            if (
              world.invocations.some((call) =>
                call.chain === "" && call.link === target.link && call.ordinal >= target.key.ordinal
              )
            ) {
              violations.push(`a ${kind} divergence still dispatched the diverged slot or one after it`)
            }
            return verdict(violations)
          }),
        { executions: ioExecutions, seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("a foreign-scope writer is absorbed and a same-scope writer is a typed conflict", async () => {
    const runners = await loadRunners()
    const report = await Effect.runPromise(
      Fuzz.run(
        tapeArbitrary,
        ({ tape: values }) =>
          Effect.gen(function*() {
            const plan = genPlan(tapeOf(values))
            const violations: Array<string> = []
            const reference = yield* runReference(plan, runners)
            const world = makeWorld()
            const intruder: Intruder = {
              injected: false,
              remaining: plan.intruder.before,
              sameScope: plan.intruder.sameScope
            }
            const result = yield* Effect.result(
              runProcess(world, plan, { ...plainConfig(plan, runners.inProcess), intruder })
            )
            violations.push(...world.violations)
            const own = world.store.filter((event) => scopeOf(event) !== "foreign-writer")
            if (intruder.injected && intruder.sameScope) {
              if (
                Result.isSuccess(result) || result.failure._tag !== "/chain/JournalError"
                || result.failure.code !== "journal_conflict"
              ) {
                violations.push("a second writer on the run's own scope was not a journal_conflict")
              }
              const written = own.filter((event) => !(event._tag === "GateRejected" && event.ordinal === 4000))
              if (Digest.canonical(written) !== Digest.canonical(reference.world.store.slice(0, written.length))) {
                violations.push("a conflicted run wrote something the uninterrupted run never would")
              }
            } else if (Result.isFailure(result)) {
              violations.push(`a foreign-scope writer broke the run: ${String(result.failure)}`)
            } else {
              if (comparable(own) !== comparable(reference.world.store)) {
                violations.push("a foreign-scope writer changed this chain's history")
              }
              if (world.store.length !== own.length + (intruder.injected ? 1 : 0)) {
                violations.push("the foreign writer's event was lost or duplicated")
              }
            }
            return verdict(violations)
          }),
        { executions: ioExecutions, seed: seed + 2 }
      )
    )
    assertPassed(report)
  })

  it("a runner that forges successor digests cannot choose the replay key of the next link", async () => {
    const runners = await loadRunners()
    const honest = await Effect.runPromise(
      Effect.flatMap(ScriptRunner.ScriptRunner, Effect.succeed).pipe(Effect.provide(runners.inProcess))
    )
    // Bypasses the shared outcome gate: every successor comes back with a digest the script "chose".
    const lying = Layer.succeed(ScriptRunner.ScriptRunner)(ScriptRunner.make({
      run: (script, handler) =>
        Effect.map(
          honest.run(script, handler),
          (outcome) =>
            outcome._tag === "To" ? { _tag: "To", script: { digest: "forged", text: outcome.script.text } } : outcome
        )
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        tapeArbitrary,
        ({ tape: values }) =>
          Effect.gen(function*() {
            const plan = genPlan(tapeOf(values))
            const violations: Array<string> = []
            const reference = yield* runReference(plan, runners)
            const forged = yield* resume(plan, lying, [])
            violations.push(...forged.world.violations)
            if (Result.isFailure(forged.result)) {
              violations.push(`a forging runner broke the run: ${String(forged.result.failure)}`)
            } else if (
              comparable(forged.world.store) !== comparable(reference.world.store)
              || comparableOutcome(forged.result.success) !== comparableOutcome(reference.outcome)
            ) {
              violations.push("a forged successor digest reached the journal")
            }
            if (Digest.canonical(forged.world.store).includes("forged")) {
              violations.push("the forged digest was journaled")
            }
            return verdict(violations)
          }),
        { executions: Math.max(15, Math.ceil(ioExecutions / 2)), seed: seed + 9 }
      )
    )
    assertPassed(report)
  })

  it("payload identity, declaration digests and call keys are deterministic and collision-free", async () => {
    const namePool = ["a", "b", "a\u0000", "a,b", "a\"", "é", "e\u0301", ""] as const
    const descriptionPool = ["", "d", "d\",\"name\":\"a", "é", "e\u0301", "d\u0000", "null"] as const
    const claimsPool: readonly [
      ReadonlyArray<string> | undefined,
      ...ReadonlyArray<ReadonlyArray<string> | undefined>
    ] = [
      undefined,
      [],
      ["*"],
      ["fs:read:a"],
      ["fs:read:a", "fs:write:b"],
      ["fs:write:b", "fs:read:a"],
      ["fs:read:a,fs:write:b"],
      [""]
    ]
    const digestPool = ["", "a", "ab", "b", "bc", "c", "0", "a\u0000"] as const
    const indexPool = [0, 1, 2, 12, 23, 123] as const
    const chainPool = ["", "0.1", "0.11", "0.1/0.1", "1.0"] as const
    const textLines = [
      "return done(1)",
      "return done(1) ",
      "return done(\"é\")",
      "return done(\"e\u0301\")",
      "const x = \"\u0000\"",
      "const y = `a${1}b`",
      "// ```",
      "await ctx.call(\"echo\", null)"
    ] as const
    const decodeKey = Schema.decodeUnknownOption(CallKey.CallKey)
    const before = hostFingerprint()

    const report = await Effect.runPromise(
      Fuzz.run(
        tapeArbitrary,
        ({ tape: values }) =>
          Effect.sync(() => {
            const tape = tapeOf(values)
            const violations: Array<string> = []

            // Canonical payload identity against the structural model.
            const left = genJson(tape, 3)
            const mode = tape.next(3)
            const right = mode === 0 ? reverseKeys(left) : mode === 1 ? genJson(tape, 3) : nearMiss(tape, left)
            const leftBound = JsonBoundary.jsonBoundary(left)
            const rightBound = JsonBoundary.jsonBoundary(right)
            if (leftBound._tag !== "Ok" || rightBound._tag !== "Ok") {
              violations.push("the boundary refused a generated JSON value")
            } else {
              const leftText = Digest.canonical(leftBound.value)
              const rightText = Digest.canonical(rightBound.value)
              const same = jsonEquals(leftBound.value, rightBound.value)
              if ((leftText === rightText) !== same) {
                violations.push(`canonical identity disagrees with structural equality: ${leftText} vs ${rightText}`)
              }
              if ((Digest.digest(leftText) === Digest.digest(rightText)) !== same) {
                violations.push("payload digests collide or split a structurally equal pair")
              }
              if (mode === 0 && !same) violations.push("reversing key order changed a value's identity")
              if (!jsonEquals(JSON.parse(leftText), leftBound.value)) {
                violations.push(`canonical text does not parse back to its value: ${leftText}`)
              }
            }

            // Script identity: the digest is a function of the exact text, nothing else.
            const lines = Array.from({ length: 1 + tape.next(3) }, () => pick(tape, textLines))
            const otherLines = tape.next(2) === 0
              ? lines
              : Array.from({ length: 1 + tape.next(3) }, () => pick(tape, textLines))
            const text = lines.join("\n")
            const otherText = otherLines.join("\n")
            const script = Script.make(text)
            if (script.digest === "" || script.digest !== Script.make(text).digest) {
              violations.push("a script digest is empty or unstable")
            }
            if ((script.digest === Script.make(otherText).digest) !== (text === otherText)) {
              violations.push("two different script texts share a digest")
            }
            if (Outcome.to({ digest: "forged", text }).script.digest !== script.digest) {
              violations.push("a successor chose its own replay digest")
            }
            for (
              const authored of [flow(text), flow(text).replace(/\n/g, "\r\n"), `prose\n\n${flow(text)}\ntrailing`]
            ) {
              const extracted = Script.extract(authored)
              if (
                extracted._tag !== "Extracted" || extracted.script.text !== text ||
                extracted.script.digest !== script.digest
              ) {
                violations.push("extracting an authored block did not round-trip its script identity")
              }
            }
            const forged = JsonBoundary.decodeOutcome({ _tag: "To", script: { digest: "forged", text } })
            if (Option.isNone(forged) || forged.value._tag !== "To" || forged.value.script.digest !== script.digest) {
              violations.push("the outcome gate let a script forge its successor's digest")
            }

            // Declaration identity: injective over (name, description, capabilities).
            const declare = (): Catalog.Entry => ({
              capabilities: pick(tape, claimsPool),
              description: pick(tape, descriptionPool),
              handler: () => Effect.succeed(null),
              name: pick(tape, namePool)
            })
            const first = declare()
            const other = declare()
            // One component at a time, so a digest that ignores a component cannot hide behind the others.
            const varied = tape.next(5)
            const second: Catalog.Entry = varied === 0
              ? { ...first, handler: () => Effect.succeed(1), settleOnInterrupt: true }
              : varied === 1
              ? { ...first, name: other.name }
              : varied === 2
              ? { ...first, description: other.description }
              : varied === 3
              ? { ...first, capabilities: other.capabilities }
              : other
            const sameDeclaration = first.name === second.name && first.description === second.description
              && JSON.stringify(first.capabilities ?? "undeclared") ===
                JSON.stringify(second.capabilities ?? "undeclared")
            if ((Catalog.entryDigest(first) === Catalog.entryDigest(second)) !== sameDeclaration) {
              violations.push(
                `declaration digests disagree with declaration equality: ${JSON.stringify([first, second])}`
              )
            }
            if (Catalog.entryDigest({ ...first, digest: "" }) !== Catalog.entryDigest(first)) {
              violations.push("an empty digest override did not fall back to the derived digest")
            }
            if (Catalog.entryDigest({ ...first, digest: "pinned" }) !== "pinned") {
              violations.push("a non-empty digest override was ignored")
            }
            const claims = [...(first.capabilities ?? ["fs:read:a"])]
            const source: Array<Catalog.Entry> = [{ ...first, capabilities: claims }]
            const service = Catalog.make(source)
            const pinned = Catalog.entryDigest(source[0] ?? first)
            claims.push("fs:write:**")
            source.push({ ...second, name: "late" })
            const looked = service.lookup(first.name)
            if (
              looked === undefined || Catalog.entryDigest(looked) !== pinned || service.lookup("late") !== undefined
            ) {
              violations.push("a catalog followed a later edit of its caller's entries")
            }
            if (service.entries.length !== 1 || !Object.isFrozen(service.entries) || !Object.isFrozen(looked)) {
              violations.push("a catalog's advertised entries are not a frozen snapshot")
            }
            for (const inherited of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
              if (Catalog.make([]).lookup(inherited) !== undefined) {
                violations.push(`an empty catalog resolved the inherited name ${inherited}`)
              }
            }

            // Call keys: equal exactly when all four components are equal.
            const key = (): CallKey.CallKey =>
              CallKey.make(pick(tape, indexPool), pick(tape, digestPool), pick(tape, indexPool), pick(tape, digestPool))
            const keyLeft = key()
            const keyRight = tape.next(3) === 0 ? { ...keyLeft } : key()
            const sameKey = keyLeft.link === keyRight.link && keyLeft.ordinal === keyRight.ordinal
              && keyLeft.scriptDigest === keyRight.scriptDigest && keyLeft.entryDigest === keyRight.entryDigest
            if ((Digest.canonical(keyLeft) === Digest.canonical(keyRight)) !== sameKey) {
              violations.push(`call keys collide: ${JSON.stringify([keyLeft, keyRight])}`)
            }
            if (Option.isNone(decodeKey(keyLeft))) violations.push("a constructed call key does not decode")
            for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
              if (
                Option.isSome(decodeKey({ ...keyLeft, link: bad })) ||
                Option.isSome(decodeKey({ ...keyLeft, ordinal: bad }))
              ) {
                violations.push(`a call key decoded with the link or ordinal ${String(bad)}`)
              }
            }

            // Journal folds isolate (chain, link) exactly, including prefix-shaped scope ids.
            const model = new Map<string, number>()
            const history: Array<Event.Event> = Array.from({ length: tape.next(12) }, (_, id): Event.Event => {
              const chain = pick(tape, chainPool)
              const link = tape.next(3)
              const ordinal = tape.next(4)
              model.set(`${chain}|${link}|${ordinal}`, id)
              return {
                _tag: "CallSettled",
                ...(chain === "" && tape.next(2) === 0 ? {} : { chain }),
                key: CallKey.make(link, "s", ordinal, "e"),
                link,
                name: "echo",
                payload: id,
                result: id
              }
            })
            for (const chain of chainPool) {
              for (let link = 0; link < 3; link = link + 1) {
                const folded = Event.settled(history, link, chain)
                const expected = [...model].filter(([slot]) => slot.startsWith(`${chain}|${link}|`))
                if (
                  folded.size !== expected.length
                  || expected.some(([slot, id]) => folded.get(Number(slot.split("|")[2]))?.payload !== id)
                ) {
                  violations.push(`settled(${JSON.stringify(chain)}, ${link}) disagrees with the model`)
                }
              }
            }
            violations.push(...hostIntact(before))
            return verdict(violations)
          }),
        { executions: pureExecutions, seed: seed + 3 }
      )
    )
    assertPassed(report)
  })

  it("the envelope fails closed: no handler effect runs without an allow for its exact slot and claims", async () => {
    const entryNames = ["read", "write", "net", "open", "raw", "mixed"] as const
    const claimPool: readonly [ReadonlyArray<string> | undefined, ...ReadonlyArray<ReadonlyArray<string> | undefined>] =
      [
        undefined,
        [],
        ["fs:read:data/a"],
        ["fs:write:data/a"],
        ["net:get:example.com/x"],
        ["fs:read:data/a", "fs:write:secret/k"],
        ["bad:::"],
        [""],
        ["fs:read"],
        ["*"],
        ["fs:*:data/**"]
      ]
    const rulePool: readonly [
      readonly [CapabilityPattern["action"], string],
      ...ReadonlyArray<readonly [CapabilityPattern["action"], string]>
    ] = [
      ["*", "**"],
      ["fs:read", "**"],
      ["fs:write", "**"],
      ["fs:*", "data/**"],
      ["fs:read", "data/a"],
      ["net:*", "**"],
      ["fs:write", "secret/*"],
      ["model:call", "**"]
    ]
    const effects = ["allow", "allow", "allow", "ask", "deny", "deny"] as const
    const unknownNames = ["ghost", "constructor", "__proto__", "toString", "", "read ", "READ"] as const
    const schemaKinds = ["count", "names", "null", "any"] as const
    const payloadFor: Record<(typeof schemaKinds)[number], unknown> = {
      any: "free text",
      count: { n: 3 },
      names: ["a", "b"],
      null: null
    }
    const decoders = {
      any: Schema.decodeUnknownOption(Schema.Unknown),
      count: Schema.decodeUnknownOption(Schema.Struct({ n: Schema.Int })),
      names: Schema.decodeUnknownOption(Schema.Array(Schema.String)),
      null: Schema.decodeUnknownOption(Schema.Null)
    }

    interface Decision {
      readonly name: string
      readonly capabilities: ReadonlyArray<string>
      readonly link: number
      readonly ordinal: number
      readonly verdict: "allow" | "denied" | "approval_required" | "authorize_unavailable"
      readonly sequence: number
    }

    const report = await Effect.runPromise(
      Fuzz.run(
        tapeArbitrary,
        ({ tape: values }) =>
          Effect.gen(function*() {
            const tape = tapeOf(values)
            const violations: Array<string> = []
            const declared = entryNames.map((name) => ({
              claims: pick(tape, claimPool),
              name,
              schema: pick(tape, schemaKinds)
            }))
            // The seam's default is ask, so most runs start from a broad allow and are then narrowed.
            const rules = [
              ...(tape.next(8) === 0 ? [] : [rule("allow", "model:call", "**")]),
              ...(tape.next(5) === 0 ? [] : [rule("allow", "*", "**")]),
              ...Array.from({ length: tape.next(4) }, () => {
                const [action, resource] = pick(tape, rulePool)
                return rule(pick(tape, effects), action, resource)
              })
            ]
            const [denyAction, denyResource] = pick(tape, rulePool)
            const seamDown = tape.next(12) === 0
            const calls = Array.from({ length: 1 + tape.next(5) }, () => {
              const known = tape.next(7) > 0
              const name = known ? pick(tape, entryNames) : pick(tape, unknownNames)
              // Mostly the shape the entry's schema takes, sometimes one it refuses.
              const fitting = declared.find((entry) => entry.name === name)?.schema
              const shape = fitting === undefined || fitting === "any" || tape.next(4) === 0
                ? pick(tape, schemaKinds)
                : fitting
              return { name, payload: payloadFor[shape], shape }
            })
            const scriptText = [
              ...calls.map((call) => `await ctx.call(${JSON.stringify(call.name)}, ${literal(call.payload)})`),
              "return done(\"end\")"
            ].join("\n")

            const run = (extra: ReadonlyArray<Rule>) =>
              Effect.gen(function*() {
                let sequence = 0
                let authorCalls = 0
                const decisions: Array<Decision> = []
                const entered: Array<{ name: string; link: number; ordinal: number; sequence: number; key: unknown }> =
                  []
                const effected: Array<{ name: string; ordinal: number; payload: unknown }> = []
                const entries = declared.map((entry): Catalog.Entry => ({
                  capabilities: entry.claims,
                  description: `typed ${entry.schema} entry`,
                  handler: (payload, slot) =>
                    Effect.suspend(() => {
                      sequence = sequence + 1
                      entered.push({
                        key: slot?.key,
                        link: slot?.link ?? -1,
                        name: entry.name,
                        ordinal: slot?.ordinal ?? -1,
                        sequence
                      })
                      if (Option.isNone(decoders[entry.schema](payload))) {
                        return Effect.fail(new Catalog.CallError({ message: "input does not match", name: entry.name }))
                      }
                      // The underlying effect: reached only past every gate and the input schema.
                      effected.push({ name: entry.name, ordinal: slot?.ordinal ?? -1, payload })
                      return Effect.succeed({ ok: entry.name })
                    }),
                  name: entry.name
                }))
                const real = yield* Effect.flatMap(Authorize.Authorize, Effect.succeed).pipe(
                  Effect.provide(seamDown ? Authorize.layerNoop() : Authorize.layerRules([...rules, ...extra]))
                )
                const spy = Layer.succeed(Authorize.Authorize)(Authorize.make({
                  authorize: (request) =>
                    Effect.tapError(
                      Effect.tap(real.authorize(request), () =>
                        Effect.sync(() => {
                          sequence = sequence + 1
                          decisions.push({
                            capabilities: [...request.capabilities],
                            link: request.slot.link,
                            name: request.name,
                            ordinal: request.slot.ordinal,
                            sequence,
                            verdict: "allow"
                          })
                        })),
                      (error) =>
                        Effect.sync(() => {
                          sequence = sequence + 1
                          decisions.push({
                            capabilities: [...request.capabilities],
                            link: request.slot.link,
                            name: request.name,
                            ordinal: request.slot.ordinal,
                            sequence,
                            verdict: error.code
                          })
                        })
                    )
                }))
                const journal = Journal.layerMemory()
                const layers = Layer.mergeAll(
                  journal,
                  Author.layerFn((input) => {
                    authorCalls = authorCalls + 1
                    return input.context.length > 1 ? flow("return done(\"recovered\")") : flow(scriptText)
                  }),
                  ScriptRunner.layerInProcess,
                  Catalog.layer(entries),
                  spy
                )
                return yield* Effect.gen(function*() {
                  const result = yield* Effect.result(Chain.run({ goal: "probe the envelope" }))
                  const events = yield* Effect.flatMap(Journal.Journal, (service) => service.read)
                  return { authorCalls: () => authorCalls, decisions, effected, entered, entries, events, result }
                }).pipe(Effect.provide(layers))
              })

            const base = yield* run([])
            const byName = new Map(base.entries.map((entry) => [entry.name, entry]))
            const scriptDigest = Script.make(scriptText).digest
            for (const call of base.entered) {
              const entry = byName.get(call.name)
              const claims = entry?.capabilities ?? ["*"]
              if (entry === undefined) {
                violations.push(`a handler ran for the undeclared name ${call.name}`)
                continue
              }
              const allowed = base.decisions.some((decision) =>
                decision.verdict === "allow" && decision.name === call.name && decision.link === call.link
                && decision.ordinal === call.ordinal && decision.sequence < call.sequence
                && JSON.stringify(decision.capabilities) === JSON.stringify(claims)
              )
              if (claims.length > 0 && !allowed) {
                violations.push(`"${call.name}" ran at ordinal ${call.ordinal} without an allow for its claims`)
              }
              const expectedKey = CallKey.make(call.link, scriptDigest, call.ordinal, Catalog.entryDigest(entry))
              if (Digest.canonical(call.key ?? null) !== Digest.canonical(expectedKey)) {
                violations.push(`"${call.name}" received a call key that is not its slot's durable identity`)
              }
            }
            for (const decision of base.decisions) {
              const entry = byName.get(decision.name)
              if (decision.name === AuthorDeclaration.authorName) {
                if (JSON.stringify(decision.capabilities) !== JSON.stringify([Chain.authorCapability])) {
                  violations.push("the model seat was authorized under a claim that is not its own")
                }
                continue
              }
              if (entry === undefined || entry.capabilities?.length === 0) {
                violations.push(`the seam was consulted for "${decision.name}", which claims nothing or does not exist`)
              }
              const rejected = base.events.some((event) =>
                event._tag === "GateRejected" && event.link === decision.link && event.ordinal === decision.ordinal
              )
              const settled = base.events.some((event) =>
                event._tag === "CallSettled" && event.link === decision.link && event.key.ordinal === decision.ordinal
              )
              const ran = base.entered.some((call) => call.link === decision.link && call.ordinal === decision.ordinal)
              if (decision.verdict === "denied") {
                const observation = base.events.find((event) =>
                  event._tag === "GateRejected" && event.link === decision.link && event.ordinal === decision.ordinal
                )
                if (
                  observation?._tag !== "GateRejected" || observation.observation.kind !== "denied" || settled || ran
                ) {
                  violations.push(`a denied "${decision.name}" was not journaled as a denial, or still ran`)
                }
              }
              if (decision.verdict === "approval_required" || decision.verdict === "authorize_unavailable") {
                if (rejected || settled || ran) violations.push(`an unapproved "${decision.name}" left a trace or ran`)
                if (base.decisions[base.decisions.length - 1] !== decision) {
                  violations.push(`the run kept going after "${decision.name}" was not approved`)
                }
              }
            }
            const last = base.decisions[base.decisions.length - 1]
            if (last?.verdict === "approval_required") {
              if (Result.isFailure(base.result) || base.result.success._tag !== "ApprovalWait") {
                violations.push("a required approval did not park the run as an approval wait")
              }
            }
            if (last?.verdict === "authorize_unavailable") {
              if (Result.isSuccess(base.result) || base.result.failure._tag !== "/chain/AuthorizeError") {
                violations.push("an unavailable seam did not fail the run typed")
              }
            }
            const seatAllows = base.decisions.filter((decision) =>
              decision.name === AuthorDeclaration.authorName && decision.verdict === "allow"
            ).length
            if (base.authorCalls() > seatAllows) {
              violations.push("the model seat authored without an allow of its own")
            }
            const seat = base.decisions.find((decision) =>
              decision.name === AuthorDeclaration.authorName
            )
            if (seat !== undefined && seat.verdict !== "allow") {
              if (base.authorCalls() !== 0 || base.entered.length !== 0) {
                violations.push("a model seat that was not allowed still authored or dispatched")
              }
              if (
                seat.verdict === "denied" &&
                (Result.isSuccess(base.result) || base.result.failure._tag !== "/chain/AuthorizeError")
              ) {
                violations.push("a denied model seat did not fail the run typed")
              }
            }
            // The script cannot pass a gate: what ran is a prefix of what it asked for, in order.
            base.entered.forEach((call, index) => {
              if (calls[index]?.name !== call.name) {
                violations.push(`dispatch order left the script's order at call ${index}`)
              }
            })
            // The underlying effect needs every gate AND a matching input, and sees exactly the authored payload.
            for (const effect of base.effected) {
              const asked = calls[effect.ordinal]
              const entry = declared.find((candidate) => candidate.name === effect.name)
              if (
                asked === undefined || entry === undefined || !(entry.schema === "any" || entry.schema === asked.shape)
              ) {
                violations.push(`"${effect.name}" ran its effect on input its schema refuses`)
              } else if (Digest.canonical(effect.payload) !== Digest.canonical(asked.payload)) {
                violations.push(`"${effect.name}" received a payload that is not the one the script sent`)
              }
            }
            for (const event of base.events) {
              if (event._tag === "GateRejected" && event.observation.kind === "catalog") {
                const asked = calls[event.ordinal]
                if (event.link !== 1 || asked === undefined || byName.has(asked.name)) {
                  violations.push("a catalog rejection was journaled for a declared entry")
                }
              }
            }

            // Attenuation: one more deny rule can only shorten what runs.
            const stricter = yield* run([rule("deny", denyAction, denyResource)])
            if (stricter.effected.length > base.effected.length || stricter.entered.length > base.entered.length) {
              violations.push("appending a deny rule let more handlers run")
            }
            stricter.entered.forEach((call, index) => {
              if (base.entered[index]?.name !== call.name || base.entered[index]?.ordinal !== call.ordinal) {
                violations.push("appending a deny rule changed which handlers ran, not just how many")
              }
            })
            return verdict(violations)
          }),
        { executions: ioExecutions, seed: seed + 4 }
      )
    )
    assertPassed(report)
  })

  it("rule verdicts form a lattice: more claims, or one more deny, never loosen a decision", async () => {
    const claimPool = [
      "fs:read:data/a",
      "fs:write:data/a",
      "fs:read:secret/k",
      "net:get:example.com/x",
      "net:private:10.0.0.1",
      "model:call:author",
      "proc:spawn:agent",
      "fs:read",
      "fs:*:data/**",
      "*",
      "*:data/a",
      "fs:read:../data/a",
      "fs:read:data/../secret/k",
      "fs:read:data/./a",
      "bad:::",
      "nope",
      ""
    ] as const
    const patternPool: readonly [
      readonly [CapabilityPattern["action"], string],
      ...ReadonlyArray<readonly [CapabilityPattern["action"], string]>
    ] = [
      ["*", "**"],
      ["fs:read", "**"],
      ["fs:write", "**"],
      ["fs:*", "data/**"],
      ["fs:read", "data/a"],
      ["fs:read", "secret/*"],
      ["net:*", "**"],
      ["net:private", "**"],
      ["model:call", "**"],
      ["proc:spawn", "agent"]
    ]
    const effects = ["allow", "ask", "deny"] as const
    const rank = { allow: 0, approval_required: 1, authorize_unavailable: 3, denied: 2 } as const

    const decide = (rules: ReadonlyArray<Rule>, capabilities: ReadonlyArray<string>) =>
      Effect.result(
        Effect.flatMap(
          Authorize.Authorize,
          (seam) => seam.authorize({ capabilities, name: "probe", slot: { chain: "", link: 0, ordinal: 0 } })
        ).pipe(Effect.provide(Authorize.layerRules(rules)))
      ).pipe(Effect.map((result) => Result.isSuccess(result) ? rank.allow : rank[result.failure.code]))

    const report = await Effect.runPromise(
      Fuzz.run(
        tapeArbitrary,
        ({ tape: values }) =>
          Effect.gen(function*() {
            const tape = tapeOf(values)
            const violations: Array<string> = []
            const rules = Array.from({ length: tape.next(6) }, () => {
              const [action, resource] = pick(tape, patternPool)
              return rule(pick(tape, effects), action, resource)
            })
            const claims = Array.from({ length: 1 + tape.next(3) }, () => pick(tape, claimPool))
            const extra = Array.from({ length: 1 + tape.next(2) }, () => pick(tape, claimPool))
            const [denyAction, denyResource] = pick(tape, patternPool)
            const told = JSON.stringify({ claims, rules: rules.map((entry) => [entry.effect, entry.pattern]) })

            const base = yield* decide(rules, claims)
            if (base !== (yield* decide(rules, claims))) violations.push(`a verdict is not deterministic: ${told}`)
            if (base === rank.authorize_unavailable) violations.push(`a rule seam reported itself unavailable: ${told}`)
            if ((yield* decide(rules, [...claims, ...extra])) < base) {
              violations.push(`claiming more loosened a verdict: ${told} + ${JSON.stringify(extra)}`)
            }
            if ((yield* decide(rules, [...extra, ...claims])) < base) {
              violations.push(`claiming more (in front) loosened a verdict: ${told} + ${JSON.stringify(extra)}`)
            }
            if ((yield* decide(rules, claims.slice().reverse())) !== base) {
              violations.push(`claim order changed a verdict: ${told}`)
            }
            if ((yield* decide([...rules, rule("deny", denyAction, denyResource)], claims)) < base) {
              violations.push(`appending deny ${denyAction}:${denyResource} loosened a verdict: ${told}`)
            }
            if ((yield* decide([], claims)) === rank.allow) {
              violations.push(`no rules allowed ${JSON.stringify(claims)}`)
            }
            if ((yield* decide(rules, [])) !== (yield* decide(rules, ["*"]))) {
              violations.push(`an empty claim set was not treated as the broadest claim: ${told}`)
            }
            const unparsed = claims.filter((claim) => Option.isNone(Authorize.claimPattern(claim)))
            if (unparsed.length > 0 && base === rank.allow) {
              violations.push(`an unparseable claim ${JSON.stringify(unparsed)} was allowed: ${told}`)
            }
            const sealed = yield* decide([...rules, rule("deny", "*", "**")], claims)
            if (sealed === rank.allow || (unparsed.length < claims.length && sealed !== rank.denied)) {
              violations.push(`a trailing deny-all did not deny: ${told}`)
            }
            return verdict(violations)
          }),
        { executions: pureExecutions, seed: seed + 5 }
      )
    )
    assertPassed(report)
  })

  it("jsonBoundary accepts exactly strict JSON, copies it, and reads every property once", async () => {
    const before = hostFingerprint()

    interface Built {
      readonly value: unknown
      readonly expected: unknown
      readonly ok: boolean
    }

    const report = await Effect.runPromise(
      Fuzz.run(
        tapeArbitrary,
        ({ tape: values }) =>
          Effect.sync(() => {
            const tape = tapeOf(values)
            const violations: Array<string> = []
            const inputs = new WeakSet<object>()
            const reads: Array<{ count: number }> = []
            const track = <A extends object>(value: A): A => {
              inputs.add(value)
              return value
            }
            const hostile = (value: unknown): Built => ({ expected: undefined, ok: false, value })

            const build = (depth: number): Built => {
              const choice = tape.next(depth <= 0 ? 30 : 38)
              switch (choice) {
                case 0:
                  return hostile(Number.NaN)
                case 1:
                  return hostile(tape.next(2) === 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)
                case 2:
                  return hostile(10n ** 30n)
                case 3:
                  return hostile(undefined)
                case 4:
                  return hostile(Symbol("s"))
                case 5:
                  return hostile(() => 1)
                case 6:
                  return hostile(pick(tape, ["\ud800", "a\udc00", "\ud83d", "\udc00\ud800"]))
                case 7:
                  return hostile(new Date(0))
                case 8:
                  return hostile(new Map([[1, 2]]))
                case 9:
                  return hostile(Object(1))
                case 10:
                  return hostile(
                    new (class Custom {
                      readonly a = 1
                    })()
                  )
                case 11: {
                  const sparse: Array<unknown> = [1]
                  sparse[2] = 3
                  return hostile(sparse)
                }
                case 12:
                  return hostile(
                    new Proxy({}, {
                      ownKeys: () => {
                        throw new Error("ownKeys trap")
                      }
                    })
                  )
                case 13:
                  return hostile(Object.defineProperty({}, "boom", {
                    enumerable: true,
                    get: () => {
                      throw new Error("getter")
                    }
                  }))
                case 14: {
                  const cyclic: Record<string, unknown> = { a: [1] }
                  ;(cyclic["a"] as Array<unknown>).push(cyclic)
                  return hostile(cyclic)
                }
                case 15: {
                  const keyed: Record<string, unknown> = {}
                  setOwn(keyed, "bad\ud800key", 1)
                  return hostile(keyed)
                }
                case 16:
                  return hostile(Object.create({ inherited: 1 }))
                case 17:
                  return hostile(new Uint8Array(2))
                case 18:
                  return hostile({ toJSON: () => "laundered" })
                case 19: {
                  // An accessor that answers differently on every read: only the first answer may cross.
                  const counter = { count: 0 }
                  reads.push(counter)
                  return {
                    expected: { once: 1 },
                    ok: true,
                    value: track(Object.defineProperty({}, "once", {
                      enumerable: true,
                      get: () => {
                        counter.count = counter.count + 1
                        return counter.count
                      }
                    }))
                  }
                }
                case 20: {
                  const bare = track(Object.create(null) as Record<string, unknown>)
                  setOwn(bare, "__proto__", { polluted: true })
                  setOwn(bare, "constructor", { prototype: { pwned: true } })
                  return {
                    expected: JSON.parse(
                      "{\"__proto__\":{\"polluted\":true},\"constructor\":{\"prototype\":{\"pwned\":true}}}"
                    ),
                    ok: true,
                    value: bare
                  }
                }
                case 21:
                  return { expected: { a: 1 }, ok: true, value: track(new Proxy({ a: 1 }, {})) }
                case 22: {
                  const decorated = track({ a: 1 })
                  Object.defineProperty(decorated, "hidden", { enumerable: false, value: 2 })
                  Object.defineProperty(decorated, Symbol("s"), { enumerable: true, value: 3 })
                  return { expected: { a: 1 }, ok: true, value: decorated }
                }
                case 23: {
                  const shared = track([1, { a: 2 }])
                  return { expected: [[1, { a: 2 }], [1, { a: 2 }]], ok: true, value: track([shared, shared]) }
                }
                case 24:
                  return { expected: 0, ok: true, value: -0 }
                case 25:
                  return { expected: [1, 2], ok: true, value: track(Object.freeze([1, 2])) }
                default: {
                  if (choice < 30) {
                    const leaf = genJson(tape, 0)
                    return { expected: leaf, ok: true, value: leaf }
                  }
                  const children = Array.from({ length: 1 + tape.next(3) }, () => build(depth - 1))
                  const ok = children.every((child) => child.ok)
                  if (choice < 34) {
                    return {
                      expected: children.map((child) => child.expected),
                      ok,
                      value: track(children.map((child) => child.value))
                    }
                  }
                  const value: Record<string, unknown> = track({})
                  const expected: Record<string, unknown> = {}
                  children.forEach((child, index) => {
                    const key = `${pick(tape, keyPool)}${index}`
                    setOwn(value, key, child.value)
                    setOwn(expected, key, child.expected)
                  })
                  return { expected, ok, value }
                }
              }
            }

            const built = build(3)
            // Top-level `undefined` is the one hostile value that crosses, as null.
            const top = built.value === undefined
            const result = JsonBoundary.jsonBoundary(built.value)
            if ((result._tag === "Ok") !== (built.ok || top)) {
              violations.push(
                `the boundary ${result._tag === "Ok" ? "accepted a hostile" : "refused a strict JSON"} value`
              )
            }
            if (result._tag === "Ok") {
              if (!jsonEquals(result.value, top ? null : built.expected)) {
                violations.push(`the boundary changed a value it accepted: ${JSON.stringify(result.value)}`)
              }
              const seen = new Set<object>()
              const walk = (value: unknown): void => {
                if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
                  violations.push("a non-finite number or negative zero crossed")
                }
                if (!isContainer(value)) return
                if (inputs.has(value)) violations.push("the copy shares an object with the input")
                if (seen.has(value)) violations.push("the copy is not a tree")
                seen.add(value)
                const prototype: unknown = Object.getPrototypeOf(value)
                if (prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype)) {
                  violations.push("the copy carries a foreign prototype")
                }
                for (const key of Reflect.ownKeys(value)) {
                  if (Array.isArray(value) && key === "length") continue
                  const descriptor = Object.getOwnPropertyDescriptor(value, key)
                  if (
                    typeof key !== "string" || descriptor === undefined || !("value" in descriptor) ||
                    !descriptor.enumerable
                  ) {
                    violations.push("the copy carries a property that is not plain enumerable data")
                    continue
                  }
                  walk(descriptor.value)
                }
              }
              walk(result.value)
              const again = JsonBoundary.jsonBoundary(result.value)
              const text = Digest.canonical(result.value)
              if (again._tag !== "Ok" || Digest.canonical(again.value) !== text) {
                violations.push("the boundary is not idempotent on its own output")
              }
              if (!jsonEquals(JSON.parse(JSON.stringify(result.value)), result.value)) {
                violations.push("an accepted value does not survive a JSON round trip")
              }
              const outcome = JsonBoundary.decodeOutcome({ _tag: "Done", value: result.value })
              if (
                Option.isNone(outcome) ||
                Digest.canonical(outcome.value) !== Digest.canonical(Outcome.done(result.value as Json))
              ) {
                violations.push("an accepted value is not a valid Done payload")
              }
              if (built.ok && reads.some((counter) => counter.count !== 1)) {
                violations.push("an accepted accessor was not read exactly once")
              }
            }
            if (reads.some((counter) => counter.count > 1)) violations.push("an accessor was read twice")

            // The depth cap is exact, for arrays, objects and their mix.
            const depth = JsonBoundary.maxJsonDepth - 3 + tape.next(7)
            const style = tape.next(3)
            let nested: unknown = pick<unknown>(tape, [0, "leaf", null])
            for (let level = 0; level < depth; level = level + 1) {
              nested = style === 0 || (style === 2 && level % 2 === 0) ? [nested] : { k: nested }
            }
            if ((JsonBoundary.jsonBoundary(nested)._tag === "Ok") !== (depth <= JsonBoundary.maxJsonDepth)) {
              violations.push(`a value nested ${depth} deep landed on the wrong side of the depth cap`)
            }
            violations.push(...hostIntact(before))
            return verdict(violations)
          }),
        { executions: pureExecutions, seed: seed + 6 }
      )
    )
    assertPassed(report)
  })

  it("the size budget is exact and a shared-reference bomb is refused without being expanded", () => {
    const fits = "x".repeat(JsonBoundary.maxJsonSize - 1)
    expect(JsonBoundary.jsonBoundary(fits)._tag).toBe("Ok")
    expect(JsonBoundary.jsonBoundary(`${fits}x`)._tag).toBe("Refused")
    expect(JsonBoundary.jsonBoundary([fits])._tag).toBe("Refused")
    const key: Record<string, unknown> = {}
    key[fits] = 1
    expect(JsonBoundary.jsonBoundary(key)._tag).toBe("Refused")
    // Nine references to one megabyte string are nine megabytes once serialized.
    const megabyte = "y".repeat(1024 * 1024)
    expect(JsonBoundary.jsonBoundary(Array.from({ length: 7 }, () => megabyte))._tag).toBe("Ok")
    expect(JsonBoundary.jsonBoundary(Array.from({ length: 9 }, () => megabyte))._tag).toBe("Refused")
    // 2^40 leaves through 40 levels of sharing: refused by budget, never walked to the end.
    let bomb: unknown = "leaf"
    for (let level = 0; level < 40; level = level + 1) bomb = [bomb, bomb]
    expect(JsonBoundary.jsonBoundary(bomb)._tag).toBe("Refused")
    expect(QuickJsRunner.decodeCallInput(JSON.stringify(`${fits}x`)).refusal).toBe(JsonBoundary.unserializableInput)
    expect(QuickJsRunner.decodeCallInput("{\"a\":").refusal).toBe(JsonBoundary.unserializableInput)
    expect(QuickJsRunner.decodeCallInput("{\"__proto__\":{\"polluted\":true}}").refusal).toBeUndefined()
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
  })

  it("both runner bindings agree on every hostile value a script can build", async () => {
    const runners = await loadRunners()
    const expressions = [
      "0 / 0",
      "-0",
      "1 / 0",
      "undefined",
      "[undefined]",
      "({ a: undefined })",
      "(() => 1)",
      "({ f() {} })",
      "Symbol.iterator",
      "[, 1]",
      "new Array(3)",
      "\"\\ud800\"",
      "\"\\ud83d\\ude00\"",
      "({ [\"\\udc00\"]: 1 })",
      "Object.create(null)",
      "Object.create({ inherited: 1 })",
      "({ get a() { return 1 } })",
      "({ get a() { throw new Error(\"boom\") } })",
      "(() => { let n = 0; return { get a() { n += 1; return n } } })()",
      "new Proxy({}, { ownKeys() { throw new Error(\"trap\") } })",
      "new Proxy({ a: 1 }, {})",
      "new Proxy([1, 2, 3], { get(t, k, r) { return k === \"length\" ? 2 : Reflect.get(t, k, r) } })",
      "(() => { const a = {}; a.self = a; return a })()",
      "(() => { const a = [1]; return [a, a] })()",
      "new (class K { constructor() { this.a = 1 } })()",
      "new Map([[1, 2]])",
      "new Uint8Array(2)",
      "new Number(1)",
      "new String(\"s\")",
      "JSON.parse('{\"__proto__\":{\"polluted\":true},\"constructor\":{\"prototype\":{\"pwned\":1}}}')",
      "({ __proto__: null, a: 1 })",
      "({ __proto__: { a: 1 } })",
      "Object.freeze({ a: [1] })",
      "({ toJSON() { return 1 } })",
      "({ toJSON: 1 })",
      "({ then: 1 })",
      "[1, [2, [3, { a: null }]]]",
      "1e21",
      "5e-324",
      "2 ** 53",
      "({ \"\": \"\" })",
      "({ \"\\u0000\": \"\\u0000\" })",
      "Object.assign([1, 2], { extra: 1 })",
      "Object.defineProperty({}, \"hidden\", { value: 1, enumerable: false })",
      "({ [Symbol(\"s\")]: 1, a: 1 })",
      "(function () { return arguments })(1, 2)",
      "/re/",
      "new Error(\"e\")",
      "globalThis",
      "ctx",
      "done",
      "Promise.resolve(1)",
      "({ _tag: \"To\", script: { text: \"return done(1)\", digest: \"forged\" } })",
      "({ _tag: \"To\", script: \"return done(2)\" })",
      "({ _tag: \"Done\", value: 1, extra: 2 })",
      "({ _tag: \"Done\" })",
      "({ _tag: \"Park\", reason: { code: \"bogus\", message: \"\" } })",
      "({ _tag: \"Park\", reason: { code: \"timer\", message: \"m\" } })",
      "({ then(resolve) { resolve(done(1)) } })",
      "(() => { let x = 0; for (let i = 0; i < DEPTH; i++) x = [x]; return x })()",
      "(() => { let x = 0; for (let i = 0; i < DEPTH; i++) x = { k: x }; return x })()"
    ] as const
    const modes = [
      (expression: string) => `return done(${expression})`,
      (expression: string) => `const r = await ctx.call("echo", ${expression}); return done(r)`,
      (expression: string) =>
        `try { const r = await ctx.call("echo", ${expression}); return done(["ok", r]) } catch (e) { return done(["refused", String(e && e.message)]) }`,
      (expression: string) => `return ${expression}`,
      (expression: string) => `return to(${expression})`,
      (expression: string) => `return park("event", ${expression})`,
      (expression: string) => `return park(${expression})`,
      (expression: string) => `const r = await ctx.call(${expression}, 1); return done(r)`,
      (expression: string) =>
        `try { await ctx.call("hostile", ${expression}) } catch (e) { return done(String(e && e.message)) } return done("crossed")`
    ] as const
    const before = hostFingerprint()
    // Both bindings enforce strict well-formed Unicode on call names too, so names match byte-for-byte.

    const report = await Effect.runPromise(
      Fuzz.run(
        tapeArbitrary,
        ({ tape: values }) =>
          Effect.gen(function*() {
            const tape = tapeOf(values)
            const violations: Array<string> = []
            const expression = pick(tape, expressions).replace(
              "DEPTH",
              String(JsonBoundary.maxJsonDepth - 3 + tape.next(6))
            )
            const text = pick(tape, modes)(expression)
            const script = Script.make(text)

            const under = (runner: Layer.Layer<ScriptRunner.ScriptRunner>) =>
              Effect.gen(function*() {
                const received: Array<unknown> = []
                const result = yield* Effect.result(
                  Effect.flatMap(ScriptRunner.ScriptRunner, (service) =>
                    service.run(script, (request) =>
                      Effect.sync(() => {
                        received.push({ name: request.name, payload: request.payload })
                        if (typeof request.name !== "string") violations.push("a call crossed without a string name")
                        const payload = JsonBoundary.jsonBoundary(request.payload)
                        if (payload._tag === "Refused" || !jsonEquals(payload.value, request.payload)) {
                          violations.push("a call payload reached the host without being strict JSON")
                        }
                        if (isContainer(request.payload) && !Array.isArray(request.payload)) {
                          if (Object.getPrototypeOf(request.payload) !== Object.prototype) {
                            violations.push("a call payload reached the host with a foreign prototype")
                          }
                        }
                        // The host answers a hostile entry with a value that is not JSON.
                        return request.name === "hostile"
                          ? {
                            leak: () =>
                              process.env
                          }
                          : { got: request.payload }
                      }))).pipe(Effect.provide(runner))
                )
                const summary = Result.isSuccess(result)
                  ? `ok ${Digest.canonical(result.success)}`
                  : `${result.failure.code} ${result.failure.message}`
                if (Result.isSuccess(result)) {
                  const decoded = JsonBoundary.decodeOutcome(JSON.parse(JSON.stringify(result.success)))
                  if (Option.isNone(decoded) || Digest.canonical(decoded.value) !== Digest.canonical(result.success)) {
                    violations.push(`a runner returned something that is not a canonical outcome: ${summary}`)
                  }
                  if (
                    result.success._tag === "To" &&
                    result.success.script.digest !== Script.make(result.success.script.text).digest
                  ) {
                    violations.push("a runner returned a successor with a digest its text does not derive")
                  }
                } else if (result.failure.message.startsWith(QuickJsRunner.hostDefectMarker)) {
                  violations.push(`a hostile value crashed the realm machinery: ${summary}`)
                }
                return `${summary} | calls ${Digest.canonical(received)}`
              })

            const inProcess = yield* under(runners.inProcess)
            const quickJs = yield* under(runners.quickJs)
            if (inProcess !== quickJs) {
              violations.push(
                `the bindings disagree on ${
                  JSON.stringify(text)
                }:\n  in-process: ${inProcess}\n  quickjs:    ${quickJs}`
              )
            }
            violations.push(...hostIntact(before))
            return verdict(violations)
          }),
        { executions: Math.max(ioExecutions, Math.min(baseExecutions, 120)), seed: seed + 7 }
      )
    )
    assertPassed(report)
  })

  it("a call name with an unpaired surrogate is refused at the boundary identically in both bindings", async () => {
    const runners = await loadRunners()
    for (const runner of [runners.inProcess, runners.quickJs]) {
      for (const name of ["\ud800", "a\udc00b", "\udc00\ud800", "echo\ud83d"]) {
        let dispatched = 0
        const entry = (declared: string): Catalog.Entry => ({
          description: "must never be reached through an ill-formed name",
          handler: () =>
            Effect.sync(() => {
              dispatched = dispatched + 1
              return "dispatched"
            }),
          name: declared
        })
        const layers = Layer.mergeAll(
          Journal.layerMemory(),
          Author.layerFn((input) =>
            input.context.length > 1
              ? flow("return done(\"recovered\")")
              : flow(`return done(await ctx.call(${JSON.stringify(name)}, 1))`)
          ),
          runner,
          Catalog.layer([entry("echo"), entry("a"), entry("b"), entry("ab"), entry("\ufffd\ufffd\ufffd")])
        )
        const { events, outcome } = await Effect.runPromise(
          Effect.gen(function*() {
            const outcome = yield* Chain.run({ goal: "call an ill-formed name" })
            const events = yield* Effect.flatMap(Journal.Journal, (journal) => journal.read)
            return { events, outcome }
          }).pipe(Effect.provide(layers))
        )
        expect(outcome).toEqual(Outcome.done("recovered"))
        expect(dispatched).toBe(0)
        expect(
          events.flatMap((event) =>
            event._tag === "GateRejected" ? [{ kind: event.observation.kind, message: event.observation.message }] : []
          )
        ).toEqual([{ kind: "script_failed", message: `runtime: ${JsonBoundary.missingCallName}` }])
        // Canonical JSON refuses an unpaired surrogate, so this throws if one reached the journal.
        expect(Digest.canonical(events)).not.toBe("")
      }
    }
  })

  it("mutated scripts end in an outcome or a typed failure, and never pass a failed handler", async () => {
    const bases = [
      "const r = await ctx.call(\"echo\", { n: 1 }); return done(r)",
      "let t = 0; for (let i = 0; i < 50; i++) { t += i } return done(t)",
      "try { await ctx.call(\"boom\", null) } catch (e) { return done(\"caught\") } return park(\"event\", \"x\")",
      "const xs = [1, 2, 3].map((x) => x * 2); return to(\"return done(\" + JSON.stringify(xs) + \")\")",
      "const o = { a: { b: [1, \"two\", null] } }; const s = JSON.stringify(o); return done(JSON.parse(s))",
      "const [a, b] = await Promise.all([ctx.call(\"echo\", 1), ctx.call(\"echo\", 2)]); return done([a, b])",
      "for (let i = 0; ; i++) { await ctx.call(\"echo\", i) }"
    ] as const
    const tokens = [
      "}",
      "{",
      ")",
      "(",
      "})()",
      "(async () => {",
      "`",
      "${",
      "*/",
      "/*",
      "//",
      "\n",
      "\r\n",
      "\u2028",
      "\u0000",
      "\\",
      "'",
      "\"",
      " await ",
      " yield ",
      " return ",
      "while(true){}",
      "for(;;);",
      "for(;;) await 0;",
      "globalThis.__seal",
      "__body",
      "__seal(__body)",
      "delete globalThis.ctx;",
      "ctx.call = 1;",
      "ctx.call(\"echo\", globalThis);",
      "Object.prototype.toJSON = () => 1;",
      "Object.prototype.polluted = true;",
      "import('node:fs')",
      "eval('1')",
      "new Function('return this')()",
      " this ",
      " arguments ",
      "<!--",
      "-->",
      "#!",
      "0n",
      "\\u{110000}",
      " async ",
      "function*",
      "=>",
      ";",
      "class A extends B {}",
      "label:",
      "debugger;",
      "with({}){}",
      "super()",
      "new.target",
      "import.meta",
      "export default 1;",
      "'use strict';",
      "throw null;",
      "(function f(){ f() })();",
      "\ud83d\ude00"
    ] as const
    const fuel = 12
    const sandbox = await Effect.runPromise(QuickJsRunner.make({ memoryBytes: 4 * 1024 * 1024, steps: 12 }))
    const before = hostFingerprint()

    class Refused extends Schema.TaggedError<Refused>()("/test/Refused", { why: Schema.String }) {}

    const report = await Effect.runPromise(
      Fuzz.run(
        tapeArbitrary,
        ({ tape: values }) =>
          Effect.gen(function*() {
            const tape = tapeOf(values)
            const violations: Array<string> = []
            let text: string = pick(tape, bases)
            const mutations = tape.next(4)
            for (let index = 0; index < mutations; index = index + 1) {
              const at = tape.next(text.length + 1)
              const operation = tape.next(10)
              if (operation === 0) text = text.slice(0, at)
              else if (operation === 1) text = text.slice(0, at) + text.slice(at + 1 + tape.next(6))
              else if (operation === 2) text = text.slice(0, at) + text.slice(Math.max(0, at - 8), at) + text.slice(at)
              else if (operation <= 5) text = text.slice(0, at) + pick(tape, tokens) + text.slice(at)
              // A hostile statement ahead of an otherwise valid script usually still parses.
              else text = `${pick(tape, tokens)}\n${text}`
            }
            // A cut may split a surrogate pair; an unpaired surrogate is not script text.
            text = text.replace(/\p{Cs}/gu, "?")

            let calls = 0
            let refusal: Refused | undefined
            const result = yield* Effect.result(sandbox.run(Script.make(text), (request) =>
              Effect.suspend(() => {
                calls = calls + 1
                if (refusal !== undefined) violations.push("a handler was contacted after an earlier handler failed")
                if (typeof request.name !== "string") violations.push("a call crossed without a string name")
                if (JsonBoundary.jsonBoundary(request.payload)._tag === "Refused") {
                  violations.push("a call payload crossed the bridge without being strict JSON")
                }
                if (request.name === "boom" || calls > fuel) {
                  refusal = new Refused({ why: request.name === "boom" ? "boom" : "fuel" })
                  return Effect.fail(refusal)
                }
                return Effect.succeed({ got: request.payload })
              })))
            const told = JSON.stringify(text)
            if (refusal !== undefined) {
              // The script may catch the rejection in-realm; the run still fails with the handler's error.
              if (Result.isSuccess(result) || result.failure !== refusal) {
                violations.push(`a script continued past a failed handler: ${told}`)
              }
            } else if (Result.isFailure(result)) {
              const failure = result.failure
              if (failure._tag !== "/chain/ScriptFailure") {
                violations.push(`a run failed with something other than a script failure: ${told}`)
              } else {
                if (!["compile", "runtime", "invalid_outcome"].includes(failure.code)) {
                  violations.push(`a mutated script reported ${failure.code}: ${told}`)
                }
                if (failure.message.startsWith(QuickJsRunner.hostDefectMarker)) {
                  violations.push(`a mutated script crashed the realm machinery (${failure.message}): ${told}`)
                }
              }
            } else {
              const decoded = JsonBoundary.decodeOutcome(JSON.parse(JSON.stringify(result.success)))
              if (Option.isNone(decoded) || Digest.canonical(decoded.value) !== Digest.canonical(result.success)) {
                violations.push(`a mutated script returned something that is not an outcome: ${told}`)
              }
            }
            if (calls > fuel + 1) violations.push(`a script issued ${calls} calls past a handler that refused: ${told}`)
            violations.push(...hostIntact(before))
            return verdict(violations)
          }),
        { executions: Math.max(ioExecutions, Math.min(baseExecutions, 120)), seed: seed + 8 }
      )
    )
    assertPassed(report)
  })

  // KNOWN DEFECT, deliberately absent from the bomb list below because it cannot finish inside a
  // test budget: the step budget does not bound a script that catches its own stack overflow and
  // recurses again,
  //
  //   const f = () => { try { f() } catch (e) { f() } }; f()
  //
  // Each overflow builds a backtrace of the whole 256 KiB stack, so QuickJS reaches its interrupt
  // poll roughly once every 3.5 s. Measured on this suite's host: 141 s of synchronous host-thread
  // time at `steps: 40`, and no return within 4 minutes at the default `steps: 10_000`. The run
  // does end typed (`runtime: interrupted`); the bound is what is missing.
  it("the realm bounds every resource, exposes no host state, and keeps nothing between runs", async () => {
    const before = hostFingerprint()
    const tight = await Effect.runPromise(QuickJsRunner.make({ memoryBytes: 1024 * 1024, steps: 40 }))
    const roomy = await Effect.runPromise(QuickJsRunner.make())
    const received: Array<ScriptRunner.Request> = []
    const warnings: Array<unknown> = []
    const quiet = Logger.layer([Logger.make<unknown, void>(({ message }) => {
      warnings.push(message)
    })])
    const run = (runner: ScriptRunner.Service, text: string) =>
      Effect.runPromise(
        Effect.result(runner.run(Script.make(text), (request) =>
          Effect.sync(() => {
            received.push(request)
            return { got: request.payload }
          }))).pipe(Effect.provide(quiet))
      ).then((result): { readonly outcome: unknown; readonly tag: string } =>
        Result.isSuccess(result)
          ? { outcome: result.success, tag: "ok" }
          : { outcome: result.failure.message, tag: result.failure.code }
      )
    const done = (value: unknown) => ({ outcome: { _tag: "Done", value }, tag: "ok" })

    // Every bomb ends typed, inside its budget, with the script's own failure (never the host's).
    const bombs = [
      "while (true) {}",
      "for (;;) await 0",
      "const spin = () => Promise.resolve().then(spin); spin(); await new Promise(() => {})",
      "(function f() { f() })()",
      "const a = []; for (;;) a.push(new Array(1000).fill(0))",
      "let s = \"x\"; for (;;) s += s",
      "return done(/(a+)+$/.test(\"a\".repeat(40) + \"b\"))",
      "const o = {}; let c = o; for (;;) { c.n = {}; c = c.n }",
      "return done(\"x\".repeat(1e9))",
      "await new Promise(() => {})"
    ]
    for (const bomb of bombs) {
      const result = await run(tight, bomb)
      expect([bomb, result.tag]).toEqual([bomb, "runtime"])
      expect(String(result.outcome).startsWith(QuickJsRunner.hostDefectMarker)).toBe(false)
    }
    expect((await run(tight, "await new Promise(() => {})")).outcome).toBe(JsonBoundary.neverSettles)
    expect(warnings).toEqual([])

    // Native parser recursion is not bounded by the in-realm stack limit: it exhausts the HOST
    // stack. That must surface typed and labelled as the host's, be logged, and leave the shared
    // module able to run the next script.
    const hostStack = [
      "return done(JSON.parse(\"[\".repeat(100000)))",
      "return done(eval(\"(\".repeat(50000) + \"1\" + \")\".repeat(50000)))"
    ]
    for (const [index, bomb] of hostStack.entries()) {
      const result = await run(tight, bomb)
      expect([bomb, result.tag]).toEqual([bomb, "runtime"])
      expect(String(result.outcome).startsWith(QuickJsRunner.hostDefectMarker)).toBe(true)
      expect(warnings.length).toBe(index + 1)
      expect(await run(tight, `return done(${index})`)).toEqual(done(index))
      expect(await run(roomy, `return done(await ctx.call("echo", ${index}))`)).toEqual(done({ got: index }))
    }

    // No host capability is reachable, by name or through any constructor.
    const probes = [
      "typeof process",
      "typeof require",
      "typeof module",
      "typeof Date",
      "typeof Math.random",
      "typeof queueMicrotask",
      "typeof fetch",
      "typeof console",
      "typeof WebAssembly",
      "typeof globalThis.__call",
      "typeof globalThis.__seal",
      "typeof globalThis.__source",
      "Function(\"return typeof process\")()",
      "(0, eval)(\"typeof process\")",
      "ctx.call.constructor(\"return typeof process\")()",
      "done.constructor(\"return typeof require\")()",
      "Object.getPrototypeOf(async () => {}).constructor(\"return typeof process\")().then === undefined ? \"object\" : \"undefined\""
    ]
    expect(await run(roomy, `return done([${probes.join(", ")}])`)).toEqual(done(probes.map(() => "undefined")))
    expect((await run(roomy, "const fs = await import(\"node:fs\"); return done(typeof fs)")).tag).toBe("runtime")
    expect(await run(roomy, "return done([Object.isFrozen(ctx), Object.keys(ctx)])")).toEqual(done([true, ["call"]]))
    // The seal is a lexical binding the body can name, so it must refuse any body but the authored one.
    expect(
      await run(
        roomy,
        "try { return done(await __seal(async () => done(\"pwn\"))) } catch (e) { return done(String(e.message)) }"
      )
    ).toEqual(done(QuickJsRunner.escapedWrapper))

    // Replacing a realm intrinsic or prototype hook cannot change what crosses.
    expect(
      await run(
        roomy,
        "Object.prototype.toJSON = () => \"pwn\"; Array.prototype.toJSON = () => \"pwn\"; return done([1, { a: 2 }])"
      )
    ).toEqual(done([1, { a: 2 }]))
    expect((await run(roomy, "Number.isFinite = () => true; return done(0 / 0)")).tag).toBe("invalid_outcome")
    expect(await run(roomy, "JSON.stringify = () => '{\"_tag\":\"Done\",\"value\":\"pwn\"}'; return done(1)")).toEqual(
      done(1)
    )
    expect(await run(roomy, "Promise.prototype.then = function () { return \"pwn\" }; return done(1)")).toEqual(done(1))
    expect(await run(roomy, "Object.keys = () => []; Array.isArray = () => false; return done({ a: [1] })")).toEqual(
      done({ a: [1] })
    )
    expect(
      await run(roomy, "Object.defineProperty = () => {}; Object.create = () => ({ pwn: 1 }); return done({ a: 1 })")
    )
      .toEqual(done({ a: 1 }))
    expect((await run(roomy, "globalThis.done = (v) => ({ _tag: \"Done\", value: \"pwn\" }); return done(1)")).outcome)
      .toEqual({ _tag: "Done", value: "pwn" })
    received.length = 0
    expect(
      await run(
        roomy,
        "Object.prototype.toJSON = () => \"pwn\"; JSON.parse = () => ({ ok: true, value: \"pwn\" }); return done(await ctx.call(\"echo\", { a: [1] }))"
      )
    ).toEqual(done({ got: { a: [1] } }))
    expect(received).toEqual([{ name: "echo", payload: { a: [1] } }])

    // Pollution keys cross as inert own data, in both directions.
    received.length = 0
    const polluted =
      "JSON.parse('{\"__proto__\":{\"polluted\":true},\"constructor\":{\"prototype\":{\"pwned\":true}}}')"
    const crossed = await run(roomy, `return done(await ctx.call("echo", ${polluted}))`)
    const payload = received[0]?.payload
    expect(isContainer(payload) && Object.getPrototypeOf(payload) === Object.prototype).toBe(true)
    expect(isContainer(payload) && Object.keys(payload)).toEqual(["__proto__", "constructor"])
    expect(JSON.stringify(crossed.outcome)).toBe(
      "{\"_tag\":\"Done\",\"value\":{\"got\":{\"__proto__\":{\"polluted\":true},\"constructor\":{\"prototype\":{\"pwned\":true}}}}}"
    )

    // A wrapper escape runs before the seal: it reaches no handler and fails as the escape.
    received.length = 0
    for (
      const escape of [
        "}; ctx.call(\"echo\", \"escaped\"); const z = async () => {",
        "return done(1)\n}\nctx.call(\"echo\", \"escaped\")\nconst z = async () => {",
        "}; globalThis.__seal = async () => '{\"_tag\":\"Done\",\"value\":\"pwn\"}'; const z = async () => {",
        "}; Promise.resolve().then(() => ctx.call(\"echo\", \"queued\")); const z = async () => {"
      ]
    ) {
      const result = await run(roomy, escape)
      expect([escape, result.tag, result.outcome]).toEqual([escape, "runtime", QuickJsRunner.escapedWrapper])
    }
    expect(received).toEqual([])
    expect((await run(roomy, "return done(1) })(); ctx.call(\"echo\", 1); (async () => {")).tag).toBe("compile")
    expect(received).toEqual([])

    // Each run gets a fresh realm: nothing a script leaves behind is visible to the next.
    await run(
      roomy,
      "globalThis.leak = \"secret\"; Object.prototype.leak = \"secret\"; Array.prototype.toJSON = () => \"secret\"; return done(1)"
    )
    expect(await run(roomy, "return done([typeof leak, typeof ({}).leak, typeof [].toJSON, [1]])")).toEqual(
      done(["undefined", "undefined", "undefined", [1]])
    )

    // A host handler defect kills the run in both bindings; it is never laundered into a script failure.
    const defect = new Error("host handler defect")
    for (
      const runner of [
        roomy,
        await Effect.runPromise(
          Effect.flatMap(ScriptRunner.ScriptRunner, Effect.succeed).pipe(Effect.provide(ScriptRunner.layerInProcess))
        )
      ]
    ) {
      const died = await Effect.runPromise(
        Effect.result(
          runner.run(
            Script.make("try { await ctx.call(\"echo\", 1) } catch (e) { return done(\"caught\") } return done(2)"),
            (): Effect.Effect<unknown> => {
              throw defect
            }
          ).pipe(
            Effect.map((): unknown => "returned"),
            Effect.catchDefect((caught) => Effect.succeed(caught))
          )
        )
      )
      expect(Result.isSuccess(died) ? died.success : died.failure.message).toBe(defect)
    }
    expect(hostIntact(before)).toEqual([])
  })
})
