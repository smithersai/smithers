import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as FlowInvoker from "../src/FlowInvoker.vibe"

const invoke: FlowInvoker.FlowInvoker.Shape["invoke"] = () => Effect.succeed("done")

describe("FlowInvoker construction", () => {
  it("copies only an own data-property invoke function", () => {
    for (
      const implementation of [
        { invoke, extra: true },
        Object.assign(Object.create(null), { invoke }),
        Object.defineProperty({}, "invoke", { value: invoke })
      ]
    ) {
      const service = FlowInvoker.make(implementation)
      expect(Object.isFrozen(service)).toBe(true)
      expect(Reflect.ownKeys(service)).toEqual(["invoke"])
      expect(service.invoke).toBe(invoke)
      Object.defineProperty(implementation, "extra", {
        get: () => {
          throw new Error("unrelated accessor")
        }
      })
      expect(service.invoke).toBe(invoke)
    }
    const implementation = { invoke }
    const service = FlowInvoker.make(implementation)
    implementation.invoke = () => Effect.succeed("changed")
    expect(service.invoke).toBe(invoke)
  })

  it("rejects invalid implementations and overrides without calling accessors", () => {
    let reads = 0
    const getter = () => {
      reads++
      return invoke
    }
    const throwingGetter = () => {
      reads++
      throw new Error("accessor must not execute")
    }
    const invalid = [
      null,
      1,
      "invoke",
      invoke,
      [],
      Object.assign([], { invoke }),
      { invoke: 1 },
      { invoke: null },
      { invoke: undefined },
      { invoke: false },
      Object.create({ invoke }),
      Object.defineProperty({}, "invoke", { get: getter }),
      Object.defineProperty({}, "invoke", { get: throwingGetter }),
      Object.create(Object.defineProperty({}, "invoke", { get: getter })),
      Object.defineProperty({}, "invoke", {
        set: () => {
          reads++
        }
      })
    ]
    for (const value of invalid) {
      expect(() => FlowInvoker.make(value as never)).toThrow(TypeError)
      expect(() => FlowInvoker.makeNoop(value as never)).toThrow(TypeError)
      expect(() => FlowInvoker.layerNoop(value as never)).toThrow(TypeError)
    }
    for (const value of [undefined, {}]) {
      expect(() => FlowInvoker.make(value as never)).toThrow(TypeError)
    }
    expect(reads).toBe(0)
  })

  it("normalizes reflection failures without retaining caller errors", () => {
    const cause = new Error("SECRET reflection failure")
    let descriptorTraps = 0
    let hasTraps = 0
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const hostile = [
      new Proxy({ invoke }, {
        getOwnPropertyDescriptor: () => {
          descriptorTraps++
          throw cause
        }
      }),
      new Proxy({}, {
        has: () => {
          hasTraps++
          throw cause
        }
      }),
      revoked.proxy
    ]
    for (const construct of [FlowInvoker.make, FlowInvoker.makeNoop, FlowInvoker.layerNoop]) {
      for (const value of hostile) {
        let thrown: unknown
        try {
          construct(value as never)
        } catch (error) {
          thrown = error
        }
        expect(thrown).toBeInstanceOf(TypeError)
        expect(thrown).not.toBe(cause)
        expect(String(thrown)).not.toContain("SECRET")
      }
    }
    expect(descriptorTraps).toBe(3)
    expect(hasTraps).toBe(2)
  })
})
