/**
 * Where the projection's value predicates come from.
 *
 * `@smthrs/engine-store` is a browser entry point, so the settlement
 * projection cannot bind `node:util/types` at build time; it reads the two
 * predicates it needs off the host. These cases cover both stances: on Node and
 * Bun the host answers, and the projection keeps the exact proxy protection
 * the static import gave it, and on a host with no built-in modules the inert
 * fallbacks answer instead, without raising and without running caller code.
 */
import { describe, expect, it } from "@effect/vitest"
import * as NodeTypes from "node:util/types"
import * as ExitEncoding from "../src/internal/ExitEncoding.ts"
import * as FailureDiagnostic from "../src/internal/FailureDiagnostic.ts"
import * as HostReflection from "../src/internal/HostReflection.ts"

/** A host that offers exactly the module `HostReflection` asks it for. */
const sourceOf = (types: unknown): HostReflection.BuiltinSource => ({ getBuiltinModule: () => types })

/** Values whose native-error answer both implementations have to agree on. */
const values: ReadonlyArray<unknown> = [
  new Error("plain"),
  new TypeError("subclass"),
  new (class Tagged extends Error {})("user subclass"),
  Object.assign(Object.create(Error.prototype), { message: "lookalike" }),
  new Proxy(new Error("wrapped"), {}),
  {},
  Object.create(null),
  [],
  new Date(),
  null,
  undefined,
  "text",
  7
]

describe("host reflection", () => {
  it("detects a proxy on a host that exposes node:util/types", () => {
    expect(HostReflection.host.isProxy(new Proxy({}, {}))).toBe(true)
    expect(HostReflection.host.isProxy({})).toBe(false)
    expect(HostReflection.host.isNativeError(new Error("boom"))).toBe(true)
    expect(HostReflection.host.isNativeError({ message: "boom" })).toBe(false)
  })

  it("takes both predicates from the host module when it names them", () => {
    const reflection = HostReflection.make(sourceOf({ isProxy: () => true, isNativeError: () => true }))

    expect(reflection.isProxy({})).toBe(true)
    expect(reflection.isNativeError("not an error")).toBe(true)
  })

  it("treats every object as opaque where the host has no built-in modules", () => {
    for (const source of [undefined, {}, sourceOf(undefined), sourceOf(null), sourceOf("node:util/types")]) {
      const reflection = HostReflection.make(source)
      expect(reflection.isProxy(new Proxy({}, {}))).toBe(true)
      expect(reflection.isProxy({})).toBe(true)
    }
  })

  it("keeps the inert answer for a predicate the host module leaves out", () => {
    const reflection = HostReflection.make(sourceOf({ isProxy: undefined, isNativeError: undefined }))

    expect(reflection.isProxy(new Proxy({}, {}))).toBe(true)
    expect(reflection.isNativeError(new Error("boom"))).toBe(true)
  })

  it("degrades rather than raises when the accessor refuses the id", () => {
    const refusing: HostReflection.BuiltinSource = {
      getBuiltinModule: () => {
        throw new Error("no such built-in module")
      }
    }

    expect(HostReflection.make(refusing).isProxy(new Proxy({}, {}))).toBe(true)
  })

  it("answers native errors exactly as node:util/types does, without the module", () => {
    const portable = HostReflection.make(undefined)

    for (const value of values) {
      expect([value, portable.isNativeError(value)]).toEqual([value, NodeTypes.isNativeError(value)])
    }
  })

  it("answers no native error where the host has neither the module nor Error.isError", () => {
    const refusing: HostReflection.PortableIntrinsics = {
      get Error(): never {
        throw new Error("no intrinsics")
      }
    }
    const throwing: HostReflection.PortableIntrinsics = {
      Error: {
        isError: () => {
          throw new Error("refused")
        }
      }
    }
    for (const intrinsics of [{}, { Error: {} }, refusing, throwing]) {
      const reflection = HostReflection.make(undefined, intrinsics)
      for (const value of values) expect(reflection.isNativeError(value)).toBe(false)
    }
  })

  // R1-Astra-D1-014: the portable predicates must not run caller code. The
  // previous fallback answered "not a proxy" and read `Symbol.toStringTag`.
  it("runs no trap and no accessor while answering on a host without native predicates", () => {
    let calls = 0
    const count = (): never => {
      calls++
      throw new Error("caller code ran")
    }
    const trapped = new Proxy({}, {
      get: count,
      has: count,
      getOwnPropertyDescriptor: count,
      getPrototypeOf: count,
      ownKeys: count
    })
    const tagged = {
      get [Symbol.toStringTag]() {
        return count()
      },
      get message() {
        return count()
      }
    }

    for (const intrinsics of [undefined, {}] as const) {
      const reflection = intrinsics === undefined
        ? HostReflection.make(undefined)
        : HostReflection.make(undefined, intrinsics)
      for (const value of [trapped, tagged]) {
        expect(reflection.isProxy(value)).toBe(true)
        expect(reflection.isNativeError(value)).toBe(false)
        expect(ExitEncoding.makeProjector(reflection).projectValue(value)).toEqual({
          type: "object",
          message: "[unrepresentable]"
        })
        expect(FailureDiagnostic.site(value, reflection)).toBeUndefined()
      }
    }
    expect(calls).toBe(0)
  })
})
