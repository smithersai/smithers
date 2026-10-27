import { baseUrlOf, resolveTier } from "../src/features/personal-model/contract"
import { fillYourModel, keyGroup, personalModelConfig, restorePersonalModel } from "./personal-model"
import { expect, expectSameThread, pairs, test } from "./devices"
import { step } from "./fixtures"
import { requires } from "./target"

// Exercise Settings against a real provider; restore the shared account even when an assertion fails.
requires("personalModel", "member", "ownConversation", "personalModelKey")
// A trace keeps what was typed and sent, the key included.
test.use({ trace: "off" })
test.afterEach(async ({ request }) => {
  await restorePersonalModel(request)
})

const { baseUrl: BASE_URL, modelId: MODEL, protocol: PROTOCOL } = personalModelConfig()
const HOST = new URL(BASE_URL).hostname

/** A save lands once `model/Put` ran and Electric brought the row back. */
const SAVED_WITHIN = 30_000

test("your model: tiers on a key show after a reload; a refused key names the provider and status; a real key answers; Remove takes it off", {
  annotation: {
    type: "summary",
    description:
      "A Member saves a key with Fast and Implement on it; a reload shows them and Hard's fallback; a refused key shows the provider's 401, a real one tests OK and answers.",
  },
}, async ({ devices, request }) => {
  test.setTimeout(300_000)
  const word = devices.word
  const [a] = await devices.open("A")
  const page = a.page
  const conversation = page.url()
  const section = page.getByRole("region", { name: "Your model" })
  const status = section.getByRole("status")
  const remove = section.getByRole("button", { name: "Remove" })
  const keyField = keyGroup(section, PROTOCOL).getByLabel(/compatible Key$/)

  /**
   * Fills the key's Base URL and Key, Fast and Implement on it, and saves: the key goes in one request, and the form
   * clears once ChatApi takes it.
   */
  const save = (key: string) =>
    step("Fill Base URL and Key, Fast and Implement, then Save", async () => {
      await fillYourModel(section, page, { protocol: PROTOCOL, baseUrl: BASE_URL, key, tiers: { fast: MODEL, implement: MODEL } })
      await expect(keyField).toHaveAttribute("placeholder", `····${[...key].slice(-4).join("")}`, { timeout: SAVED_WITHIN })
    })

  // The run's own conversation is a branch's page, whose header has no Settings link: Settings is a page of its own.
  const settings = new URL("/app/settings", conversation).href
  await step("Open Settings", async () => {
    await page.goto(settings)
    await expect(section).toBeVisible({ timeout: 30_000 })
  })

  // An earlier run that stopped half way may have left its model.
  if (await remove.isVisible()) {
    await step("Remove the model an earlier run left", async () => {
      await remove.click()
      await expect(remove).toHaveCount(0, { timeout: SAVED_WITHIN })
    })
  }

  await save(`sk-smithers-e2e-refused-${word}`)

  await step("Reload: Fast and Implement show the saved model; Hard shows the model it uses anyway", async () => {
    await page.reload()
    await expect(section).toBeVisible({ timeout: 30_000 })
    await expect(section.getByLabel("Fast", { exact: true })).toHaveValue(MODEL, { timeout: SAVED_WITHIN })
    await expect(section.getByLabel("Implement", { exact: true })).toHaveValue(MODEL)
    const hard = section.getByLabel("Hard", { exact: true })
    await expect(hard).toHaveValue("")
    // A preset when the key is at its provider's own host, else the tier Hard falls back to: Implement's model.
    const saved = { protocol: PROTOCOL, baseUrl: baseUrlOf(BASE_URL)!, fastModel: MODEL, implementModel: MODEL, hardModel: null }
    await expect(hard).toHaveAttribute("placeholder", `Default: ${resolveTier([saved], "hard")!.modelId}`)
  })

  await step("Test: the provider refuses the key, by its host and status", async () => {
    await section.getByRole("button", { name: "Test" }).click()
    // The test's own words, or, once the person's row syncs, the same refusal with when it happened.
    await expect(status).toHaveText(new RegExp(`^${HOST.replaceAll(".", "\\.")}( refused)? · HTTP 401`), { timeout: 60_000 })
  })

  const toast = page.locator("[data-personal-model]")
  await step("Back in the conversation, the toast says the same", async () => {
    await page.goto(conversation)
    await a.ready()
    await expect(toast).toContainText(`${HOST} · HTTP 401`, { timeout: SAVED_WITHIN })
  })

  await step("Open Settings from the toast", async () => {
    await toast.locator('[data-slot="toast-open"]').click()
    await expect(section).toBeVisible({ timeout: 30_000 })
  })

  await restorePersonalModel(request)
  await page.reload()

  await step("Test: the real key answers OK", async () => {
    await section.getByRole("button", { name: "Test" }).click()
    await expect(status).toHaveText("OK", { timeout: 60_000 })
  })

  await step("Ask in the conversation: the person's own model answers, and the toast is gone", async () => {
    await page.goto(conversation)
    await a.ready()
    await expect(toast).toHaveCount(0)
    await a.ask(`Reply with exactly this word and nothing else: byok-${word}`)
    const [exchange] = pairs(await expectSameThread([a], word, 2, 120_000))
    expect(exchange![1].text).toContain(`byok-${word}`)
  })

  await step("Remove: the saved model and its Test button are gone", async () => {
    await page.goto(settings)
    await remove.click()
    await expect(remove).toHaveCount(0, { timeout: SAVED_WITHIN })
    await expect(section.getByRole("button", { name: "Test" })).toHaveCount(0)
    await expect(keyField).not.toHaveAttribute("placeholder", /····/)
  })
})
