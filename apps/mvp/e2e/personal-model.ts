import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import { DEVICE_PERSON_HEADER } from "../src/features/auth/contract"
import type { ModelTier } from "../src/features/model/contract"
import {
  PERSONAL_MODEL_ROUTE,
  PERSONAL_MODEL_TEST_ROUTE,
  PERSONAL_MODEL_SHAPE_ROUTE,
  type ConnectionKind,
  isProtocol,
  baseUrlOf,
  type Protocol,
} from "../src/features/personal-model/contract"
import { KIND_LABEL, PROTOCOL_LABEL, TIER_LABEL } from "../src/features/personal-model/copy"
import { shapeRows } from "./shape"
import { personalModelTestDiagnostic } from "./personal-model-result"
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

/** A saved connection as Electric's shape serves it: snake_case columns, every value its text. Never the credential. */
export type SavedRow = {
  id: string
  kind: string
  position: string
  active: string
  protocol: string | null
  base_url: string | null
  fast_model: string | null
  key_last4: string | null
  updated_at: string
}

/** A boolean column's text, read as Electric's own client reads it. */
const isTrue = (text: string) => text === "true" || text === "t"

/** `rows` in the person's order. */
const inOrder = (rows: ReadonlyArray<SavedRow>) => [...rows].sort((a, b) => Number(a.position) - Number(b.position))

/**
 * Whether `rows` are the fixture: the configured API key first, active, Fast on it, and after it nothing but the Codex
 * subscription a person linked by hand (subscriptions.spec.ts), which no run can link again.
 */
export const isFixture = (rows: ReadonlyArray<SavedRow>, config: ReturnType<typeof personalModelConfig>, key: string) => {
  const [row, ...rest] = inOrder(rows)
  return row?.kind === "api_key" && isTrue(row.active) && row.protocol === config.protocol && row.base_url === baseUrlOf(config.baseUrl) &&
    row.fast_model === config.modelId && row.key_last4 === [...key].slice(-4).join("") &&
    rest.every((each) => each.kind === "codex_subscription")
}

/**
 * The whole list a restore saves: the configured key, Fast on it, then each saved Codex subscription by its id and
 * activity. A kept connection sends no key, so its sealed tokens stay where they are; any other connection goes.
 */
export const fixtureConnections = (rows: ReadonlyArray<SavedRow>, config: ReturnType<typeof personalModelConfig>, key: string) => [
  { kind: "api_key", protocol: config.protocol, baseUrl: config.baseUrl, key, models: { fast: config.modelId } },
  ...inOrder(rows).filter((row) => row.kind === "codex_subscription")
    .map((row) => ({ id: row.id, kind: "codex_subscription", active: isTrue(row.active) })),
]

/** A read-only bootstrap check: readers never replace a connection that already matches their configured fixture. */
export const personalModelReady = async (request: APIRequestContext) => {
  const key = process.env.E2E_PERSONAL_MODEL_KEY
  if (!key) return true
  return isFixture(await shapeRows<SavedRow>(request, PERSONAL_MODEL_SHAPE_ROUTE), personalModelConfig(), key)
}

