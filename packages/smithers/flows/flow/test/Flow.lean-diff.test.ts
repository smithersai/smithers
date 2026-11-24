/**
 * The retry policy, the allocation scope, the capability ceilings and the static checks of `Flow.make` against their
 * Lean 4 reference specification (`spec/lean/flow`), generated: every case is answered by the implementation and by
 * the specification's compiled oracle, and the two answers must be equal, to the bit for a double and to the code
 * unit for a text.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A text crosses as its UTF-16 code units and a double as the decimal text of its 64 bits, so a lone surrogate,
 * an infinity and a negative zero all arrive as they left.
 *
 * An oracle is evidence only for the sources it was built from, so its freshness is decided by content, never by a
 * modification time (`./LeanOracle.ts`): a build records the fingerprint of the specification's whole source tree
 * beside the oracle, and the oracle is fresh only while that fingerprint is the tree's. A machine with `lake` builds
 * the oracle whenever it is not fresh. A machine without `lake` runs only against a fresh oracle and otherwise skips
 * the file, naming why. A specification that is present but missing a source fails the file: it is neither skipped
 * nor answered by an oracle built from something else. A run shown no specification at all skips.
 */
import { Capability } from "@smthrs/capability"
import { Sha256 } from "@smthrs/crypto"
import { Fuzz } from "@smthrs/fuzz"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Flow, RetryPolicy, StepIdentity } from "../src/index.ts"
import { key, runSync } from "./Crypto.ts"
import * as LeanOracle from "./LeanOracle.ts"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "flow")
const binary = join(specDir, ".lake", "build", "bin", "flow-spec")
const elan = join(homedir(), ".elan", "bin")
const lake = [...(process.env["PATH"] ?? "").split(delimiter).filter((directory) => directory !== ""), elan]
  .map((directory) => join(directory, "lake"))
  .find((path) => existsSync(path))
const specification: LeanOracle.Specification = {
  directory: specDir,
  binary,
  required: ["Main.lean", "FlowSpec.lean", "FlowSpec/Basic.lean", "lakefile.toml", "lean-toolchain"],
  library: "FlowSpec"
}
const current = LeanOracle.sources(specification)

/**
 * Why the differential cases cannot run, or `undefined` when they can. An oracle whose manifest does not name the
 * sources as they are is not evidence, so without `lake` to rebuild it the file skips rather than passes against it.
 */
const unavailable: string | undefined = !existsSync(specDir)
  ? "the specification is not visible to this run"
  : current._tag === "Incomplete"
  ? `the specification is missing ${current.missing.map(LeanOracle.shown).join(", ")}`
  : lake !== undefined
  ? undefined
  : LeanOracle.stale(specification, current)
  ? "the built oracle was not built from the specification as it is, and lake is unavailable to rebuild it"
  : undefined
const oracleReady = unavailable === undefined
const differential = it.skipIf(!oracleReady)

// A specification that is here but incomplete is a broken checkout, not a confined run: it fails.
it.skipIf(!existsSync(specDir))("the specification's source tree is complete", () => {
  expect(current).toMatchObject({ _tag: "Complete" })
})

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
  if (lake !== undefined && current._tag === "Complete" && LeanOracle.stale(specification, current)) {
    const built = spawnSync(lake, ["build"], {
      cwd: specDir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${elan}${delimiter}${process.env["PATH"] ?? ""}` }
    })
    if (built.status !== 0) throw new Error(`lake build failed in ${specDir}:\n${built.stdout}\n${built.stderr}`)
    // The build read the sources after they were fingerprinted; record it only if they did not change meanwhile.
    const after = LeanOracle.sources(specification)
    if (after._tag !== "Complete" || after.fingerprint !== current.fingerprint) {
      throw new Error(`the specification in ${specDir} changed while it was being built`)
    }
    LeanOracle.record(specification, current)
  }
  oracle = start()
})

afterAll(() => {
  if (oracleReady) oracle.close()
})

// --- the wire -------------------------------------------------------------------------------------------------------

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

/** An absent option on the wire. */
const orNull = <A, B>(value: A | undefined, encode: (value: A) => B): B | null =>
  value === undefined ? null : encode(value)

/** Fails with both answers unless the implementation's answer is the specification's. */
const same = (what: string, actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${what}: the implementation answered ${left} and the specification ${right}`)
}

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

/** A value that is absent about one time in three. */
const maybe = <A>(item: Arbitrary.Arbitrary<A>): Arbitrary.Arbitrary<A | undefined> =>
  Arbitrary.map(Arbitrary.all([int(0, 2), item]), ([choice, value]) => (choice === 0 ? undefined : value))

/** Mostly the first generator, sometimes the second: valid inputs go deep and hostile ones still arrive. */
const mostly = <A>(usual: Arbitrary.Arbitrary<A>, rare: Arbitrary.Arbitrary<A>): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(Arbitrary.all([int(0, 5), usual, rare]), ([choice, first, second]) => (choice === 0 ? second : first))

/** Runs the property over generated values and fails the test with the shrunk counterexample. */
const holds = async <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (value: A) => Promise<void>): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(arbitrary, (value) => Effect.tryPromise(async () => (await property(value), true)), { seed, executions })
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) expect.fail(failure)
  expect(report._tag === "Passed").toBe(true)
}

/** Every double a hostile caller or a corrupt row can supply. */
const hostile = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  0,
  -0,
  -1,
  -5e-324,
  5e-324,
  1e-320,
  0.000002,
  0.1,
  0.5,
  1,
  1.5,
  2,
  100,
  1e308,
  Number.MAX_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  2.5
] as const

const anyDouble: Arbitrary.Arbitrary<number> = mostly(pick(hostile), Arbitrary.schema(Schema.Number))

const tags: ReadonlyArray<string> = [
  "ModelError",
  "Timeout",
  "@smthrs/engine-store/CacheCorruptionDetected",
  "@smthrs/engine-store/AttemptEvidenceQuarantined",
  "",
  "é",
  "é",
  "\ud83d",
  "__proto__",
  "Error"
]

const codes = ["rate_limited", "overloaded", "invalid_request", "", "é"] as const

