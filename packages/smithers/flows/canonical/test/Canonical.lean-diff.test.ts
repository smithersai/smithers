/**
 * `canonicalize` and `BoundedJson` against their Lean 4 reference specification (`spec/lean/canonical`), generated:
 * every case is answered by the implementation and by the specification's compiled oracle, and the two answers must
 * be equal, to the code unit for a text and to the code, complaint and path for a refusal.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A text crosses as its UTF-16 code units, so a lone surrogate arrives as it left. A number crosses as text: a
 * whole number in decimal, or `-0`, `nan`, `inf`, `-inf`. The specification covers no other double, so none is
 * generated.
 *
 * A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
 * and builds it again when a source of the specification is newer than it.
 */
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BoundedJson, CanonicalError, canonicalize } from "../src/index.ts"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "canonical")
const binary = join(specDir, ".lake", "build", "bin", "canonical-spec")
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
    "CanonicalSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "CanonicalSpec")).map((name) => join("CanonicalSpec", name))
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

type Units = ReadonlyArray<number>

/** A text as its UTF-16 code units. */
const units = (text: string): Array<number> => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))

type Wire = null | boolean | { readonly n: string } | { readonly s: Units } | ReadonlyArray<Wire> | {
  readonly o: ReadonlyArray<readonly [Units, Wire]>
}

const numberWire = (value: number): string => {
  if (Number.isNaN(value)) return "nan"
  if (value === Infinity) return "inf"
  if (value === -Infinity) return "-inf"
  if (Object.is(value, -0)) return "-0"
  return String(value)
}

/**
 * The value as the oracle reads it, taken from the built JavaScript value itself: an object's members cross in the
 * engine's own-key order, which puts index-like keys first and keeps one member per key.
 */
