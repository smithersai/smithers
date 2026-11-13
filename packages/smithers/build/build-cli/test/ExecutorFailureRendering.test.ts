/**
 * How `describeFailure` renders the failure values it walks member by member:
 * values outside the JSON domain become markers, and every rendering stays
 * inside one diagnostic without losing the members an operator reads first.
 */
import { describe, expect, it } from "vitest"
import * as Diagnostic from "../src/Diagnostic.ts"
import { describeFailure } from "../src/Executor.ts"

/** The longest length an array can have; a sparse one allocates nothing. */
const maximumArrayLength = 2 ** 32 - 1

/** Renders a failure and parses the JSON rendering back. */
const rendered = (value: unknown): Record<string, unknown> => {
  const text = describeFailure(value)
  expect(text.length).toBeLessThanOrEqual(Diagnostic.maximumMessageCodeUnits)
  return JSON.parse(text) as Record<string, unknown>
}

describe("describeFailure over values outside the JSON domain", () => {
  it("leaves a top-level proxy to the generic rendering without invoking its traps", () => {
    const touched: Array<string | symbol> = []
    const proxy = new Proxy({ reason: "disk full" }, {
      get: (target, key) => {
        touched.push(key)
        return Reflect.get(target, key)
      },
      ownKeys: (target) => {
        touched.push("ownKeys")
        return Reflect.ownKeys(target)
      },
      getPrototypeOf: (target) => {
        touched.push("getPrototypeOf")
        return Reflect.getPrototypeOf(target)
      }
    })
    expect(describeFailure(proxy)).toBe("target failed")
    expect(touched).toEqual([])
  })

  it("renders a plain top-level array as JSON", () => {
    expect(JSON.parse(describeFailure(["lint", 2, null]))).toEqual(["lint", 2, null])
  })

  it("renders a nested array subclass instance by its elements", () => {
    class Lines extends Array<string> {}
    const lines = Lines.from(["error: a", "error: b"])
    expect(rendered({ lines })).toEqual({ lines: ["error: a", "error: b"] })
  })

  it("names each function member without reading an accessor name", () => {
    let nameReads = 0
    const accessorNamed = function() {}
    Object.defineProperty(accessorNamed, "name", {
      get: () => {
        nameReads += 1
        return "fromGetter"
      }
    })
    const anonymous = [() => 1][0]
    expect(rendered({
      accessorNamed,
      anonymous,
      named: function onExit() {},
      proxy: new Proxy(function hidden() {}, {})
    })).toEqual({
      accessorNamed: "<function>",
      anonymous: "<function>",
      named: "<function onExit>",
      proxy: "<function proxy>"
    })
    expect(nameReads).toBe(0)
  })

  it("renders holes as null, accessor elements as markers, and keeps non-enumerable elements", () => {
    let reads = 0
    const items: Array<unknown> = ["first", "second", "third"]
    Object.defineProperty(items, "1", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1
        return "secret"
      }
    })
    const hidden: Array<unknown> = ["shown", "kept"]
    Object.defineProperty(hidden, "1", { enumerable: false })
    const holes = new Array<unknown>(3)
    holes[0] = 1
    holes[2] = 3
    expect(rendered({ hidden, holes, items })).toEqual({
      hidden: ["shown", "kept"],
      holes: [1, null, 3],
      items: ["first", "<accessor>", "third"]
    })
    expect(reads).toBe(0)
  })
})

describe("describeFailure within the diagnostic budget", () => {
  it("drops the elements past the byte budget and says how many it dropped", () => {
    const codes = Array.from({ length: 40_000 }, (_, index) => index)
    const result = rendered({ codes, exitCode: 2 })
    const kept = result["codes"] as Array<unknown>
    expect(kept.slice(0, 3)).toEqual([0, 1, 2])
    const marker = kept.at(-1) as string
    const omitted = Number(/^<(\d+) more items omitted>$/.exec(marker)?.[1])
    expect(kept.length - 1 + omitted).toBe(codes.length)
    expect(result["<truncated>"]).toBe("1 more members omitted")
  })

  it("adds no omission marker when the budget runs out on the last element", () => {
    const tail = "x".repeat(Diagnostic.maximumMessageCodeUnits * 2)
    const result = rendered({ output: ["exit status 1", tail] })
    const output = result["output"] as Array<string>
    expect(output).toHaveLength(2)
    expect(output[0]).toBe("exit status 1")
    expect(output[1]).toMatch(/^x+\.\.\.<\d+ more bytes truncated>x+$/)
  })

  it("renders a maximum-length sparse array promptly, as a counted omission", () => {
    const started = performance.now()
    const result = rendered({ exitCode: 1, slots: new Array(maximumArrayLength) })
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(result["exitCode"]).toBe(1)
    const slots = result["slots"] as Array<unknown>
    expect(slots.slice(0, -1).every((slot) => slot === null)).toBe(true)
    const omitted = Number(/^<(\d+) more items omitted>$/.exec(slots.at(-1) as string)?.[1])
    expect(slots.length - 1 + omitted).toBe(maximumArrayLength)
  })

  it("names the omitted holes of a large sparse array instead of cutting the rendering mid-array", () => {
    const text = describeFailure({ code: "exit_status", slots: new Array(1_000_000) })
    expect(text.endsWith("...")).toBe(false)
    const result = JSON.parse(text) as Record<string, unknown>
    expect(result["code"]).toBe("exit_status")
    expect(String((result["slots"] as Array<unknown>).at(-1))).toMatch(/^<\d+ more items omitted>$/)
  })

  it("stays inside one diagnostic when escaping keeps overshooting every re-walk", () => {
    // Each argument vector walks under its own budget, so every one of them
    // renders a deep chain of omission markers that its budget never pays for.
    let chain: unknown = "\u0001".repeat(100_000)
    for (let level = 0; level < 250; level += 1) {
      const array = new Array<unknown>(maximumArrayLength)
      array[0] = chain
      chain = array
    }
    const failures = Array.from({ length: 64 }, () => ({ argv: chain }))
    const text = describeFailure(failures)
    expect(text.length).toBeLessThanOrEqual(Diagnostic.maximumMessageCodeUnits)
    expect(text.startsWith("[{\"argv\":[[[")).toBe(true)
    expect(text).toContain(`<${maximumArrayLength - 1} more items omitted>`)
  })
})
