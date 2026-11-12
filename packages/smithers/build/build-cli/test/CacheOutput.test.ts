import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openCache } from "../src/Cache.ts"
import { decodeCacheOutput, encodeCacheOutput } from "../src/Executor.ts"
import { outDirLimits } from "../src/PackageTree.ts"

describe("cache output envelopes", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a plain record", { a: 1, b: [true, "x"] }]
  ])("round trips %s", (_name, value) => {
    const encoded = encodeCacheOutput(value)
    expect(encoded).toHaveProperty("output")
    if (!("output" in encoded)) throw new Error(encoded.reason)
    expect(decodeCacheOutput(encoded.output)).toEqual({ value })
  })

  it.each([
    ["a cycle", () => {
      const cyclic: Record<string, unknown> = {}
      cyclic["self"] = cyclic
      return cyclic
    }],
    ["a nested undefined", () => ({ value: undefined })],
    ["NaN", () => ({ value: Number.NaN })],
    ["Infinity", () => ({ value: Number.POSITIVE_INFINITY })],
    ["a bigint", () => ({ value: 1n })],
    ["a function", () => ({ value: () => 1 })],
    ["a symbol", () => ({ value: Symbol("s") })],
    ["a Date", () => ({ value: new Date(0) })],
    ["a Map", () => ({ value: new Map([["a", 1]]) })],
    ["a class instance", () => ({
      value: new (class Holder {
        readonly a = 1
      })()
    })],
    ["a sparse array", () => ({ value: [1, , 3] })],
    ["negative zero", () => -0],
    ["an array property", () => Object.assign([1], { extra: 2 })],
    ["a symbol key", () => ({ [Symbol.for("smthrs/test")]: 1 })],
    ["a non-enumerable property", () => {
      const value = { visible: 1 }
      Object.defineProperty(value, "hidden", { value: 2, enumerable: false })
      return value
    }],
    ["a Proxy", () => new Proxy({ value: 1 }, {})]
  ])("refuses %s", (_name, build) => {
    expect(encodeCacheOutput(build())).toHaveProperty("reason")
  })

  it("refuses an accessor without invoking it", () => {
    let calls = 0
    const value = {}
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get: () => {
        calls += 1
        return "leaked"
      }
    })
    expect(encodeCacheOutput(value)).toHaveProperty("reason")
    expect(calls).toBe(0)
  })

  it("refuses malformed envelopes", () => {
    expect(decodeCacheOutput(null)).toHaveProperty("reason")
    expect(decodeCacheOutput({ _tag: "smithers-build/cache-output/undefined-v1", extra: true }))
      .toHaveProperty("reason")
    expect(decodeCacheOutput({ _tag: "unknown", value: 1 })).toHaveProperty("reason")
  })
})

describe("the cache store accepts every output a capture step accepts", () => {
  let root: string
  beforeEach(async () => {
    root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cache-limits-"))
  })
  afterEach(async () => {
    await Fs.rm(root, { recursive: true, force: true })
  })

  const roundTrips = async (output: unknown): Promise<void> => {
    const cache = await openCache({ workspaceRoot: root })
    await cache.put("limit", {
      key: "limit",
      target: "Test",
      label: "//:test",
      exitOk: true,
      output,
      storedAt: "2026-11-12T00:00:00.000Z"
    })
    expect((await cache.get("limit"))?.output).toEqual(output)
  }

  const encoded = (value: unknown): unknown => {
    const result = encodeCacheOutput(value)
    if (!("output" in result)) throw new Error(result.reason)
    return result.output
  }

  const nested = (levels: number): unknown => {
    let value: unknown = 0
    for (let level = 0; level < levels; level += 1) value = [value]
    return value
  }

  it("stores a result nested as deep as the encoder allows", async () => {
    expect(encodeCacheOutput(nested(256))).toHaveProperty("reason")
    await roundTrips(encoded(nested(255)))
  })

  it("stores a result with as many members as the encoder allows", async () => {
    expect(encodeCacheOutput(Array.from({ length: 499_999 }, () => 0))).toHaveProperty("reason")
    await roundTrips(encoded(Array.from({ length: 499_998 }, () => 0)))
  })

  const entry = (path: string) => ({
    path,
    kind: "file",
    digest: "a".repeat(64),
    executable: false,
    target: ""
  })

  it("stores a build record whose outDir manifest has as many entries as capture allows", async () => {
    const entries = Array.from({ length: outDirLimits.entries }, (_, index) => entry(`f${index}`))
    await roundTrips({ kind: "build", manifests: [{ outDir: "dist", entries }], files: [] })
  })

  it("stores a build record whose outDir manifest is as large as capture allows", async () => {
    const long = (index: number): string => `${String(index).padStart(8, "0")}/${"a".repeat(4_000)}`
    const size = Buffer.byteLength(JSON.stringify(entry(long(0))), "utf8") + 1
    const entries = Array.from(
      { length: Math.floor(outDirLimits.manifestBytes / size) },
      (_, index) => entry(long(index))
    )
    expect(Buffer.byteLength(JSON.stringify(entries), "utf8")).toBeGreaterThan(outDirLimits.manifestBytes - size)
    await roundTrips({ kind: "build", manifests: [{ outDir: "dist", entries }], files: [] })
  })
})
