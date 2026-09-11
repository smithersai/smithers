import type { StandardSchemaV1 } from "@standard-schema/spec"
import { describe, expect, test } from "bun:test"
import { decodeStoredRow, StorageDecoderError } from "./StoredRowDecoder"

const constant = (value: unknown): StandardSchemaV1 => ({
  "~standard": { version: 1, vendor: "fixture", validate: () => ({ value }) }
})

describe("the stored decoder's JSON boundary", () => {
  for (
    const [name, make] of [
      ["undefined root", () => undefined],
      ["function", () => ({ call: () => {} })],
      ["symbol field", () => ({ [Symbol("private")]: 1 })],
      ["symbol value", () => ({ value: Symbol("private") })],
      ["bigint", () => 42n],
      ["infinity", () => Infinity],
      ["class", () =>
        new (class Record {
          id = 1
        })()],
      ["cycle", () => {
        const value: unknown[] = []
        value.push(value)
        return value
      }],
      ["array hole", () => new Array(1)],
      ["extra array field", () => Object.assign([], { extra: true })],
      ["hole replaced with an extra field", () => Object.assign(new Array(1), { extra: true })],
      ["getter", () => Object.defineProperty({}, "value", { enumerable: true, get: () => "hidden read" })],
      ["hidden field", () => Object.defineProperty({}, "value", { value: "omitted" })]
    ] as const
  ) {
    test(`refuses ${name} rather than silently changing its JSON representation`, async () => {
      await expect(decodeStoredRow(constant(make()), {})).rejects.toBeInstanceOf(StorageDecoderError)
    })
  }

  test("object key order does not count as a changed value or require another validation", async () => {
    let calls = 0
    const schema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: () => {
          calls += 1
          return { value: { a: 1, b: [null, true, "saved"] } }
        }
      }
    }
    expect(await decodeStoredRow(schema, { b: [null, true, "saved"], a: 1 })).toMatchObject({
      valid: true,
      changed: false
    })
    expect(calls).toBe(1)
  })

  test("a shared acyclic object, null prototype, and prototype-like key remain ordinary JSON data", async () => {
    const shared = Object.assign(Object.create(null), { value: "saved" })
    const value = Object.fromEntries([["__proto__", shared], ["other", shared]])
    const decoded = await decodeStoredRow(constant(value), {})
    expect(decoded.valid).toBe(true)
    if (!decoded.valid) throw new Error("decoder failed")
    expect(JSON.parse(decoded.encoded)).toEqual(
      JSON.parse("{\"__proto__\":{\"value\":\"saved\"},\"other\":{\"value\":\"saved\"}}")
    )
    expect(Object.prototype).not.toHaveProperty("value")
  })

  test("output rejected by its own input schema requires a versioned migration", async () => {
    const schema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: (value) => typeof value === "string" ? { value: 1 } : { issues: [{ message: "strings only" }] }
      }
    }
    await expect(decodeStoredRow(schema, "one")).rejects.toMatchObject({ reason: "unstable" })
  })

  test("a mutating normalizer is checked against its pre-call source and returns a detached value", async () => {
    const input = { body: " saved " }
    const schema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: (value) => {
          const row = value as { body: string }
          row.body = row.body.trim()
          return { value: row }
        }
      }
    }
    const result = await decodeStoredRow(schema, input)
    expect(result).toMatchObject({ valid: true, changed: true, data: { body: "saved" } })
    input.body = "changed by caller"
    expect(result).toMatchObject({ data: { body: "saved" } })
  })
})
