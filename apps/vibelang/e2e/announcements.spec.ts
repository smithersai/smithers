// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test, type Page } from "@playwright/test"

type Observation = { updates: string[]; streaming: Array<{ count: number; text: string; announcement: string }> }
declare global { interface Window { answerObservation: Observation } }
const input = (page: Page) => page.getByRole("textbox", { name: "Message" })
const answers = (page: Page) => page.locator(".sui-chat-message[data-role='assistant']")

async function open(page: Page) {
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByRole("dialog", { name: "Ask the agent" }).getByRole("textbox", { name: "Message" })).toBeFocused()
}
async function send(page: Page) {
  await expect(input(page)).toBeFocused()
  await input(page).pressSequentially("What is a service?")
  await expect(input(page)).toHaveValue("What is a service?")
  await input(page).press("Enter")
}

test("9: the named log stays quiet during streaming and announces each completed answer politely", async ({ page }) => {
  const port = process.env.E2E_PORT ?? process.env.E2E_4510 ?? process.env.E2E_4508 ?? process.env.E2E_4505 ?? process.env.E2E_4501 ?? process.env.E2E_4516 ?? process.env.E2E_4511 ?? process.env.E2E_4502 ?? 4173
  await page.goto(`http://127.0.0.1:${port}/e2e/runtime/index.html?fault=streaming`)
  const announcement = page.getByRole("status", { name: "Answer" })
  await expect(announcement).toHaveText("")
  // Observe from before sending, so the assertion covers every rendered piece regardless of protocol/test speed.
  await announcement.evaluate(element => {
    const observation: Observation = { updates: [], streaming: [] }
    window.answerObservation = observation
    new MutationObserver(() => {
      const announcement = element.textContent ?? ""
      if (announcement && observation.updates.at(-1) !== announcement) observation.updates.push(announcement)
      const replies = document.querySelectorAll(".sui-chat-message[data-role='assistant']")
      const last = replies.item(replies.length - 1)
      if (last?.getAttribute("data-done") === "false") observation.streaming.push({
        count: replies.length, text: last.querySelector(".sui-chat-bubble")?.textContent ?? "", announcement,
      })
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await open(page)
  await send(page)
  const log = page.getByRole("log", { name: "Conversation" })
  await expect(log).toBeVisible()
  await expect(log).toHaveAttribute("aria-live", "off")
  await expect(answers(page).last()).toHaveAttribute("data-done", "false")
  await expect(answers(page).last()).toContainText("service")
  await expect(announcement).toHaveText("")
  await page.evaluate(() => window.recovery.release())
  await expect(answers(page).last()).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  await expect(announcement).toContainText("service")
  const completed = (await announcement.textContent())!
  const cdp = await page.context().newCDPSession(page)
  const { nodes } = await cdp.send("Accessibility.getFullAXTree")
  expect(nodes.some(node => node.role?.value === "log" && node.name?.value === "Conversation")).toBe(true)
  const answer = nodes.find(node => node.role?.value === "status" && node.name?.value === "Answer")!
  expect(answer.properties).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "live", value: expect.objectContaining({ value: "polite" }) }),
    expect.objectContaining({ name: "atomic", value: expect.objectContaining({ value: true }) }),
  ]))
  await input(page).focus()
  await send(page)
  await expect(answers(page)).toHaveCount(2)
  await expect(answers(page).last()).toHaveAttribute("data-done", "false")
  await expect(answers(page).last()).toContainText("service")
  await expect(announcement).toHaveText(completed)
  await open(page)
  await page.evaluate(() => window.recovery.release())
  await expect(answers(page).last()).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  const second = completed.replace("Answer 1:", "Answer 2:")
  await expect(announcement).toHaveText(second)
  const observation = await page.evaluate(() => window.answerObservation)
  expect(observation.updates).toEqual([completed, second])
  for (const count of [1, 2]) {
    const streaming = observation.streaming.filter(item => item.count === count)
    expect(streaming.some(item => item.text !== "")).toBe(true)
    expect(streaming.every(item => item.announcement === (count === 1 ? "" : completed))).toBe(true)
  }
})
