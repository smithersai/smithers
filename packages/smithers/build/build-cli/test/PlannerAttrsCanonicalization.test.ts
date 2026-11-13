/**
 * Canonicalizing target attrs into key material.
 *
 * `attrsValue` replaces target references with dependency keys and declared
 * inputs with content digests, copies plain data, and hands anything that is
 * not plain data back unchanged so the injective encoder refuses it later.
 */
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import { Schema } from "effect"
import * as Vm from "node:vm"
import { describe, expect, it } from "vitest"
import { attrsValue, KeyMaterialError, keyOf } from "../src/Planner.ts"

const makeTarget = (name: string): Target.AnyTarget =>
  Target.make(name, {
    attrs: Schema.Struct({}),
    kinds: ["build"],
    implementation: () => Target.notImplemented(name)
  })({})

const noTargets: ReadonlyMap<Target.AnyTarget, string> = new Map()
const noInputs: ReadonlyMap<Input.Declared, string> = new Map()

const canonical = (value: unknown): unknown => attrsValue(value, noTargets, noInputs)

/** Captures the refusal attrsValue raises, so a test can read its path and sentence. */
const refusal = (value: unknown): KeyMaterialError => {
  try {
    canonical(value)
  } catch (cause) {
    if (cause instanceof KeyMaterialError) return cause
    throw cause
  }
  throw new Error("attrsValue accepted a value it should refuse")
}

describe("attrsValue references", () => {
  it("replaces a planned target dependency with its key", () => {
    const dependency = makeTarget("PlannerAttrsDependency")
    const depKeys = new Map([[dependency, "a".repeat(64)]])
    expect(attrsValue({ dep: dependency }, depKeys, noInputs))
      .toEqual({ dep: { _tag: "Target", key: "a".repeat(64) } })
  })

  it("refuses a target reference that was not planned as a dependency", () => {
    const stray = makeTarget("PlannerAttrsStray")
    expect(() => attrsValue({ dep: stray }, noTargets, noInputs))
      .toThrow("attrs reference a target that was not planned as a dependency")
  })

  it("replaces a declared input with its digest", () => {
    const source = Input.file("src/index.ts")
    const inputDigests = new Map([[source, "b".repeat(64)]])
    expect(attrsValue({ srcs: [source] }, noTargets, inputDigests))
      .toEqual({ srcs: [{ _tag: source._tag, digest: "b".repeat(64) }] })
  })

  it("records a declared input without a digest as null rather than dropping it", () => {
    const missing = Input.file("src/missing.ts")
    const value = canonical({ src: missing }) as { readonly src: unknown }
    expect(value.src).toEqual({ _tag: missing._tag, digest: null })
    expect(keyOf({ body: value, inputs: null, layers: [], capabilities: [] }))
      .not.toBe(keyOf({ body: { src: null }, inputs: null, layers: [], capabilities: [] }))
  })
})

describe("attrsValue copies plain data", () => {
  it("copies a plain object with its keys in code-unit order", () => {
    const value = canonical({ b: 1, a: [true, "x"], Z: null })
    expect(Object.keys(value as object)).toEqual(["Z", "a", "b"])
    expect(value).toEqual({ Z: null, a: [true, "x"], b: 1 })
  })

  it("keeps a null-prototype object null-prototype", () => {
    const holder = Object.create(null) as Record<string, unknown>
    holder["value"] = 1
    const copy = canonical(holder)
    expect(copy).not.toBe(holder)
    expect(Object.getPrototypeOf(copy)).toBeNull()
    expect({ ...(copy as object) }).toEqual({ value: 1 })
  })

  it("lets a value that appears twice through without reading it as a cycle", () => {
    const shared = { path: "src/index.ts" }
    expect(canonical({ first: shared, second: [shared] }))
      .toEqual({ first: { path: "src/index.ts" }, second: [{ path: "src/index.ts" }] })
  })
})

describe("attrsValue refusals", () => {
  it.each([
    ["an object Proxy", new Proxy({ value: 1 }, {})],
    ["a function Proxy", new Proxy(() => 1, {})]
  ])("refuses %s at the attrs root", (_name, value) => {
    const error = refusal(value)
    expect(error.path).toBe("attrs")
    expect(error.message).toBe("cache key material at attrs is a Proxy")
  })

  it("refuses a reference cycle at the member that closes it", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = [cyclic]
    const error = refusal(cyclic)
    expect(error.path).toBe("attrs.self.0")
    expect(error.message).toBe("cache key material at attrs.self.0 closes a reference cycle")
  })

  it("turns a hostile host object's thrown trap into a key material refusal", () => {
    const sandbox = new Proxy({}, {
      ownKeys: () => {
        throw new Error("hostile ownKeys trap")
      }
    })
    const hostile = Vm.runInContext(
      "Object.setPrototypeOf(globalThis, null); globalThis",
      Vm.createContext(sandbox)
    ) as object
    const error = refusal({ context: hostile })
    expect(error.path).toBe("attrs.context")
    expect(error.message).toBe(
      "cache key material at attrs.context could not be inspected without executing hostile object behavior"
    )
  })
})

/**
 * Values that are not plain data come back as the same reference. The
 * encoder then refuses them with a precise reason instead of this rewrite
 * guessing a plain shape for them.
 */
describe("attrsValue returns non-plain values untouched", () => {
  class Holder {
    readonly a = 1
  }
  class Listing extends Array<number> {}

  it.each([
    ["an array subclass instance", () => Listing.from([1])],
    ["an array with an extra own property", () => Object.assign([1], { extra: 2 })],
    ["an array with a symbol-keyed own property", () => Object.assign([1], { [Symbol.for("smthrs/test")]: 2 })],
    ["an array accessor element", () => {
      const list = [1]
      Object.defineProperty(list, "0", { get: () => 1, enumerable: true, configurable: true })
      return list
    }],
    ["a class instance", () => new Holder()],
    ["a Map", () => new Map([["a", 1]])],
    ["an object with a symbol-keyed own property", () => ({ a: 1, [Symbol.for("smthrs/test")]: 2 })],
    ["an object accessor property", () => {
      const holder = {}
      Object.defineProperty(holder, "value", { get: () => 1, enumerable: true, configurable: true })
      return holder
    }],
    ["a non-enumerable object property", () => {
      const holder = { visible: 1 }
      Object.defineProperty(holder, "hidden", { value: 2, enumerable: false })
      return holder
    }]
  ])("returns %s as the same reference", (_name, build) => {
    const value = build()
    const output = canonical({ value }) as { readonly value: unknown }
    expect(output.value).toBe(value)
    expect(() => keyOf({ body: output, inputs: null, layers: [], capabilities: [] })).toThrow(KeyMaterialError)
  })

  it("returns an array with a non-enumerable element as the same reference", () => {
    const list = [1]
    Object.defineProperty(list, "0", { value: 1, enumerable: false, configurable: true })
    expect((canonical({ list }) as { readonly list: unknown }).list).toBe(list)
  })
})
