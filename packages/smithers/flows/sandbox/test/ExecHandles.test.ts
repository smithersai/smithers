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

  const onBun = "Bun" in globalThis

  it("uses the runtime's own collector", () => {
    const own = () => undefined
    expect(exposeCollector({ gc: own })).toBe(own)
    execHandles.release()
  })

  it("collects through Bun.gc on Bun", () => {
    const calls: Array<unknown> = []
    const bun = {
      gc(this: unknown, sync: boolean) {
        calls.push([this, sync])
      }
    }
    exposeCollector({ Bun: bun })()
    expect(calls).toEqual([[bun, true]])
  })

  it.runIf(onBun)("collects on the real Bun runtime", () => {
    exposeCollector()()
  })

  it.skipIf(onBun)("exposes Node's collector when the process did not", () => {
    for (const runtime of [{}, { Bun: null }, { Bun: {} }]) {
      const exposed = exposeCollector(runtime)
      expect(typeof exposed).toBe("function")
      exposed()
    }
  })
})
