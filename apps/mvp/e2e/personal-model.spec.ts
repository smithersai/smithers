import { CLAUDE_TOKEN_PREFIX } from "../src/features/personal-model/contract"
import { connectionRows, fillYourModel, openAdd, personalModelConfig, removeConnections, restorePersonalModel } from "./personal-model"
import { expect, expectSameThread, pairs, test } from "./devices"
import { step } from "./fixtures"
import { requires } from "./target"

// Exercise Settings against a real provider; restore the shared account even when an assertion fails.
requires("personalModel", "member", "ownConversation")
// A trace keeps what was typed and sent, the key included.
test.use({ trace: "off" })
test.afterEach(async ({ request }) => {
  await restorePersonalModel(request)
})

const { baseUrl: BASE_URL, modelId: MODEL, protocol: PROTOCOL } = personalModelConfig()
const HOST = new URL(BASE_URL).hostname

/** A save lands once `model/Put` ran and Electric brought the row back. */
const SAVED_WITHIN = 30_000

/** Opens Settings' Your model with nothing left from an earlier run. */
const emptySettings = async (page: import("@playwright/test").Page, conversation: string) => {
  const section = page.getByRole("region", { name: "Your model" })
  await step("Open Settings, with no connection an earlier run left", async () => {
    await page.goto(new URL("/app/settings", conversation).href)
    await expect(section).toBeVisible({ timeout: 30_000 })
    await removeConnections(section, SAVED_WITHIN)
  })
  return section
}

test("your model: a connection shows after a reload; a refused key names the provider and status; a real key answers; Remove takes it off", {
  annotation: {
    type: "summary",
    description:
      "A Member adds an API key; a reload shows it; a refused key shows the provider's 401 on its row, a real one tests OK and answers.",
  },
}, async ({ devices, request }) => {
  requires("personalModelKey")
  test.setTimeout(300_000)
  const word = devices.word
  const [a] = await devices.open("A")
  const page = a.page
  const conversation = page.url()
  const section = await emptySettings(page, conversation)
  const rows = connectionRows(section)
  const row = rows.first()

  await step("Add an API key: Protocol, Base URL, Key, Fast and Implement, then Save", async () => {
    await fillYourModel(section, page, {
      protocol: PROTOCOL,
      baseUrl: BASE_URL,
      key: `sk-smithers-e2e-refused-${word}`,
      tiers: { fast: MODEL, implement: MODEL },
    })
    await expect(rows).toHaveCount(1, { timeout: SAVED_WITHIN })
  })

  await step("Reload: the connection shows its kind and host, active", async () => {
    await page.reload()
    await expect(section).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText("API key", { timeout: SAVED_WITHIN })
    await expect(row).toContainText(HOST)
    await expect(row.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "true")
  })

  await step("Test: the provider refuses the key, by its host and status", async () => {
    await row.getByRole("button", { name: "Test" }).click()
    // The test's own words, or, once the person's row syncs, the same refusal with when it happened.
    await expect(row.getByRole("status")).toHaveText(new RegExp(`^${HOST.replaceAll(".", "\\.")}( refused)? · HTTP 401`), { timeout: 60_000 })
  })

  await restorePersonalModel(request)
  await page.reload()

  await step("Test: the real key answers OK", async () => {
    await row.getByRole("button", { name: "Test" }).click()
    await expect(row.getByRole("status")).toHaveText("OK", { timeout: 60_000 })
  })

  await step("Ask in the conversation: the person's own model answers", async () => {
    await page.goto(conversation)
    await a.ready()
    await a.ask(`Reply with exactly this word and nothing else: byok-${word}`)
    const [exchange] = pairs(await expectSameThread([a], word, 2, 120_000))
    expect(exchange![1].text).toContain(`byok-${word}`)
  })

  await step("Remove: the connection and its Test button are gone", async () => {
    await page.goto(new URL("/app/settings", conversation).href)
    await row.getByRole("button", { name: "Remove" }).click()
    await expect(rows).toHaveCount(0, { timeout: SAVED_WITHIN })
    await expect(section.getByRole("button", { name: "Test" })).toHaveCount(0)
  })
})

test("your model: Kimi K3 needs only a key, and Move up reorders the list", {
  annotation: { type: "summary", description: "A Member adds an API key and Kimi K3, then moves Kimi first; a reload keeps the order." },
}, async ({ devices }) => {
  test.setTimeout(180_000)
  const [a] = await devices.open("A")
  const page = a.page
  const section = await emptySettings(page, page.url())
  const rows = connectionRows(section)

  await step("Add an API key", async () => {
    await fillYourModel(section, page, { protocol: PROTOCOL, baseUrl: BASE_URL, key: `sk-e2e-first-${devices.word}-0123456789`, tiers: { fast: MODEL } })
    await expect(rows).toHaveCount(1, { timeout: SAVED_WITHIN })
  })

  await step("Add Kimi K3: just a key, and its row shows Moonshot's host", async () => {
    const dialog = await openAdd(section, page, "moonshot")
    await dialog.getByLabel("Key", { exact: true }).fill(`sk-e2e-kimi-${devices.word}-0123456789`)
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).toHaveCount(0, { timeout: SAVED_WITHIN })
    await expect(rows).toHaveCount(2, { timeout: SAVED_WITHIN })
    await expect(rows.nth(1)).toContainText("Kimi K3")
    await expect(rows.nth(1)).toContainText("moonshot")
  })

  await step("Move up: Kimi K3 is first, and stays first after a reload", async () => {
    await expect(rows.nth(0).getByRole("button", { name: "Move up" })).toBeDisabled()
    await rows.nth(1).getByRole("button", { name: "Move up" }).click()
    await expect(rows.nth(0)).toContainText("Kimi K3", { timeout: SAVED_WITHIN })
    await page.reload()
    await expect(rows.nth(0)).toContainText("Kimi K3", { timeout: SAVED_WITHIN })
    await expect(rows.nth(1)).toContainText("API key")
  })
})

test("your model: a Claude token that isn't one is refused on the spot; one that is shows no Test", {
  annotation: { type: "summary", description: "Claude's dialog shows the command to run; a token with the wrong prefix never leaves the tab." },
}, async ({ devices }) => {
  test.setTimeout(180_000)
  const [a] = await devices.open("A")
  const page = a.page
  const section = await emptySettings(page, page.url())
  const rows = connectionRows(section)
  let puts = 0
  page.on("request", (sent) => {
    if (sent.method() === "PUT" && new URL(sent.url()).pathname === "/api/me/model") puts++
  })

  const dialog = await openAdd(section, page, "claude_subscription")
  await step("Claude's dialog: the command, and a token that isn't one", async () => {
    await expect(dialog).toContainText("claude setup-token")
    await dialog.getByLabel("Token", { exact: true }).fill(`sk-ant-api03-e2e-${devices.word}-0123456789`)
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog.getByRole("status")).toHaveText("Tokens start with sk-ant-oat")
    expect(puts).toBe(0)
  })

  await step("A real token's shape saves; its row has no Test", async () => {
    await dialog.getByLabel("Token", { exact: true }).fill(`${CLAUDE_TOKEN_PREFIX}01-e2e-${devices.word}-0123456789`)
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).toHaveCount(0, { timeout: SAVED_WITHIN })
    await expect(rows).toHaveCount(1, { timeout: SAVED_WITHIN })
    await expect(rows.first()).toContainText("Claude subscription")
    await expect(rows.first()).toContainText("····")
    await expect(rows.first().getByRole("button", { name: "Test" })).toHaveCount(0)
  })
})
