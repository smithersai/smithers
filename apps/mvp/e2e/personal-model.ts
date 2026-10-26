import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import { DEVICE_PERSON_HEADER } from "../src/features/auth/contract"
import type { ModelTier } from "../src/features/model/contract"
import {
  PERSONAL_MODEL_ROUTE,
  PERSONAL_MODEL_TEST_ROUTE,
  PERSONAL_MODEL_SHAPE_ROUTE,
  isProtocol,
  type Protocol,
} from "../src/features/personal-model/contract"
import { PROTOCOL_LABEL, TIER_LABEL, tierKeyLabel } from "../src/features/personal-model/copy"
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

/**
 * Fills Settings' Your model `section` as a person does: one key's Base URL and Key, under its protocol's name, and each
 * of `tiers`' models on that key; then Save. Context must have tracing disabled: the key is typed.
 */
export const fillYourModel = async (
  section: Locator,
  page: Page,
  fill: {
    readonly protocol: Protocol
    readonly baseUrl: string
    readonly key: string
    readonly tiers: Partial<Record<ModelTier, string>>
  },
) => {
  const group = section.getByRole("group", { name: PROTOCOL_LABEL[fill.protocol], exact: true })
  await group.getByLabel("Base URL", { exact: true }).fill(fill.baseUrl)
  await group.getByLabel("Key", { exact: true }).fill(fill.key)
  for (const [tier, model] of Object.entries(fill.tiers) as Array<[ModelTier, string]>) {
    await section.getByLabel(TIER_LABEL[tier], { exact: true }).fill(model)
    await section.getByRole("combobox", { name: tierKeyLabel(tier), exact: true }).click()
    await page.getByRole("option", { name: PROTOCOL_LABEL[fill.protocol], exact: true }).click()
  }
  await section.getByRole("button", { name: "Save" }).click()
}

/** One protocol's key group in the Your model section. */
export const keyGroup = (section: Locator, protocol: Protocol) =>
  section.getByRole("group", { name: PROTOCOL_LABEL[protocol], exact: true })

/**
 * Save and Test through the same product endpoints as Settings: the one key, Fast named on it. Context must have
 * tracing disabled.
 */
export const restorePersonalModel = async (request: APIRequestContext) => {
  const key = process.env.E2E_PERSONAL_MODEL_KEY
  if (!key) return
  const headers = { origin: new URL(baseURL).origin, [DEVICE_PERSON_HEADER]: me().personId }
  // Transport diagnostics can contain request bodies. Drop them whole rather than risk printing the key.
  const config = personalModelConfig()
  type Saved = { updated_at: string; protocol: string; base_url: string; fast_model: string | null; key_last4: string }
  const latest = (rows: ReadonlyArray<Saved>) => rows.map((row) => row.updated_at).sort().at(-1)
  const before = latest(await shapeRows<Saved>(request, PERSONAL_MODEL_SHAPE_ROUTE))
  // The whole configuration: this one key, Fast on it; a key an earlier run left goes.
  const data = {
    keys: [{ protocol: config.protocol, baseUrl: config.baseUrl, key }],
    models: { fast: { protocol: config.protocol, modelId: config.modelId } },
  }
  const saved = await request.put(PERSONAL_MODEL_ROUTE, { headers, data })
    .catch(() => { throw new Error("Personal model Save transport failed (details withheld)") })
  expect(saved.status(), "personal model Save accepted").toBe(202)
  // Acceptance is not completion: wait for the durable Put's row before testing the saved model.
  await expect.poll(async () => {
    const rows = await shapeRows<Saved>(request, PERSONAL_MODEL_SHAPE_ROUTE)
    const row = rows[0]
    return rows.length === 1 && row !== undefined && latest(rows) !== before && row.protocol === config.protocol &&
      row.fast_model === config.modelId && row.key_last4 === [...key].slice(-4).join("")
  }, { timeout: 30_000, message: "personal model Save completed" }).toBe(true)
  const tested = await request.post(PERSONAL_MODEL_TEST_ROUTE, { headers, timeout: 60_000 })
    .catch(() => { throw new Error("Personal model Test transport failed (details withheld)") })
  expect(tested.status(), "personal model Test answered").toBe(200)
  const result = await tested.json().catch(() => { throw new Error("Personal model Test returned invalid JSON (details withheld)") }) as { ok?: unknown }
  // Never attach the response body: a provider could echo credentials or prompt content.
  expect(result.ok === true, "saved personal model passes Test").toBe(true)
}
