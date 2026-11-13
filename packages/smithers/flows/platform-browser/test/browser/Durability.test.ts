/**
 * The durable browser engine in real Chromium, over real OPFS.
 *
 * Each case runs the fixture flows through the page's `BrowserEngine` and
 * the engine worker's `BrowserRuntime.run`, and reads which worker ran which
 * step from the step log every worker posts to.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Harness from "./Harness.ts"

type Harnessed = {
  readonly harness: {
    readonly start: (flow: string, executionId: string, payload: unknown) => Promise<void>
    readonly result: (flow: string, executionId: string) => Promise<unknown>
    readonly steal: (name: string) => Promise<void>
    readonly release: (name: string) => Promise<void>
  }
}

let server: Awaited<ReturnType<typeof Harness.serve>>

beforeAll(async () => {
  server = await Harness.serve()
})

afterAll(() => server.close())

const labels = (logged: ReadonlyArray<Harness.Logged>) => logged.map((entry) => entry.label)

describe("a run in the browser engine", () => {
  it("resumes at the step a killed browser was in, and never runs a sealed step again", async () => {
    const profile = Harness.profile()
    try {
      const first = await Harness.launch(profile.directory)
      const a = await Harness.open(first, server.origin, "block")
      await a.evaluate(() =>
        (globalThis as unknown as Harnessed).harness.start("browser-test/Steps", "crash-1", { prefix: "x" })
      )
      await Harness.waitForStep(a, "x:two")
      expect(labels(await Harness.logged(a))).toEqual(["x:one", "x:two"])
      Harness.kill(profile.directory)
      await first.close().catch(() => undefined)

      const second = await Harness.launch(profile.directory)
      try {
        const b = await Harness.open(second, server.origin, "finish")
        const result = await b.evaluate(() =>
          (globalThis as unknown as Harnessed).harness.result("browser-test/Steps", "crash-1")
        )
        expect(result).toEqual({ ok: true, value: "x:three" })
        // Step one was sealed before the kill and replays; step two was not, and runs again.
        expect(labels(await Harness.logged(b))).toEqual(["x:two", "x:three"])
      } finally {
        await second.close()
      }
    } finally {
      profile.remove()
    }
  })

  it("moves to a follower tab when the leader tab closes mid-run, and the follower finishes it", async () => {
    const profile = Harness.profile()
    const context = await Harness.launch(profile.directory)
    try {
      const leader = await Harness.open(context, server.origin, "block")
      await Harness.waitForLeader(leader)
      const follower = await Harness.open(context, server.origin, "finish")
      // The follower's request reaches the leader's worker over the channel.
      await follower.evaluate(() =>
        (globalThis as unknown as Harnessed).harness.start("browser-test/Steps", "handoff-1", { prefix: "y" })
      )
      await Harness.waitForStep(follower, "y:two")
      const before = await Harness.logged(follower)
      expect(labels(before)).toEqual(["y:one", "y:two"])
      const old = before[0]!.worker

      const result = follower.evaluate(() =>
        (globalThis as unknown as Harnessed).harness.result("browser-test/Steps", "handoff-1")
      )
      await leader.close()
      expect(await result).toEqual({ ok: true, value: "y:three" })
      const after = (await Harness.logged(follower)).slice(2)
      expect(labels(after)).toEqual(["y:two", "y:three"])
      // The follower's own worker took over and ran the rest.
      expect(after.every((entry) => entry.worker !== old)).toBe(true)
    } finally {
      await context.close()
      profile.remove()
    }
  })

  it("hands OPFS to a follower after an engine-lock steal mid-run, without repeating sealed steps", async () => {
    const profile = Harness.profile()
    const context = await Harness.launch(profile.directory)
    try {
      const leader = await Harness.open(context, server.origin, "block")
      await Harness.waitForLeader(leader)
      const follower = await Harness.open(context, server.origin, "finish")
      // Its worker must be ahead of the robbed leader when that leader requeues.
      await Harness.waitForFollower(follower)
      const leadingWorker = leader.workers()[0]
      const followingWorker = follower.workers()[0]
      await follower.evaluate(() =>
        (globalThis as unknown as Harnessed).harness.start("browser-test/Steps", "steal-1", { prefix: "s" })
      )
      await Harness.waitForStep(follower, "s:two")
      const before = await Harness.logged(follower)
      expect(labels(before)).toEqual(["s:one", "s:two"])
      const old = before[0]!.worker

      // Both tabs and their workers stay alive. The page takes the engine's
      // actual lock, forcing the robbed worker to close its OPFS handles.
      await follower.evaluate(() => (globalThis as unknown as Harnessed).harness.steal("browser-test"))
      await follower.evaluate(() => (globalThis as unknown as Harnessed).harness.release("browser-test"))
      await Harness.waitForLeader(follower)
      expect(leader.isClosed()).toBe(false)
      expect(
        await follower.evaluate(() =>
          (globalThis as unknown as Harnessed).harness.result("browser-test/Steps", "steal-1")
        )
      ).toEqual({ ok: true, value: "s:three" })
      const after = await Harness.logged(follower)
      // Only the interrupted, unsealed step repeats, in a different worker.
      expect(labels(after)).toEqual(["s:one", "s:two", "s:two", "s:three"])
      expect(after.slice(2).every((entry) => entry.worker !== old)).toBe(true)
      expect(
        await leader.evaluate(() =>
          (globalThis as unknown as Harnessed).harness.result("browser-test/Steps", "steal-1")
        )
      ).toEqual({ ok: true, value: "s:three" })
      expect(await Harness.logged(follower)).toEqual(after)
      expect(leader.workers()).toContain(leadingWorker)
      expect(follower.workers()).toContain(followingWorker)
    } finally {
      await context.close()
      profile.remove()
    }
  })

  it("wakes a durable sleep that came due while every tab was closed", async () => {
    const profile = Harness.profile()
    try {
      const first = await Harness.launch(profile.directory)
      const a = await Harness.open(first, server.origin, "finish")
      await a.evaluate(() =>
        (globalThis as unknown as Harnessed).harness.start("browser-test/Sleeper", "sleep-1", {
          prefix: "z",
          pauseMs: 2_000
        })
      )
      // The sleep's timer is recorded only after the first step is sealed.
      await Harness.waitForEvent(a, "sleep-1", "flows.engine.clock-scheduled")
      expect(labels(await Harness.logged(a))).toEqual(["z:before"])
      await first.close()
      await new Promise((resolve) => setTimeout(resolve, 2_500))

      const second = await Harness.launch(profile.directory)
      try {
        const b = await Harness.open(second, server.origin, "finish")
        // Nothing asks for the run: the new leader wakes it on load.
        await Harness.waitForStep(b, "z:after")
        expect(labels(await Harness.logged(b))).toEqual(["z:after"])
        expect(
          await b.evaluate(() => (globalThis as unknown as Harnessed).harness.result("browser-test/Sleeper", "sleep-1"))
        ).toEqual({ ok: true, value: "z:after" })
      } finally {
        await second.close()
      }
    } finally {
      profile.remove()
    }
  })
})
