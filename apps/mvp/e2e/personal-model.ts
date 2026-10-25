import { expect, type APIRequestContext } from "@playwright/test"
import { DEVICE_PERSON_HEADER } from "../src/features/auth/contract"
import { PERSONAL_MODEL_ROUTE, PERSONAL_MODEL_TEST_ROUTE, PERSONAL_MODEL_SHAPE_ROUTE, isProtocol } from "../src/features/personal-model/contract"
import { shapeRows } from "./shape"
import { baseURL, me } from "./target"

/** Only an explicitly supplied test-account credential may configure the release path. Never return it to a reporter. */
export const personalModelConfig = () => {
  const protocol = process.env.E2E_PERSONAL_MODEL_PROTOCOL || "openai-chat"
  if (!isProtocol(protocol)) throw new Error("E2E_PERSONAL_MODEL_PROTOCOL must be openai-chat or anthropic-messages")
  return {
    protocol,
    baseUrl: process.env.E2E_PERSONAL_MODEL_BASE_URL || "https://api.openai.com",
    modelId: process.env.E2E_PERSONAL_MODEL_ID || "gpt-4.1-mini",
  }
}

/** Save and Test through the same product endpoints as Settings. Context must have tracing disabled. */
export const restorePersonalModel = async (request: APIRequestContext) => {
  const key = process.env.E2E_PERSONAL_MODEL_KEY
  if (!key) return
  const headers = { origin: new URL(baseURL).origin, [DEVICE_PERSON_HEADER]: me().personId }
  // Transport diagnostics can contain request bodies. Drop them whole rather than risk printing the key.
  const config = personalModelConfig()
  type Saved = { updated_at: string; protocol: string; base_url: string; model_id: string; key_last4: string }
  const before = (await shapeRows<Saved>(request, PERSONAL_MODEL_SHAPE_ROUTE))[0]?.updated_at
  const saved = await request.put(PERSONAL_MODEL_ROUTE, { headers, data: { ...config, key } })
    .catch(() => { throw new Error("Personal model Save transport failed (details withheld)") })
  expect(saved.status(), "personal model Save accepted").toBe(202)
  // Acceptance is not completion: wait for the durable Put's row before testing the saved model.
  await expect.poll(async () => {
    const row = (await shapeRows<Saved>(request, PERSONAL_MODEL_SHAPE_ROUTE))[0]
    return row !== undefined && row.updated_at !== before && row.protocol === config.protocol &&
      row.model_id === config.modelId && row.key_last4 === [...key].slice(-4).join("")
  }, { timeout: 30_000, message: "personal model Save completed" }).toBe(true)
  const tested = await request.post(PERSONAL_MODEL_TEST_ROUTE, { headers, timeout: 60_000 })
    .catch(() => { throw new Error("Personal model Test transport failed (details withheld)") })
  expect(tested.status(), "personal model Test answered").toBe(200)
  const result = await tested.json().catch(() => { throw new Error("Personal model Test returned invalid JSON (details withheld)") }) as { ok?: unknown }
  // Never attach the response body: a provider could echo credentials or prompt content.
  expect(result.ok === true, "saved personal model passes Test").toBe(true)
}
