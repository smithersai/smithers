/**
 * The MCP wire protocol against its Lean 4 reference specification (`spec/lean/mcp_protocol`), generated: the JSON
 * limits (`JsonLimits`, `Limits`), framing (`Transport.lines`), envelopes (`Rpc`) and reply correlation
 * (`StdioTransport`). Every case is answered by the implementation and by the specification's compiled oracle, and
 * the two answers must be equal.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A text crosses as its UTF-16 code units, so a lone surrogate arrives as it left. A number crosses as text: a
 * whole number in decimal, `fraction` for any other finite double, `nonFinite` for the rest. Bytes cross as numbers.
 *
 * A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
 * and builds it again when a source of the specification is newer than it.
 */
import { NodeServices } from "@effect/platform-node"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema, Stream } from "effect"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as JsonLimits from "../src/internal/JsonLimits.ts"
import * as Limits from "../src/internal/Limits.ts"
import * as Rpc from "../src/internal/Rpc.ts"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import * as Transport from "../src/internal/Transport.ts"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "mcp_protocol")
const binary = join(specDir, ".lake", "build", "bin", "mcp-protocol-spec")
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
    "McpProtocolSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "McpProtocolSpec")).map((name) => join("McpProtocolSpec", name))
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

/** A number as the oracle reads it: a whole number exactly, or what kind of double it is. */
const numberWire = (value: number): string =>
  Number.isInteger(value) ? BigInt(value).toString() : Number.isFinite(value) ? "fraction" : "nonFinite"

/** A parsed JSON value as the oracle reads it; an object's members cross in the engine's own-key order. */
const wire = (value: unknown): Wire => {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return { n: numberWire(value) }
  if (typeof value === "string") return { s: units(value) }
  if (Array.isArray(value)) return value.map(wire)
  const record = value as Record<string, unknown>
  return { o: Object.keys(record).map((key) => [units(key), wire(record[key])] as const) }
}

/** A value that may be absent, as the oracle writes it: an array of none or one. */
const optional = (value: unknown): ReadonlyArray<Wire> => (value === undefined ? [] : [wire(value)])

/**
 * JSON text for a value, with a literal past the finite range where the value holds an infinity: `JSON.parse` reads
 * `1e999` as `Infinity`, which is how a non-finite number reaches the client at all.
 */
