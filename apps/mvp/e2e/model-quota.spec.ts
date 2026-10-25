import { MODEL_QUOTA_SPENT } from "../src/features/chat/contract"
import { expect, test } from "./devices"
import { requires, scriptedAgent, target } from "./target"

// The same browser failure path with an injected faulty model locally and a real refusing provider on a deployment.
test("model quota: a refusal ends Working promptly with a reason and Retry", {
  annotation: { type: "summary", description: "A spent model balance ends the answer promptly; Retry stays available." },
}, async ({ devices }) => {
  requires("member", "ownConversation")
  if (target === "local") requires("scriptedAgent")
  else requires("modelQuotaRefusal")
  const [a] = await devices.open("A")
  if (target === "local") {
    await a.page.goto(scriptedAgent("quota-refused"))
    await a.ready()
  }
  const question = `Say hello, quota-${devices.word}`
  await test.step("Ask: the refused answer shows its reason and Retry", async () => {
    await a.askAndWaitTaken(question)
    const answer = a.answerTo(question)
    await expect(answer.locator(".sui-chat-bubble")).toHaveText(MODEL_QUOTA_SPENT, { timeout: 15_000 })
    await expect(answer.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
    await expect(answer.locator('[data-slot="message-response"]')).toHaveAttribute("data-streaming", "false")
  })
  await test.step("Retry: another refused answer also ends promptly", async () => {
    await a.answerTo(question).getByRole("button", { name: "Retry", exact: true }).click()
    await expect(a.question(question)).toHaveCount(2, { timeout: 15_000 })
    const retried = a.question(question).last().locator("xpath=following-sibling::*[1]")
    await expect(retried.locator(".sui-chat-bubble")).toHaveText(MODEL_QUOTA_SPENT, { timeout: 15_000 })
    await expect(retried.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  })
})
