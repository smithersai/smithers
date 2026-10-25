import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Redaction from "../src/Redaction.ts"
import * as TelemetryLog from "../src/TelemetryLog.ts"

const {
  maximumSnapshotBytes,
  maximumSnapshotDepth,
  maximumSnapshotMembers,
  truncatedMarker,
  unrenderableMarker
} = TelemetryLog

const decode = Schema.decodeUnknownSync(TelemetryLog.Log)
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** Every record `effect` logs, snapshotted inside the logger as a producer does. */
const capture = (
  effect: Effect.Effect<unknown>,
  settings?: TelemetryLog.SnapshotOptions
): ReadonlyArray<TelemetryLog.Log> => {
  const records: Array<TelemetryLog.Log> = []
  const logger = Logger.make<unknown, void>((options) => {
    records.push(TelemetryLog.snapshot(options, settings))
  })
  Effect.runSync(effect.pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger]))))
  return records.map((record) => decode(record))
}

/** The one record `effect` logs. */
const one = (effect: Effect.Effect<unknown>, settings?: TelemetryLog.SnapshotOptions): TelemetryLog.Log => {
  const records = capture(effect, settings)
  expect(records).toHaveLength(1)
  return records[0]!
}

/** A snapshot of a hand-built log event on the current fiber. */
const direct = (
  build: (fiber: Logger.Options<unknown>["fiber"]) => Logger.Options<unknown>,
  settings?: TelemetryLog.SnapshotOptions
): TelemetryLog.Log =>
  Effect.runSync(Effect.withFiber((fiber) => Effect.sync(() => decode(TelemetryLog.snapshot(build(fiber), settings)))))

/** The malformation a well-formed cut never leaves. */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * The exact work a synchronous block does over string buffers: code units the
 * bounding scanner reads one at a time, and code units handed to a full UTF-8
 * encode. Both are integers no machine load can move.
 */
const bufferPasses = <A>(
  body: () => A
): { readonly result: A; readonly unitsRead: number; readonly unitsEncoded: number } => {
  const charCodeAt = String.prototype.charCodeAt
  const encode = TextEncoder.prototype.encode
  let unitsRead = 0
  let unitsEncoded = 0
  String.prototype.charCodeAt = function(this: string, index: number): number {
    unitsRead += 1
    return charCodeAt.call(this, index)
  }
  TextEncoder.prototype.encode = function(this: TextEncoder, input?: string): ReturnType<TextEncoder["encode"]> {
    unitsEncoded += input === undefined ? 0 : input.length
    return encode.call(this, input)
  }
  try {
    return { result: body(), unitsRead, unitsEncoded }
  } finally {
    String.prototype.charCodeAt = charCodeAt
    TextEncoder.prototype.encode = encode
  }
}

/** A seeded generator, so a red property run is reproducible from its seed. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}

/** Values chosen to attack the snapshot: identity traps, unreadable members, malformed text, oversized payloads. */
const hostileValue = (next: () => number, depth: number): unknown => {
  switch (Math.floor(next() * 16)) {
    case 0: {
      const cycle: { self?: unknown } = {}
      cycle.self = cycle
      return cycle
    }
    case 1:
      return Object.defineProperty({}, "value", {
        enumerable: true,
        get: () => {
          throw new Error("must not run")
        }
      })
    case 2: {
      const revoked = Proxy.revocable({ value: "secret" }, {})
      revoked.revoke()
      return { revoked: revoked.proxy }
    }
    case 3:
      return "\u{1F600}".repeat(1 + Math.floor(next() * 64))
    case 4:
      return `${"\ud800"}lone${"\udfff"}`
    case 5:
      return depth > 6 ? "leaf" : { next: hostileValue(next, depth + 1) }
    case 6:
      return Array.from({ length: maximumSnapshotMembers + 8 }, (_, index) => index)
    case 7:
      return { apiKey: "x".repeat(maximumSnapshotBytes) }
    case 8:
      return 2n ** 70n
    case 9:
      return Symbol("hostile")
    case 10:
      return () => undefined
    case 11:
      return new Date(next() > 0.5 ? 0 : Number.NaN)
    case 12:
      return new Uint8Array([1, 2, 3])
    case 13:
      return { token: "sk-live-abcdefgh", nested: depth > 4 ? null : hostileValue(next, depth + 1) }
    case 14:
      return [Number.NaN, Number.POSITIVE_INFINITY, true, null, "\u0000"]
    default:
      return `plain-${Math.floor(next() * 1000)}`
  }
}