const wire = (value: unknown): Wire => {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return { n: numberWire(value) }
  if (typeof value === "string") return { s: units(value) }
  if (Array.isArray(value)) return value.map(wire)
  const record = value as Record<string, unknown>
  return { o: Object.keys(record).map((key) => [units(key), wire(record[key])] as const) }
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

/**
 * Pieces a hostile text is built from: every escape class, the boundaries of the one-, two- and three-byte ranges,
 * both halves of a surrogate pair, the reserved keys, and keys the engine orders as indices.
 */
const fragments = [
  "a",
  "b",
  "Z",
  "_",
  "$",
  "0",
  "10",
  "\"",
  "\\",
  "\b",
  "\t",
  "\n",
  "\f",
  "\r",
  "\u0000",
  "\u001f",
  " ",
  "\u007f",
  "\u0080",
  "é",
  "߿",
  "ࠀ",
  " ",
  "퟿",
  "",
  "￿",
  "😺",
  "\ud83d",
  "\ude3a",
  "__proto__",
  "constructor",
  "prototype",
  "toJSON",
  "."
] as const

const text: Arbitrary.Arbitrary<string> = Arbitrary.map(list(pick(fragments), 4), (parts) => parts.join(""))

/** Whole numbers at every digit count and sign the serializer writes plainly, and the four special doubles. */
const numbers = [
  0,
  1,
  -1,
  -0,
  9,
  10,
  -10,
  255,
  65_536,
  2_147_483_648,
  -4_294_967_296,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  100_000_000_000_000_000_000,
  -100_000_000_000_000_000_000,
  Number.NaN,
  Infinity,
  -Infinity
] as const

/** Hostile leaves are rare so most trees reach the walk past them. */
const leaf: Arbitrary.Arbitrary<unknown> = Arbitrary.map(
  Arbitrary.all([int(0, 11), bit, pick(numbers), int(-1000, 1000), text]),
  ([choice, flag, special, whole, made]) =>
    choice === 0 ? null : choice <= 2 ? flag : choice === 3 ? special : choice <= 6 ? whole : made
)

/** An object with exactly the generated own keys, `__proto__` included. */
const record = (entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> => {
  const made: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    Object.defineProperty(made, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return made
}

/** A JSON tree at most `depth` containers deep. */
const tree = (depth: number): Arbitrary.Arbitrary<unknown> => {
  if (depth === 0) return leaf
  const below = tree(depth - 1)
  return Arbitrary.map(
    Arbitrary.all([int(0, 5), leaf, list(below, 3), list(Arbitrary.all([text, below]), 4)]),
    ([choice, plain, items, entries]) => (choice <= 1 ? plain : choice <= 3 ? items : record(entries))
  )
}

const value = tree(3)

/** A limit: absent, tight, or roomy. */
const limit = (tight: number, roomy: number): Arbitrary.Arbitrary<number | undefined> =>
  Arbitrary.map(
    Arbitrary.all([int(0, 3), int(0, tight)]),
    ([choice, small]) => (choice === 0 ? undefined : choice === 1 ? small : roomy)
  )

const required = (tight: number, roomy: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.map(Arbitrary.all([int(0, 2), int(0, tight)]), ([choice, small]) => (choice === 0 ? small : roomy))

const limits: Arbitrary.Arbitrary<BoundedJson.Limits> = Arbitrary.map(
  Arbitrary.all([
    limit(120, 100_000),
    required(4, 64),
    required(5, 1000),
    limit(12, 10_000),
    required(24, 10_000),
    limit(24, 10_000),
    limit(16, 10_000)
  ]),
  ([maxBytes, maxDepth, maxMembers, maxTotalMembers, maxNodes, maxStringBytes, maxKeyBytes]) => ({
    maxBytes,
    maxDepth,
    maxMembers,
    maxTotalMembers,
    maxNodes,
    maxStringBytes,
    maxKeyBytes
  })
)

const strictLimits: Arbitrary.Arbitrary<BoundedJson.StrictLimits> = Arbitrary.map(
  Arbitrary.all([
    required(120, 100_000),
    required(4, 64),
    required(12, 1000),
    required(24, 10_000),
    required(24, 10_000),
    required(16, 10_000)
  ]),
  ([maxBytes, maxDepth, maxMembers, maxNodes, maxStringBytes, maxKeyBytes]) => ({
    maxBytes,
    maxDepth,
    maxMembers,
    maxNodes,
    maxStringBytes,
    maxKeyBytes
  })
)

/** Fails the test with the shrunk counterexample unless the property holds for every generated value. */
const agrees = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  offset: number,
  property: (value: A) => Promise<void>
): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(arbitrary, (generated) => Effect.as(Effect.tryPromise(() => property(generated)), true), {
      seed: seed + offset,
      executions
    })
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

// --- the implementation's answers, in the oracle's shapes ------------------------------------------------------------

type Rendered = { readonly text: Units } | { readonly code: string; readonly path: Units }

const rendered = (input: unknown, escape: boolean): Rendered => {
  try {
    return { text: units(escape ? canonicalize(input, { loneSurrogates: "escape" }) : canonicalize(input)) }
  } catch (cause) {
    if (!(cause instanceof CanonicalError)) throw cause
    return { code: cause.code, path: units(cause.path) }
  }
}

const admitted = (result: BoundedJson.Result): unknown =>
  result.ok
    ? { bytes: result.bytes }
    : { code: result.code, complaint: result.complaint, path: result.path.map(units) }

const utf8 = new TextEncoder()

// --- the suite ------------------------------------------------------------------------------------------------------

describe("canonical JSON and bounded admission agree with the Lean specification", () => {
  differential("canonicalize serializes and refuses as the specification does, strictly and escaping", async () => {
    await agrees(Arbitrary.all([value, bit]), 0, async ([input, escape]) => {
      const actual = rendered(input, escape)
      expect(actual).toEqual(await oracle.ask("canonicalize", { value: wire(input), escape }))
    })
  })

  differential("canonicalizing a canonical document changes nothing", async () => {
    await agrees(Arbitrary.all([value, bit]), 1, async ([input, escape]) => {
      const first = rendered(input, escape)
      expect(await oracle.ask("normalizedAgain", { value: wire(input), escape })).toEqual(first)
      if (!("text" in first)) return
      const document = String.fromCharCode(...first.text)
      const reparsed: unknown = JSON.parse(document)
      expect(rendered(reparsed, escape)).toEqual(first)
      expect(await oracle.ask("canonicalize", { value: wire(reparsed), escape })).toEqual(first)
    })
  })

  differential("the depth limit is the specification's, to the level", async () => {
    for (const depth of [0, 1, 9999, 10_000, 10_001, 10_002]) {
      let nested: unknown = null
      for (let level = 0; level < depth; level++) nested = [nested]
      expect(rendered(nested, false)).toEqual(await oracle.ask("canonicalizeNested", { depth }))
    }
  })

  differential("encodedStringBytes counts as the specification does, with and without a maximum", async () => {
    await agrees(Arbitrary.all([text, text, limit(24, 10_000)]), 2, async ([head, tail, maximum]) => {
      const input = head + tail
      const actual = maximum === undefined
        ? BoundedJson.encodedStringBytes(input)
        : BoundedJson.encodedStringBytes(input, maximum)
      expect(actual ?? null).toEqual(
        await oracle.ask("encodedStringBytes", { text: units(input), maximum: maximum ?? null })
      )
      if (actual !== undefined) expect(actual).toBe(utf8.encode(JSON.stringify(input)).length)
    })
  })

  differential("admit accepts, counts and refuses as the specification does", async () => {
    await agrees(Arbitrary.all([value, limits, bit]), 3, async ([input, bounds, preflight]) => {
      const result = BoundedJson.admit(input, bounds, { preflightObjects: preflight })
      expect(admitted(result)).toEqual(
        await oracle.ask("admitJson", { value: wire(input), limits: bounds, preflight })
      )
      if (!result.ok) return
      // An accepted tree is copied whole, and its count is the size of its JSON text.
      expect(wire(result.value)).toEqual(wire(input))
      expect(result.bytes).toBe(utf8.encode(JSON.stringify(input)).length)
    })
  })

  differential("admitStrict accepts and refuses as the specification does, with either key diagnostic", async () => {
    await agrees(Arbitrary.all([value, strictLimits, bit]), 4, async ([input, bounds, boundedText]) => {
      const result = BoundedJson.admitStrict(input, bounds, { boundedText })
      const actual = result.ok
        ? { accepted: true }
        : { complaint: result.complaint, path: units(result.path) }
      expect(actual).toEqual(await oracle.ask("admitStrict", { value: wire(input), limits: bounds, boundedText }))
      if (result.ok) expect(wire(result.value)).toEqual(wire(input))
    })
  })

  differential("every case above was answered by the oracle", () => {
    expect(oracle.asked()).toBeGreaterThan(executions * 5)
  })
})