interface PolicyCase {
  readonly initialMs: number
  readonly factor: number
  readonly maxMs: number
  readonly maxAttempts: number | undefined
  readonly expirationMs: number | undefined
  readonly jitterRatio: number | undefined
  readonly nonRetryable: ReadonlyArray<string> | undefined
  readonly retryable: ReadonlyArray<{ readonly tag: string; readonly code: string | undefined }> | undefined
}

const initials = [200, 1, 5000, 0.5, 5e-324, 1e-300, 1e300, 1000, 3.7] as const
const factors = [1.5, 2, 1, 0.5, 1.1, 3, 10, 0.9, 1e10, 1e-10, 1.0000001] as const
const stretches = [1, 2, 5, 150, 1e6, 1e300, 0.999, 1.0000000000000002] as const
const limits = [1, 2, 3, 5, 10, 60, 2000, Number.MAX_SAFE_INTEGER, 0, 1.5, -1, Number.MAX_SAFE_INTEGER + 1] as const
const expirations = [1, 100, 1000, 7_200_000, 0.5, 1e300, 0, -1] as const
const ratios = [0, 0.000002, 0.1, 0.5, 1, 0.9999999999999999, 1.0000000000000002, -0.1] as const

const retryables = list(
  Arbitrary.map(
    Arbitrary.all([
      mostly(pick(tags.filter((tag) => tag !== "")), pick(tags)),
      maybe(mostly(pick(codes.slice(0, 3)), pick(codes)))
    ]),
    ([tag, code]) => ({ tag, code })
  ),
  3
)

const policyCase: Arbitrary.Arbitrary<PolicyCase> = Arbitrary.map(
  Arbitrary.all([
    mostly(pick(initials), anyDouble),
    mostly(pick(factors), anyDouble),
    mostly(pick(stretches), anyDouble),
    bit,
    maybe(mostly(pick(limits), anyDouble)),
    maybe(mostly(pick(expirations), anyDouble)),
    maybe(mostly(pick(ratios), anyDouble)),
    maybe(list(pick(tags), 3)),
    Arbitrary.map(Arbitrary.all([int(0, 3), retryables]), ([choice, entries]) => (choice === 0 ? entries : undefined))
  ]),
  ([initialMs, factor, stretch, scaled, maxAttempts, expirationMs, jitterRatio, nonRetryable, retryable]) => ({
    initialMs,
    factor,
    maxMs: scaled ? initialMs * stretch : stretch,
    maxAttempts,
    expirationMs,
    jitterRatio,
    nonRetryable,
    retryable
  })
)

/** The policy as the implementation holds it: an absent field is a missing key. */
const policyOf = (policy: PolicyCase): RetryPolicy.RetryPolicy =>
  ({
    initialMs: policy.initialMs,
    factor: policy.factor,
    maxMs: policy.maxMs,
    ...(policy.maxAttempts === undefined ? {} : { maxAttempts: policy.maxAttempts }),
    ...(policy.expirationMs === undefined ? {} : { expirationMs: policy.expirationMs }),
    ...(policy.jitterRatio === undefined ? {} : { jitterRatio: policy.jitterRatio }),
    ...(policy.nonRetryable === undefined ? {} : { nonRetryable: policy.nonRetryable }),
    ...(policy.retryable === undefined
      ? {}
      : { retryable: policy.retryable.map((entry) => (entry.code === undefined ? { tag: entry.tag } : entry)) })
  }) as RetryPolicy.RetryPolicy

/** The policy as the oracle reads it, its numbers written by `number`. */
const wirePolicy = (policy: PolicyCase, number: (value: number) => unknown): Record<string, unknown> => ({
  initialMs: number(policy.initialMs),
  factor: number(policy.factor),
  maxMs: number(policy.maxMs),
  maxAttempts: orNull(policy.maxAttempts, number),
  expirationMs: orNull(policy.expirationMs, number),
  jitterRatio: orNull(policy.jitterRatio, number),
  nonRetryable: orNull(policy.nonRetryable, (entries) => entries.map(units)),
  retryable: orNull(
    policy.retryable,
    (entries) => entries.map((entry) => [units(entry.tag), orNull(entry.code, units)])
  )
})

interface FailureCase {
  /** How the tag is carried: an own `_tag`, an own `name` under a `_tag` that is no string, or an inherited `name`. */
  readonly form: number
  readonly tag: string | undefined
  readonly code: string | undefined
  /** A `code` that is no string is no code. */
  readonly numericCode: boolean
  readonly hint: number | undefined
  /** A `retryAfterMillis` that is no number is no hint. */
  readonly textHint: boolean
}

const failureCase: Arbitrary.Arbitrary<FailureCase> = Arbitrary.map(
  Arbitrary.all([
    int(0, 2),
    maybe(pick(tags)),
    maybe(pick(codes)),
    int(0, 5),
    maybe(mostly(pick([0, 50, 1000, 1e7, -0]), anyDouble)),
    int(0, 5)
  ]),
  ([form, tag, code, numeric, hint, textual]) => ({
    form,
    tag,
    code: numeric === 0 ? undefined : code,
    numericCode: numeric === 0,
    hint: textual === 0 ? undefined : hint,
    textHint: textual === 0
  })
)

/** The failure as the engine meets it. */
const failureOf = (failure: FailureCase): unknown => {
  const error: Record<string, unknown> = failure.tag !== undefined && failure.form === 2
    ? (Object.create({ name: failure.tag }) as Record<string, unknown>)
    : {}
  if (failure.tag !== undefined && failure.form === 0) error["_tag"] = failure.tag
  if (failure.tag !== undefined && failure.form === 1) {
    error["_tag"] = 7
    error["name"] = failure.tag
  }
  if (failure.code !== undefined) error["code"] = failure.code
  if (failure.numericCode) error["code"] = 429
  if (failure.hint !== undefined) error["retryAfterMillis"] = failure.hint
  if (failure.textHint) error["retryAfterMillis"] = "5"
  return error
}

