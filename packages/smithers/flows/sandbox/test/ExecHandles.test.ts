import { describe, expect, it } from "vitest"
import { collectEvery, execHandles, exposeCollector, makeReleaser } from "../src/internal/execHandles.ts"

describe("exec handle release", () => {
  it("collects garbage every so many starts, exposing the collector once", () => {
    const exposed: Array<number> = []
    let collections = 0
    const releaser = makeReleaser(() => {
      exposed.push(1)
      return () => {
        collections++
      }
    }, 3)
    for (let start = 0; start < 7; start++) releaser.started()
    expect(collections).toBe(2)
    releaser.release()
    expect(collections).toBe(3)
    expect(exposed).toHaveLength(1)
    expect(collectEvery).toBeLessThan(140)
  })

  it("uses the runtime's collector, exposing it when the process did not", () => {
    const saved: unknown = Reflect.get(globalThis, "gc")
    try {
      Reflect.deleteProperty(globalThis, "gc")
      const exposed = exposeCollector()
      expect(typeof exposed).toBe("function")
      exposed()
      const own = () => undefined
      Reflect.set(globalThis, "gc", own)
      expect(exposeCollector()).toBe(own)
      execHandles.release()
    } finally {
      if (saved === undefined) Reflect.deleteProperty(globalThis, "gc")
      else Reflect.set(globalThis, "gc", saved)
    }
  })
})
