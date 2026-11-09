import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Suite from "../src/Suite.vibe"

describe("durable suite data", () => {
  it("round trips cycles, shared records, holes and cloneable primitives without JSON coercion", async () => {
    const record = Object.assign(Object.create(null), { value: "shared" })
    const input = {
      values: [record, record, undefined, null, true, "x", 1n, NaN, Infinity, -Infinity, -0],
      self: undefined as unknown
    }
    input.self = input
    const output = await Effect.runPromise(
      Suite.encodeData(input).pipe(Effect.flatMap(Suite.decodeData))
    ) as typeof input
    expect(output.self).toBe(output)
    expect(output.values[0]).toBe(output.values[1])
    expect(Object.getPrototypeOf(output.values[0])).toBeNull()
    expect(output.values).toEqual(input.values)
    expect(Object.is(output.values.at(-1), -0)).toBe(true)
    const sparse = new Array(3)
    sparse[2] = "last"
    const copy = await Effect.runPromise(Suite.encodeData(sparse).pipe(Effect.flatMap(Suite.decodeData))) as unknown[]
    expect(0 in copy).toBe(false)
    expect(copy).toEqual(sparse)
  })

  it("reads the committed wire format independently of the current encoder", async () => {
    const value = await Effect.runPromise(Suite.decodeData(
      "devalue-5.9.2:[{\"self\":0,\"shared\":1,\"again\":1,\"big\":2},{\"x\":3},[\"BigInt\",\"1\"],\"value\"]"
    )) as { self: unknown; shared: { x: string }; again: unknown; big: bigint }
    expect(value.self).toBe(value)
    expect(value.shared).toBe(value.again)
    expect(value.shared.x).toBe("value")
    expect(value.big).toBe(1n)
  })

  it("reports unsupported executable data as a typed failure", async () => {
    expect(await Effect.runPromise(Effect.flip(Suite.encodeData(() => 1)))).toMatchObject({ code: "invalid_suite" })
  })

  it("refuses accessors without invoking them and non-suite decoded types", async () => {
    let reads = 0
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        reads += 1
        return 1
      }
    })
    expect(await Effect.runPromise(Effect.flip(Suite.encodeData(value)))).toMatchObject({ code: "invalid_suite" })
    expect(reads).toBe(0)
    expect(
      await Effect.runPromise(Effect.flip(Suite.decodeData("devalue-5.9.2:[[\"Date\",\"2026-01-01T00:00:00.000Z\"]]")))
    )
      .toMatchObject({ code: "invalid_suite" })
  })

  it.each(["unknown:[]", "devalue-5.9.2:invalid"])("refuses an unknown or corrupt envelope: %s", async (source) => {
    expect(await Effect.runPromise(Effect.flip(Suite.decodeData(source)))).toMatchObject({ code: "invalid_suite" })
  })
})