const wireFailure = (failure: FailureCase, number: (value: number) => unknown): Record<string, unknown> => ({
  tag: orNull(failure.tag, units),
  code: orNull(failure.code, units),
  hint: orNull(failure.hint, number)
})

const attempts: Arbitrary.Arbitrary<number> = mostly(
  int(1, 12),
  mostly(pick([0, 60, 1100, 1.5, -1, Number.MAX_SAFE_INTEGER]), anyDouble)
)
const samples: Arbitrary.Arbitrary<number | undefined> = maybe(
  mostly(pick([0, 1, 0.5, 0.25, 0.9999999999999999, -0, 5e-324]), anyDouble)
)
const elapsedTimes: Arbitrary.Arbitrary<number | undefined> = maybe(
  mostly(pick([0, 1, 99, 100, 101, 500, 999.5, 7_199_000, 7_200_000, -0]), anyDouble)
)

/** The first field `RetryPolicy.make` refuses, or `null` when it accepts the policy. */
const issueOf = (policy: RetryPolicy.RetryPolicy): string | null => {
  try {
    RetryPolicy.make(policy)
    return null
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError)
    return /^RetryPolicy\.make: "(\w+)"/.exec((error as Error).message)?.[1] ?? "unnamed"
  }
}

const decisionOf = (decision: RetryPolicy.RetryDecision, number: (value: number) => unknown): unknown =>
  decision._tag === "RetryAfter" ? { retryAfter: number(decision.delayMs) } : { giveUp: decision.reason }

// --- the retry policy -----------------------------------------------------------------------------------------------

const issueAgrees = async (policy: PolicyCase): Promise<string | null> => {
  const actual = issueOf(policyOf(policy))
  same("validationIssue", actual, await oracle.ask("issue", { policy: wirePolicy(policy, sent) }))
  // Decoding enforces the same contract as construction: persisted data cannot bypass it.
  same("decoding", Exit.isSuccess(Schema.decodeUnknownExit(RetryPolicy.RetryPolicy)(policyOf(policy))), actual === null)
  return actual
}

const delayAgrees = async (input: {
  readonly policy: PolicyCase
  readonly attempt: number
  readonly random: number | undefined
  readonly elapsed: number | undefined
}): Promise<number | undefined> => {
  const actual = Option.getOrUndefined(
    RetryPolicy.nextDelay(policyOf(input.policy), input.attempt, { random: input.random, elapsedMs: input.elapsed })
  )
  same(
    "nextDelay",
    orNull(actual, bitsOf),
    await oracle.ask("nextDelay", {
      policy: wirePolicy(input.policy, sent),
      attempt: sent(input.attempt),
      random: orNull(input.random, sent),
      elapsed: orNull(input.elapsed, sent)
    })
  )
  return actual
}

const decisionAgrees = async (input: {
  readonly policy: PolicyCase
  readonly attempt: number
  readonly failure: FailureCase
  readonly random: number | undefined
  readonly elapsed: number | undefined
}): Promise<RetryPolicy.RetryDecision> => {
  const error = failureOf(input.failure)
  const policy = policyOf(input.policy)
  const actual = RetryPolicy.decide(policy, {
    attempt: input.attempt,
    error,
    random: input.random,
    elapsedMs: input.elapsed
  })
  const request = {
    policy: wirePolicy(input.policy, sent),
    attempt: sent(input.attempt),
    ...wireFailure(input.failure, sent),
    random: orNull(input.random, sent),
    elapsed: orNull(input.elapsed, sent)
  }
  same("decide", decisionOf(actual, bitsOf), await oracle.ask("decide", request))
  same("isNonRetryable", RetryPolicy.isNonRetryable(policy, error), await oracle.ask("isNonRetryable", request))
  return actual
}

const plain = (policy: Partial<PolicyCase> & Pick<PolicyCase, "initialMs" | "factor" | "maxMs">): PolicyCase => ({
  maxAttempts: undefined,
  expirationMs: undefined,
  jitterRatio: undefined,
  nonRetryable: undefined,
  retryable: undefined,
  ...policy
})

const noFailure: FailureCase = {
  form: 0,
  tag: undefined,
  code: undefined,
  numericCode: false,
  hint: undefined,
  textHint: false
}