/** Opens Add's menu in Settings' Your model `section` and a kind's form: its dialog. */
export const openAdd = async (section: Locator, page: Page, kind: ConnectionKind) => {
  await section.getByRole("button", { name: "Add", exact: true }).click()
  await page.getByRole("button", { name: KIND_LABEL[kind], exact: true }).click()
  const dialog = page.getByRole("dialog", { name: KIND_LABEL[kind], exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * Fills the API key form as a person does: its protocol, Base URL, Key and each of `tiers`' models; then Save. Context
 * must have tracing disabled: the key is typed.
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
  const dialog = await openAdd(section, page, "api_key")
  await dialog.getByRole("combobox", { name: "Protocol", exact: true }).click()
  await page.getByRole("option", { name: PROTOCOL_LABEL[fill.protocol], exact: true }).click()
  await dialog.getByLabel("Base URL", { exact: true }).fill(fill.baseUrl)
  await dialog.getByLabel("Key", { exact: true }).fill(fill.key)
  for (const [tier, model] of Object.entries(fill.tiers) as Array<[ModelTier, string]>) {
    await dialog.getByLabel(TIER_LABEL[tier], { exact: true }).fill(model)
  }
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
}

/** The rows of the Your model section, in the person's order. */
export const connectionRows = (section: Locator) => section.getByRole("listitem")

/** Presses every Remove in the section until no connection is left, as a run that stopped half way may leave some. */
export const removeConnections = async (section: Locator, within: number) => {
  const removes = section.getByRole("button", { name: "Remove" })
  while ((await removes.count()) > 0) {
    const left = await removes.count()
    await removes.first().click()
    await expect(removes).toHaveCount(left - 1, { timeout: within })
  }
}

/**
 * Save and Test through the same product endpoints as Settings: the one API key, Fast named on it, and a linked Codex
 * subscription kept as it is. Context must have tracing disabled.
 */
export const restorePersonalModel = async (request: APIRequestContext) => {
  const key = process.env.E2E_PERSONAL_MODEL_KEY
  if (!key) return
  const headers = { origin: new URL(baseURL).origin, [DEVICE_PERSON_HEADER]: me().personId }
  // Transport diagnostics can contain request bodies. Drop them whole rather than risk printing the key.
  const config = personalModelConfig()
  const latest = (rows: ReadonlyArray<SavedRow>) => rows.map((row) => row.updated_at).sort().at(-1)
  const saved = await shapeRows<SavedRow>(request, PERSONAL_MODEL_SHAPE_ROUTE)
  const before = latest(saved)
  // The whole list: this one key, Fast on it, then the Codex link a person made; a connection an earlier run left goes.
  const connections = fixtureConnections(saved, config, key)
  const kept = connections.flatMap((connection) => "id" in connection ? [connection.id] : [])
  const put = await request.put(PERSONAL_MODEL_ROUTE, { headers, data: { connections } })
    .catch(() => { throw new Error("Personal model Save transport failed (details withheld)") })
  expect(put.status(), "personal model Save accepted").toBe(202)
  // Acceptance is not completion: wait for the durable Put's row before testing the saved model.
  await expect.poll(async () => {
    const rows = await shapeRows<SavedRow>(request, PERSONAL_MODEL_SHAPE_ROUTE)
    return latest(rows) !== before && isFixture(rows, config, key) && rows.length === kept.length + 1 &&
      kept.every((id) => rows.some((row) => row.id === id))
  }, { timeout: 30_000, message: "personal model Save completed" }).toBe(true)
  const tested = await request.post(PERSONAL_MODEL_TEST_ROUTE, { headers, timeout: 60_000 })
    .catch(() => { throw new Error("Personal model Test transport failed (details withheld)") })
  expect(tested.status(), "personal model Test answered").toBe(200)
  const result = await tested.json().catch(() => { throw new Error("Personal model Test returned invalid JSON (details withheld)") }) as { ok?: unknown }
  // Never attach the response body: a provider could echo credentials or prompt content.
  expect(result.ok === true, `saved personal model passes Test (${personalModelTestDiagnostic(result)})`).toBe(true)
}

/**
 * Removes the model an earlier run left, as a person does in Settings' Your model `section`: the server's rows say
 * whether one is saved, since Remove shows only once the device has synced them and a look before that sees none.
 */
export const removeLeftModel = async (request: APIRequestContext, section: Locator, within: number) => {
  if ((await shapeRows(request, PERSONAL_MODEL_SHAPE_ROUTE)).length === 0) return
  const remove = section.getByRole("button", { name: "Remove" })
  await expect(remove).toBeVisible({ timeout: within })
  await remove.click()
  await expect(remove).toHaveCount(0, { timeout: within })
}
