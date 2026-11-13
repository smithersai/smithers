/**
 * BrowserRuntime.run uses the dedicated worker's own globals in real Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Harness from "./Harness.ts"

let server: Awaited<ReturnType<typeof Harness.serve>>
beforeAll(async () => {
  server = await Harness.serve()
})
afterAll(() => server.close())

describe("the dedicated worker entry", () => {
  it.each([
    ["sqlite-failure", "SqlError"],
    ["telemetry-failure", "TelemetryUnavailable"]
  ])("tells the tab why %s stopped its engine", async (mode, error) => {
    const profile = Harness.profile()
    const context = await Harness.launch(profile.directory)
    try {
      const page = await context.newPage()
      await page.goto(server.origin + "/cache")
      const stopped = await page.evaluate((mode) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(`/runtime-worker.js?mode=${mode}`, { type: "module" })
          worker.onerror = () => reject(new Error("worker load failed"))
          worker.onmessage = ({ data }) => {
            if (data._tag === "@smthrs/platform-browser/EngineStopped") {
              worker.terminate()
              resolve(data)
            }
          }
        }), mode)
      expect(stopped).toEqual({ _tag: "@smthrs/platform-browser/EngineStopped", error })
    } finally {
      await context.close()
      profile.remove()
    }
  })

  it("logs actual uncaught errors and rejections by kind and name without content", async () => {
    const profile = Harness.profile()
    const context = await Harness.launch(profile.directory)
    try {
      const page = await context.newPage()
      await page.goto(server.origin + "/cache")
      const records = await page.evaluate(() =>
        new Promise<
          Array<{
            message: unknown
            annotations: Record<string, string>
          }>
        >((resolve, reject) => {
          const worker = new Worker("/runtime-worker.js", { type: "module" })
          const logs: Array<{ message: unknown; annotations: Record<string, string> }> = []
          worker.onerror = () => reject(new Error("uncaught worker error reached the tab"))
          worker.onmessage = ({ data }) => {
            if (data._tag === "Ready") worker.postMessage("exercise")
            if (data._tag === "@smthrs/platform-browser/EngineStopped") reject(new Error("engine stopped"))
            if (data._tag === "Log" && data.message === "browser.runtime.uncaught") {
              logs.push(data)
              if (logs.length === 3) {
                worker.terminate()
                resolve(logs)
              }
            }
          }
        })
      )
      expect(records.map(({ annotations }) => [annotations.kind, annotations["error.type"]]).sort())
        .toEqual([["error", "TypeError"], ["rejection", "Refused"], ["rejection", "string"]])
      expect(JSON.stringify(records)).not.toContain("SENTINEL")
    } finally {
      await context.close()
      profile.remove()
    }
  })
})
