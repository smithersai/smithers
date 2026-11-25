import { expect, test } from "./devices"
import { step } from "./fixtures"
import { connectionRows, fillYourModel, personalModelConfig, removeConnections, restorePersonalModel } from "./personal-model"
import { requires } from "./target"

// A person's model connection can change independently of chat admission.
// A trace would retain the entered key, so this test disables tracing.
requires("member", "ownConversation", "personalModelKey", "hostedModelOff")
// A trace keeps what was typed and sent, the key included.
test.use({ trace: "off" })
test.afterEach(async ({ request }) => {
  await restorePersonalModel(request)
})

const KEY = process.env.E2E_PERSONAL_MODEL_KEY || ""
const { baseUrl: BASE_URL, modelId: MODEL, protocol: PROTOCOL } = personalModelConfig()

/** A save lands once `model/Put` ran and Electric brought the row back. */
const SAVED_WITHIN = 30_000

test("saving and removing a model connection leaves chat available", {
  annotation: { type: "summary", description: "The person can manage their model without interrupting chat." },
}, async ({ devices }) => {
  test.setTimeout(240_000)
  const [tab] = await devices.open("Personal model")
  const page = tab.page
  const conversation = page.url()
  const settings = new URL("/app/settings", conversation).href
  const section = page.getByRole("region", { name: "Your model" })
  const openChat = async () => {
    await page.goto(conversation)
    await expect(tab.chatButton).toBeEnabled({ timeout: 60_000 })
  }

  await step("Remove any existing connection", async () => {
    await page.goto(settings)
    await expect(section).toBeVisible({ timeout: 30_000 })
    await removeConnections(section, SAVED_WITHIN)
    await openChat()
  })

  await step("Save a personal model and return to chat", async () => {
    await page.goto(settings)
    await fillYourModel(section, page, { protocol: PROTOCOL, baseUrl: BASE_URL, key: KEY, tiers: { fast: MODEL } })
    await expect(connectionRows(section)).toHaveCount(1, { timeout: SAVED_WITHIN })
    await openChat()
  })

  await step("Remove the connection and send a question", async () => {
    await page.goto(settings)
    await removeConnections(section, SAVED_WITHIN)
    await openChat()
    const question = `To my attached agent ${devices.word}`
    await tab.askAndWaitTaken(question)
    await expect(tab.question(question)).toHaveAttribute("data-state", "done")
  })
})
