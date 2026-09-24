import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { awaitBoot, command, expect, openApp } from "./support"
import { ACCEPTED_CREDENTIAL, credentialSha256, listModels, maximize, modelRow, providerJournal, providerOrigin, restore, seatSelect } from "./models/ui"
import { PROVIDER_MODEL, PROVIDER_REPLY } from "./support/model-provider-behaviors"

/* The runner's loopback provider and its operator credential (scripts/run-real-e2e.ts); the app enrolls no keys. */
authenticatedTest("owner assigns a model to Chat and Chat streams its reply", scenario("chat.owner-model", {
  capabilities: ["identity", "model.turn"],
  coverage: ["action:model.save", "action:model.assign", "host:local", "path:success", "door:button", "evidence:provider-request-journal"]
}), async ({ page }) => {
  const startedAt = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", startedAt)
  const modelName = `owner-chat-${Date.now().toString(36)}`
  await listModels(page)
  await command(page, `/model.save --name ${modelName} --protocol openai-chat --model ${PROVIDER_MODEL.answers} --credential ${ACCEPTED_CREDENTIAL} --url ${providerOrigin()}`)
  await expect(modelRow(page, modelName)).toBeVisible()
  await maximize(page)
  await seatSelect(page, "chat").selectOption(modelName)
  await expect(seatSelect(page, "chat")).toHaveValue(modelName)
  await page.keyboard.press("Escape")

  await command(page, "Say hello")
  await expect(page.locator('.smithers-chat-message[data-role="assistant"]').last()).toContainText(PROVIDER_REPLY.join(""))
  expect((await providerJournal()).at(-1)).toMatchObject({ modelId: PROVIDER_MODEL.answers, authorized: true, credentialSha256: credentialSha256(ACCEPTED_CREDENTIAL) })
  await restore(page)
})