describe("the retry policy against its specification", () => {
  differential(
    "validationIssue names the same first field, and decoding accepts exactly the valid policies",
    async () => {
      await holds(policyCase, async (policy) => {
        await issueAgrees(policy)
      })
    }
  )

  differential("validationIssue agrees at every bound of every field", async () => {
    const base = plain({ initialMs: 200, factor: 1.5, maxMs: 30_000 })
    expect(await issueAgrees(base)).toBeNull()
    for (const value of hostile) {
      await issueAgrees({ ...base, initialMs: value })
      await issueAgrees({ ...base, factor: value })
      await issueAgrees({ ...base, maxMs: value })
      await issueAgrees({ ...base, maxAttempts: value })
      await issueAgrees({ ...base, expirationMs: value })
      await issueAgrees({ ...base, jitterRatio: value })
    }
    expect(await issueAgrees({ ...base, initialMs: 0 })).toBe("initialMs")
    expect(await issueAgrees({ ...base, initialMs: 0, factor: 0, maxMs: -1 })).toBe("initialMs")
    expect(await issueAgrees({ ...base, factor: 0, maxMs: 1 })).toBe("factor")
    expect(await issueAgrees({ ...base, maxMs: 199.99999999999997 })).toBe("maxMs")
    expect(await issueAgrees({ ...base, maxMs: 200 })).toBeNull()
    expect(await issueAgrees({ ...base, maxAttempts: 0, jitterRatio: 2 })).toBe("maxAttempts")
    expect(await issueAgrees({ ...base, expirationMs: 0, jitterRatio: 2 })).toBe("expirationMs")
    expect(await issueAgrees({ ...base, jitterRatio: 1 })).toBeNull()
    expect(await issueAgrees({ ...base, retryable: [{ tag: "", code: undefined }] })).toBe("retryable")
    expect(await issueAgrees({ ...base, retryable: [{ tag: "T", code: "" }] })).toBe("retryable")
    expect(await issueAgrees({ ...base, retryable: [] })).toBeNull()
  })

  differential("nextDelay agrees to the bit on every policy, attempt, sample and elapsed time", async () => {
    await holds(
      Arbitrary.all([policyCase, attempts, samples, elapsedTimes]),
      async ([policy, attempt, random, elapsed]) => {
        await delayAgrees({ policy, attempt, random, elapsed })
      }
    )
  })

  differential("nextDelay agrees on valid policies, where the schedule runs to its end", async () => {
    await holds(
      Arbitrary.all([
        pick(initials),
        pick(factors),
        pick(stretches.filter((stretch) => stretch >= 1)),
        maybe(pick(limits.slice(0, 8))),
        maybe(pick(expirations.slice(0, 6))),
        maybe(pick(ratios.slice(0, 6))),
        int(1, 70),
        samples,
        elapsedTimes
      ]),
      async ([initialMs, factor, stretch, maxAttempts, expirationMs, jitterRatio, attempt, random, elapsed]) => {
        const policy = plain({ initialMs, factor, maxMs: initialMs * stretch, maxAttempts, expirationMs, jitterRatio })
        if (!Number.isFinite(policy.maxMs)) return
        expect(await issueAgrees(policy)).toBeNull()
        const delay = await delayAgrees({ policy, attempt, random, elapsed })
        // The laws the specification proves, seen on the implementation's own doubles.
        if (delay !== undefined) {
          expect(delay).toBeLessThanOrEqual(policy.maxMs)
          expect(delay).toBeGreaterThanOrEqual(0)
          if (maxAttempts !== undefined) expect(attempt).toBeLessThan(maxAttempts)
          if (expirationMs !== undefined && elapsed !== undefined) {
            expect(delay).toBeLessThanOrEqual(Math.max(0, expirationMs - elapsed))
          }
        }
      }
    )
  })

  differential("nextDelay agrees at the boundaries the implementation documents", async () => {
    const policy = plain({ initialMs: 200, factor: 1.5, maxMs: 30_000 })
    const at = (input: Partial<PolicyCase>, attempt: number, random?: number, elapsed?: number) =>
      delayAgrees({ policy: { ...policy, ...input }, attempt, random, elapsed })
    expect(await at({}, 1)).toBe(200)
    expect(await at({}, 2)).toBe(300)
    expect(await at({}, 14)).toBe(30_000)
    expect(await at({}, 0)).toBeUndefined()
    expect(await at({}, 1.5)).toBeUndefined()
    expect(await at({}, Number.MAX_SAFE_INTEGER)).toBe(30_000)
    expect(await at({}, Number.MAX_SAFE_INTEGER + 1)).toBeUndefined()
    expect(await at({ maxAttempts: 3 }, 2)).toBe(300)
    expect(await at({ maxAttempts: 3 }, 3)).toBeUndefined()
    // A shrinking factor underflows to a backoff of zero, which gives up.
    expect(await at({ factor: 1e-10 }, 40)).toBeUndefined()
    // The window caps the delay, and expires the sequence once it cannot fit the initial interval.
    expect(await at({ expirationMs: 1000 }, 3, undefined, 700)).toBe(300)
    expect(await at({ expirationMs: 1000 }, 3, undefined, 800)).toBe(200)
    expect(await at({ expirationMs: 1000 }, 3, undefined, 801)).toBeUndefined()
    expect(await at({ expirationMs: 1000 }, 1, undefined, 1000.0000000000001)).toBeUndefined()
    expect(await at({ expirationMs: 1000 }, 1, undefined, -1)).toBeUndefined()
    expect(await at({ expirationMs: 1000 }, 1, undefined, Number.NaN)).toBeUndefined()
    // Full jitter with a sample of zero retries immediately; a sample outside the band gives up.
    expect(await at({ jitterRatio: 1 }, 1, 0)).toBe(0)
    expect(await at({ jitterRatio: 1 }, 1, -0)).toBe(0)
    expect(await at({ jitterRatio: 0.5 }, 1, 0)).toBe(100)
    expect(await at({ jitterRatio: 0.5 }, 1)).toBe(200)
    expect(await at({ jitterRatio: 0.5 }, 1, 1.0000000000000002)).toBeUndefined()
    expect(await at({ jitterRatio: 0.5 }, 1, Number.NaN)).toBeUndefined()
    expect(await at({ jitterRatio: 0 }, 1, Number.NaN)).toBe(200)
    // The two jitter terms round above the delay; the clamp keeps the band's upper bound exact.
    expect(await at({ initialMs: 100, maxMs: 100, factor: 1, jitterRatio: 0.000002 }, 1, 1)).toBe(100)
  })

  differential("decide agrees on every policy, failure, attempt, sample and elapsed time", async () => {
    await holds(
      Arbitrary.all([policyCase, attempts, failureCase, samples, elapsedTimes]),
      async ([policy, attempt, failure, random, elapsed]) => {
        await decisionAgrees({ policy, attempt, failure, random, elapsed })
      }
    )
  })

  differential("decide agrees on valid policies, where hints and expiry are reached", async () => {
    await holds(
      Arbitrary.all([
        Arbitrary.all([
          pick(initials.slice(0, 4)),
          pick(factors.slice(0, 5)),
          pick([1, 2, 5, 150]),
          maybe(pick(limits.slice(0, 5))),
          maybe(pick(expirations.slice(0, 4))),
          maybe(pick(ratios.slice(0, 5)))
        ]),
        maybe(list(pick(tags), 2)),
        maybe(retryables),
        int(1, 12),
        failureCase,
        samples,
        elapsedTimes
      ]),
      async (
        [
          [initialMs, factor, stretch, maxAttempts, expirationMs, jitterRatio],
          nonRetryable,
          retryable,
          attempt,
          failure,
          random,
          elapsed
        ]
      ) => {
        const policy: PolicyCase = {
          initialMs,
          factor,
          maxMs: initialMs * stretch,
          maxAttempts,
          expirationMs,
          jitterRatio,
          nonRetryable,
          retryable
        }
        const decision = await decisionAgrees({ policy, attempt, failure, random, elapsed })
        if (decision._tag === "RetryAfter") {
          expect(decision.delayMs).toBeLessThanOrEqual(policy.maxMs)
          if (maxAttempts !== undefined) expect(attempt).toBeLessThan(maxAttempts)
        }
        // `nonRetryable` wins over `retryable`, whatever else the policy says.
        if (failure.tag !== undefined && nonRetryable?.includes(failure.tag) === true) {
          expect(decision).toEqual({ _tag: "GiveUp", reason: "nonRetryable" })
        }
      }
    )
  })

  differential("decide agrees on precedence, hints and the reason it stops", async () => {
    const policy = plain({ initialMs: 200, factor: 2, maxMs: 1000 })
    const failed = (input: Partial<FailureCase>): FailureCase => ({ ...noFailure, ...input })
    const at = (input: Partial<PolicyCase>, attempt: number, failure: FailureCase, elapsed?: number) =>
      decisionAgrees({ policy: { ...policy, ...input }, attempt, failure, random: undefined, elapsed })
    const corrupt = "@smthrs/engine-store/CacheCorruptionDetected"
    expect(await at({}, 1, noFailure)).toEqual({ _tag: "RetryAfter", delayMs: 200 })
    expect(await at({ retryable: [{ tag: corrupt, code: undefined }] }, 1, failed({ tag: corrupt })))
      .toEqual({ _tag: "GiveUp", reason: "nonRetryable" })
    expect(await at({ nonRetryable: ["T"], retryable: [{ tag: "T", code: undefined }] }, 1, failed({ tag: "T" })))
      .toEqual({ _tag: "GiveUp", reason: "nonRetryable" })
    expect(await at({ retryable: [{ tag: "T", code: "c" }] }, 1, failed({ tag: "T", code: "c" })))
      .toEqual({ _tag: "RetryAfter", delayMs: 200 })
    expect(await at({ retryable: [{ tag: "T", code: "c" }] }, 1, failed({ tag: "T" })))
      .toEqual({ _tag: "GiveUp", reason: "nonRetryable" })
    expect(await at({ retryable: [{ tag: "T", code: "c" }] }, 1, failed({ tag: "T", numericCode: true })))
      .toEqual({ _tag: "GiveUp", reason: "nonRetryable" })
    expect(await at({ retryable: [] }, 1, noFailure)).toEqual({ _tag: "GiveUp", reason: "nonRetryable" })
    expect(await at({ retryable: [{ tag: "T", code: undefined }] }, 1, failed({ tag: "T", form: 2 })))
      .toEqual({ _tag: "RetryAfter", delayMs: 200 })
    // A hint is a floor under the backoff, under the cap and under the window.
    expect(await at({}, 1, failed({ hint: 0 }))).toEqual({ _tag: "RetryAfter", delayMs: 200 })
    expect(await at({}, 1, failed({ hint: 650 }))).toEqual({ _tag: "RetryAfter", delayMs: 650 })
    expect(await at({}, 1, failed({ hint: 1e9 }))).toEqual({ _tag: "RetryAfter", delayMs: 1000 })
    expect(await at({ expirationMs: 900 }, 1, failed({ hint: 1e9 }), 300)).toEqual({ _tag: "RetryAfter", delayMs: 600 })
    expect(await at({}, 1, failed({ hint: -1 }))).toEqual({ _tag: "RetryAfter", delayMs: 200 })
    expect(await at({}, 1, failed({ hint: Number.POSITIVE_INFINITY }))).toEqual({ _tag: "RetryAfter", delayMs: 200 })
    expect(await at({}, 1, failed({ textHint: true }))).toEqual({ _tag: "RetryAfter", delayMs: 200 })
    // `expired` needs an expiration that alone stopped the sequence; anything else is `exhausted`.
    expect(await at({ expirationMs: 500 }, 1, noFailure, 501)).toEqual({ _tag: "GiveUp", reason: "expired" })
    expect(await at({ expirationMs: 500 }, 1, noFailure, 400)).toEqual({ _tag: "GiveUp", reason: "expired" })
    expect(await at({ expirationMs: 500, maxAttempts: 1 }, 1, noFailure, 501))
      .toEqual({ _tag: "GiveUp", reason: "exhausted" })
    expect(await at({ expirationMs: 500 }, 1, noFailure, Number.NaN)).toEqual({ _tag: "GiveUp", reason: "exhausted" })
    expect(await at({ maxAttempts: 2 }, 2, noFailure)).toEqual({ _tag: "GiveUp", reason: "exhausted" })
    expect(await at({ initialMs: 0 }, 1, noFailure)).toEqual({ _tag: "GiveUp", reason: "exhausted" })
  })

  differential("the exact schedule is the implementation's wherever doubles are exact", async () => {
    const whole = (value: number): number => value
    await holds(
      Arbitrary.all([
        Arbitrary.all([
          int(0, 1000),
          int(0, 4),
          int(0, 100_000),
          maybe(int(0, 14)),
          maybe(int(0, 200_000)),
          maybe(int(0, 1))
        ]),
        int(0, 12),
        maybe(int(0, 500_000)),
        maybe(int(0, 1)),
        maybe(int(0, 250_000)),
        maybe(pick(tags))
      ]),
      async (
        [[initialMs, factor, room, maxAttempts, expirationMs, jitterRatio], attempt, hint, random, elapsed, tag]
      ) => {
        const policy = plain({
          initialMs,
          factor,
          maxMs: Math.max(0, initialMs + room - 50),
          maxAttempts,
          expirationMs,
          jitterRatio
        })
        const failure: FailureCase = { ...noFailure, tag, hint }
        const request = {
          policy: wirePolicy(policy, whole),
          attempt,
          ...wireFailure(failure, whole),
          random: orNull(random, whole),
          elapsed: orNull(elapsed, whole)
        }
        same(
          "the exact delay",
          Option.getOrNull(RetryPolicy.nextDelay(policyOf(policy), attempt, { random, elapsedMs: elapsed })),
          await oracle.ask("nextDelayExact", request)
        )
        same(
          "the exact decision",
          decisionOf(
            RetryPolicy.decide(policyOf(policy), { attempt, error: failureOf(failure), random, elapsedMs: elapsed }),
            whole
          ),
          await oracle.ask("decideExact", request)
        )
      }
    )
  })
})

