import { expect, expectSameThread, pairs, test } from "./devices"
import { step } from "./fixtures"
import { fillYourModel, keyGroup, personalModelConfig, restorePersonalModel } from "./personal-model"
import { requires } from "./target"

// People's own models first (decision 0099, docs/features/model-endpoint.md#hosted-inference): while the deployment's own
// model is off, as a deploy leaves it, a Member who saved no model sees "Add your model" where the composer would be,
// and its button opens Settings. With their own model saved, the composer is back, a question is answered, and the
// timeline's summary of it is written, each by the person's own model: the deployment's would refuse them. Locally it
// runs against a dev server started with HOSTED_MODEL_ENABLED=false and a key in the environment; in production
// through the vault's environment wrapper (`personalModelKey`, e2e/target.ts; the model's settings are e2e/README.md's).
// The key is typed into a password field, which the video masks; it is never printed. It ends with the account's model
// saved again, as the deployment setup left it for the specs after this one.

requires("member", "ownConversation", "personalModelKey", "hostedModelOff")
// A trace keeps what was typed and sent, the key included.
test.use({ trace: "off" })

const KEY = process.env.E2E_PERSONAL_MODEL_KEY || ""
const { baseUrl: BASE_URL, modelId: MODEL, protocol: PROTOCOL } = personalModelConfig()

/** A save lands once `model/Put` ran and Electric brought the row back. */
const SAVED_WITHIN = 30_000

test("byok first: no model shows Add your model; with one, the person's own model answers and summarizes", {
  annotation: {
    type: "summary",
    description: "With the hosted model off, a Member without a model is sent to Settings; with one, it answers and summarizes.",
  },
}, async ({ devices }) => {
  test.setTimeout(300_000)
  const word = devices.word
  const [a] = await devices.open("A")
  const page = a.page
  const conversation = page.url()
  const section = page.getByRole("region", { name: "Your model" })
  const remove = section.getByRole("button", { name: "Remove" })
  const addModel = page.locator("[data-add-model]")
  const composer = page.getByRole("textbox", { name: "Message Smithers", exact: true })
  const chat = page.getByRole("button", { name: /^Chat\b/ })
  const settings = new URL("/app/settings", conversation).href

  /**
   * Opens Chat, which a branch page shows collapsed until ⌘K or its Chat button: once the page has mounted either the
   * button, the composer or what stands in its place, it presses the button when that is what shows.
   */
  const openChat = () =>
    step("Open Chat", async () => {
      await addModel.or(composer).or(chat).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 60_000 })
      if (await chat.isVisible()) await chat.click()
    })

  await step("Open Settings, and remove a model an earlier run left", async () => {
    await page.goto(settings)
    await expect(section).toBeVisible({ timeout: 30_000 })
    if (await remove.isVisible()) {
      await remove.click()
      await expect(remove).toHaveCount(0, { timeout: SAVED_WITHIN })
    }
  })

  await step("Back in the conversation: Add your model stands where the composer was", async () => {
    await page.goto(conversation)
    await openChat()
    await expect(addModel).toBeVisible({ timeout: 60_000 })
    await expect(addModel).toContainText("Add your model")
    await expect(composer).toHaveCount(0)
  })

  await step("Open settings goes to Your model", async () => {
    await addModel.getByRole("button", { name: "Open settings" }).click()
    await expect(section).toBeVisible({ timeout: 30_000 })
  })

  await step("Fill Base URL, Key and Fast, then Save", async () => {
    await fillYourModel(section, page, { protocol: PROTOCOL, baseUrl: BASE_URL, key: KEY, tiers: { fast: MODEL } })
    await expect(keyGroup(section, PROTOCOL).getByLabel("Key", { exact: true })).toHaveAttribute("placeholder", /····/, {
      timeout: SAVED_WITHIN,
    })
  })

  await step("Ask: the person's own model answers, and writes the timeline's summary", async () => {
    // With the deployment's model off, the endpoint answers a summary only with the person's own.
    const summarized = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/model/summary" && response.status() === 200,
      { timeout: 180_000 },
    )
    await page.goto(conversation)
    await a.ready()
    await expect(addModel).toHaveCount(0)
    await a.ask(`Reply with exactly this word and nothing else: byok-first-${word}`)
    const [exchange] = pairs(await expectSameThread([a], word, 2, 120_000))
    expect(exchange![1].text).toContain(`byok-first-${word}`)
    const body = await (await summarized).text()
    expect(body).toContain("\"type\":\"text-delta\"")
    expect(body).not.toContain("\"type\":\"error\"")
  })

  await step("Remove: Add your model stands where the composer was again", async () => {
    await page.goto(settings)
    await remove.click()
    await expect(remove).toHaveCount(0, { timeout: SAVED_WITHIN })
    await page.goto(conversation)
    await openChat()
    await expect(addModel).toBeVisible({ timeout: 60_000 })
  })

  await step("Save the account's model again for the specs after this one", () => restorePersonalModel(page.request))
})
