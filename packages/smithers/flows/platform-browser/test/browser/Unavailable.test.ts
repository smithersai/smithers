/**
 * A tab whose engine worker cannot run, in real Chromium: a worker that
 * throws while it loads makes the tab's requests fail promptly with
 * `EngineUnavailable` instead of waiting forever, and the tab reports why.
 * An uncaught callback error in a running worker leaves its tab usable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Harness from "./Harness.ts"

type Harnessed = {
  readonly harness: {
    readonly attempt: (flow: string, executionId: string, payload: unknown) => Promise<unknown>
    readonly unavailable: () => Promise<unknown>
    readonly result: (flow: string, executionId: string) => Promise<unknown>
  }
}

let server: Awaited<ReturnType<typeof Harness.serve>>

beforeAll(async () => {
  server = await Harness.serve()
})

afterAll(() => server.close())

describe("a tab whose engine worker fails to load", () => {
  it("fails a start promptly with EngineUnavailable, and reports the worker failed", async () => {
    const profile = Harness.profile()
    const context = await Harness.launch(profile.directory)
    try {
      const page = await context.newPage()
      await page.goto(`${server.origin}/?mode=finish&worker=broken`)
      await page.waitForFunction(() => "harness" in globalThis)
      const started = Date.now()
      const attempt = await page.evaluate(() =>
        (globalThis as unknown as Harnessed).harness.attempt("browser-test/Steps", "broken-1", { prefix: "b" })
      )
      expect(attempt).toEqual({ ok: false, tag: "@smthrs/platform-browser/EngineUnavailable", reason: "worker-failed" })
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(await page.evaluate(() => (globalThis as unknown as Harnessed).harness.unavailable())).toEqual({
        _tag: "@smthrs/platform-browser/EngineUnavailable",
        reason: "worker-failed",
        error: "ErrorEvent"
      })
    } finally {
      await context.close()
      profile.remove()
    }
  }, 60_000)
})

describe("a running engine worker with an uncaught callback error", () => {
  it("keeps pending results and later starts usable under the same leader", async () => {
    const profile = Harness.profile()
    const context = await Harness.launch(profile.directory)
    try {
      const page = await Harness.open(context, server.origin, "finish")
      expect(
        await page.evaluate(() =>
          (globalThis as unknown as Harnessed).harness.attempt("browser-test/Sleeper", "uncaught-sleep", {
            prefix: "sleep",
            pauseMs: 1_000
          })
        )
      ).toEqual({ ok: true })
      await Harness.waitForEvent(page, "uncaught-sleep", "flows.engine.clock-scheduled")
      const leader = (await Harness.logged(page))[0]!.worker
      const pending = page.evaluate(() =>
        (globalThis as unknown as Harnessed).harness.result("browser-test/Sleeper", "uncaught-sleep")
      ).then((result) => result, () => ({ ok: false }))
      const worker = page.workers()[0]!
      // Throw in a real timer callback: the browser dispatches a runtime ErrorEvent
      // while the same worker keeps its lock and processes channel requests.
      await worker.evaluate(() =>
        new Promise<void>((resolve) => {
          self.addEventListener("error", () => resolve(), { once: true })
          setTimeout(() => {
            throw new TypeError("private callback failure")
          }, 0)
        })
      )
      expect(await pending).toEqual({ ok: true, value: "sleep:after" })
      for (const executionId of ["after-error-1", "after-error-2"]) {
        expect(
          await page.evaluate(
            (executionId) =>
              (globalThis as unknown as Harnessed).harness.attempt("browser-test/Steps", executionId, {
                prefix: executionId
              }),
            executionId
          )
        ).toEqual({ ok: true })
        expect(
          await page.evaluate(
            (executionId) => (globalThis as unknown as Harnessed).harness.result("browser-test/Steps", executionId),
            executionId
          )
        ).toEqual({ ok: true, value: `${executionId}:three` })
      }
      expect((await Harness.logged(page)).every((entry) => entry.worker === leader)).toBe(true)
      expect(page.workers()).toEqual([worker])
    } finally {
      await context.close()
      profile.remove()
    }
  })
})
