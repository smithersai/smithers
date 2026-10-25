// ChatApi's records as the e2e tests read them (e2e/logs.ts). The live case opens a real Cloudflare tail on the
// deployment E2E_PROD_URL names, with the account's CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and skips without
// them; it makes one signed-out read, which writes nothing.
import { describe, expect, it } from "vitest"
import { CloudflareTail, recordOf, TailCapture, traceIdOf, frameText } from "./logs"
import { NEEDS } from "./target"

describe("a tail's log message as a record", () => {
  it("is the structured logger's JSON line parsed, or the object logged; anything else is no record", () => {
    expect(recordOf('{"message":"github.webhook","level":"INFO","annotations":{"outcome":"applied"}}')).toEqual({
      message: "github.webhook",
      level: "INFO",
      annotations: { outcome: "applied" },
    })
    expect(recordOf({ message: "repo.clone" })).toEqual({ message: "repo.clone" })
    expect(recordOf("plain text")).toBeUndefined()
    expect(recordOf("[1,2]")).toBeUndefined()
    expect(recordOf("null")).toBeUndefined()
    expect(recordOf(42)).toBeUndefined()
  })
})

describe("WebSocket frame decoding", () => {
  it("reads text, Blob, ArrayBuffer and ranged typed bytes without dropping or adding bytes", async () => {
    const text = '{"message":"flow.run.started"}'
    const bytes = new TextEncoder().encode(text)
    const ranged = new Uint8Array(bytes.length + 4)
    ranged.set(bytes, 2)
    for (const frame of [text, new Blob([bytes]), bytes.buffer, bytes, Buffer.from(bytes), new DataView(ranged.buffer, 2, bytes.length)]) {
      expect(await frameText(frame)).toBe(text)
    }
    await expect(frameText({})).rejects.toThrow()
  })
})

describe("Cloudflare tail capture integrity", () => {
  it.each(["disconnected", "failed", "malformed"] as const)("rejects an incomplete capture when the socket %s", (reason) => {
    const capture = new TailCapture()
    capture.add({ logs: [{ message: [{ message: "question stored" }] }] })
    capture.fail(reason)
    expect(() => capture.lines).toThrow(`Cloudflare log tail ${reason}; capture is incomplete`)
  })

  it("reports a sampling gap even when later events resume, without retaining protocol metadata", () => {
    const capture = new TailCapture()
    capture.add({ event: { type: "overload" } })
    capture.add({ event: { type: "overload-stop" } })
    capture.add({ logs: [{ message: [{ message: "chat.answer.write" }] }] })
    expect(() => capture.lines).toThrow("Cloudflare log tail entered sampling mode; capture is incomplete")
    capture.fail("disconnected")
    expect(capture.failure).toBe("Cloudflare log tail entered sampling mode; capture is incomplete")
  })

  it("keeps only bounded transport facts, never request metadata or credentials", () => {
    const capture = new TailCapture()
    capture.add({ event: { request: { url: "https://example.test/api/telemetry/v1/logs?token=private-sentinel",
      headers: { "content-length": "42", cookie: "private-sentinel" } } }, eventTimestamp: 123, outcome: "ok",
      logs: [{ message: [{ message: "flow.run.settled", annotations: { flow: "app/theme/set" } }] }] })
    capture.add({ event: { request: { url: "https://example.test/api/telemetry/v1/metrics" } }, outcome: "unrecognized" })
    expect(capture.receipts).toEqual([
      { signal: "logs", bytes: 42, outcome: "ok", target: 1, at: 123 },
      { signal: "metrics", bytes: 0, outcome: "other", target: 0 },
    ])
    expect(JSON.stringify(capture.receipts)).not.toContain("private-sentinel")
  })

  it("retains every structured log in a batched invocation, as JSON or an object, in order", () => {
    const question = { message: "chat.question", annotations: { answerId: "answer", status: 202 } }
    const stored = { message: "question stored", annotations: { answerId: "answer", "otlp.signal": "logs" } }
    const captured = new TailCapture()
    captured.add({})
    captured.add({ event: { type: "overload-stop" } })
    expect(captured.lines).toEqual([])
    captured.add({ logs: [{ message: [JSON.stringify(question), stored] }, { message: ["plain diagnostic"] }, {}] })
    expect(captured.failure).toBeUndefined()
    expect(captured.lines.map(({ record }) => record)).toEqual([question, stored, undefined])
    expect(captured.lines.map(({ worker, file }) => [worker, file])).toEqual(Array(3).fill(["ChatApi", "tail"]))
  })
})

