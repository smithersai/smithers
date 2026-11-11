import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import * as Timer from "../src/timer.ts"

/** Resolves on the timer's own callback, so no case waits a fixed time. */
const fired = (ms: number): Promise<number> => {
  const started = performance.now()
  return new Promise((resolve) => Timer.after(ms, () => resolve(performance.now() - started)))
}

describe("Timer.after", () => {
  it("calls back once, no sooner than its delay", async () => {
    expect(await fired(20)).toBeGreaterThanOrEqual(19)
  })

  it("never calls back once cancelled, and a second cancel does nothing", async () => {
    let ran = false
    const cancel = Timer.after(5, () => (ran = true))
    cancel()
    cancel()
    await fired(25)
    expect(ran).toBe(false)
  })

  it("runs a zero delay after the current turn", async () => {
    const order: Array<string> = []
    const done = new Promise<void>((resolve) =>
      Timer.after(0, () => {
        order.push("timer")
        resolve()
      })
    )
    order.push("sync")
    await done
    expect(order).toEqual(["sync", "timer"])
  })

  it("leaves no pending wait behind a cancelled timer, so the process exits at once", () => {
    const script = `
      import * as Timer from ${JSON.stringify(join(import.meta.dir, "../src/timer.ts"))}
      Timer.after(60_000, () => {})()
      Timer.every(60_000, () => {})()
    `
    const started = performance.now()
    const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" })
    expect(run.status).toBe(0)
    expect(performance.now() - started).toBeLessThan(30_000)
  })

  it("surfaces a throwing callback as an uncaught error, as a host timer did", () => {
    const script = `
      import * as Timer from ${JSON.stringify(join(import.meta.dir, "../src/timer.ts"))}
      Timer.after(1, () => { throw new Error("callback failed") })
    `
    const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("callback failed")
  })
})

describe("Timer.every", () => {
  it("calls back each period until cancelled, the first time one period from now", async () => {
    const started = performance.now()
    const at: Array<number> = []
    await new Promise<void>((resolve) => {
      const cancel = Timer.every(10, () => {
        at.push(performance.now() - started)
        if (at.length === 3) {
          cancel()
          resolve()
        }
      })
    })
    await fired(40)
    expect(at).toHaveLength(3)
    expect(at[0]).toBeGreaterThanOrEqual(9)
    expect(at[2]! - at[0]!).toBeGreaterThanOrEqual(18)
  })
})
