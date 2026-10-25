import { personalModelConfig, restorePersonalModel } from "./personal-model"
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

test("your model: a refused key names the provider and status; a real key answers the person; Remove takes it off", {
  annotation: {
    type: "summary",
    description: "A Member saves their own model's key; a refused key shows the provider's 401, a real one tests OK and answers.",
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

  /** Fills the form and saves: the key goes in one request, and the form clears once ChatApi takes it. */
  const save = (key: string) =>
    step("Fill Base URL, Model and Key, then Save", async () => {
      await section.getByRole("combobox").click()
      await page.getByRole("option", { name: PROTOCOL === "openai-chat" ? "OpenAI-compatible" : "Anthropic-compatible", exact: true }).click()
      await section.getByLabel("Base URL", { exact: true }).fill(BASE_URL)
      await section.getByLabel("Model", { exact: true }).fill(MODEL)
      await section.getByLabel("Key", { exact: true }).fill(key)
      await section.getByRole("button", { name: "Save" }).click()
      await expect(section.getByLabel("Key", { exact: true })).toHaveAttribute("placeholder", `····${[...key].slice(-4).join("")}`, {
        timeout: SAVED_WITHIN,
      })
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

  await step("Remove: the model is gone, and the account has no model", async () => {
    await page.goto(settings)
    await remove.click()
    await expect(remove).toHaveCount(0, { timeout: SAVED_WITHIN })
    await expect(section.getByRole("button", { name: "Test" })).toHaveCount(0)
    await expect(section.getByLabel("Key", { exact: true })).not.toHaveAttribute("placeholder", /····/)
  })
})
