/**
 * Non-JSON causes carried by harness failures must survive the codec used by
 * the durable journal instead of masking the original provider or adapter
 * failure with a JSON encode error.
 */
import { ModelError } from "@smthrs/model/ModelError"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { HarnessError } from "../src/HarnessError.vibe"
import { SandboxError } from "../src/Sandbox.vibe"
import { TranscriptError } from "../src/Transcript.vibe"

const causes = {
  error: () => new Error("provider returned 429"),
  raw: () => ({ status: 429, retryAfter: 30n, retry: () => undefined })
}

const roundTrip = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Effect.runSync(
    Effect.gen(function*() {
      const json = Schema.toCodecJson(schema)
      const encoded = yield* Schema.encodeEffect(json)(value)
      const decoded = yield* Schema.decodeEffect(json)(JSON.parse(JSON.stringify(encoded)))
      return { encoded, decoded }
    })
  )

describe("a harness failure carrying a non-JSON cause", () => {
  it("encodes and decodes with its code and message intact when the cause is an Error", () => {
    const { decoded, encoded } = roundTrip(
      HarnessError,
      new HarnessError({ code: "model_failed", message: "the model call failed", cause: causes.error() })
    )
    expect(decoded.code).toBe("model_failed")
    expect(decoded.message).toBe("the model call failed")
    expect(JSON.stringify(encoded)).toContain("provider returned 429")
  })

  it("encodes and decodes when the cause holds a bigint and a function", () => {
    const { decoded, encoded } = roundTrip(
      HarnessError,
      new HarnessError({ code: "engine_failed", message: "the quota is spent", cause: causes.raw() })
    )
    expect(decoded.code).toBe("engine_failed")
    expect(decoded.message).toBe("the quota is spent")
    expect(JSON.stringify(encoded)).toContain("429")
  })

  it("keeps the cause value itself in process", () => {
    const cause = causes.error()
    const error = new HarnessError({ code: "model_failed", message: "the model call failed", cause })
    expect(error.cause).toBe(cause)
  })

  it("encodes a sandbox failure whose cause is an Error", () => {
    const { decoded } = roundTrip(
      SandboxError,
      new SandboxError({ code: "runtime_failed", message: "the realm died", cause: causes.error() })
    )
    expect(decoded.code).toBe("runtime_failed")
    expect(decoded.message).toBe("the realm died")
  })

  it("encodes a transcript failure whose cause holds a bigint and a function", () => {
    const { decoded } = roundTrip(
      TranscriptError,
      new TranscriptError({ code: "projection_failed", message: "the projection failed", cause: causes.raw() })
    )
    expect(decoded.code).toBe("projection_failed")
    expect(decoded.message).toBe("the projection failed")
  })

  it("keeps a provider's ModelError, live or rendered to JSON, as a ModelError across the journal", () => {
    // What AgentAction journals for a refused model call: the ModelError rendered to plain JSON.
    const rendered = {
      _tag: "flows/model/ModelError",
      code: "no_route",
      httpStatus: 409,
      message: "Model route unavailable"
    }
    const fromJson = roundTrip(HarnessError, new HarnessError({ code: "model_failed", message: "m", cause: rendered }))
    expect(fromJson.decoded.cause).toBeInstanceOf(ModelError)
    expect(fromJson.decoded.cause).toMatchObject({ code: "no_route", httpStatus: 409 })
    const live = new ModelError({ code: "rate_limited", message: "slow down", httpStatus: 429, retryAfterMillis: 5 })
    const fromLive = roundTrip(HarnessError, new HarnessError({ code: "model_failed", message: "m", cause: live }))
    const encoded = Schema.decodeUnknownSync(Schema.Struct({ cause: Schema.Unknown }))(fromLive.encoded)
    expect(encoded.cause).toMatchObject({ _tag: "flows/model/ModelError", code: "rate_limited" })
    expect(fromLive.decoded.cause).toMatchObject({ code: "rate_limited", httpStatus: 429, retryAfterMillis: 5 })
    // A JSON cause that isn't a ModelError stays a Defect, as before.
    const other = roundTrip(
      HarnessError,
      new HarnessError({ code: "model_failed", message: "m", cause: { status: 500 } })
    )
    expect(other.decoded.cause).not.toBeInstanceOf(ModelError)
  })
})
