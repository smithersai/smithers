import { expect, test } from "./fixtures"
import { baseURL, broken, requires } from "./target"
import { LogTail, traceIdOf } from "./logs"

requires("localLogs")
test.use({ video: "off" })

test("telemetry transport: complete collector replies retain every content-free probe", async ({ page }) => {
  broken("telemetryTail")
  const logs = await LogTail.start({ postOnly: true })
  try {
    await page.context().setExtraHTTPHeaders(logs.captureHeaders)
    // A JSON document starts no app, agent or model.
    await page.goto(new URL("/manifest.webmanifest", baseURL).href)
    const replies: Array<unknown> = []
    const ids = { canceled: [] as Array<string>, drained: [] as Array<string> }
    for (let n = 0; n < 10; n++) for (const mode of ["canceled", "drained"] as const) {
      const trace = crypto.randomUUID().replaceAll("-", "")
      ids[mode].push(trace)
      const reply = await page.evaluate(async ({ mode, trace }) => {
        const controller = new AbortController()
        const body = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "smithers-mvp-probe" } }] },
          scopeLogs: [{ logRecords: [{ body: { stringValue: "POST" }, severityNumber: 9, traceId: trace,
            attributes: [{ key: "source", value: { stringValue: "e2e.transport" } }] }] }] }] }
        const response = await fetch("/api/telemetry/v1/logs", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
        })
        let bytes = 0
        let kind = "unread"
        let rejected = 0
        if (mode === "drained") {
          const buffer = await response.arrayBuffer()
          bytes = buffer.byteLength
          let ack: { partialSuccess?: { rejectedLogRecords?: number } } | undefined
          try { ack = JSON.parse(new TextDecoder().decode(buffer)) } catch {}
          kind = ack !== undefined && ack !== null && typeof ack === "object" && Object.keys(ack).length === 0
            ? "accepted" : ack?.partialSuccess !== undefined ? "partial" : "other"
          rejected = typeof ack?.partialSuccess?.rejectedLogRecords === "number" ? ack.partialSuccess.rejectedLogRecords : 0
        } else controller.abort()
        return { status: response.status, json: response.headers.get("content-type")?.includes("application/json") === true,
          challenge: response.headers.get("cf-mitigated") === "challenge", redirected: response.redirected,
          bytes, kind, rejected, controlled: navigator.serviceWorker.controller !== null }
      }, { mode, trace })
      replies.push({ mode, ...reply })
      expect(reply.status).toBe(200)
      if (mode === "drained") expect(reply.kind).toBe("accepted")
    }
    const counts = async () => {
      const records = (await logs.records()).browser
      return Object.fromEntries(Object.entries(ids).map(([mode, traces]) => [mode,
        traces.filter((trace) => records.some((record) => traceIdOf(record) === trace)).length,
      ]))
    }
    await expect.poll(async () => (await counts()).drained, { timeout: 30_000 }).toBe(10)
      .finally(async () => {
        await test.info().attach("transport-counts", { body: JSON.stringify({ ...await counts(), replies, receipts: logs.receipts }), contentType: "application/json" })
      })
  } finally {
    await logs.dispose()
  }
})