const jsonText = (value: unknown): string => {
  if (typeof value === "number" && !Number.isFinite(value)) return value < 0 ? "-1e999" : "1e999"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(jsonText).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).map((key) => `${JSON.stringify(key)}:${jsonText(record[key])}`).join(",")}}`
}

// --- generators -----------------------------------------------------------------------------------------------------

const baseExecutions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "100"))
const executions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 5), 30))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261123")

const int = (minimum: number, maximum: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))

/** One of `values`; a failing case shrinks toward the first. */
const pick = <A>(values: ReadonlyArray<A>): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(int(0, values.length - 1), (index) => values[index]!)

const bit: Arbitrary.Arbitrary<boolean> = Arbitrary.schema(Schema.Boolean)

const list = <A>(item: Arbitrary.Arbitrary<A>, maxLength: number): Arbitrary.Arbitrary<Array<A>> =>
  Arbitrary.array(item, { maxLength })

/** Fails the test with the shrunk counterexample unless the property holds for every generated value. */
const agrees = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  offset: number,
  property: (value: A) => Promise<void>,
  runs: number = executions
): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(arbitrary, (generated) => Effect.as(Effect.tryPromise(() => property(generated)), true), {
      seed: seed + offset,
      executions: runs
    })
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** An object with exactly the given own keys, `__proto__` included, as `JSON.parse` would make it. */
const record = (entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> => {
  const made: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    Object.defineProperty(made, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return made
}

/** Numbers at every boundary the protocol reads: sign, wholeness, the safe range, and the finite range. */
const numbers = [
  0,
  1,
  2,
  3,
  -1,
  -0,
  7,
  1.5,
  -0.5,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  -Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER - 1,
  2 ** 53 + 2,
  1e300,
  -32_601,
  Infinity,
  -Infinity
] as const

const texts = ["", "a", "2.0", "ping", "é", "😺", "\ud800", "\n", "__proto__", "0", "1", "01"] as const

const jsonLeaf: Arbitrary.Arbitrary<unknown> = Arbitrary.map(
  Arbitrary.all([int(0, 9), bit, pick(numbers), pick(texts)]),
  ([choice, flag, number, made]) => (choice === 0 ? null : choice === 1 ? flag : choice <= 5 ? number : made)
)

/** A JSON value at most `depth` containers deep. */
const jsonTree = (depth: number): Arbitrary.Arbitrary<unknown> => {
  if (depth === 0) return jsonLeaf
  const below = jsonTree(depth - 1)
  return Arbitrary.map(
    Arbitrary.all([int(0, 5), jsonLeaf, list(below, 3), list(Arbitrary.all([pick(texts), below]), 3)]),
    ([choice, plain, items, entries]) => (choice <= 1 ? plain : choice <= 3 ? items : record(entries))
  )
}

const json = jsonTree(2)

// --- the tests ------------------------------------------------------------------------------------------------------

describe("the JSON limits against the Lean specification", () => {
  /** `count` containers around `inner`, each an array or an object by the bits of `shape`. */
  const spine = (count: number, shape: number, inner: unknown): unknown => {
    let made = inner
    for (let index = 0; index < count; index++) made = (shape >> (index % 16)) % 2 === 0 ? [made] : { k: made }
    return made
  }

  /** Branches whose depth straddles the limit, with numbers on either side of the finite range at their ends. */
  const branch: Arbitrary.Arbitrary<unknown> = Arbitrary.map(
    Arbitrary.all([
      pick([0, 1, 2, 125, 126, 127, 128, 129]),
      int(0, 65_535),
      pick([0, 1, "a", null, Infinity, -1e300])
    ]),
    ([count, shape, end]) => spine(count, shape, end)
  )

  const limited: Arbitrary.Arbitrary<unknown> = Arbitrary.map(
    Arbitrary.all([int(0, 3), list(branch, 4), json]),
    ([choice, branches, small]) =>
      choice === 0
        ? small
        : choice === 1
        ? branches
        : choice === 2
        ? record(branches.map((made, index) => [`k${index}`, made] as const))
        : branches[0] ?? small
  )

  differential("checkParsed reports the issue the specification reports, or none", async () => {
    await agrees(limited, 0, async (value) => {
      expect(JsonLimits.checkParsed(value) ?? null).toEqual(await oracle.ask("checkParsed", { value: wire(value) }))
    })
  })

  differential("checkParsed counts the envelope as the first of 128 containers", async () => {
    const passes = async (value: unknown): Promise<unknown> => {
      const actual = JsonLimits.checkParsed(value) ?? null
      expect(actual).toEqual(await oracle.ask("checkParsed", { value: wire(value) }))
      return actual
    }
    expect(await passes(spine(JsonLimits.maxDepth, 0, 1))).toBeNull()
    expect(await passes(spine(JsonLimits.maxDepth + 1, 0, 1))).toBe("JSON nesting exceeds 128 containers")
    expect(await passes(spine(JsonLimits.maxDepth, 0xaaaa, {}))).toBe("JSON nesting exceeds 128 containers")
    expect(await passes(spine(JsonLimits.maxDepth - 1, 0x5555, []))).toBeNull()
    // The last child is visited first, so of two issues the later one is reported.
    expect(await passes([spine(200, 0, 1), Infinity])).toBe("a JSON number is outside the finite range")
    expect(await passes([Infinity, spine(200, 0, 1)])).toBe("JSON nesting exceeds 128 containers")
  })

  const optionValues = [1, 2, 0, -1, -0, 1.5, Number.MAX_SAFE_INTEGER, 2 ** 53, 1e300, Number.NaN, Infinity] as const
  const optionNames = ["requestTimeoutMs", "queueCapacity", "maxFrameBytes", "", "a\"b", "é"] as const

  differential("isPositiveInteger and checkPositiveIntegers name the option the specification names", async () => {
    await agrees(list(Arbitrary.all([pick(optionNames), pick(optionValues)]), 6), 1, async (entries) => {
      for (const [, value] of entries) {
        expect(Limits.isPositiveInteger(value)).toBe(
          await oracle.ask("isPositiveInteger", { value: numberWire(value) })
        )
      }
      const expected = (await oracle.ask("firstInvalid", {
        entries: entries.map(([name, value]) => [units(name), numberWire(value)])
      })) as Units | null
      const result = await Effect.runPromise(Effect.result(Limits.checkPositiveIntegers("server", entries)))
      if (expected === null) return expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isFailure(result)) throw new Error("an option the specification refuses was accepted")
      expect(result.failure.code).toBe("protocol_error")
      expect(units(result.failure.message)).toEqual([
        ...units("MCP option \""),
        ...expected,
        ...units("\" must be a positive integer")
      ])
    })
  })
})

describe("framing against the Lean specification", () => {
  const utf8 = new TextEncoder()
  const pieces = ["a", "b", "\n", "\r", "\r\n", "\n\r", "é", "😺", "ab", "\r\r", "\n\n", "", "﻿", "{\"a\":1}"]
  const stream = Arbitrary.all([
    list(pick(pieces), 8),
    list(int(0, 5), 8),
    pick([1, 2, 3, 4, 5, 6, 8, 1024]),
    bit
  ])

  /** `bytes` cut into chunks of the given widths, repeated; a width of zero is an empty chunk. */
  const cut = (bytes: Uint8Array, widths: ReadonlyArray<number>): Array<Uint8Array> => {
    const chunks: Array<Uint8Array> = []
    if (widths.every((width) => width === 0)) return [bytes]
    for (let offset = 0, index = 0; offset < bytes.length; index++) {
      const end = offset + widths[index % widths.length]!
      chunks.push(bytes.subarray(offset, end))
      offset = end
    }
    return chunks
  }

  /** The implementation's lines, or `null` when it fails the stream for an overlong frame. */
  const framed = async (
    chunks: ReadonlyArray<Uint8Array>,
    max: number,
    crTerminates: boolean
  ): Promise<ReadonlyArray<string> | null> => {
    const result = await Effect.runPromise(
      Effect.result(Stream.runCollect(Transport.lines("framer", max, Stream.fromIterable(chunks), { crTerminates })))
    )
    if (Result.isSuccess(result)) return Array.from(result.success)
    expect(result.failure.code).toBe("protocol_error")
    expect(result.failure.message).toBe(`MCP frame exceeded ${max} bytes`)
    return null
  }

  /** The specification's lines for the same chunks, decoded as the implementation decodes a line. */
  const specified = async (
    chunks: ReadonlyArray<Uint8Array>,
    max: number,
    cr: boolean
  ): Promise<ReadonlyArray<string> | null> => {
    const answer = (await oracle.ask("lines", { cr, max, chunks: chunks.map((chunk) => Array.from(chunk)) })) as
      | ReadonlyArray<Units>
      | null
    return answer === null ? null : answer.map((line) => new TextDecoder().decode(Uint8Array.from(line)))
  }

  differential("splits any partition of a stream into the specification's lines", async () => {
    await agrees(stream, 2, async ([parts, widths, max, cr]) => {
      const bytes = utf8.encode(parts.join(""))
      const chunks = cut(bytes, widths)
      const streamed = await framed(chunks, max, cr)
      expect(streamed).toEqual(await specified(chunks, max, cr))
      // Chunk-split invariance, observed on both sides: one chunk holding every byte frames the same.
      const whole = await framed([bytes], max, cr)
      expect(whole).toEqual(await specified([bytes], max, cr))
      expect(streamed).toEqual(whole)
      // And so does one byte at a time.
      const bytewise = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1))
      expect(await framed(bytewise, max, cr)).toEqual(whole)
    })
  })

  differential("frames arbitrary bytes, valid UTF-8 or not, where the specification does", async () => {
    const raw = Arbitrary.all([
      list(pick([0x0a, 0x0d, 0x0a, 0x0d, 0x61, 0x00, 0xff, 0xc3, 0xa9, 0xef, 0xbb, 0xbf]), 16),
      list(int(0, 4), 6),
      pick([1, 2, 3, 5, 64]),
      bit
    ])
    await agrees(raw, 3, async ([values, widths, max, cr]) => {
      const chunks = cut(Uint8Array.from(values), widths)
      expect(await framed(chunks, max, cr)).toEqual(await specified(chunks, max, cr))
    })
  })

  differential("holds the cap at a CRLF cut between its bytes", async () => {
    const both = async (chunks: ReadonlyArray<string>, max: number, cr: boolean) => {
      const encoded = chunks.map((chunk) => utf8.encode(chunk))
      const actual = await framed(encoded, max, cr)
      expect(actual).toEqual(await specified(encoded, max, cr))
      return actual
    }
    expect(await both(["a\r", "\nb"], 1, false)).toEqual(["a", "b"])
    expect(await both(["a\r", "\nb"], 1, true)).toEqual(["a", "b"])
    expect(await both(["a\r", "b\n"], 1, false)).toBeNull()
    expect(await both(["a\r", "", "\n"], 1, true)).toEqual(["a"])
    expect(await both(["ab\r\r", "\n"], 3, false)).toEqual(["ab\r"])
    expect(await both(["\r"], 1, false)).toEqual([""])
    expect(await both(["\r"], 1, true)).toEqual([""])
    expect(await both(["a\r\r\nb"], 4, true)).toEqual(["a", "", "b"])
  })
})

// --- envelopes ------------------------------------------------------------------------------------------------------

/** One member of an envelope: absent, or one of the values that probe its checks. */
const member = <A>(values: ReadonlyArray<A>): Arbitrary.Arbitrary<A | undefined> =>
  Arbitrary.map(int(0, values.length), (index) => values[index - 1])

const errors = [
  { code: -32_601, message: "Method not found" },
  { code: 7, message: "tool missing", data: { a: [1] } },
  { code: 1e300, message: "" },
  { code: -0, message: "é", data: null },
  { code: 1.5, message: "m" },
  { code: "7", message: "m" },
  { code: 7, message: 7 },
  { code: 7 },
  { message: "m" },
  {},
  [],
  null,
  "error",
  { code: Infinity, message: "m" }
] as const

const ids = [
  1,
  2,
  3,
  "1",
  "2",
  "3",
  null,
  0,
  "0",
  -1,
  "-1",
  "01",
  "1.0",
  " 1",
  "",
  "a",
  1.5,
  true,
  [],
  {},
  Number.MAX_SAFE_INTEGER,
  String(Number.MAX_SAFE_INTEGER),
  Number.MAX_SAFE_INTEGER + 1,
  "9007199254740992",
  "9007199254740993",
  1e300,
  Infinity
] as const

/** An envelope with each member absent or hostile, in a generated member order. */
const envelope: Arbitrary.Arbitrary<Record<string, unknown>> = Arbitrary.map(
  Arbitrary.all([
    member(["2.0", "2.0", "2.0", "2.0", "1.0", 2, null]),
    member(ids),
    member(["ping", "notifications/progress", "tools/list", "", 5, null]),
    member([{}, { a: 1 }, [], null, "p", 1]),
    member([null, {}, { content: [] }, 0, "r", [1, 2]]),
    member(errors),
    int(0, 5),
    Arbitrary.all([int(0, 11), pick(["extra", "__proto__", "ID", "Method"]), json])
  ]),
  ([jsonrpc, id, method, params, result, error, rotate, [choice, extraKey, extra]]) => {
    // Most envelopes are a request, a notification or a reply; the rest carry any mix of members.
    const reply = choice <= 4
    const entries: Array<readonly [string, unknown]> = [
      ["jsonrpc", choice <= 9 ? "2.0" : jsonrpc],
      ["id", id],
      ["method", reply ? undefined : method],
      ["params", reply ? undefined : params],
      ["result", choice <= 2 ? (result === undefined ? null : result) : choice <= 4 ? undefined : result],
      ["error", choice <= 2 ? undefined : choice <= 4 ? (error === undefined ? errors[0] : error) : error],
      [extraKey, choice === 11 ? extra : undefined]
    ]
    const present = entries.filter(([, value]) => value !== undefined)
    return record([...present.slice(rotate % (present.length + 1)), ...present.slice(0, rotate % (present.length + 1))])
  }
)

type Tagged = Readonly<Record<string, unknown>>

/** A classification in the oracle's shape. */
const tagged = (classification: Rpc.Classification): Tagged => {
  switch (classification._tag) {
    case "Notification":
      return { tag: "Notification" }
    case "Request":
      return {
        tag: "Request",
        id: typeof classification.id === "string"
          ? { s: units(classification.id) }
          : { n: numberWire(classification.id) },
        method: units(classification.method),
        params: optional(classification.params)
      }
    case "Result":
      return { tag: "Result", id: numberWire(classification.id), result: wire(classification.result) }
    case "Error":
      return {
        tag: "Error",
        id: numberWire(classification.id),
        code: numberWire(classification.code),
        message: units(classification.message),
        data: optional(classification.data)
      }
    case "UncorrelatedError":
      return {
        tag: "UncorrelatedError",
        code: numberWire(classification.code),
        message: units(classification.message),
        data: optional(classification.data)
      }
    case "Malformed":
      return { tag: "Malformed", reason: classification.reason }
  }
}

describe("JSON-RPC envelopes against the Lean specification", () => {
  differential("parse keeps exactly the lines the specification takes for JSON-RPC", async () => {
    const line = Arbitrary.all([json, envelope, int(0, 3), pick(["", " ", "\t", "\r", " \n "])])
    await agrees(line, 4, async ([value, message, choice, padding]) => {
      const made = choice === 0 ? value : choice === 1 ? [message] : message
      const parsed = Rpc.parse(`${padding}${jsonText(made)}${padding}`)
      // The oracle reads the value `JSON.parse` returns, so a literal past the finite range arrives as it parses.
      const expected = await oracle.ask("accepts", { value: wire(JSON.parse(jsonText(made))) })
      expect(parsed !== undefined).toBe(expected)
      if (parsed !== undefined) expect(wire(parsed)).toEqual(wire(JSON.parse(jsonText(made))))
    })
    for (const noise of ["", "   ", "{", "log line", "[1,2", "{\"jsonrpc\":"]) expect(Rpc.parse(noise)).toBeUndefined()
  })

  differential("classify and replyOf give the specification's classification", async () => {
    await agrees(envelope, 5, async (message) => {
      const parsed = JSON.parse(jsonText(message)) as Rpc.Inbound
      expect(tagged(Rpc.classify(parsed))).toEqual(await oracle.ask("classify", { message: wire(parsed) }))
      expect(tagged(Rpc.replyOf(parsed))).toEqual(await oracle.ask("replyOf", { message: wire(parsed) }))
    })
  })

  differential("a reply's id is the id the client sent, in either spelling", async () => {
    await agrees(Arbitrary.all([int(0, 99_999), json]), 6, async ([id, result]) => {
      const classify = async (fields: Record<string, unknown>): Promise<unknown> => {
        const parsed = JSON.parse(jsonText({ jsonrpc: "2.0", ...fields })) as Rpc.Inbound
        const actual = tagged(Rpc.classify(parsed))
        expect(actual).toEqual(await oracle.ask("classify", { message: wire(parsed) }))
        return actual
      }
      const asNumber = await classify({ id, result })
      expect(await classify({ id: String(id), result })).toEqual(asNumber)
      expect(asNumber).toMatchObject({ tag: "Result", id: String(id) })
      // Every other spelling of the same number is refused, so one id has one text.
      for (const spelling of [`0${id}`, `${id}.0`, ` ${id}`, `+${id}`]) {
        expect(await classify({ id: spelling, result })).toMatchObject({ tag: "Malformed" })
      }
      // The same id on a server request stays the server's, exactly as written.
      expect(await classify({ id: String(id), method: "ping" })).toMatchObject({
        tag: "Request",
        id: { s: units(String(id)) }
      })
    })
  })
})

// --- correlation ----------------------------------------------------------------------------------------------------

/**
 * A line-oriented peer. Once it has read `count` requests it writes the scripted lines, then a late result for every
 * request it read, so a request the script did not settle still settles.
 */
const peer = String.raw`
const readline = require("node:readline")
const script = JSON.parse(process.argv[1])
const count = Number(process.argv[2])
const seen = new Map()
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method !== "ask" || seen.size === count) return
  seen.set(message.id, message.params.index)
  if (seen.size !== count) return
  let out = ""
  for (const scripted of script) out += scripted + "\r\n"
  for (const [id, index] of seen) out += JSON.stringify({ jsonrpc: "2.0", id, result: { late: index } }) + "\n"
  process.stdout.write(out)
})
`

type Action = {
  readonly do: "ignore" | "resolve" | "reject" | "report" | "respond" | "close" | "refuse"
  readonly id?: unknown
  readonly result?: Wire
  readonly code?: string
  readonly reason?: string
  readonly issue?: string
}

type Outcome = { readonly ok: Wire } | { readonly rejected: string } | { readonly closed: string }

describe("reply correlation against the Lean specification", () => {
  const count = 3
  const waiting = Array.from({ length: count }, (_, index) => index + 1)

  /** Lines a server could write while three requests wait: replies in both spellings, its own requests, and noise. */
  const scripted: Arbitrary.Arbitrary<unknown> = Arbitrary.map(
    Arbitrary.all([
      int(0, 15),
      pick([1, 2, 3, "1", "2", "3", 4, "4", 0, null, "01", 1.5]),
      pick([{ made: 1 }, null, "text", [1, 2], 0]),
      pick([-32_601, 7, -5, 0]),
      envelope
    ]),
    ([choice, id, result, code, any]) =>
      choice <= 5
        ? { jsonrpc: "2.0", id, result }
        : choice <= 8
        ? { jsonrpc: "2.0", id, error: { code, message: "refused", data: result } }
        : choice === 9
        ? { jsonrpc: "2.0", id, method: "ping" }
        : choice === 10
        ? { jsonrpc: "2.0", id, method: "tools/list", params: {} }
        : choice === 11
        ? { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }
        : choice === 12
        ? { log: "not JSON-RPC", id }
        : choice === 13
        ? { jsonrpc: "2.0", id, result: [Infinity] }
        : any
  )

  /** What each waiting request comes to, from the specification's actions. */
  const expectedOutcomes = (actions: ReadonlyArray<Action>): Array<Outcome> => {
    const outcomes = new Map<number, Outcome>()
    let closed: string | undefined
    for (const action of actions) {
      if (action.do === "resolve") outcomes.set(Number(action.id), { ok: action.result! })
      if (action.do === "reject") outcomes.set(Number(action.id), { rejected: action.code! })
      if (action.do === "close") closed = `sent a malformed JSON-RPC reply: ${action.reason}`
      if (action.do === "refuse") closed = `sent invalid JSON: ${action.issue}`
    }
    return waiting.map((id) => outcomes.get(id) ?? (closed === undefined ? { ok: wire({ late: id - 1 }) } : { closed }))
  }

  differential("the stdio transport settles each request as the specification's reader does", async () => {
    await agrees(list(scripted, 6), 7, async (messages) => {
      const lines = messages.map(jsonText)
      const answer = (await oracle.ask("readAll", {
        pending: waiting.map(String),
        lines: lines.map((line) => wire(JSON.parse(line)))
      })) as { readonly pending: ReadonlyArray<string>; readonly actions: ReadonlyArray<Action> }
      const actual = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const transport = yield* StdioTransport.connect({
            server: "peer",
            command: process.execPath,
            args: ["-e", peer, JSON.stringify(lines), String(count)],
            requestTimeoutMs: 10_000
          })
          // Requests are numbered from 1 in the order they start, so request `index` waits under id `index + 1`.
          return yield* Effect.forEach(
            waiting,
            (id) => Effect.result(transport.request("ask", { index: id - 1 })),
            { concurrency: "unbounded" }
          )
        })).pipe(Effect.provide(NodeServices.layer))
      )
      const outcomes = actual.map((result): Outcome => {
        if (Result.isSuccess(result)) return { ok: wire(result.success) }
        const rejected = /failed ask \((.+?)\)/.exec(result.failure.message)
        return rejected === null ? { closed: result.failure.message } : { rejected: numberWire(Number(rejected[1])) }
      })
      const expected = expectedOutcomes(answer.actions)
      outcomes.forEach((outcome, index) => {
        const want = expected[index]!
        if ("closed" in want && "closed" in outcome) expect(outcome.closed).toContain(want.closed)
        else expect(outcome).toEqual(want)
      })
      // A closed connection leaves nothing waiting; otherwise exactly the unsettled requests still wait.
      const settled = new Set(
        answer.actions.filter((action) => action.do === "resolve" || action.do === "reject").map((action) =>
          Number(action.id)
        )
      )
      const closes = answer.actions.some((action) => action.do === "close" || action.do === "refuse")
      expect(answer.pending).toEqual(closes ? [] : waiting.filter((id) => !settled.has(id)).map(String))
    }, ioExecutions)
  })

  differential("the specification's reader answers a server request under the server's id", async () => {
    const read = async (lines: ReadonlyArray<unknown>) =>
      (await oracle.ask("readAll", { pending: ["1", "2"], lines: lines.map(wire) })) as {
        readonly pending: ReadonlyArray<string>
        readonly actions: ReadonlyArray<Action>
      }
    // A ping whose id equals a waiting request's settles nothing.
    expect(await read([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: "1", method: "other" }]))
      .toEqual({
        pending: ["1", "2"],
        actions: [{ do: "respond", id: { n: "1" }, pong: true }, { do: "respond", id: { s: units("1") }, pong: false }]
      })
    // The same reply twice resolves once.
    expect(await read([{ jsonrpc: "2.0", id: "2", result: 5 }, { jsonrpc: "2.0", id: 2, result: 6 }])).toEqual({
      pending: ["1"],
      actions: [{ do: "resolve", id: "2", result: { n: "5" } }, { do: "ignore" }]
    })
    // Nothing is read after the line that closes the connection.
    expect(await read([{ jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, result: 1 }])).toEqual({
      pending: [],
      actions: [{ do: "close", reason: "a reply carried neither result nor error" }]
    })
  })
})

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope")
    await expect(oracle.ask("classify", { message: [] })).rejects.toThrow("the oracle refused")
    expect(await oracle.ask("lines", { cr: false, max: 4, chunks: [[97, 10]] })).toEqual([[97]])
  })

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(executions * 8)
  })
})