const deployment = process.env.E2E_PROD_URL ?? ""

/** Whether a deployment run here could open a tail: the `localLogs` need, as e2e/target.ts declares it. */
const canTail = NEEDS.localLogs.met({ target: "deployment", role: () => null, env: process.env })

describe.skipIf(deployment === "" || !canTail)("a Cloudflare tail on the deployment's ChatApi", () => {
  it("an isolated capture includes only requests carrying its opaque capture header", { timeout: 120_000 }, async () => {
    const captureId = crypto.randomUUID()
    const tail = await CloudflareTail.shared(process.env, true, captureId)
    try {
      const from = tail.lines.length
      expect(Object.keys(tail.captureHeaders)).toEqual(["x-smithers-e2e-capture"])
      expect(Object.values(tail.captureHeaders).every((value) => value === captureId)).toBe(true)
      const excluded = crypto.randomUUID().replaceAll("-", "")
      const included = crypto.randomUUID().replaceAll("-", "")
      const ask = (trace: string, headers: Record<string, string>) => fetch(new URL("/api/questions", deployment), {
        method: "POST", body: "{}", headers: { ...headers, traceparent: `00-${trace}-0123456789abcdef-01`, "content-type": "application/json" },
      }).then((response) => response.body?.cancel())
      await ask(excluded, {})
      await ask(included, tail.captureHeaders)
      await expect.poll(() => tail.lines.slice(from).some(({ record }) => traceIdOf(record) === included), { timeout: 30_000 }).toBe(true)
      expect(tail.lines.slice(from).some(({ record }) => traceIdOf(record) === excluded)).toBe(false)
    } finally {
      await tail.close()
    }
  })

  it("a POST capture retains the ask and excludes unrelated shape reads", { timeout: 120_000 }, async () => {
    const tail = await CloudflareTail.shared(process.env, true)
    try {
      const from = tail.lines.length
      const traceId = crypto.randomUUID().replaceAll("-", "")
      await fetch(new URL("/api/shapes/items?offset=-1", deployment)).then((response) => response.body?.cancel())
      await fetch(new URL("/api/questions", deployment), {
        method: "POST", body: "{}", headers: { traceparent: `00-${traceId}-0123456789abcdef-01`, "content-type": "application/json" },
      }).then((response) => response.body?.cancel())
      await expect.poll(() => tail.lines.slice(from).some(({ record }) =>
        record?.message === "chat.question" && traceIdOf(record) === traceId
      ), { timeout: 30_000 }).toBe(true)
      expect(tail.lines.slice(from).filter(({ record }) => record?.message === "github.shape.items")).toEqual([])
    } finally {
      await tail.close()
    }
  })

  it("streams the record of a request made after it opened, and is deleted on close", { timeout: 120_000 }, async () => {
    const tail = await CloudflareTail.shared()
    try {
      // Opening is a receipt barrier for the malformed, signed-out ask, not merely the first unrelated log line.
      expect(tail.lines.some(({ record }) => record?.message === "chat.question" && traceIdOf(record) === tail.readinessTraceId && record.annotations?.status === 401)).toBe(true)
      // A signed-out read of the issues shape is refused, and ChatApi records it (`github.shape.items`, 401). A tail
      // can take a few seconds to start streaming, so the read repeats until its record arrives.
      await expect.poll(async () => {
        await fetch(new URL("/api/shapes/items?offset=-1", deployment))
        return tail.lines.filter((line) => line.record?.message === "github.shape.items").length
      }, { timeout: 90_000, interval: 3_000 }).toBeGreaterThan(0)
    } finally {
      await tail.close()
    }
    // Closed, the process's next tail is a new one.
    const next = await CloudflareTail.shared()
    expect(next).not.toBe(tail)
    await next.close()
  })
})