// --- the allocation scope -------------------------------------------------------------------------------------------

/** Pieces a hostile name is built from: every separator of the encoding, digits, and both halves of a pair. */
const fragments = [
  "a",
  "/",
  ":",
  "/s:",
  "/c:",
  "/g:",
  "0",
  "12",
  "action",
  "internal",
  "key1_",
  "é",
  "😺",
  "\ud83d",
  "\ude3a",
  "\u0000",
  " "
] as const

const built: Arbitrary.Arbitrary<string> = Arbitrary.map(list(pick(fragments), 6), (parts) => parts.join(""))

const anyText: Arbitrary.Arbitrary<string> = mostly(built, Arbitrary.schema(Schema.String))

/** Text a digest accepts: every lone surrogate replaced, as `toWellFormed` replaces it. */
const wellFormed: Arbitrary.Arbitrary<string> = Arbitrary.map(
  anyText,
  (text) => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")
)

interface ScopeCase {
  readonly kind: "action" | "internal"
  readonly name: string
  readonly idempotency: string | Schema.JsonObject | undefined
  readonly site: string | undefined
}

const scopeCase: Arbitrary.Arbitrary<ScopeCase> = Arbitrary.map(
  Arbitrary.all([bit, anyText, int(0, 2), wellFormed, int(0, 9), maybe(anyText)]),
  ([internal, name, form, text, count, site]) => ({
    kind: internal ? "internal" : "action",
    name,
    idempotency: form === 0 ? undefined : form === 1 ? text : count === 0 ? {} : { count, text },
    site
  })
)

