/**
 * What the drain writes when a flow's own codec rejects its settlement.
 *
 * release validation found the drain guarding the terminal transition with
 * `Effect.orDie` around that encode: `engine-store: coordinated drain failed
 * for run-1 SchemaError: Expected JSON value at ["exit"]["cause"][0]["error"]`,
 * after which the engine row stayed `running` under a dead owner and the next
 * process stole it and called the model seat a second time. Every case here
 * asserts the opposite property — the encode answers bytes for every cause
 * shape, and it says so when those bytes are a projection rather than the
 * flow's own encoding.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Logger, Schema } from "effect"
import * as ExitEncoding from "../src/internal/ExitEncoding.ts"
import { RunState } from "../src/RunState.ts"

/** The shape `@smthrs/agent`'s `agent/run` declares: both channels unknown. */
const unknownFlow = Flow.make("test/unknown", {
  payload: { runId: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/** A provider failure shape observed by a persisted run. */
class ModelError extends Schema.TaggedError<ModelError>()("flows/model/ModelError", {
  code: Schema.String,
  message: Schema.String
}) {}

/** The harness failure that wrapped it. */
class HarnessError extends Schema.TaggedError<HarnessError>()("/harness/HarnessError", {
  code: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

const quota = new ModelError({ code: "quota_exceeded", message: "You have no credits remaining" })

const wrapped = new HarnessError({ code: "model_failed", message: "The model call failed", cause: quota })

/** Runs an encode with the warning silenced, as the drain does under a logger. */
const run = <A>(effect: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([]))))

const encode = (result: Flow.Result<unknown, unknown>) => run(ExitEncoding.encode(unknownFlow, result))

/** Decodes persisted bytes exactly as `RunDriver`'s `poll` does. */
const decode = (encoded: unknown) =>
  run(
    Schema.decodeUnknownEffect(
      Schema.toCodecJson(Flow.Result({
        success: unknownFlow.successSchema,
        error: unknownFlow.errorSchema
      }))
    )(encoded).pipe(Effect.orDie) as Effect.Effect<Flow.Result<unknown, unknown>>
  )

const projection = (encoded: unknown): ExitEncoding.ResultProjection => {
  const die = (encoded as {
    exit: { cause: ReadonlyArray<{ defect: ExitEncoding.ResultProjection }> }
  }).exit.cause[0]
  if (die === undefined) throw new Error("the degraded exit carries no reason")
  return die.defect
}

describe("a settlement the flow's own codec accepts", () => {
  it("encodes through that codec and reports no projection", async () => {
    const encoded = await encode(new Flow.Complete({ exit: Exit.succeed({ ok: true }) }))

    expect(encoded.note).toBeUndefined()
    expect(encoded.encoded).toEqual({ _tag: "Complete", exit: { _tag: "Success", value: { ok: true } } })
  })
})

describe("a `Fail` cause carrying a typed error the codec rejects", () => {
  it("still answers bytes, and projects the tag, code, message, and nested cause", async () => {
    const encoded = await encode(new Flow.Complete({ exit: Exit.fail(wrapped) }))

    expect(encoded.note).toBe("the flow result codec rejected the settlement")
    const projected = projection(encoded.encoded)
    expect(projected._tag).toBe(ExitEncoding.projectionTag)
    expect(projected.result).toBe("Complete")
    expect(projected.reasons).toHaveLength(1)
    expect(projected.reasons[0]?._tag).toBe("Fail")
    expect(projected.reasons[0]?.error?.tag).toBe("/harness/HarnessError")
    expect(projected.reasons[0]?.error?.code).toBe("model_failed")
    expect(projected.reasons[0]?.error?.message).toBe("The model call failed")
    expect(projected.reasons[0]?.error?.cause?.tag).toBe("flows/model/ModelError")
    expect(projected.reasons[0]?.error?.cause?.code).toBe("quota_exceeded")
    expect(projected.reasons[0]?.error?.cause?.message).toBe("You have no credits remaining")
    expect(projected.value).toBeNull()
  })

  it("writes bytes the poll path can decode back", async () => {
    const encoded = await encode(new Flow.Complete({ exit: Exit.fail(wrapped) }))

    const decoded = await decode(encoded.encoded)

    expect(decoded._tag).toBe("Complete")
    const exit = (decoded as Flow.Complete<unknown, unknown>).exit
    expect(Exit.isFailure(exit)).toBe(true)
    // Round-tripped as the structured record it went in as: `Schema.Defect`
    // revives an object with a top-level string `message` as an `Error`, and a
    // projection deliberately has none.
    expect((exit as Exit.Failure<unknown, unknown>).cause.reasons[0]).toMatchObject({
      _tag: "Die",
      defect: { _tag: ExitEncoding.projectionTag }
    })
  })
})

describe("a `Die` cause carrying a defect the codec accepts anyway", () => {
  it("encodes through the flow's codec, because `Schema.Defect` takes any value", async () => {
    const encoded = await encode(new Flow.Complete({ exit: Exit.die(new Error("boom")) }))

    expect(encoded.note).toBeUndefined()
  })
})

describe("a cause mixing a typed failure, a defect, and an interrupt", () => {
  it("projects every reason in order", async () => {
    const cause = Cause.fromReasons([
      Cause.makeFailReason(wrapped),
      Cause.makeDieReason(new Error("defect text")),
      Cause.makeInterruptReason(42)
    ])

    const encoded = await encode(new Flow.Complete({ exit: Exit.failCause(cause) }))

    const projected = projection(encoded.encoded)
    expect(projected.reasons.map((reason) => reason._tag)).toEqual(["Fail", "Die", "Interrupt"])
    expect(projected.reasons[1]?.error?.type).toBe("Error")
    expect(projected.reasons[1]?.error?.message).toBe("defect text")
    expect(projected.reasons[1]?.error?.stack).toBeUndefined()
    expect(projected.reasons[2]?.fiberId).toBe(42)
  })

  it("projects an interrupt with no fiber id without inventing one", async () => {
    const cause = Cause.fromReasons([Cause.makeFailReason(wrapped), Cause.makeInterruptReason()])

    const encoded = await encode(new Flow.Complete({ exit: Exit.failCause(cause) }))

    expect(projection(encoded.encoded).reasons[1]).toEqual({ _tag: "Interrupt" })
  })
})

describe("a success value the codec rejects", () => {
  it("settles as a failed `Complete` carrying the projected value", async () => {
    const encoded = await encode(new Flow.Complete({ exit: Exit.succeed(wrapped) }))

    const projected = projection(encoded.encoded)
    expect(projected.result).toBe("Complete")
    expect(projected.reasons).toEqual([])
    expect(projected.value?.tag).toBe("/harness/HarnessError")
  })
})

describe("a suspension", () => {
  // `Flow.Suspended` types its cause `Schema.Cause(Schema.Never,
  // Schema.Defect())` and validates it in the constructor, so a suspension the
  // codec would reject cannot be built; the projection is pinned directly so
  // the shape stays correct if that ever widens.
  it("projects its reasons under the `Suspended` shape", () => {
    const projected = ExitEncoding.projectResult(
      new Flow.Suspended({ cause: Cause.die(wrapped) }),
      "note"
    )

    expect(projected.result).toBe("Suspended")
    expect(projected.reasons[0]?._tag).toBe("Die")
    expect(projected.reasons[0]?.error?.tag).toBe("/harness/HarnessError")
    expect(projected.value).toBeNull()
  })

  it("encodes through the flow's own codec, so nothing is projected", async () => {
    const encoded = await encode(new Flow.Suspended({ cause: Cause.die(wrapped) }))

    expect(encoded.note).toBeUndefined()
  })
})

describe("a handoff whose payload the codec rejects", () => {
  it("keeps the handoff shape so the lineage stays readable", async () => {
    const encoded = await encode(new Flow.Handoff({ flow: "test/next", payload: wrapped }))

    expect(encoded.note).toBe("the flow result codec rejected the settlement")
    expect(encoded.encoded).toMatchObject({
      _tag: "Handoff",
      flow: "test/next",
      payload: { _tag: ExitEncoding.projectionTag, result: "Handoff" }
    })
  })
})

describe("value projection", () => {
  it("names a primitive by its `typeof` and renders it", () => {
    expect(ExitEncoding.projectValue("boom")).toEqual({ type: "string", message: "\"boom\"" })
    expect(ExitEncoding.projectValue(7)).toEqual({ type: "number", message: "7" })
    expect(ExitEncoding.projectValue(null)).toEqual({ type: "null", message: "null" })
  })

  it("renders every remaining primitive and container shape", () => {
    expect(ExitEncoding.projectValue(Number.POSITIVE_INFINITY)).toEqual({
      type: "number",
      message: "[number]"
    })
    expect(ExitEncoding.projectValue(true)).toEqual({ type: "boolean", message: "true" })
    expect(ExitEncoding.projectValue(false)).toEqual({ type: "boolean", message: "false" })
    expect(ExitEncoding.projectValue(1n)).toEqual({ type: "bigint", message: "[bigint]" })
    expect(ExitEncoding.projectValue(() => undefined)).toEqual({
      type: "function",
      message: "[function]"
    })
    expect(ExitEncoding.projectValue([])).toEqual({ type: "Array", message: "[array]" })
  })

  it("renders a value `JSON.stringify` drops by its shape", () => {
    expect(ExitEncoding.projectValue(undefined)).toEqual({ type: "undefined", message: "[undefined]" })
    expect(ExitEncoding.projectValue(Symbol("s"))).toEqual({ type: "symbol", message: "[symbol]" })
  })

  it("renders a circular object without raising", () => {
    const circular: Record<string, unknown> = {}
    circular["self"] = circular

    expect(ExitEncoding.projectValue(circular)).toEqual({ type: "object", message: "[object]" })
  })

  it("names an object with no constructor `object`", () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare["field"] = 1

    expect(ExitEncoding.projectValue(bare)).toEqual({ type: "object", message: "[object]" })
  })

  it("stops following `cause` links at the depth bound", () => {
    let deepest: { message: string; cause?: unknown } = { message: "leaf" }
    for (let level = 0; level < ExitEncoding.maxCauseDepth + 2; level++) {
      deepest = { message: `level-${level}`, cause: deepest }
    }

    let projected = ExitEncoding.projectValue(deepest)
    let depth = 0
    while (projected.cause !== undefined) {
      projected = projected.cause
      depth++
    }

    expect(depth).toBe(ExitEncoding.maxCauseDepth)
  })

  it("keeps only the leading stack lines", () => {
    const error = new Error("trimmed")
    Object.defineProperty(error, "stack", {
      value: ["Error: trimmed", "a", "b", "c", "d", "e"].join("\n"),
      enumerable: false
    })

    expect(ExitEncoding.projectValue(error).stack).toBe(["Error: trimmed", "a", "b", "c"].join("\n"))
  })

  it("truncates a message past the text bound", () => {
    const long = "x".repeat(ExitEncoding.maxTextLength + 10)

    const projected = ExitEncoding.projectValue({ message: long })

    expect(projected.message).toBe(`${"x".repeat(ExitEncoding.maxTextLength)}…`)
  })

  it("never invokes accessors, proxies, or toJSON while projecting", () => {
    let calls = 0
    const getter = Object.defineProperties({}, {
      message: { get: () => ++calls, enumerable: true },
      toJSON: { value: () => ++calls, enumerable: true }
    })
    const proxy = new Proxy({}, {
      get: () => {
        calls++
        throw new Error("proxy trap ran")
      },
      ownKeys: () => {
        calls++
        throw new Error("proxy trap ran")
      }
    })

    expect(ExitEncoding.projectValue(getter)).toEqual({ type: "object", message: "[object]" })
    expect(ExitEncoding.projectValue(proxy)).toEqual({ type: "object", message: "[unrepresentable]" })
    expect(calls).toBe(0)
  })

  it("fails closed if descriptor introspection itself refuses", () => {
    const target = {}
    const descriptor = Object.getOwnPropertyDescriptor
    Object.getOwnPropertyDescriptor = ((value: object, key: PropertyKey) => {
      if (value === target) throw new Error("descriptor host refused")
      return descriptor(value, key)
    }) as typeof Object.getOwnPropertyDescriptor
    try {
      expect(ExitEncoding.projectValue(target)).toEqual({
        type: "object",
        message: "[unrepresentable]"
      })
    } finally {
      Object.getOwnPropertyDescriptor = descriptor
    }
  })
})

describe("cause projection", () => {
  it("answers no reasons for an absent cause", () => {
    expect(ExitEncoding.projectCause(undefined)).toEqual([])
  })

  it("bounds oversized causes and records the omission", () => {
    const cause = Cause.fromReasons(
      Array.from({ length: ExitEncoding.maxReasonCount + 10 }, (_, index) => Cause.makeFailReason(index))
    )
    const projected = ExitEncoding.projectCause(cause)
    expect(projected).toHaveLength(ExitEncoding.maxReasonCount + 1)
    expect(projected.at(-1)).toMatchObject({ _tag: "Die", error: { type: "truncated" } })
  })

  it("fails closed for proxy causes, proxy reasons, and malformed reason arrays", () => {
    const proxy = new Proxy({}, {})
    expect(ExitEncoding.projectCause(proxy as never)).toEqual([{
      _tag: "Die",
      error: { type: "object", message: "[unrepresentable]" }
    }])
    expect(ExitEncoding.projectCause({ reasons: proxy } as never)).toEqual([{
      _tag: "Die",
      error: { type: "object", message: "[unrepresentable]" }
    }])
    expect(ExitEncoding.projectCause(Cause.fromReasons([proxy as never]))).toEqual([{
      _tag: "Die",
      error: { type: "object", message: "[unrepresentable]" }
    }])
  })

  it("fails closed if cause or reason descriptor inspection refuses", () => {
    const reason = Cause.makeFailReason("typed")
    const cause = Cause.fromReasons([reason])
    const descriptor = Object.getOwnPropertyDescriptor
    Object.getOwnPropertyDescriptor = ((value: object, key: PropertyKey) => {
      if (value === reason) throw new Error("reason descriptor refused")
      return descriptor(value, key)
    }) as typeof Object.getOwnPropertyDescriptor
    try {
      expect(ExitEncoding.projectCause(cause)).toEqual([{
        _tag: "Die",
        error: { type: "object", message: "[unrepresentable]" }
      }])
    } finally {
      Object.getOwnPropertyDescriptor = descriptor
    }

    Object.getOwnPropertyDescriptor = ((value: object, key: PropertyKey) => {
      if (value === cause) throw new Error("cause descriptor refused")
      return descriptor(value, key)
    }) as typeof Object.getOwnPropertyDescriptor
    try {
      expect(ExitEncoding.projectCause(cause)).toEqual([{
        _tag: "Die",
        error: { type: "object", message: "[unrepresentable]" }
      }])
    } finally {
      Object.getOwnPropertyDescriptor = descriptor
    }
  })
})

describe("result projection failure boundaries", () => {
  it("fails closed for proxy, missing, and forged Exit values", () => {
    expect(ExitEncoding.projectResult(new Proxy({}, {}) as never, "proxy")).toMatchObject({
      result: "Complete",
      note: "proxy"
    })
    expect(ExitEncoding.projectResult({ _tag: "Complete", exit: null } as never, "missing")).toMatchObject({
      result: "Complete",
      note: "missing"
    })
    expect(ExitEncoding.projectResult({ _tag: "Complete", exit: {} } as never, "forged")).toMatchObject({
      result: "Complete",
      note: "forged"
    })
  })

  it("bounds an oversized diagnostic projection", () => {
    const long = "x".repeat(ExitEncoding.maxTextLength)
    const cause = Cause.fromReasons(
      Array.from(
        { length: ExitEncoding.maxReasonCount },
        () => Cause.makeFailReason({ _tag: long, code: long, message: long, stack: long })
      )
    )
    const projected = ExitEncoding.projectResult(
      new Flow.Complete({ exit: Exit.failCause(cause) }),
      "oversized"
    )
    expect(projected.note).toContain("exceeded the diagnostic projection bound")
  })

  it("fails closed when JSON serialization or Exit prototype inspection refuses", () => {
    const stringify = JSON.stringify
    JSON.stringify = (() => {
      throw new Error("serializer refused")
    }) as typeof JSON.stringify
    try {
      expect(
        ExitEncoding.projectResult(
          new Flow.Handoff({ flow: "next", payload: {} }),
          "serialize"
        ).note
      ).toContain("could not be projected")
    } finally {
      JSON.stringify = stringify
    }

    const exit = Exit.succeed("value")
    const getPrototypeOf = Object.getPrototypeOf
    Object.getPrototypeOf = ((value: object) => {
      if (value === exit) throw new Error("prototype host refused")
      return getPrototypeOf(value)
    }) as typeof Object.getPrototypeOf
    try {
      expect(ExitEncoding.projectResult(
        { _tag: "Complete", exit } as never,
        "prototype"
      )).toMatchObject({ result: "Complete", note: "prototype" })
    } finally {
      Object.getPrototypeOf = getPrototypeOf
    }
  })

  it("degrades a malformed handoff without inventing a flow name", async () => {
    const encoded = await encode({ _tag: "Handoff", flow: 1, payload: wrapped } as never)
    expect(encoded.encoded).toMatchObject({ _tag: "Complete" })
  })
})

/**
 * The sweep for the same class one level up.
 *
 * `RunDriver`'s `encodeState` also guards every terminal transition with
 * `Effect.orDie`, over `Schema.fromJsonString(RunState)`. That encode tolerates
 * a class instance — `JSON.stringify` walks its own properties — but fails
 * `SchemaError(Expected a JSON-serializable value)` on a value it cannot
 * serialize at all, and a defect there wedges the row exactly as the result
 * encode did. Nothing this module answers may reach it in that state.
 */
describe("the state a terminal transition writes", () => {
  const encodeState = (result: unknown) =>
    run(
      Schema.encodeEffect(Schema.fromJsonString(RunState))({
        version: 1,
        flowName: unknownFlow._tag,
        payload: { runId: "run-1" },
        result
      }).pipe(Effect.orDie)
    )

  it("carries a projected settlement through `encodeState` intact", async () => {
    const encoded = await encode(new Flow.Complete({ exit: Exit.fail(wrapped) }))

    const stateJson = await encodeState(encoded.encoded)

    const state = JSON.parse(stateJson) as {
      result: { exit: { cause: ReadonlyArray<{ defect: Record<string, unknown> }> } }
    }
    expect(state.result.exit.cause[0]?.defect["_tag"]).toBe(ExitEncoding.projectionTag)
  })

  it("carries a projection of a circular failure through `encodeState`", async () => {
    const circular = new HarnessError({ code: "engine_failed", message: "circular" }) as unknown as {
      self?: unknown
    }
    circular.self = circular

    const encoded = await encode(new Flow.Complete({ exit: Exit.fail(circular) }))

    const state = JSON.parse(await encodeState(encoded.encoded)) as {
      result: { exit: { cause: ReadonlyArray<{ defect: ExitEncoding.ResultProjection }> } }
    }
    expect(state.result.exit.cause[0]?.defect.reasons[0]?.error?.message).toBe("circular")
  })
})
