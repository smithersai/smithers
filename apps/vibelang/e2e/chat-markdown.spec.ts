// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"

// A recorded reply of the real model (ruling VL-36) in the chat: the live API Worker in workerd answers the prompt
// through test/recordings/model-markdown.json (test/support/recordedProvider.vibe, served by e2e/authbroker-host.vibe
// beside the preview build), and the page renders its table, list and quote (src/web/markdown.vibe). It skips until
// that recording is committed (`pnpm record:model`, test/model.recorded.test.vibe).
const recorded: { readonly prompt: string; readonly origins: Record<string, string> } = JSON.parse(process.env.LIVE_REPLY_TEST!)

test("a recorded reply's table, list and quote render in the chat", async ({ page }, info) => {
  const origin = recorded.origins[info.project.name]
  test.skip(origin === undefined, "no recorded Markdown reply: pnpm record:model")
  await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
  await page.goto(origin + "/")
  await page.keyboard.press("ControlOrMeta+k")
  await page.getByRole("textbox", { name: "Message" }).fill(recorded.prompt)
  await page.keyboard.press("Enter")
  const answer = page.locator(".sui-chat-message[data-role='assistant']").last()
  await expect(answer).toHaveAttribute("data-done", "true", { timeout: 60_000 })
  await expect(answer.locator("table thead th").first()).toBeVisible()
  await expect(answer.locator("table tbody td").first()).toBeVisible()
  await expect(answer.locator("ul > li, ol > li").first()).toBeVisible()
  await expect(answer.locator("blockquote")).toBeVisible()
})