const scopeAgrees = async (identity: ScopeCase): Promise<string> => {
  const actual = runSync(StepIdentity.allocationScope(identity).pipe(Effect.orDie))
  // The specification takes the canonical component as given; the hash is derived here, apart from the scope.
  const digest = typeof identity.idempotency === "string"
    ? runSync(Schema.decodeUnknownEffect(Sha256)(identity.idempotency).pipe(Effect.orDie))
    : undefined
  const derived = typeof identity.idempotency === "object"
    ? key({ kind: "declaration", input: identity.idempotency })
    : undefined
  // The widths the injectivity theorem assumes.
  if (digest !== undefined) expect(digest).toHaveLength(64)
  if (derived !== undefined) expect(derived).toHaveLength(69)
  same(
    "allocationScope",
    units(actual),
    await oracle.ask("scope", {
      kind: identity.kind,
      name: units(identity.name),
      text: orNull(digest, units),
      object: orNull(derived, units),
      site: orNull(identity.site, units)
    })
  )
  return actual
}

describe("the allocation scope against its specification", () => {
  differential("allocationScope is the specification's framing, code unit for code unit", async () => {
    await holds(scopeCase, async (identity) => {
      await scopeAgrees(identity)
    })
  })

  differential("distinct declarations never share a scope", async () => {
    const identityOf = (identity: ScopeCase): string =>
      JSON.stringify([
        identity.kind,
        units(identity.name),
        typeof identity.idempotency,
        identity.idempotency ?? null,
        orNull(identity.site, units)
      ])
    await holds(Arbitrary.all([scopeCase, scopeCase]), async ([left, right]) => {
      const scopes = [await scopeAgrees(left), await scopeAgrees(right)]
      expect(scopes[0] === scopes[1]).toBe(identityOf(left) === identityOf(right))
    })
  })

  differential("allocationScope agrees where a name spells another declaration's suffix", async () => {
    const digest = "0".repeat(64)
    expect(await scopeAgrees({ kind: "action", name: "", idempotency: undefined, site: undefined })).toBe("action/0:")
    expect(await scopeAgrees({ kind: "internal", name: "a", idempotency: undefined, site: "" })).toBe(
      "internal/1:a/g:0:"
    )
    const spliced = await scopeAgrees({
      kind: "action",
      name: `a/s:${digest}`,
      idempotency: undefined,
      site: undefined
    })
    const keyed = await scopeAgrees({ kind: "action", name: "a", idempotency: "x", site: undefined })
    expect(spliced.startsWith("action/68:")).toBe(true)
    expect(keyed.startsWith("action/1:a/s:")).toBe(true)
    const sited = await scopeAgrees({ kind: "action", name: "a/g:1:b", idempotency: undefined, site: undefined })
    expect(sited).not.toBe(await scopeAgrees({ kind: "action", name: "a", idempotency: undefined, site: "b" }))
    // A length counts code units, so a pair counts twice and a lone half once.
    expect(await scopeAgrees({ kind: "action", name: "😺\ud83d", idempotency: {}, site: "😺" })).toMatch(
      /^action\/3:.*\/c:key1_[0-9a-f]{64}\/g:2:😺$/u
    )
    const long = "n".repeat(4097)
    expect(await scopeAgrees({ kind: "action", name: long, idempotency: undefined, site: long })).toHaveLength(8214)
  })

  differential("a length is written as the specification's decimal numeral", async () => {
    await holds(int(0, Number.MAX_SAFE_INTEGER), async (value) => {
      same("the numeral", units(String(value)), await oracle.ask("decimal", { value }))
    })
    for (const value of [0, 9, 10, 99, 100, 4096, Number.MAX_SAFE_INTEGER]) {
      same("the numeral", units(String(value)), await oracle.ask("decimal", { value }))
    }
  })
})

// --- the capability ceilings ----------------------------------------------------------------------------------------

const actions = [
  ...Capability.PatternAction.literals,
  "fs",
  "fs:nope",
  "FS:read",
  "",
  "*:*",
  "fs:read:fs:read"
] as const

