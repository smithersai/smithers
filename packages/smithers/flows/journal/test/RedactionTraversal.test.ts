import { describe, expect, it } from "@effect/vitest"
import { Effect, Logger, References } from "effect"
import * as FastCheck from "fast-check"
import * as RedactedLogger from "../src/RedactedLogger.ts"
import * as Redaction from "../src/Redaction.ts"

describe("redaction traversal", () => {
  it("serializes self-returning toJSON values as fields and preserves real cycles", () => {
    class RecordValue {
      readonly count = 1
      readonly token = "private"
      toJSON() {
        return this
      }
    }
    const value = new RecordValue()
    expect(Redaction.redact({ value })).toEqual({ value: { count: 1, token: Redaction.placeholder } })
    const cyclic = Object.assign(value, { self: value })
    expect(Redaction.redact(cyclic)).toEqual({ count: 1, token: Redaction.placeholder, self: "[Circular]" })
  })

  it("never invokes a serializer on the replacement returned by toJSON", () => {
    let calls = 0
    const fresh = (): object =>
      Object.defineProperty({ count: 1, token: "private" }, "toJSON", {
        value: () => {
          calls++
          return fresh()
        }
      })
    expect(Redaction.redact(fresh())).toEqual({ count: 1, token: Redaction.placeholder })
    expect(calls).toBe(1)

    const replacement = Object.defineProperty({ count: 2 }, "toJSON", {
      get() {
        throw new Error("replacement serializer must not be read")
      }
    })
    expect(Redaction.redact({ toJSON: () => replacement })).toEqual({ count: 2 })
  })

  it("detects cycles through fresh serializer replacements without re-expanding them", () => {
    let calls = 0
    const parent = {
      toJSON(): unknown {
        calls++
        return { children: [child, child] }
      }
    }
    const child = {
      toJSON(): unknown {
        calls++
        return { parent }
      }
    }
    expect(Redaction.redact(parent)).toEqual({
      children: [{ parent: "[Circular]" }, { parent: "[Circular]" }]
    })
    expect(calls).toBe(3)
    FastCheck.assert(
      FastCheck.property(FastCheck.integer({ min: 1, max: 20 }), (width) => {
        let calls = 0
        const value = {
          toJSON(): unknown {
            calls++
            return { children: Array.from({ length: width }, () => value) }
          }
        }
        expect(Redaction.redact(value)).toEqual({ children: Array.from({ length: width }, () => "[Circular]") })
        expect(calls).toBe(1)
      }),
      { numRuns: 100 }
    )
  })

  it("counts serializer replacements against the depth bound", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = { toJSON: () => "leaf" }
      for (let index = 0; index < depth; index++) value = { child: value }
      return value
    }
    expect(() => Redaction.redact(nested(Redaction.maxDepth - 1))).not.toThrow()
    expect(() => Redaction.redact(nested(Redaction.maxDepth))).toThrow(Redaction.RedactionDepthError)
    let named = Redaction.redact(nested(Redaction.maxDepth), { onTooDeep: "name" })
    for (let index = 0; index < Redaction.maxDepth; index++) named = (named as { child: unknown }).child
    expect(named).toBe(Redaction.depthMarker)
  })

  it("matches JSON serialization for self-returning and replacement serializers", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.jsonValue(),
        FastCheck.boolean(),
        (fields, selfReturning) => {
          const replacement = Object.defineProperty({ fields }, "toJSON", {
            value() {
              throw new Error("a replacement serializer must not run")
            }
          })
          const value = Object.defineProperty({ fields }, "toJSON", {
            value() {
              return selfReturning ? this : replacement
            }
          })
          const input = { left: value, right: [value] }
          expect(JSON.stringify(Redaction.redact(input))).toBe(
            JSON.stringify(Redaction.redact(JSON.parse(JSON.stringify(input))))
          )
        }
      ),
      { numRuns: 100, examples: [[{ "": -0 }, false]] }
    )
  })

  it("keeps the public redactor usable as an array callback", () => {
    const callback: Redaction.Redactor = Redaction.redact
    expect([{ error: new Error("not enumerable"), token: "private" }].map(callback)).toEqual([
      { error: {}, token: Redaction.placeholder }
    ])
  })

  it("keeps accepting a plain one-argument redactor", () => {
    const redactor: Redaction.Redactor = Redaction.redact
    expect(RedactedLogger.redactArgument({ count: 1, token: "private" }, redactor)).toEqual({
      count: 1,
      token: Redaction.placeholder
    })
    const error = new Error("failed token=sk-live-abcdefgh", {
      cause: new Error("inner token=sk-live-abcdefgh")
    })
    const copy = RedactedLogger.redactArgument(error, redactor) as Error
    expect(copy.message).toBe(`failed token=${Redaction.placeholder}`)
    expect(copy.cause).toBeInstanceOf(Error)
    expect((copy.cause as Error).message).toBe(`inner token=${Redaction.placeholder}`)
  })

  it("drops inherited rendering hooks on nested errors without invoking them", () => {
    class Failure extends Error {
      toJSON(): never {
        throw new Error("an Error serializer must not run")
      }
    }
    Object.defineProperty(Failure.prototype, "cause", { value: new Error("token=sk-live-abcdefgh") })
    const copy = RedactedLogger.redactArgument({ error: new Failure("request failed") }, Redaction.make()) as {
      error: Error
    }
    expect(copy.error).toBeInstanceOf(Error)
    expect(copy.error.message).toBe("request failed")
    expect(Object.getPrototypeOf(copy.error)).toBe(Error.prototype)
    expect(copy.error.cause).toBeUndefined()
  })

  it("keeps nested errors and shared references through object and aggregate members", () => {
    const inner = new TypeError("bad input token=sk-live-abcdefgh")
    const outer = new AggregateError([inner, { error: inner }], "all failed", { cause: { error: inner } })
    const value = { error: outer, list: [inner] }
    const copy = RedactedLogger.redactArgument(value, Redaction.make()) as {
      error: AggregateError
      list: Array<Error>
    }
    expect(copy.error).toBeInstanceOf(Error)
    expect(copy.error.message).toBe("all failed")
    expect(Object.getPrototypeOf(copy.error)).toBe(Error.prototype)
    const nested = copy.error.errors as [Error, { error: Error }]
    expect(nested[0]).toBeInstanceOf(Error)
    expect(nested[0].name).toBe("TypeError")
    expect(nested[0].message).toBe(`bad input token=${Redaction.placeholder}`)
    expect(nested[0].stack).toContain(`bad input token=${Redaction.placeholder}`)
    expect(nested[0]).toBe(nested[1].error)
    expect(nested[0]).toBe((copy.error.cause as { error: Error }).error)
    expect(nested[0]).toBe(copy.list[0])
    expect(inner.message).toBe("bad input token=sk-live-abcdefgh")
  })

  it("bounds mixed error and object cycles without exposing original errors", () => {
    const error = new Error("failed token=sk-live-abcdefgh") as Error & { detail: unknown }
    error.detail = { error }
    const copy = RedactedLogger.redactArgument({ error }, Redaction.make()) as { error: typeof error }
    expect((copy.error.detail as { error: Error }).error).toBe(copy.error)
    expect(copy.error.message).toBe(`failed token=${Redaction.placeholder}`)

    let value: unknown = "leaf"
    for (let index = 0; index < Redaction.maxDepth * 2; index++) {
      value = new Error("failed", { cause: { value } })
    }
    const deep = RedactedLogger.redactArgument({ value }, Redaction.make({ onTooDeep: "name" })) as {
      value: Error
    }
    expect(deep.value).toBeInstanceOf(Error)
    let current: unknown = deep
    for (let index = 0; index <= Redaction.maxDepth + 1; index++) {
      if (current === Redaction.depthMarker) break
      current = current instanceof Error ? current.cause : (current as { value: unknown }).value
    }
    expect(current).toBe(Redaction.depthMarker)
  })

  it("counts a root error against the depth budget of its object members", () => {
    let nested: unknown = "leaf"
    for (let index = 0; index < Redaction.maxDepth; index++) nested = { child: nested }
    const value = new Error("outer", { cause: nested })
    const copy = RedactedLogger.redactArgument(value, Redaction.make({ onTooDeep: "name" })) as Error
    let current = copy.cause
    for (let index = 0; index < Redaction.maxDepth; index++) current = (current as { child: unknown }).child
    expect(current).toBe(Redaction.depthMarker)
  })

  it("keeps errors diagnostic at arbitrary object and array depths", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(FastCheck.boolean(), { maxLength: 30 }),
        (wrappers) => {
          let value: unknown = new Error("failed token=sk-live-abcdefgh")
          for (const array of wrappers) value = array ? [value] : { detail: value }
          let copy = RedactedLogger.redactArgument(value, Redaction.make())
          for (const array of [...wrappers].reverse()) {
            copy = array ? (copy as Array<unknown>)[0] : (copy as { detail: unknown }).detail
          }
          expect(copy).toBeInstanceOf(Error)
          expect((copy as Error).message).toBe(`failed token=${Redaction.placeholder}`)
          expect((copy as Error).stack).not.toContain("sk-live-abcdefgh")
        }
      ),
      { numRuns: 100 }
    )
  })

  it.effect("hands diagnostic errors in messages and annotations to the installed logger", () =>
    Effect.gen(function*() {
      const records: Array<{ message: unknown; annotations: unknown }> = []
      const logger = Logger.make((options) => {
        records.push({
          message: options.message,
          annotations: options.fiber.getRef(References.CurrentLogAnnotations)
        })
      })
      const error = new Error("connection refused token=sk-live-abcdefgh")
      yield* Effect.logError("deploy failed", { error }).pipe(
        Effect.annotateLogs({ error }),
        Effect.provide(RedactedLogger.layer()),
        Effect.provide(Logger.layer([logger]))
      )
      expect(records).toHaveLength(1)
      const message = records[0]!.message as [string, { error: Error }]
      const annotations = records[0]!.annotations as { error: Error }
      for (const copy of [message[1].error, annotations.error]) {
        expect(copy).toBeInstanceOf(Error)
        expect(copy.message).toBe(`connection refused token=${Redaction.placeholder}`)
        expect(copy.stack).toContain("connection refused")
        expect(copy.stack).not.toContain("sk-live-abcdefgh")
      }
    }))
})