describe("TelemetryLog", () => {
  it("snapshots a versioned record under the telemetry.log event type", () => {
    expect(TelemetryLog.eventType).toBe("telemetry.log")
    expect(one(Effect.logInfo("hello"))).toMatchObject({
      version: 1,
      level: "Info",
      message: ["hello"],
      annotations: {},
      cause: { version: 1, reasons: [] }
    })
  })

  it("names a Redacted value without its label or the value it hides", () => {
    const record = one(
      Effect.logInfo("connecting", Redacted.make("sk-live-hidden-value", { label: "sk-live-label" }), {
        nested: Redacted.make("sk-live-nested-value")
      })
    )
    expect(record.message).toEqual(["connecting", TelemetryLog.redactedMarker, { nested: "<redacted>" }])
    expect(JSON.stringify(record)).not.toContain("sk-live")
  })

  it("detaches mutable messages and annotations before asynchronous delivery", () => {
    const message = { value: "before", nested: { token: "sk-live-abcdefgh" } }
    const annotation = { value: "annotation-before" }
    const records: Array<TelemetryLog.Log> = []
    const logger = Logger.make<unknown, void>((options) => {
      records.push(TelemetryLog.snapshot(options))
    })
    Effect.runSync(
      Effect.logInfo(message).pipe(
        Effect.annotateLogs({ snapshot: annotation }),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger]))
      )
    )
    message.value = "after"
    message.nested.token = "after"
    annotation.value = "annotation-after"
    expect(records[0]!.message).toEqual([{ value: "before", nested: { token: "[REDACTED]" } }])
    expect(records[0]!.annotations).toEqual({ snapshot: { value: "annotation-before" } })
  })

  it("names cycles, accessors, revoked proxies, binaries, and bounded excess", () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("must not run")
      }
    })
    const revoked = Proxy.revocable({ value: "secret" }, {})
    revoked.revoke()
    const many = Object.fromEntries(
      Array.from({ length: maximumSnapshotMembers + 10 }, (_, index) => [`key-${index}`, index])
    )
    const message = one(
      Effect.logInfo(cycle, accessor, { revoked: revoked.proxy }, new Uint8Array([1, 2]), many, 1n, undefined)
    ).message as ReadonlyArray<unknown>
    expect(message[0]).toEqual({ self: "[Circular]" })
    expect(message[1]).toEqual({ value: unrenderableMarker })
    expect(message[2]).toEqual({ revoked: unrenderableMarker })
    expect(message[3]).toBe("[Binary]")
    expect(message[4]).toMatchObject({ [truncatedMarker]: truncatedMarker })
    expect(message.slice(5)).toEqual([truncatedMarker])
  })

  it("detaches every supported value shape within explicit depth and byte ceilings", () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let depth = 0; depth <= maximumSnapshotDepth + 1; depth++) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    const sparse = new Array<unknown>(2)
    sparse[1] = "tail"
    const descriptorless = new Proxy({}, { ownKeys: () => ["missing"], getOwnPropertyDescriptor: () => undefined })
    const unreadable = new Proxy({}, {
      ownKeys: () => {
        throw new Error("unreadable keys")
      }
    })
    const hostileError = new Proxy(new Error("boom"), {
      getOwnPropertyDescriptor: (target, key) => {
        if (key === "stack") throw new Error("unreadable stack")
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    const hostileView = new Proxy(new Uint8Array(1), {
      getPrototypeOf: () => {
        throw new Error("unreadable prototype")
      }
    })
    const records = capture(Effect.gen(function*() {
      yield* Effect.logInfo(
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NaN,
        true,
        false,
        null,
        1n,
        undefined,
        () => undefined,
        Symbol("shape"),
        new Date(0),
        new Date(Number.NaN),
        hostileError,
        sparse,
        descriptorless,
        unreadable,
        deep,
        [hostileView]
      )
      yield* Effect.logInfo("x".repeat(maximumSnapshotBytes + 100), "after-budget")
      yield* Effect.logInfo("x".repeat(maximumSnapshotBytes - 100), "y".repeat(200))
      yield* Effect.logInfo("spanned").pipe(Effect.withSpan("telemetry-log-span"))
    }))
    const shapes = records[0]!.message as ReadonlyArray<unknown>
    expect(shapes.slice(0, 7)).toEqual(["Infinity", "-Infinity", "NaN", true, false, null, "1n"])
    expect(shapes.slice(7, 11)).toEqual(["[Undefined]", "[Function]", "[Symbol]", "1970-01-01T00:00:00.000Z"])
    expect(shapes[11]).toBe(unrenderableMarker)
    expect(shapes[12]).toMatchObject({ name: "Error", message: "boom", stack: unrenderableMarker })
    expect(shapes[13]).toEqual([unrenderableMarker, "tail"])
    expect(shapes[14]).toEqual({ missing: unrenderableMarker })
    expect(shapes[15]).toBe(unrenderableMarker)
    expect(JSON.stringify(shapes[16])).toContain("[Deep]")
    expect(shapes[17]).toEqual([unrenderableMarker])
    expect(bytes(records[1])).toBeLessThanOrEqual(maximumSnapshotBytes)
    expect(JSON.stringify(records[1]!.message)).toContain(truncatedMarker)
    expect(JSON.stringify(records[2]!.message)).toContain(truncatedMarker)
    expect(records[3]!.traceId).toBeTypeOf("string")
    expect(records[3]!.spanId).toBeTypeOf("string")
  })

  it("stays total when runtime-owned metadata is unreadable", () => {
    const record = direct((fiber) => ({
      message: ["unreachable"],
      logLevel: "Info",
      cause: Cause.empty,
      fiber: {
        id: fiber.id,
        get context(): never {
          throw new Error("unreadable fiber context")
        }
      } as never,
      date: new Date(0)
    }))
    expect(record).toMatchObject({
      message: unrenderableMarker,
      annotations: {},
      cause: { version: 1, reasons: [] },
      timestamp: "1970-01-01T00:00:00.000Z"
    })
  })

  it("persists ordered fail, defect, and interrupt reasons with redaction", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("request failed token=sk-live-abcdefgh")),
      Cause.combine(Cause.die({ apiKey: "secret" }), Cause.combine(Cause.interrupt(41), Cause.interrupt()))
    )
    expect(one(Effect.logError("failed", cause)).cause.reasons).toMatchObject([
      { _tag: "Fail", error: { name: "Error", message: "request failed token=[REDACTED]" } },
      { _tag: "Die", defect: { apiKey: "[REDACTED]" } },
      { _tag: "Interrupt", fiberId: 41 },
      { _tag: "Interrupt", fiberId: null }
    ])
  })

  it("keeps tagged error fields and system error diagnostics", () => {
    class ActionFailed extends Schema.TaggedError<ActionFailed>()("ActionFailed", {
      code: Schema.String,
      actionId: Schema.String,
      cause: Schema.optional(Schema.Unknown)
    }) {}
    const systemError = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
      syscall: "open",
      path: "/tmp/missing token=sk-live-abcdefgh"
    })
    const tagged = new ActionFailed({ code: "quota_exhausted", actionId: "action-7", cause: systemError })
    const [failed, died] = one(Effect.logError("failed", Cause.combine(Cause.fail(tagged), Cause.die(systemError))))
      .cause.reasons as ReadonlyArray<{ error?: unknown; defect?: unknown }>
    expect(failed!.error).toMatchObject({
      name: "ActionFailed",
      _tag: "ActionFailed",
      code: "quota_exhausted",
      actionId: "action-7",
      cause: { name: "Error", code: "ENOENT", syscall: "open", path: "/tmp/missing token=[REDACTED]" }
    })
    expect(died!.defect).toMatchObject({ name: "Error", message: "ENOENT: no such file", code: "ENOENT" })
  })

  it("marks an error truncated past the member budget, and an own accessor unread", () => {
    const wide = Object.assign(
      new Error("wide"),
      Object.fromEntries(Array.from({ length: maximumSnapshotMembers + 8 }, (_, index) => [`field${index}`, index]))
    )
    const [wideReason] = one(Effect.logError("failed", Cause.die(wide))).cause.reasons as ReadonlyArray<
      { defect?: Record<string, unknown> }
    >
    expect(wideReason!.defect![truncatedMarker]).toBe(truncatedMarker)
    expect(Object.keys(wideReason!.defect!).length).toBeLessThanOrEqual(maximumSnapshotMembers + 1)
    const withAccessor = Object.defineProperty(new Error("accessor"), "detail", {
      enumerable: true,
      get: () => {
        throw new Error("must not run")
      }
    })
    const [accessorReason] = one(Effect.logError("failed", Cause.die(withAccessor))).cause.reasons as ReadonlyArray<
      { defect?: unknown }
    >
    expect(accessorReason!.defect).toMatchObject({ name: "Error", message: "accessor", detail: unrenderableMarker })
  })

  it("never invokes caller serialization or accessors for dates and standard error fields", () => {
    let calls = 0
    const date = new Date(0)
    Object.defineProperty(date, "toISOString", {
      get: () => {
        calls++
        return () => "caller controlled"
      }
    })
    expect(one(Effect.logInfo(date)).message).toEqual(["1970-01-01T00:00:00.000Z"])
    const error = new Error("original")
    for (const key of ["stack", "message", "cause"]) {
      Object.defineProperty(error, key, {
        configurable: true,
        get: () => {
          calls++
          return "getter result"
        }
      })
    }
    Object.setPrototypeOf(
      error,
      Object.create(Error.prototype, {
        name: {
          get: () => {
            calls++
            return "getter name"
          }
        }
      })
    )
    expect(one(Effect.logError("failed", Cause.die(error))).cause.reasons).toEqual([{
      _tag: "Die",
      defect: {
        name: unrenderableMarker,
        message: unrenderableMarker,
        stack: unrenderableMarker,
        cause: unrenderableMarker
      }
    }])
    expect(calls).toBe(0)
  })

  it("bounds inherited error fields beyond the depth, and keeps the standard fields when own keys refuse", () => {
    let prototype: object = Error.prototype
    for (let depth = 0; depth <= maximumSnapshotDepth; depth++) prototype = Object.create(prototype)
    expect(one(Effect.logError("failed", Cause.die(Object.create(prototype)))).cause.reasons).toEqual([{
      _tag: "Die",
      defect: { name: truncatedMarker, message: truncatedMarker, stack: truncatedMarker, cause: truncatedMarker }
    }])
    const refuses = new Proxy(new Error("ownKeys refuses"), {
      ownKeys: () => {
        throw new Error("ownKeys trap refuses")
      }
    })
    const [died] = one(Effect.logError("failed", Cause.die(refuses))).cause.reasons as ReadonlyArray<
      { defect?: Record<string, unknown> }
    >
    expect(Object.keys(died!.defect!).sort()).toEqual(["cause", "message", "name", "stack"])
    expect(died!.defect).toMatchObject({ name: "Error", message: "ownKeys refuses" })
  })

  it("never lets a truncated key overwrite a member already in a record or an error", () => {
    // Key "a[Truncated]" (14) + "keep" (6) + key "apiKey" (8) + the filler
    // (its length + 2) leaves exactly 14 bytes, so the oversized third key
    // truncates to "a" and reads "a[Truncated]".
    const fillerLength = maximumSnapshotBytes - 14 - 6 - 8 - 2 - 14
    const message = {
      [`a${truncatedMarker}`]: "keep",
      apiKey: "x".repeat(fillerLength),
      [`a${"b".repeat(maximumSnapshotBytes)}`]: "overwrite"
    }
    const [record] = one(Effect.logInfo(message)).message as ReadonlyArray<Record<string, unknown>>
    expect(record![`a${truncatedMarker}`]).toBe("keep")
    expect(record![truncatedMarker]).toBe(truncatedMarker)

    const failure = new Error("m")
    failure.name = "E"
    Object.defineProperty(failure, "stack", { configurable: true, value: "s" })
    // Message ["failed"] (8), the standard fields "E", "m", "s", "[Undefined]"
    // (22), then the same three keys as above.
    Object.assign(failure, {
      [`a${truncatedMarker}`]: "keep",
      apiKey: "x".repeat(maximumSnapshotBytes - 8 - 22 - 14 - 6 - 8 - 2 - 14),
      [`a${"b".repeat(maximumSnapshotBytes)}`]: "overwrite"
    })
    const [died] = one(Effect.logError("failed", Cause.die(failure))).cause.reasons as ReadonlyArray<
      { defect?: Record<string, unknown> }
    >
    expect(died!.defect![`a${truncatedMarker}`]).toBe("keep")
    expect(died!.defect![truncatedMarker]).toBe(truncatedMarker)
  })

  it("cuts long plain runs at the exact byte the budget leaves", () => {
    // Key "apiKey" (8) + the filler (its length + 2) leaves 141 bytes; the
    // oversized key spends 13 on the marker and quotes, keeping 128 bytes: two
    // 48-byte lines (each newline escapes to two bytes) and 30 letters.
    const line = `${"a".repeat(47)}\n`
    const message = { apiKey: "x".repeat(maximumSnapshotBytes - 8 - 2 - 141), [line.repeat(30_000)]: "dropped" }
    const [record] = one(Effect.logInfo(message)).message as ReadonlyArray<Record<string, unknown>>
    const cut = `${line.repeat(2)}${"a".repeat(30)}${truncatedMarker}`
    expect(Object.keys(record!).filter((key) => key !== "apiKey")).toEqual([cut])
    expect(record![cut]).toBe(truncatedMarker)
  })

  it("keeps annotations a record when the budget is spent or the reference is unusable", () => {
    const spent = one(
      Effect.logInfo({ apiKey: "x".repeat(maximumSnapshotBytes) }).pipe(
        Effect.annotateLogs({ lane: "spent" })
      )
    )
    expect(spent.message).toEqual([{ apiKey: "[REDACTED]" }])
    expect(spent.annotations).toEqual({ [truncatedMarker]: truncatedMarker })
    for (const annotations of [null, ["not", "a", "record"]]) {
      const record = direct((fiber) => ({
        message: ["shape"],
        logLevel: "Info",
        cause: Cause.empty,
        fiber: { id: fiber.id, context: fiber.context, getRef: () => annotations } as never,
        date: new Date(0)
      }))
      expect(record.annotations).toEqual({ [truncatedMarker]: truncatedMarker })
    }
  })

  it("degrades to a decodable total record when the projection fails its own schema", () => {
    // A negative interrupt identity is outside `Interrupt`.
    expect(one(Effect.logError("refused", Cause.interrupt(-1)))).toMatchObject({
      level: "Error",
      message: truncatedMarker,
      annotations: {},
      cause: { version: 1, reasons: [] }
    })
  })

  it("bounds a multi-megabyte record in one pass and never retains half a surrogate pair", () => {
    const astral = "\u{1F600}".repeat(600_000)
    const escaped = `"\\\n\u0001aéあ𐀀\u{1F600}`.repeat(200_000)
    const malformed = `${"\ud800"}lone${"\udfff"}`.repeat(200_000)
    const lines = `${"a".repeat(47)}\n`.repeat(30_000)
    const inputs = [astral, escaped, malformed, lines]
    const measured = inputs.map((input) =>
      bufferPasses(() =>
        direct((fiber) => ({ message: input, logLevel: "Info", cause: Cause.empty, fiber, date: new Date(0) }))
      )
    )
    measured.forEach(({ result, unitsEncoded, unitsRead }, index) => {
      const input = inputs[index]!
      expect(unitsRead).toBeLessThanOrEqual(maximumSnapshotBytes + 2)
      expect(unitsRead).toBeLessThan(input.length)
      // The only full encode is the one size check on the bounded projection;
      // a second encode of even the smallest input would add 1,200,000 units.
      expect(unitsEncoded).toBeLessThanOrEqual(maximumSnapshotBytes + 64 * 1024)
      const message = result.message as string
      expect(message.endsWith(truncatedMarker)).toBe(true)
      const prefix = message.slice(0, -truncatedMarker.length)
      expect(prefix.length).toBeGreaterThan(0)
      expect(input.startsWith(prefix)).toBe(true)
      const next = String.fromCodePoint(input.codePointAt(prefix.length)!)
      expect(bytes({ ...result, message: `${prefix}${next}${truncatedMarker}` })).toBeGreaterThan(maximumSnapshotBytes)
      expect(bytes(result)).toBeLessThanOrEqual(maximumSnapshotBytes)
    })
    expect(loneSurrogate.test(measured[0]!.result.message as string)).toBe(false)
    expect(loneSurrogate.test(measured[1]!.result.message as string)).toBe(false)
    expect(loneSurrogate.test(measured[3]!.result.message as string)).toBe(false)
  })

  it("freezes the durable telemetry.log wire shape", () => {
    const cause = Cause.combine(
      Cause.fail({ code: "golden_failure" }),
      Cause.combine(Cause.die({ reason: "golden_defect" }), Cause.combine(Cause.interrupt(7), Cause.interrupt()))
    )
    const { fiberId, spanId, timestamp, traceId, ...frozen } = one(
      Effect.logError("golden", cause).pipe(
        Effect.annotateLogs({ lane: "golden", attempt: 2 }),
        Effect.withSpan("golden-span")
      )
    )
    expect(frozen).toEqual({
      version: 1,
      level: "Error",
      message: ["golden"],
      annotations: { lane: "golden", attempt: 2 },
      cause: {
        version: 1,
        reasons: [
          { _tag: "Fail", error: { code: "golden_failure" } },
          { _tag: "Die", defect: { reason: "golden_defect" } },
          { _tag: "Interrupt", fiberId: 7 },
          { _tag: "Interrupt", fiberId: null }
        ]
      }
    })
    expect(Number.isInteger(fiberId) && fiberId >= 0).toBe(true)
    expect(traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it("keeps every generated payload decodable and inside the byte ceiling", () => {
    const seed = 0x5eed_1234
    const next = mulberry32(seed)
    const records = capture(Effect.gen(function*() {
      for (let index = 0; index < 200; index++) {
        yield* Effect.logInfo({ value: hostileValue(next, 0) }).pipe(
          Effect.annotateLogs({ note: { value: hostileValue(next, 0) } })
        )
      }
    }))
    expect(records, `seed ${seed}`).toHaveLength(200)
    for (const [index, record] of records.entries()) {
      expect(bytes(record), `seed ${seed}, record ${index}`).toBeLessThanOrEqual(maximumSnapshotBytes)
    }
  })

  describe("SnapshotOptions", () => {
    const attribution = { runId: "run-1", stepKeyDigest: "a".repeat(64) }

    it("bounds a record to maximumBytes, and a non-finite or larger bound takes the default ceiling", () => {
      const long = "x".repeat(10_000)
      const small = one(Effect.logInfo(long), { maximumBytes: 512 })
      expect(bytes(small)).toBeLessThanOrEqual(512)
      expect((small.message as ReadonlyArray<string>)[0]!.endsWith(truncatedMarker)).toBe(true)
      for (const maximumBytes of [Number.POSITIVE_INFINITY, Number.NaN, maximumSnapshotBytes * 4]) {
        expect(one(Effect.logInfo(long), { maximumBytes }).message).toEqual([long])
      }
    })

    it("copies the producer's annotations first, lets them win, and keeps them through every fallback", () => {
      const record = one(
        Effect.logInfo("attributed").pipe(Effect.annotateLogs({ runId: "forged", lane: "kept" })),
        { annotations: attribution }
      )
      expect(Object.entries(record.annotations)).toEqual([
        ["runId", "run-1"],
        ["stepKeyDigest", "a".repeat(64)],
        ["lane", "kept"]
      ])
      // A spent member budget still holds the producer's names, copied first.
      const wide = Object.fromEntries(
        Array.from({ length: maximumSnapshotMembers + 4 }, (_, index) => [`k${index}`, index])
      )
      const crowded = one(Effect.logInfo("crowded").pipe(Effect.annotateLogs(wide)), { annotations: attribution })
      expect(crowded.annotations).toMatchObject({ ...attribution, [truncatedMarker]: truncatedMarker })
      // A record too large for the bound loses its message, not its attribution.
      const tiny = one(Effect.logInfo("y".repeat(400)), { maximumBytes: 64, annotations: attribution })
      expect(tiny).toMatchObject({ message: truncatedMarker, annotations: attribution })
      // An unreadable fiber keeps them too.
      const unreadable = direct((fiber) => ({
        message: ["unreachable"],
        logLevel: "Warn",
        cause: Cause.empty,
        fiber: {
          id: fiber.id,
          get context(): never {
            throw new Error("unreadable fiber context")
          }
        } as never,
        date: new Date(0)
      }), { annotations: attribution })
      expect(unreadable).toMatchObject({ message: unrenderableMarker, annotations: attribution })
      // An unusable annotations reference is replaced by the producer's.
      const replaced = direct((fiber) => ({
        message: ["shape"],
        logLevel: "Info",
        cause: Cause.empty,
        fiber: { id: fiber.id, context: fiber.context, getRef: () => null } as never,
        date: new Date(0)
      }), { annotations: attribution })
      expect(replaced.annotations).toEqual(attribution)
    })

    it("redacts with the rules it is given", () => {
      const line = "fetching https://bucket.test/report?sig=abc123"
      // The two rule sets disagree on this line, so the case can tell them apart.
      expect(Redaction.redactDiagnostic(line)).not.toEqual(Redaction.redact(line))
      expect(one(Effect.logInfo(line)).message).toEqual([Redaction.redact(line)])
      expect(one(Effect.logInfo(line), { rules: Redaction.diagnosticRules }).message).toEqual([
        Redaction.redactDiagnostic(line)
      ])
    })

    it("cuts a long message to the bound and keeps the attribution and the other annotations' marker", () => {
      const record = one(
        Effect.logInfo("z".repeat(10_000)).pipe(Effect.annotateLogs({ lane: "spent" })),
        { maximumBytes: 1024, annotations: attribution }
      )
      expect(bytes(record)).toBeLessThanOrEqual(1024)
      expect((record.message as ReadonlyArray<string>)[0]).toMatch(/^z+\[Truncated\]$/)
      expect(record.annotations).toEqual({ ...attribution, [truncatedMarker]: truncatedMarker })
    })
  })
})