const resources = [
  "**",
  "src/**",
  "src/main.ts",
  "src/**/main.ts",
  "src",
  "",
  "*",
  "?",
  "/",
  "/w/**",
  "/w/../etc",
  ".",
  "..",
  "./src",
  "./src/./out",
  "src/..",
  "src/../..",
  "src/*/../x",
  "src/../x/**",
  "a//b",
  "a/",
  "~/x",
  "C:x",
  "c:/x/./y",
  "a\\.\\b/.",
  "x:y",
  "https://example.com/**",
  "😺/**",
  "\ud83d/./x",
  "src/**/**"
] as const

/** A pattern as a ceiling carries it: mostly an action and a resource, sometimes any text at all. */
const patternText: Arbitrary.Arbitrary<string> = mostly(
  Arbitrary.map(Arbitrary.all([pick(actions), pick(resources)]), ([action, resource]) => `${action}:${resource}`),
  mostly(pick(["*", "", ":", "::", "*:", "fs:read", "fs:*", "*:*:*", ":fs:read:x"]), anyText)
)

type Ceiling = ReadonlyArray<ReadonlyArray<string>>

const ceilingOf: Arbitrary.Arbitrary<Array<Array<string>>> = list(list(patternText, 4), 4)

const wireCeiling = (ceiling: Ceiling): Array<Array<Array<number>>> => ceiling.map((group) => group.map(units))

const intersectAgrees = async (left: Ceiling, right: Ceiling): Promise<Ceiling> => {
  const actual = Flow.intersectCeilings(left, right)
  same(
    "intersectCeilings",
    wireCeiling(actual),
    await oracle.ask("intersect", { left: wireCeiling(left), right: wireCeiling(right) })
  )
  return actual
}

const withinAgrees = async (inner: Ceiling, outer: Ceiling): Promise<boolean> => {
  const actual = Flow.ceilingWithin(inner, outer)
  same("ceilingWithin", actual, await oracle.ask("within", { inner: wireCeiling(inner), outer: wireCeiling(outer) }))
  return actual
}

const parseAgrees = async (text: string): Promise<Capability.CapabilityPattern | undefined> => {
  const actual = Option.getOrUndefined(Capability.parsePattern(text))
  same(
    "parsePattern",
    orNull(actual, (pattern) => [units(pattern.action), units(pattern.resource)]),
    await oracle.ask("parsePattern", { text: units(text) })
  )
  return actual
}

describe("the capability ceilings against their specification", () => {
  differential("parsePattern accepts the same texts and reads the same action and resource", async () => {
    await holds(patternText, async (text) => {
      const parsed = await parseAgrees(text)
      // A parsed pattern is written back as text that parses to itself: the transported form loses nothing.
      if (parsed !== undefined) {
        const again = await parseAgrees(Capability.format(parsed))
        expect([again?.action, again?.resource]).toEqual([parsed.action, parsed.resource])
      }
    })
  })

  differential("parsePattern agrees at the resource length limit and on every action of the vocabulary", async () => {
    for (const action of actions) await parseAgrees(`${action}:src/**`)
    expect(await parseAgrees("*")).toMatchObject({ action: "*", resource: "**" })
    expect(await parseAgrees("*:")).toMatchObject({ action: "*", resource: "" })
    expect(await parseAgrees("fs:read")).toBeUndefined()
    expect(await parseAgrees("fs:read:")).toMatchObject({ action: "fs:read", resource: "" })
    expect(await parseAgrees("net:get:https://a:8080/x")).toMatchObject({ resource: "https://a:8080/x" })
    expect(await parseAgrees(`fs:read:${"r".repeat(Capability.maxResourceLength)}`)).toBeDefined()
    expect(await parseAgrees(`fs:read:${"r".repeat(Capability.maxResourceLength + 1)}`)).toBeUndefined()
    expect(await parseAgrees(`*:${"r".repeat(Capability.maxResourceLength)}`)).toBeDefined()
    expect(await parseAgrees(`*:${"r".repeat(Capability.maxResourceLength + 1)}`)).toBeUndefined()
  })

  differential("subsumes agrees on every pair of parsed patterns", async () => {
    await holds(Arbitrary.all([patternText, patternText]), async ([left, right]) => {
      const cover = Option.getOrUndefined(Capability.parsePattern(left))
      const covered = Option.getOrUndefined(Capability.parsePattern(right))
      if (cover === undefined || covered === undefined) return
      same(
        "subsumes",
        Capability.subsumes(cover, covered),
        await oracle.ask("subsumes", {
          left: [units(cover.action), units(cover.resource)],
          right: [units(covered.action), units(covered.resource)]
        })
      )
    })
  })

  differential("intersectCeilings agrees, group for group and pattern for pattern", async () => {
    await holds(Arbitrary.all([ceilingOf, ceilingOf]), async ([left, right]) => {
      const both = await intersectAgrees(left, right)
      // The laws the specification proves, seen on the implementation.
      expect(await intersectAgrees(right, left)).toEqual(both)
      expect(await intersectAgrees(both, both)).toEqual(both)
      expect(await intersectAgrees(left, [])).toEqual(await intersectAgrees(left, left))
    })
  })

  differential("intersectCeilings is associative on three ceilings", async () => {
    await holds(Arbitrary.all([ceilingOf, ceilingOf, ceilingOf]), async ([first, second, third]) => {
      expect(await intersectAgrees(await intersectAgrees(first, second), third)).toEqual(
        await intersectAgrees(first, await intersectAgrees(second, third))
      )
    })
  })

  differential("ceilingWithin agrees, and narrowing an inner ceiling keeps it within", async () => {
    await holds(Arbitrary.all([ceilingOf, ceilingOf, ceilingOf]), async ([inner, outer, extra]) => {
      const contained = await withinAgrees(inner, outer)
      const narrowed = await withinAgrees(await intersectAgrees(inner, extra), outer)
      if (contained) expect(narrowed).toBe(true)
      if (contained && (await withinAgrees(inner, extra))) {
        expect(await withinAgrees(inner, await intersectAgrees(outer, extra))).toBe(true)
      }
    })
  })

  differential("the ceilings agree at unrestricted, deny-all and dot-segment boundaries", async () => {
    expect(await intersectAgrees([], [])).toEqual([])
    expect(await intersectAgrees([[]], [])).toEqual([[]])
    expect(await intersectAgrees([["fs:read:**"]], [[]])).toEqual([[]])
    expect(await intersectAgrees([["nonsense"]], [["fs:read:**"]])).toEqual([[]])
    expect(await intersectAgrees([["fs:read:b", "fs:read:a", "fs:read:a", "bad"]], [["*"]])).toEqual([
      ["*:**"],
      ["fs:read:a", "fs:read:b"]
    ])
    expect(await intersectAgrees([["fs:write:x"], ["fs:read:x"]], [["fs:read:x"]])).toEqual([["fs:read:x"], [
      "fs:write:x"
    ]])
    expect(await withinAgrees([], [])).toBe(true)
    expect(await withinAgrees([], [["*"]])).toBe(false)
    expect(await withinAgrees([[]], [["fs:read:x"]])).toBe(true)
    expect(await withinAgrees([["fs:read:x"]], [])).toBe(true)
    expect(await withinAgrees([["fs:read:src/main.ts"]], [["fs:*:src/**"]])).toBe(true)
    expect(await withinAgrees([["fs:read:src"]], [["fs:read:src/**"]])).toBe(false)
    expect(await withinAgrees([["net:get:src/main.ts"]], [["fs:*:src/**"]])).toBe(false)
    expect(await withinAgrees([["*:src/x"]], [["fs:*:src/**"]])).toBe(false)
    expect(await withinAgrees([["fs:read:./src/./out"]], [["fs:read:**"]])).toBe(true)
    expect(await withinAgrees([["fs:read:./src/out"]], [["fs:read:src/**"]])).toBe(false)
    expect(await withinAgrees([["fs:read:src/../../etc"]], [["fs:read:**"]])).toBe(false)
    expect(await withinAgrees([["fs:read:/w/../etc"]], [["fs:read:/w/**"]])).toBe(false)
    expect(await withinAgrees([["fs:read:src/*/../x"]], [["fs:read:**"]])).toBe(false)
    expect(await withinAgrees([["net:get:a/../b"]], [["net:get:a/**"]])).toBe(true)
    expect(await withinAgrees([["fs:read:a"], ["fs:read:b"]], [["fs:read:a", "fs:read:b"]])).toBe(true)
    expect(await withinAgrees([["fs:read:a", "fs:read:b"]], [["fs:read:a"]])).toBe(false)
  })
})

