import { expect, test } from "bun:test"
import { Effect } from "effect"
import { serveRequest } from "./Boundary"
import { markCause } from "./RefusalLog"
import { refuse, withIsolationHeaders } from "./Responses"
import { eraseDurableTurn } from "./DurableTurn"
import { StorageFailure } from "./Failures"
import { memoryDurableObjects } from "./memoryDurableObjects"

const request = () => new Request("https://app.test/api/turn?secret=hidden", { headers: { "cf-ray": "ray-123" } })
const capture = async (run: () => Promise<void>) => {
  const lines: string[] = [], original = console.error
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")) }
  try { await run() } finally { console.error = original }
  return lines.map(line => JSON.parse(line))
}

test("a refusal logs once with correlation and cause without consuming its response", async () => {
  const lines = await capture(async () => {
    const response = await serveRequest(request(), Effect.sync(() => withIsolationHeaders(markCause(
      refuse("storage_failed", "Unavailable"), "turn journal", new Error("disk unavailable")))))
    expect(await response.json()).toMatchObject({ code: "storage_failed" })
  })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ event: "worker_refusal", code: "storage_failed", fault: "infra", seam: "turn journal", route: "/api/turn", method: "GET", status: 500, cfRay: "ray-123", cause: "Error: disk unavailable" })
  expect(JSON.stringify(lines)).not.toContain("hidden")
  expect(lines[0].durationMs).toBeGreaterThanOrEqual(0)
})

test("successful streaming responses are neither read nor logged", async () => {
  const lines = await capture(async () => {
    const body = new ReadableStream({ start() {} })
    const response = await serveRequest(request(), Effect.succeed(new Response(body)))
    expect(response.body).toBe(body)
    expect(body.locked).toBe(false)
    await body.cancel()
  })
  expect(lines).toEqual([])
})

test("journal erasure storage failure keeps its cause in the request log", async () => {
  const lines = await capture(async () => {
    const req = new Request("https://app.test/api/agent/turn/erase", { method: "POST", body: JSON.stringify({ runId: "run", legId: "leg", retirementProof: "a".repeat(64) }) })
    const response = await serveRequest(req, eraseDurableTurn(req, { request: () => Effect.fail(new StorageFailure({ operation: "fetch", cause: new Error("journal offline") })) }))
    expect(response.status).toBe(503)
  })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ code: "storage_failed", seam: "turn journal" })
  expect(lines[0].cause).toContain("journal offline")
})

test("the deployed router emits correlated refusal metadata", async () => {
  const { default: worker } = await import("./index")
  const lines = await capture(async () => {
    const response = await worker.fetch(request(), { ...memoryDurableObjects(), ASSETS: { fetch: async () => new Response("asset") } })
    expect(response.status).toBe(404)
  })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ code: "route_not_found", cfRay: "ray-123", route: "/api/turn" })
})
