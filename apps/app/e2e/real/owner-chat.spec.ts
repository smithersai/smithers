import { createHash } from "node:crypto"
import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, closeComposer, command, expect, openApp } from "./support"
import { listModels, maximize, modelsCard, modelRow, seatSelect } from "./models/ui"
import { PROVIDER_MODEL, PROVIDER_REPLY } from "./support/model-provider-behaviors"
import { launchModelProvider } from "./support/model-provider-process"

authenticatedTest("owner adds a model key in the UI and Chat streams its reply", scenario("chat.owner-credential-ui", {
  capabilities: ["identity", "model.turn"],
  coverage: ["action:model.credential.enroll", "action:model.save", "action:model.assign", "host:local", "host:production", "host:native", "path:success", "path:error", "door:button", "dimension:owner-model-credential", "evidence:provider-request-journal"]
}), async ({ page }) => {
  const key = "owner-playwright-provider-key"
  const provider = await launchModelProvider({ key })
  try {
    const startedAt = performance.now()
    await openApp(page)
    await awaitBoot(page, "navigate", startedAt)
    const modelName = `owner-chat-${Date.now().toString(36)}`
    const credentialName = `OWNER_E2E_${Date.now().toString(36).toUpperCase()}`
    await listModels(page)
    await command(page, `/model.save --name ${modelName} --protocol openai-chat --model ${PROVIDER_MODEL.answers} --credential ${credentialName} --url ${provider.origin}`)
    await expect(modelRow(page, modelName)).toBeVisible()
    await maximize(page)
    await seatSelect(page, "chat").selectOption(modelName)
    await expect(seatSelect(page, "chat")).toHaveValue(modelName)
    await page.keyboard.press("Escape")

    await command(page, "Say hello")
    await expect(modelsCard(page).getByTestId("models-attention-fix")).toHaveText("Add credential")
    await closeComposer(page)
    await modelsCard(page).getByTestId("models-attention-fix").click()
    const form = page.locator('.flow-form[data-flow-name="model.credential.enroll"]')
    await form.getByTestId("flow-form-name").fill(credentialName)
    await form.getByTestId("flow-form-origin").fill(provider.origin)
    await form.getByTestId("flow-form-value").fill(key)
    const enrolled = page.waitForResponse(response => new URL(response.url()).pathname === "/api/model/credential")
    await form.getByTestId("flow-form-submit").click()
    expect((await enrolled).status()).toBe(200)
    await expect(modelsCard(page).locator('[data-credential-state="completed"]')).toBeVisible()

    await command(page, "Say hello again")
    await expect(page.locator('.smithers-chat-message[data-role="assistant"]').last()).toContainText(PROVIDER_REPLY.join(""))
    const journal = await provider.journal()
    expect(journal.at(-1)).toMatchObject({ modelId: PROVIDER_MODEL.answers, authorized: true,
      credentialSha256: createHash("sha256").update(key).digest("hex") })
    expect(await page.locator("body").innerText()).not.toContain(key)
  } finally {
    await provider.close()
  }
})