// --- the flow metadata ----------------------------------------------------------------------------------------------

/** Code units `trim` removes, and near misses it keeps. */
const spaces = [
  " ",
  "\t",
  "\n",
  "\u000b",
  "\f",
  "\r",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff"
] as const
const inks = ["a", "\u0000", "\u0085", "\u180e", "\u200b", "\u2060", "flow/tag", "\ud83d"] as const

const tagText: Arbitrary.Arbitrary<string> = Arbitrary.map(
  Arbitrary.all([list(pick(spaces), 3), int(0, 2), pick(inks), list(pick(spaces), 2)]),
  ([before, choice, ink, after]) => `${before.join("")}${choice === 0 ? "" : ink}${after.join("")}`
)

/** A deadline in whole milliseconds, or a value that is no duration at all. */
const wholeMillis = [
  1,
  30_000,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  1e300,
  0,
  -0,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY
] as const

const metadataAgrees = async (
  tag: string,
  maxRounds: number | undefined,
  deadline: number | undefined
): Promise<string | null> => {
  let actual: string | null = null
  try {
    Flow.make(tag, {
      payload: {},
      success: Schema.String,
      maxRounds,
      deadline,
      body: () => Effect.succeed("unused") as never
    })
  } catch (error) {
    const message = (error as Error).message
    actual = message.endsWith("tag must be a non-empty string")
      ? "tag"
      : message.endsWith("maxRounds must be a positive safe integer")
      ? "maxRounds"
      : message.endsWith("deadline must be a positive finite duration")
      ? "deadline"
      : message.endsWith(`deadline must be at most ${Number.MAX_SAFE_INTEGER} ms`)
      ? "deadlineTooLong"
      : `unexpected: ${message}`
  }
  same(
    "Flow.make",
    actual,
    await oracle.ask("metadata", {
      tag: units(tag),
      maxRounds: orNull(maxRounds, sent),
      deadline: orNull(deadline, sent)
    })
  )
  return actual
}

describe("the flow metadata against its specification", () => {
  differential("Flow.make refuses the same tags, rounds and deadlines, for the same first reason", async () => {
    await holds(
      Arbitrary.all([tagText, maybe(mostly(pick(limits), anyDouble)), maybe(pick(wholeMillis))]),
      async ([tag, maxRounds, deadline]) => {
        await metadataAgrees(tag, maxRounds, deadline)
      }
    )
  })

  differential("Flow.make agrees at every bound", async () => {
    for (const space of spaces) expect(await metadataAgrees(space, undefined, undefined)).toBe("tag")
    for (const ink of inks) expect(await metadataAgrees(` ${ink} `, undefined, undefined)).toBeNull()
    expect(await metadataAgrees("", 0, 0)).toBe("tag")
    expect(await metadataAgrees("t", 0, 0)).toBe("maxRounds")
    expect(await metadataAgrees("t", 1, 0)).toBe("deadline")
    expect(await metadataAgrees("t", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBeNull()
    expect(await metadataAgrees("t", Number.MAX_SAFE_INTEGER + 1, 1)).toBe("maxRounds")
    expect(await metadataAgrees("t", undefined, Number.MAX_SAFE_INTEGER + 1)).toBe("deadlineTooLong")
    expect(await metadataAgrees("t", undefined, Number.POSITIVE_INFINITY)).toBe("deadline")
    for (const value of hostile) await metadataAgrees("t", value, undefined)
    for (const value of wholeMillis) await metadataAgrees("t", undefined, value)
  })
})

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope")
    await expect(oracle.ask("decimal", { value: "not a number" })).rejects.toThrow("the oracle refused")
    expect(await oracle.ask("decimal", { value: 7 })).toEqual([55])
  })

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(0)
    expect(oracle.asked()).toBeGreaterThan(2000)
  })
})
