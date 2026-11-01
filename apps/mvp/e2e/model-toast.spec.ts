import { expect, test } from "./devices"
import { step } from "./fixtures"
import { connectionRows, fillYourModel, removeConnections } from "./personal-model"
import { requires } from "./target"
import { expectServerError } from "./watch"

// Local real-browser proof without a provider: real question/answer receipts establish history; real model/Put
// metadata enables routing. No request is intercepted, and no provider is called with the display-only credential.
requires("localServer", "member", "hostedModelOff")
test.use({ trace: "off" })

test("model setup overlays existing history, survives reload, opens Settings and resolves after Save", {
  annotation: { type: "summary", description: "A model prerequisite takes no conversation space; Hide and Save remove its one shared toast." },
}, async ({ devices }) => {
  test.setTimeout(240_000)
  // Hosted inference is deliberately disabled: summaries may report that no model is configured yet.
  expectServerError(409, "/api/model/*")
  const [a] = await devices.open("Model setup")
  const page = a.page
  const notice = page.locator(".sui-toast-stack [data-add-model]")
  const settings = page.getByRole("region", { name: "Your model" })
  const text = `Model setup history ${devices.word}`

  await step("A real conversation already has history", async () => {
    const id = crypto.randomUUID(), answerId = crypto.randomUUID()
    expect((await page.request.post("/api/questions", { data: { id, answerId, text } })).status()).toBe(202)
    expect((await page.request.post(`/api/answers/${answerId}`, { data: { status: "failed", failure: "unfinished" } })).status()).toBe(200)
    await page.reload()
    await expect(page.getByRole("region", { name: "Conversation", exact: true })).toContainText(text, { timeout: 60_000 })
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(page.locator("[data-add-model]")).toHaveCount(1)
    await expect(page.locator(".app-shell-center [data-add-model], .sui-empty[data-add-model]")).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Get started" })).toHaveCount(0)
    await expect(notice.locator("xpath=..")).toHaveAttribute("data-placement", "anchored")
    await expect(page.getByRole("button", { name: "Add your model to ask" })).toBeDisabled()
  })

  await step("Hide gives the conversation the same space; reload checks the prerequisite again", async () => {
    const conversation = page.getByRole("region", { name: "Conversation", exact: true })
    const before = await conversation.boundingBox()
    await notice.getByRole("button", { name: "Hide", exact: true }).click()
    await expect(notice).toHaveCount(0)
    expect(await conversation.boundingBox()).toEqual(before)
    await page.reload()
    await expect(notice).toBeVisible({ timeout: 30_000 })
  })

  await step("Open settings goes to Your model, with only one notice across surfaces", async () => {
    await notice.getByRole("button", { name: "Open settings" }).click()
    await expect(page).toHaveURL(/\/app\/settings$/)
    await expect(settings).toBeVisible({ timeout: 30_000 })
    await expect(notice).toHaveCount(1)
  })

  await step("Save a usable connection: the notice resolves without reload", async () => {
    await fillYourModel(settings, page, { protocol: "openai-chat", baseUrl: "https://models.example.com", key: "model-toast-display-only", tiers: { fast: "display-only" } })
    await expect(connectionRows(settings)).toHaveCount(1, { timeout: 30_000 })
    await expect(notice).toHaveCount(0)
  })

  await step("Remove the connection: one persistent notice returns", async () => {
    await removeConnections(settings, 30_000)
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(page.locator("[data-add-model]")).toHaveCount(1)
  })
})
