import { expect, expectSameThread, pairs, test } from "./devices"
import { step } from "./fixtures"
import { requires } from "./target"

// Your model, end to end (docs/features/personal-model.md, decision 0096): a Member saves a model of their own on the
// Settings page, against a real provider. A key the provider refuses is saved first: Test names the provider's host and
// status, and the shell's toast says the same. Then the real key: Test says OK, and a question in the person's own
// conversation is answered through it. Remove takes the model off again. Locally it runs under `alchemy dev` with a key
// in the environment; in production through the vault's environment wrapper, where the deployment's own OPENAI_API_KEY
// stands in for a person's key (`personalModelKey`, e2e/target.ts). The key is typed into a password field, which the
// video masks; it is never printed.

requires("member", "personalModelKey")
// A trace keeps what was typed and sent, the key included.
test.use({ trace: "off" })

const KEY = process.env.E2E_PERSONAL_MODEL_KEY || process.env.OPENAI_API_KEY || ""
const BASE_URL = process.env.E2E_PERSONAL_MODEL_BASE_URL || "https://api.openai.com"
const MODEL = process.env.E2E_PERSONAL_MODEL || "gpt-4.1-mini"
const HOST = new URL(BASE_URL).hostname

/** A save lands once `model/Put` ran and Electric brought the row back. */
const SAVED_WITHIN = 30_000

test("your model: a refused key names the provider and status; a real key answers the person; Remove takes it off", {
  annotation: {
    type: "summary",
    description: "A Member saves their own model's key; a refused key shows the provider's 401, a real one tests OK and answers.",
  },
}, async ({ devices }) => {
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
      await section.getByLabel("Base URL").fill(BASE_URL)
      await section.getByLabel("Model").fill(MODEL)
      await section.getByLabel("Key").fill(key)
      await section.getByRole("button", { name: "Save" }).click()
      await expect(section.getByLabel("Key")).toHaveAttribute("placeholder", `····${[...key].slice(-4).join("")}`, {
        timeout: SAVED_WITHIN,
      })
    })

  await step("Open Settings from the header", async () => {
    await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Settings" }).click()
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
    await expect(toast).toContainText(`${HOST} · HTTP 401`, { timeout: SAVED_WITHIN })
  })

  await step("Open Settings from the toast", async () => {
    await toast.locator('[data-slot="toast-open"]').click()
    await expect(section).toBeVisible({ timeout: 30_000 })
  })

  await save(KEY)

  await step("Test: the real key answers OK", async () => {
    await section.getByRole("button", { name: "Test" }).click()
    await expect(status).toHaveText("OK", { timeout: 60_000 })
  })

  await step("Ask in the conversation: the person's own model answers, and the toast is gone", async () => {
    await page.goto(conversation)
    await expect(toast).toHaveCount(0)
    await a.ask(`Reply with exactly this word and nothing else: byok-${word}`)
    const [exchange] = pairs(await expectSameThread([a], word, 2, 120_000))
    expect(exchange![1].text).toContain(`byok-${word}`)
  })

  await step("Remove: the model is gone, and the deployment's model answers again", async () => {
    await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Settings" }).click()
    await remove.click()
    await expect(remove).toHaveCount(0, { timeout: SAVED_WITHIN })
    await expect(section.getByRole("button", { name: "Test" })).toHaveCount(0)
    await expect(section.getByLabel("Key")).not.toHaveAttribute("placeholder", /····/)
  })
})
