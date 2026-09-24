import { expect, spyOn, test } from "bun:test"
import * as Effect from "effect/Effect"
import { exportClientError } from "./clientErrorTelemetry"
import type { ClientErrorAppendOutcome } from "./clientErrorLog"
import { configLayer } from "./Config"
import { DeploymentBindings, ExecutionContext, executionContextFrom } from "./Environment"
import { transportLayer } from "./Http"

const TOKEN = "fixture-exchange-secret"
const run = async (options: {
  outcome?: ClientErrorAppendOutcome; base?: string; token?: string; bound?: boolean;
  response?: (request: Request) => Promise<Response>
} = {}) => {
  const requests: Request[] = []
  const work: Promise<unknown>[] = []
  const logs = spyOn(console, "error").mockImplementation(() => {})
  try {
    await Effect.runPromise(exportClientError(options.outcome ?? "stored").pipe(
      Effect.provide(configLayer({ SMITHERS_CLOUD_API_BASE_URL: options.base ?? "https://cloud.test/ignored/path", PLUE_WORKER_EXCHANGE_TOKEN: options.token ?? TOKEN, SMITHERS_BUILD_SHA: "s".repeat(200) })),
      Effect.provideService(DeploymentBindings, { cloudApi: options.bound ?? true, clientErrors: true, recommendLog: false }),
      Effect.provideService(ExecutionContext, executionContextFrom({ waitUntil: promise => { work.push(promise) } })),
      Effect.provide(transportLayer(async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return options.response ? options.response(request) : new Response(null, { status: 204 })
      }))
    ))
    await Promise.all(work)
    return { requests, logs: logs.mock.calls.map(args => [...args]), work: work.length }
  } finally { logs.mockRestore() }
}

test("exports an admitted error with the exchange bearer and no report or browser data", async () => {
  const { requests, logs, work } = await run()
  expect(work).toBe(1)
  expect(requests).toHaveLength(1)
  const request = requests[0]!
  expect(request.url).toBe("https://cloud.test/api/telemetry/errors")
  expect(request.method).toBe("POST")
  expect(request.redirect).toBe("manual")
  expect([...request.headers.keys()].sort()).toEqual(["authorization", "content-type"])
  expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
  expect(await request.json()).toEqual({ client: "web", version: "s".repeat(128), error: { type: "Error" } })
  expect(logs).toEqual([])
})

test.each(["throttled", "failed", "unbound"] as const)("does not export %s reports", async outcome => {
  const result = await run({ outcome })
  expect(result.requests).toHaveLength(0)
  expect(result.work).toBe(0)
  expect(result.logs).toEqual([["client-error telemetry skipped:", outcome]])
})

test("skips an unconfigured Cloud binding or token", async () => {
  for (const options of [{ bound: false }, { token: "" }]) {
    const result = await run(options)
    expect(result.requests).toHaveLength(0)
    expect(result.logs).toEqual([["client-error telemetry skipped:", "unconfigured"]])
  }
})

test.each(["http://cloud.test", "https://user:secret@cloud.test"])("refuses unsafe export base %s", async base => {
  const result = await run({ base })
  expect(result.requests).toHaveLength(0)
  expect(result.logs).toEqual([["client-error telemetry failed:", { reason: "InvalidConfiguration" }]])
})

test.each([302, 500])("logs only the status of an HTTP %s refusal", async status => {
  const result = await run({ response: async () => new Response(TOKEN, { status }) })
  expect(result.logs).toEqual([["client-error telemetry failed:", { status }]])
  expect(JSON.stringify(result.logs)).not.toContain(TOKEN)
})

test("transport failures never log exception text that might echo the token", async () => {
  const result = await run({ response: async () => { throw new Error(TOKEN) } })
  expect(result.logs).toEqual([["client-error telemetry failed:", { reason: "UpstreamUnreachable" }]])
  expect(JSON.stringify(result.logs)).not.toContain(TOKEN)
})
