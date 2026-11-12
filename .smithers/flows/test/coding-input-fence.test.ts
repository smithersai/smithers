import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { platform } from "../../../packages/smithers/src/internal/NodeControlHost.ts"
import { nativePlatform, type Options } from "../coding/host.ts"
import { systemFlows } from "./fixtures/system-flows.ts"

const binding = ["SMITHERS_MODEL_PROXY_URL", "SMITHERS_MODEL_ROLE_IMPLEMENTER_KEY"] as const

/** Sets the hosted input-delivery binding for one test and restores the operator's afterwards. */
const bind = (t: TestContext, environment: Partial<Record<(typeof binding)[number], string>>) => {
  const saved = binding.map((key) => [key, process.env[key]] as const)
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  for (const key of binding) {
    const value = environment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/** A local project host: project planning and a local lander, with no hosted service. */
const options: Options = {
  repositoryPath: "/unused",
  systemFlows,
  gatewayId: "11111111-1111-4111-8111-111111111111",
  implementationModel: "test:model",
  credential: "operator-key",
  planning: { implementation: "coding/implementation", checks: [], wiki: false, landing: "fast-forward" }
}

const drain = (runId: string, flowId = "todo") =>
  nativePlatform(platform, options, ScriptedJudge.layerAll).beforeSteeringDrain!(runId, flowId)

/** The hosted input-delivery service, answering each fence with `status`. */
const fenceService = async (t: TestContext, status: number) => {
  const requests: Array<{ url: string | undefined; authorization: string | undefined }> = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization })
    response.writeHead(status).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model-proxy/`, requests }
}

test("a local TODO drains its own inbox without a hosted input-delivery binding", async (t) => {
  bind(t, {})
  await Effect.runPromise(drain("local-run"))
})

test("a half-declared hosted binding refuses TODO input delivery", async (t) => {
  for (
    const environment of [
      { SMITHERS_MODEL_PROXY_URL: "http://127.0.0.1:9/model-proxy" },
      { SMITHERS_MODEL_ROLE_IMPLEMENTER_KEY: "implementer-key" }
    ]
  ) {
    bind(t, environment)
    const refusal = await Effect.runPromise(Effect.flip(drain("hosted-run")))
    assert.deepEqual({ code: refusal.code, message: refusal.message }, {
      code: "assembly_failed",
      message: "TODO input delivery is unavailable"
    })
  }
})

test("a bound host fences each TODO steering drain at the hosted service", async (t) => {
  const service = await fenceService(t, 200)
  bind(t, { SMITHERS_MODEL_PROXY_URL: service.origin, SMITHERS_MODEL_ROLE_IMPLEMENTER_KEY: "implementer-key" })
  await Effect.runPromise(drain("run/1"))
  await Effect.runPromise(drain("run/1", "coding"))
  assert.deepEqual(service.requests, [
    { url: "/model-proxy/input-fence?run=run%2F1", authorization: "Bearer implementer-key" }
  ])
})

test("a bound host refuses TODO input delivery the hosted service declines", async (t) => {
  const service = await fenceService(t, 503)
  bind(t, { SMITHERS_MODEL_PROXY_URL: service.origin, SMITHERS_MODEL_ROLE_IMPLEMENTER_KEY: "implementer-key" })
  const refusal = await Effect.runPromise(Effect.flip(drain("hosted-run")))
  assert.equal(refusal.code, "assembly_failed")
  assert.equal(service.requests.length, 1)
})
