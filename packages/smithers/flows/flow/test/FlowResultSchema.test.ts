// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Flow } from "@smthrs/flow"
import { Cause, Effect, Exit, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

const CompleteSchema = Flow.Complete.Schema({
  success: Schema.Number,
  error: Schema.String
})

const ResultSchema = Flow.Result({
  success: Schema.Number,
  error: Schema.String
})

const resultMarker = "@smthrs/flow/Flow/Result"

describe("Flow.Complete.Schema", () => {
  effect("decodes a completed success exit into a Complete result", () =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeEffect(CompleteSchema)(
        new Flow.Complete({ exit: Exit.succeed(7) })
      )
      expect(decoded).toBeInstanceOf(Flow.Complete)
      expect(Flow.isResult(decoded)).toBe(true)
      expect(decoded.exit).toStrictEqual(Exit.succeed(7))
    }))

  effect("decodes a completed failure exit, preserving the typed error", () =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeEffect(CompleteSchema)(
        new Flow.Complete({ exit: Exit.fail("boom") })
      )
      expect(Exit.isFailure(decoded.exit)).toBe(true)
      expect(String(decoded.exit)).toContain("boom")
    }))

  effect("rejects a Suspended result, which is not a Complete", () =>
    Effect.gen(function*() {
      const exit = yield* Schema.decodeEffect(CompleteSchema)(new Flow.Suspended() as any).pipe(
        Effect.exit
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  effect("rejects a plain object that is not a flow result at all", () =>
    Effect.gen(function*() {
      const exit = yield* Schema.decodeEffect(CompleteSchema)(
        { _tag: "Complete", exit: Exit.succeed(1) } as any
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  effect("reports the failing member under the `exit` pointer", () =>
    Effect.gen(function*() {
      const exit = yield* Schema.decodeEffect(CompleteSchema)(
        new Flow.Complete({ exit: Exit.succeed("not-a-number") as any })
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("exit")
    }))
})

describe("Flow.Result round trips", () => {
  effect("round trips a Complete result through its JSON codec", () =>
    Effect.gen(function*() {
      const codec = Schema.toCodecJson(ResultSchema)
      const encoded = yield* Schema.encodeEffect(codec)(new Flow.Complete({ exit: Exit.succeed(3) }))
      const decoded = yield* Schema.decodeEffect(codec)(encoded)
      expect(decoded._tag).toBe("Complete")
      expect(decoded._tag === "Complete" && decoded.exit).toStrictEqual(Exit.succeed(3))
    }))

  effect("round trips a Suspended result through its JSON codec", () =>
    Effect.gen(function*() {
      const codec = Schema.toCodecJson(ResultSchema)
      const encoded = yield* Schema.encodeEffect(codec)(new Flow.Suspended())
      const decoded = yield* Schema.decodeEffect(codec)(encoded)
      expect(decoded._tag).toBe("Suspended")
      expect(Flow.isResult(decoded)).toBe(true)
    }))

  effect("isResult rejects non-result values", () => {
    expect(Flow.isResult(null)).toBe(false)
    expect(Flow.isResult({ _tag: "Complete" })).toBe(false)
    expect(Flow.isResult("Complete")).toBe(false)
    return Effect.void
  })
})

describe("Flow.ResultEncoded", () => {
  // The stored form: what an engine writes through the flow's own JSON codec,
  // read back by a consumer that knows none of the flow's schemas.
  const stored = Schema.toCodecJson(ResultSchema)
  const results: ReadonlyArray<Flow.Result<number, string>> = [
    new Flow.Complete({ exit: Exit.succeed(3) }),
    new Flow.Complete({ exit: Exit.fail("boom") }),
    new Flow.Suspended(),
    new Flow.Suspended({ cause: Cause.die("parked") }),
    new Flow.Handoff({ flow: "next", payload: { round: 2 } })
  ]

  effect("round trips every stored result shape unchanged", () =>
    Effect.gen(function*() {
      for (const result of results) {
        const json = JSON.parse(JSON.stringify(yield* Schema.encodeEffect(stored)(result)))
        const read = yield* Schema.decodeUnknownEffect(Flow.ResultEncoded)(json, { onExcessProperty: "error" })
        expect(read).toStrictEqual(json)
        const written = yield* Schema.encodeEffect(Flow.ResultEncoded)(read)
        expect(written).toStrictEqual(json)
        const typed = yield* Schema.decodeUnknownEffect(stored)(written)
        expect(typed._tag).toBe(result._tag)
        expect(yield* Schema.encodeEffect(stored)(typed)).toStrictEqual(json)
      }
    }))

  effect("refuses values no result encodes to", () =>
    Effect.gen(function*() {
      for (
        const value of [
          { _tag: "Pending" },
          { _tag: "Handoff", flow: "", payload: null },
          { _tag: "Complete", exit: { _tag: "Success", value: 1 }, extra: true }
        ]
      ) {
        const exit = yield* Schema.decodeUnknownEffect(Flow.ResultEncoded)(value, { onExcessProperty: "error" }).pipe(
          Effect.exit
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }))
})

describe("Flow.isResult", () => {
  it("rejects an own marker with the wrong value", () => {
    expect(Flow.isResult({ [resultMarker]: false, _tag: "Complete" })).toBe(false)
  })

  it("rejects an inherited marker", () => {
    const inherited = Object.assign(Object.create({ [resultMarker]: resultMarker }) as object, {
      _tag: "Complete"
    })
    expect(Flow.isResult(inherited)).toBe(false)
  })

  it("does not invoke a marker getter", () => {
    let reads = 0
    const getterBacked = { _tag: "Complete" }
    Object.defineProperty(getterBacked, resultMarker, {
      get: () => {
        reads++
        return resultMarker
      }
    })

    expect(Flow.isResult(getterBacked)).toBe(false)
    expect(reads).toBe(0)
  })

  it("rejects a valid marker with a missing, accessor, or unknown tag", () => {
    const missing = { [resultMarker]: resultMarker }
    const accessor = { [resultMarker]: resultMarker }
    Object.defineProperty(accessor, "_tag", { get: () => "Complete" })
    const unknown = { [resultMarker]: resultMarker, _tag: "Unknown" }

    expect(Flow.isResult(missing)).toBe(false)
    expect(Flow.isResult(accessor)).toBe(false)
    expect(Flow.isResult(unknown)).toBe(false)
  })

  it("accepts all three real result shapes", () => {
    expect([
      new Flow.Complete({ exit: Exit.succeed(1) }),
      new Flow.Suspended(),
      new Flow.Handoff({ flow: "next", payload: { value: 1 } })
    ].every(Flow.isResult)).toBe(true)
  })
})
